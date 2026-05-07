import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import { JournalEvent } from "@ronde/core/journal"
import { createFsRuntime, openFsRuntime } from "../src/index.js"
import {
  initializeJournalState,
  META_FILE,
  readJournalState,
  SEGMENTS_DIR,
} from "../src/journal.js"
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

describe("@ronde/fs journal append and replay", () => {
  it("appends journal events to the active segment", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await journal.event(JournalEvent.warning(1, "hello"))

    const body = await fs.readFile(
      path.join(dir, SEGMENTS_DIR, "00000001.jsonl"),
      "utf8",
    )
    expect(body).toContain('"type":"warning"')
    expect(body).toContain('"message":"hello"')
  })

  it("replays only the active generation through scan()", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await journal.event(JournalEvent.warning(1, "old"))
    await journal.partition("compact", [JournalEvent.warning(2, "new")])

    const events = await collectEvents(journal)

    expect(events).toEqual([JournalEvent.warning(2, "new")])
  })

  it("ignores empty lines in the active segment", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)
    const segment = path.join(dir, SEGMENTS_DIR, "00000001.jsonl")
    await fs.appendFile(segment, "\n\n", "utf8")
    await journal.event(JournalEvent.warning(1, "hello"))

    const events = await collectEvents(journal)

    expect(events).toEqual([JournalEvent.warning(1, "hello")])
  })

  it("rejects invalid metadata ledgers on open", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    await fs.writeFile(
      path.join(dir, META_FILE),
      JSON.stringify({
        v: 1,
        id: "broken",
        createdAt: new Date().toISOString(),
        type: "runtime_created",
      }),
      "utf8",
    )

    await expect(openFsRuntime(dir)).rejects.toThrow(
      /invalid journal metadata/i,
    )
  })
})

describe("@ronde/fs journal commit semantics", () => {
  it("persists turn_end events without mutating metadata", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)
    const before = await fs.readFile(path.join(dir, META_FILE), "utf8")

    await journal.event(
      JournalEvent.turnEnd(1, emptyUsage(), StopReason.EndTurn),
    )

    const after = await fs.readFile(path.join(dir, META_FILE), "utf8")
    expect(after).toBe(before)
  })

  it("syncs commit() without mutating metadata", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)
    const before = await fs.readFile(path.join(dir, META_FILE), "utf8")

    await journal.event(JournalEvent.warning(1, "buffered"))
    await journal.commit()

    const after = await fs.readFile(path.join(dir, META_FILE), "utf8")
    expect(after).toBe(before)
  })

  it("keeps metadata unchanged for non-commit events", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)
    const before = await fs.readFile(path.join(dir, META_FILE), "utf8")

    await journal.event(JournalEvent.warning(1, "hello"))

    const after = await fs.readFile(path.join(dir, META_FILE), "utf8")
    expect(after).toBe(before)
  })
})

describe("@ronde/fs journal partition semantics", () => {
  it("publishes a new active generation atomically", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await journal.event(JournalEvent.warning(1, "old"))
    await journal.partition("compact", [JournalEvent.warning(2, "new")])

    const state = await readJournalState(dir)

    expect(state.activeGeneration).toBe(2)
    await expect(
      fs.access(path.join(dir, SEGMENTS_DIR, "00000002.jsonl")),
    ).resolves.toBeUndefined()
  })

  it("supports empty replacement generations", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await journal.event(JournalEvent.warning(1, "old"))
    await journal.partition("clear")

    const events = await collectEvents(journal)

    expect(events).toEqual([])
  })

  it("supports replacement generations seeded with nextEvents", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await journal.partition("seed", [
      JournalEvent.warning(1, "one"),
      JournalEvent.error(1, "two"),
    ])

    const events = await collectEvents(journal)

    expect(events).toEqual([
      JournalEvent.warning(1, "one"),
      JournalEvent.error(1, "two"),
    ])
  })

  it("fails partition when publishing to the metadata ledger fails", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)
    const originalOpen = fs.open.bind(fs)
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (filePath, flags, ...rest) => {
        if (String(filePath).endsWith(META_FILE) && String(flags) === "a") {
          throw new Error("disk full")
        }
        return await originalOpen(filePath, flags as never, ...(rest as []))
      })

    try {
      await expect(
        journal.partition("compact", [JournalEvent.warning(2, "new")]),
      ).rejects.toThrow(/disk full/i)
    } finally {
      openSpy.mockRestore()
    }

    const state = await readJournalState(dir)
    const events = await collectEvents(journal)

    expect(state.activeGeneration).toBe(1)
    expect(events).toEqual([])
  })
})

describe("@ronde/fs journal write ordering", () => {
  it("serializes concurrent writes through the internal promise chain", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await Promise.all([
      journal.event(JournalEvent.warning(1, "one")),
      journal.event(JournalEvent.warning(2, "two")),
      journal.event(JournalEvent.warning(3, "three")),
    ])

    const events = await collectEvents(journal)

    expect(events).toEqual([
      JournalEvent.warning(1, "one"),
      JournalEvent.warning(2, "two"),
      JournalEvent.warning(3, "three"),
    ])
  })

  it("keeps partition and append operations coherent under contention", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const { journal } = await createFsRuntime(dir)

    await Promise.all([
      journal.event(JournalEvent.warning(1, "before")),
      journal.partition("compact", [JournalEvent.warning(2, "after")]),
    ])

    const events = await collectEvents(journal)

    expect(events).toEqual([JournalEvent.warning(2, "after")])
  })
})

describe("@ronde/fs journal legacy back-compat", () => {
  it("lifts legacy string tool_result content to a single text Block", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const legacy = JSON.stringify({
      type: "message",
      message: {
        parts: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            name: "echo",
            arguments: { text: "hi" },
          },
          {
            type: "tool_result",
            toolCallId: "call-1",
            ok: true,
            content: "hello world",
          },
        ],
      },
    })
    await fs.writeFile(
      path.join(dir, SEGMENTS_DIR, "00000001.jsonl"),
      `${legacy}\n`,
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    const events = (await collectEvents(journal)) as Array<{
      type: string
      message: { parts: Array<Record<string, unknown>> }
    }>

    expect(events).toHaveLength(1)
    const parts = events[0]!.message.parts
    expect(parts[1]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      ok: true,
      content: [{ kind: "text", text: "hello world" }],
    })
  })

  it("passes through new-format Block[] tool_result content unchanged", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const fresh = JSON.stringify({
      type: "message",
      message: {
        parts: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            ok: true,
            content: [
              { kind: "text", text: "captured" },
              { kind: "ref", uri: "file:///tmp/x", bytes: 12 },
            ],
          },
        ],
      },
    })
    await fs.writeFile(
      path.join(dir, SEGMENTS_DIR, "00000001.jsonl"),
      `${fresh}\n`,
      "utf8",
    )

    const { journal } = await openFsRuntime(dir)
    const events = (await collectEvents(journal)) as Array<{
      type: string
      message: { parts: Array<Record<string, unknown>> }
    }>

    expect(events[0]!.message.parts[0]!.content).toEqual([
      { kind: "text", text: "captured" },
      { kind: "ref", uri: "file:///tmp/x", bytes: 12 },
    ])
  })
})
