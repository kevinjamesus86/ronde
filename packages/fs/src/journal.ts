import fs from "node:fs/promises"
import path from "node:path"
import { genHex } from "@ronde/core/id"
import { Journal } from "@ronde/core/journal"
import type { JournalSink, JournalEvent } from "@ronde/core/journal"
import type { Awaitable } from "@ronde/core"
import { rebase } from "./internal.js"

export const SEGMENTS_DIR = "segments"
export const META_FILE = "meta.jsonl"

const SCAN_CHUNK_BYTES = 256 * 1024
const NEWLINE_BYTE = 0x0a
const SPACE_BYTE = 0x20
const TAB_BYTE = 0x09
const CARRIAGE_RETURN_BYTE = 0x0d
const Uint8IndexOf = Uint8Array.prototype.indexOf

export interface FsJournalState {
  v: 1
  id: string
  createdAt: string
  activeGeneration: number
}

type FsJournalMetaRecord =
  | {
      type: "runtime_created"
      v: 1
      id: string
      createdAt: string
    }
  | {
      type: "generation_published"
      generation: number
      reason: string
      at: string
    }

type TailMode = "repair" | "tolerate" | "strict"

type ScanJsonlOptions<T> = {
  tailMode: TailMode
  parse: (line: string) => T
  invalidContext: string
  onValue?: (value: T) => Awaitable<boolean | void>
}

type TailState = {
  chunks: Buffer[]
  bytes: number
  startOffset: number
}

/**
 * Each active-history generation lives in its own append-only JSONL
 * segment; current state is reduced from an append-only metadata ledger.
 */
export class FsJournal extends Journal {
  readonly kind = "fs" as const
  private writes: Promise<void> = Promise.resolve()
  private writableGeneration?: number
  private activeDirty = false

  #dir: string
  get dir(): string {
    return this.#dir
  }

  constructor(
    readonly id: string,
    dir: string,
    private state: FsJournalState,
  ) {
    super()
    this.#dir = dir
  }

  [rebase](dir: string): void {
    this.#dir = dir
  }

  async event(event: JournalEvent): Promise<void> {
    await this.runExclusiveOnActive(async () => {
      await appendJsonLine(this.activeSegmentPath(), event)
      this.activeDirty = true
    })
  }

  /**
   * Fsyncs the active segment iff something was appended since the last
   * commit. Callers pick the boundary — the journal makes no assumption
   * about which events warrant a flush.
   */
  override async commit(): Promise<void> {
    await this.runExclusiveOnActive(async () => {
      if (this.activeDirty) {
        await fsync(this.activeSegmentPath())
        this.activeDirty = false
      }
    })
  }

  async partition(
    reason: string,
    nextEvents: readonly JournalEvent[] = [],
  ): Promise<void> {
    await this.runExclusiveOnActive(async () => {
      const nextGeneration = this.state.activeGeneration + 1
      const tempPath = path.join(
        this.dir,
        SEGMENTS_DIR,
        `${segmentFileName(nextGeneration)}.tmp-${genHex()}`,
      )
      const finalPath = segmentPath(this.dir, nextGeneration)
      const at = new Date().toISOString()

      await writeEventsFile(tempPath, nextEvents)
      await fs.rename(tempPath, finalPath)
      await fsync(path.join(this.dir, SEGMENTS_DIR))
      await appendMetaRecord(this.dir, {
        type: "generation_published",
        generation: nextGeneration,
        reason,
        at,
      })

      this.state = {
        ...this.state,
        activeGeneration: nextGeneration,
      }
      this.writableGeneration = nextGeneration
      this.activeDirty = false
    })
  }

  async scan(onEvent: JournalSink): Promise<void> {
    const repairTail = this.writableGeneration !== this.state.activeGeneration
    const completed = await scanJsonlFile(this.activeSegmentPath(), {
      tailMode: repairTail ? "repair" : "strict",
      parse: parseJournalEvent,
      invalidContext: `Invalid active segment in ${this.dir}`,
      onValue: onEvent,
    })
    if (repairTail && completed) {
      this.writableGeneration = this.state.activeGeneration
    }
  }

  private activeSegmentPath(): string {
    return segmentPath(this.dir, this.state.activeGeneration)
  }

  private async ensureActiveGenerationWritable(): Promise<void> {
    if (this.writableGeneration !== this.state.activeGeneration) {
      await ensureJsonlTailWritable(this.activeSegmentPath())
      this.writableGeneration = this.state.activeGeneration
    }
  }

  /**
   * Serialize a mutation against the active generation and repair only
   * its writable tail before mutating. Interior corruption is a
   * scan-time concern.
   */
  private runExclusiveOnActive<T>(op: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      await this.ensureActiveGenerationWritable()
      return op()
    })
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writes.then(op, op)
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export async function readJournalState(
  dir: string,
  tailMode: TailMode = "strict",
): Promise<FsJournalState> {
  let state: FsJournalState | undefined
  await scanJsonlFile(path.join(dir, META_FILE), {
    tailMode,
    parse: parseMetaRecord,
    invalidContext: `Invalid journal metadata in ${dir}`,
    onValue: (record) => {
      state = reduceMetaRecord(state, record, dir)
    },
  })

  if (!state) {
    throw new Error(`Invalid journal metadata in ${dir}.`)
  }
  if (state.activeGeneration < 1) {
    throw new Error(
      `Invalid journal metadata in ${dir}: no active generation has been published`,
    )
  }
  return state
}

export async function initializeJournalState(
  dir: string,
  state: FsJournalState,
): Promise<void> {
  const body =
    [
      JSON.stringify({
        type: "runtime_created",
        v: 1,
        id: state.id,
        createdAt: state.createdAt,
      } satisfies FsJournalMetaRecord),
      JSON.stringify({
        type: "generation_published",
        generation: state.activeGeneration,
        reason: "create",
        at: state.createdAt,
      } satisfies FsJournalMetaRecord),
    ].join("\n") + "\n"
  await writeFileDurable(path.join(dir, META_FILE), body)
}

function reduceMetaRecord(
  state: FsJournalState | undefined,
  record: FsJournalMetaRecord,
  dir: string,
): FsJournalState {
  switch (record.type) {
    case "runtime_created": {
      if (state) {
        throw new Error(
          `Invalid journal metadata in ${dir}: duplicate runtime_created record`,
        )
      }
      return {
        v: 1,
        id: record.id,
        createdAt: record.createdAt,
        activeGeneration: 0,
      }
    }
    case "generation_published": {
      if (!state) {
        throw new Error(
          `Invalid journal metadata in ${dir}: generation published before runtime_created`,
        )
      }
      const expected = state.activeGeneration + 1
      if (record.generation !== expected) {
        throw new Error(
          `Invalid journal metadata in ${dir}: expected generation ${expected} but saw ${record.generation}`,
        )
      }
      return {
        ...state,
        activeGeneration: record.generation,
      }
    }
  }
}

function isMetaRecord(x: unknown): x is FsJournalMetaRecord {
  if (typeof x !== "object" || x === null || !("type" in x)) {
    return false
  }

  switch (x.type) {
    case "runtime_created":
      return (
        "v" in x &&
        x.v === 1 &&
        "id" in x &&
        typeof x.id === "string" &&
        "createdAt" in x &&
        typeof x.createdAt === "string"
      )
    case "generation_published":
      return (
        "generation" in x &&
        typeof x.generation === "number" &&
        Number.isInteger(x.generation) &&
        x.generation > 0 &&
        "reason" in x &&
        typeof x.reason === "string" &&
        "at" in x &&
        typeof x.at === "string"
      )
    default:
      return false
  }
}

function parseMetaRecord(line: string): FsJournalMetaRecord {
  const parsed = JSON.parse(line)
  if (!isMetaRecord(parsed)) {
    throw new Error("invalid metadata record shape")
  }
  return parsed
}

function parseJournalEvent(line: string): JournalEvent {
  const event = JSON.parse(line) as JournalEvent
  if (event.type === "message") {
    normalizeLegacyMessageParts(event.message.parts)
  }
  return event
}

/**
 * Lift legacy `string` content on tool-result parts to `Block[]`.
 * In-place rewrite of parts read from pre-Block journals so the rest
 * of the framework only ever sees the new shape.
 */
function normalizeLegacyMessageParts(parts: unknown[]): void {
  for (const part of parts) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "tool_result"
    ) {
      const trp = part as { content: unknown }
      if (typeof trp.content === "string") {
        trp.content = [{ kind: "text", text: trp.content }]
      }
    }
  }
}

function segmentFileName(generation: number): string {
  return `${generation.toString().padStart(8, "0")}.jsonl`
}

function segmentPath(dir: string, generation: number): string {
  return path.join(dir, SEGMENTS_DIR, segmentFileName(generation))
}

async function appendMetaRecord(
  dir: string,
  record: FsJournalMetaRecord,
): Promise<void> {
  await appendJsonLine(path.join(dir, META_FILE), record, true)
}

async function appendJsonLine(
  filePath: string,
  value: unknown,
  flush = false,
): Promise<void> {
  const fh = await fs.open(filePath, "a")
  try {
    await fh.writeFile(JSON.stringify(value) + "\n", "utf8")
    if (flush) {
      await fh.sync()
    }
  } finally {
    await fh.close()
  }
}

async function writeEventsFile(
  filePath: string,
  events: readonly JournalEvent[],
): Promise<void> {
  const body =
    events.length === 0
      ? ""
      : events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  await writeFileDurable(filePath, body)
}

async function writeFileDurable(filePath: string, body: string): Promise<void> {
  const fh = await fs.open(filePath, "w")
  try {
    await fh.writeFile(body, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function fsync(pathToSync: string): Promise<void> {
  const fh = await fs.open(pathToSync, "r")
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function scanJsonlFile<T>(
  filePath: string,
  options: ScanJsonlOptions<T>,
): Promise<boolean> {
  const { tailMode, parse, invalidContext, onValue } = options
  const fh = await fs.open(filePath, tailMode === "repair" ? "r+" : "r")
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES)
  const tail = emptyTail()
  let fileOffset = 0

  try {
    for (;;) {
      const chunkStartOffset = fileOffset
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, fileOffset)
      if (bytesRead === 0) {
        break
      }

      fileOffset += bytesRead
      const incoming = chunk.subarray(0, bytesRead)
      let lineStart = 0

      if (tail.bytes > 0) {
        const tailNewline = byteIndexOf(incoming, NEWLINE_BYTE, 0)
        if (tailNewline === -1) {
          appendTailChunk(tail, incoming)
          continue
        }

        if (tailHasNonWhitespaceBytes(tail, incoming, 0, tailNewline)) {
          const value = parseJsonLine(
            decodeTailLine(tail, incoming, 0, tailNewline),
            parse,
            invalidContext,
          )
          if (await invokeSink(onValue, value)) {
            return false
          }
        }

        lineStart = tailNewline + 1
        resetTail(tail)
      }

      for (;;) {
        const newline = byteIndexOf(incoming, NEWLINE_BYTE, lineStart)
        if (newline === -1) {
          break
        }

        if (hasNonWhitespaceBytes(incoming, lineStart, newline)) {
          const value = parseJsonLine(
            incoming.toString("utf8", lineStart, newline),
            parse,
            invalidContext,
          )
          if (await invokeSink(onValue, value)) {
            return false
          }
        }

        lineStart = newline + 1
      }

      if (lineStart === incoming.length) {
        resetTail(tail)
      } else {
        setTail(
          tail,
          Buffer.from(incoming.subarray(lineStart)),
          chunkStartOffset + lineStart,
        )
      }
    }

    if (tail.bytes === 0) {
      return true
    }

    if (!tailHasNonWhitespaceBytes(tail)) {
      if (tailMode === "repair") {
        await normalizeOpenFileTail(fh, {
          kind: "truncate",
          at: tail.startOffset,
        })
      }
      return true
    }

    const tailText = decodeTailLine(tail)
    try {
      const value = parse(tailText)
      if (await invokeSink(onValue, value)) {
        return false
      }
      if (tailMode === "repair") {
        await normalizeOpenFileTail(fh, {
          kind: "appendNewline",
          at: fileOffset,
        })
      }
      return true
    } catch (error) {
      if (tailMode === "repair") {
        await normalizeOpenFileTail(fh, {
          kind: "truncate",
          at: tail.startOffset,
        })
        return true
      }
      if (tailMode === "tolerate") {
        return true
      }
      throw new Error(`${invalidContext}: ${(error as Error).message}`)
    }
  } finally {
    await fh.close()
  }
}

async function ensureJsonlTailWritable(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, "r+")
  try {
    const { size } = await fh.stat()
    if (size === 0) {
      return
    }

    let start = Math.max(0, size - SCAN_CHUNK_BYTES)
    for (;;) {
      const length = size - start
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await fh.read(chunk, 0, length, start)
      const data = chunk.subarray(0, bytesRead)

      if (data.length === 0) {
        return
      }
      if (data[data.length - 1] === NEWLINE_BYTE) {
        return
      }

      const lineStart = byteLastIndexOf(data, NEWLINE_BYTE)
      if (lineStart === -1 && start > 0) {
        start = Math.max(0, start - SCAN_CHUNK_BYTES)
        continue
      }

      const tail = data.subarray(lineStart === -1 ? 0 : lineStart + 1)
      const tailStart = lineStart === -1 ? 0 : start + lineStart + 1
      const tailText = tail.toString("utf8")
      if (!hasNonWhitespaceBytes(tail, 0, tail.length)) {
        await normalizeOpenFileTail(fh, {
          kind: "truncate",
          at: tailStart,
        })
        return
      }

      try {
        JSON.parse(tailText)
        await normalizeOpenFileTail(fh, {
          kind: "appendNewline",
          at: size,
        })
      } catch {
        await normalizeOpenFileTail(fh, {
          kind: "truncate",
          at: tailStart,
        })
      }
      return
    }
  } finally {
    await fh.close()
  }
}

function parseJsonLine<T>(
  line: string,
  parse: (line: string) => T,
  invalidContext: string,
): T {
  try {
    return parse(line)
  } catch (error) {
    throw new Error(`${invalidContext}: ${(error as Error).message}`)
  }
}

type TailOp =
  | { kind: "truncate"; at: number }
  | { kind: "appendNewline"; at: number }

async function normalizeOpenFileTail(
  fh: fs.FileHandle,
  op: TailOp,
): Promise<void> {
  if (op.kind === "truncate") {
    await fh.truncate(op.at)
  } else {
    await fh.write("\n", op.at, "utf8")
  }
  await fh.sync()
}

function byteIndexOf(buf: Uint8Array, value: number, start: number): number {
  return Uint8IndexOf.call(buf, value, start)
}

function byteLastIndexOf(buf: Uint8Array, value: number): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === value) {
      return i
    }
  }
  return -1
}

function hasNonWhitespaceBytes(
  buf: Uint8Array,
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]
    if (
      byte !== SPACE_BYTE &&
      byte !== TAB_BYTE &&
      byte !== CARRIAGE_RETURN_BYTE
    ) {
      return true
    }
  }
  return false
}

function emptyTail(): TailState {
  return { chunks: [], bytes: 0, startOffset: 0 }
}

function resetTail(tail: TailState): void {
  tail.chunks = []
  tail.bytes = 0
  tail.startOffset = 0
}

function setTail(tail: TailState, chunk: Buffer, startOffset: number): void {
  if (chunk.length === 0) {
    resetTail(tail)
    return
  }
  tail.chunks = [chunk]
  tail.bytes = chunk.length
  tail.startOffset = startOffset
}

function appendTailChunk(tail: TailState, chunk: Uint8Array): void {
  if (chunk.length === 0) {
    return
  }
  tail.chunks.push(Buffer.from(chunk))
  tail.bytes += chunk.length
}

function tailHasNonWhitespaceBytes(
  tail: TailState,
  suffix?: Uint8Array,
  start = 0,
  end = suffix?.length ?? 0,
): boolean {
  for (const chunk of tail.chunks) {
    if (hasNonWhitespaceBytes(chunk, 0, chunk.length)) {
      return true
    }
  }
  if (!suffix) {
    return false
  }
  return hasNonWhitespaceBytes(suffix, start, end)
}

function decodeTailLine(
  tail: TailState,
  suffix?: Buffer,
  start = 0,
  end = suffix?.length ?? 0,
): string {
  let text = ""
  for (const chunk of tail.chunks) {
    text += chunk.toString("utf8")
  }
  if (suffix && end > start) {
    text += suffix.toString("utf8", start, end)
  }
  return text
}

async function invokeSink<T>(
  onValue: ((value: T) => Awaitable<boolean | void>) | undefined,
  value: T,
): Promise<boolean> {
  if (!onValue) {
    return false
  }
  const result = onValue(value)
  if (result === true) {
    return true
  }
  if (result && typeof result === "object" && "then" in result) {
    return (await result) === true
  }
  return false
}
