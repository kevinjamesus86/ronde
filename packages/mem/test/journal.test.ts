import { describe, expect, it } from "vitest"
import { emptyUsage, StopReason } from "@ronde/core/completion"
import { JournalEvent } from "@ronde/core/journal"
import { userMessage } from "@ronde/core/message"
import { MemoryJournal, memoryJournal } from "../src/journal.js"

async function collect(journal: MemoryJournal): Promise<JournalEvent[]> {
  const events: JournalEvent[] = []
  await journal.scan((ev) => {
    events.push(ev)
  })
  return events
}

describe("@ronde/mem journal append and replay", () => {
  it("makes appended events visible through scan()", async () => {
    const journal = new MemoryJournal("runtime-1")
    const event = JournalEvent.message(userMessage("hello"))

    await journal.event(event)

    expect(await collect(journal)).toEqual([event])
  })

  it("replays only the active partition through scan()", async () => {
    const journal = new MemoryJournal("runtime-1")
    const stale = JournalEvent.message(userMessage("stale"))
    const active = JournalEvent.turnEnd(2, emptyUsage(), StopReason.EndTurn)
    await journal.event(stale)
    await journal.partition("checkpoint", [active])

    expect(await collect(journal)).toEqual([active])
  })
})

describe("@ronde/mem journal partition semantics", () => {
  it("starts a fresh empty slice when partition is called without nextEvents", async () => {
    const journal = new MemoryJournal("runtime-1")
    await journal.event(JournalEvent.message(userMessage("before")))

    await journal.partition("compaction")

    expect(await collect(journal)).toEqual([])
  })

  it("publishes replacement nextEvents as the new active slice", async () => {
    const journal = new MemoryJournal("runtime-1")
    await journal.event(JournalEvent.message(userMessage("before")))
    const replacement = [
      JournalEvent.warning(1, "condensed"),
      JournalEvent.turnEnd(1, emptyUsage(), StopReason.EndTurn),
    ]

    await journal.partition("compaction", replacement)

    expect(await collect(journal)).toEqual(replacement)
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
