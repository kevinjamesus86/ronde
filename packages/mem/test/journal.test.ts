import { describe, expect, it } from "vitest"
import { emptyUsage, StopReason } from "@ronde/core/completion"
import { JournalEvent } from "@ronde/core/journal"
import { userMessage } from "@ronde/core/message"
import { MemoryJournal, memoryJournal } from "../src/journal.js"

describe("@ronde/mem journal append and replay", () => {
  it("appends journal events into the active generation", async () => {
    const journal = new MemoryJournal("runtime-1")
    const event = JournalEvent.message(userMessage("hello"))

    await journal.event(event)

    expect(journal.generations).toEqual([{ reason: null, events: [event] }])
  })

  it("replays only the active generation through scan()", async () => {
    const journal = new MemoryJournal("runtime-1")
    const stale = JournalEvent.message(userMessage("stale"))
    const active = JournalEvent.turnEnd(2, emptyUsage(), StopReason.EndTurn)
    await journal.event(stale)
    await journal.partition("checkpoint", [active])

    const events: unknown[] = []
    await journal.scan((event) => {
      events.push(event)
    })

    expect(events).toEqual([active])
  })
})

describe("@ronde/mem journal partition semantics", () => {
  it("creates a new generation with the provided reason", async () => {
    const journal = new MemoryJournal("runtime-1")

    await journal.partition("compaction")

    expect(journal.generations).toEqual([
      { reason: null, events: [] },
      { reason: "compaction", events: [] },
    ])
  })

  it("supports replacement nextEvents for the new active generation", async () => {
    const journal = new MemoryJournal("runtime-1")
    const replacement = [
      JournalEvent.warning(1, "condensed"),
      JournalEvent.turnEnd(1, emptyUsage(), StopReason.EndTurn),
    ]

    await journal.partition("compaction", replacement)

    expect(journal.generations[1]).toEqual({
      reason: "compaction",
      events: replacement,
    })
  })

  it("retains prior generations for inspection", async () => {
    const journal = new MemoryJournal("runtime-1")
    const old = JournalEvent.message(userMessage("before"))
    const next = JournalEvent.message(userMessage("after"))
    await journal.event(old)

    await journal.partition("handoff", [next])

    expect(journal.generations).toEqual([
      { reason: null, events: [old] },
      { reason: "handoff", events: [next] },
    ])
  })
})

describe("@ronde/mem journal identity", () => {
  it("generates a runtime id when one is not provided", () => {
    const journal = memoryJournal()

    expect(journal.id).toMatch(/^rt-/)
  })

  it("preserves an explicit journal id when provided", () => {
    const journal = memoryJournal("runtime-1")

    expect(journal.id).toBe("runtime-1")
  })
})
