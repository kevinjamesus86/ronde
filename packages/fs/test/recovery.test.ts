import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { JournalEvent } from "@ronde/core/journal"
import { openFsRuntime } from "../src/index.js"
import { initializeJournalState, SEGMENTS_DIR } from "../src/journal.js"
import { useTmp } from "./support.js"

const tmp = useTmp()
afterEach(() => tmp.cleanup())

async function seedFsRuntimeDir(
  dir: string,
  id = "runtime-seed",
): Promise<void> {
  const now = new Date().toISOString()
  await fs.mkdir(path.join(dir, SEGMENTS_DIR), { recursive: true })
  await fs.mkdir(path.join(dir, "tool-results"), { recursive: true })
  await fs.writeFile(path.join(dir, SEGMENTS_DIR, "00000001.jsonl"), "", "utf8")
  await initializeJournalState(dir, {
    v: 1,
    id,
    createdAt: now,
    activeGeneration: 1,
  })
}

async function collectEvents(journal: {
  scan: (onEvent: (event: unknown) => void | boolean) => Promise<void>
}): Promise<unknown[]> {
  const events: unknown[] = []
  await journal.scan((event) => {
    events.push(event)
  })
  return events
}

describe("@ronde/fs recovery", () => {
  it("repairs a torn final line on first replay, not on open", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const segmentPath = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.writeFile(
      segmentPath,
      [
        JSON.stringify(JournalEvent.warning(1, "good")),
        '{"type":"message","message":',
      ].join("\n"),
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    const beforeReplay = await fs.readFile(segmentPath, "utf8")
    expect(beforeReplay).toContain('{"type":"message","message":')

    const events = await collectEvents(journal)

    expect(events).toEqual([JournalEvent.warning(1, "good")])

    const afterReplay = await fs.readFile(segmentPath, "utf8")
    expect(afterReplay).not.toContain('{"type":"message","message":')
  })

  it("repairs a torn final line before a write-first append", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const segmentPath = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.writeFile(
      segmentPath,
      [
        JSON.stringify(JournalEvent.warning(1, "good")),
        '{"type":"message","message":',
      ].join("\n"),
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    await journal.event(JournalEvent.warning(2, "after-recovery"))

    const events = await collectEvents(journal)

    expect(events).toEqual([
      JournalEvent.warning(1, "good"),
      JournalEvent.warning(2, "after-recovery"),
    ])

    const body = await fs.readFile(segmentPath, "utf8")
    expect(body).not.toContain('{"type":"message","message":')
    expect(body).toContain('"message":"after-recovery"')
  })

  it("fails replay on malformed non-tail lines in the active segment", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const segmentPath = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.writeFile(
      segmentPath,
      [
        JSON.stringify(JournalEvent.warning(1, "before")),
        "not-json",
        JSON.stringify(JournalEvent.warning(2, "after")),
        "",
      ].join("\n"),
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    const seen: unknown[] = []
    const replay = async () => {
      await journal.scan((event) => {
        seen.push(event)
      })
    }

    await expect(replay()).rejects.toThrow(/invalid active segment/i)
    expect(seen).toEqual([JournalEvent.warning(1, "before")])
  })

  it("allows write-first append with malformed non-tail lines and fails later scan", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const segmentPath = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.writeFile(
      segmentPath,
      [
        JSON.stringify(JournalEvent.warning(1, "before")),
        "not-json",
        JSON.stringify(JournalEvent.warning(2, "after")),
        "",
      ].join("\n"),
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    await expect(
      journal.event(JournalEvent.warning(3, "appended-after-tail-check")),
    ).resolves.toBeUndefined()

    const seen: unknown[] = []
    await expect(
      journal.scan((event) => {
        seen.push(event)
      }),
    ).rejects.toThrow(/invalid active segment/i)
    expect(seen).toEqual([JournalEvent.warning(1, "before")])

    const body = await fs.readFile(segmentPath, "utf8")
    expect(body).toContain("appended-after-tail-check")
  })

  it("normalizes a valid unterminated final line before future appends", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const segmentPath = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.writeFile(
      segmentPath,
      JSON.stringify(JournalEvent.warning(1, "good")),
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)

    const events = await collectEvents(journal)
    expect(events).toEqual([JournalEvent.warning(1, "good")])

    await journal.event(JournalEvent.warning(2, "after"))
    const replayed = await collectEvents(journal)

    expect(replayed).toEqual([
      JournalEvent.warning(1, "good"),
      JournalEvent.warning(2, "after"),
    ])

    const body = await fs.readFile(segmentPath, "utf8")
    expect(body).toContain("good")
    expect(body).toContain("after")
    expect(
      body.includes('{"type":"warning","turn":1,"message":"good"}\n'),
    ).toBe(true)
  })
})
