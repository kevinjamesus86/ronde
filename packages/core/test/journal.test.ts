import { describe, expect, it } from "vitest"
import type { Awaitable } from "@ronde/core"
import { Journal, JournalEvent } from "@ronde/core/journal"
import {
  EMPTY_USAGE,
  StopReason,
  type UsageStats,
} from "@ronde/core/completion"
import { userMessage } from "@ronde/core/message"

describe("@ronde/core JournalEvent constructors", () => {
  it("constructs message events", () => {
    const message = userMessage("hello")
    expect(JournalEvent.message(message)).toEqual({
      type: "message",
      message,
    })
  })

  it("constructs turn_end events with usage and stop reason", () => {
    const usage: UsageStats = {
      inputTokens: 1,
      outputTokens: 2,
      cachedReadTokens: 3,
      cachedWriteTokens: 4,
      reasoningTokens: 5,
    }

    expect(JournalEvent.turnEnd(2, usage, StopReason.ToolUse)).toEqual({
      type: "turn_end",
      turn: 2,
      usage,
      stopReason: StopReason.ToolUse,
    })
  })

  it("constructs compaction boundary events", () => {
    expect(JournalEvent.compactionStart(3, 8)).toEqual({
      type: "compaction_start",
      turn: 3,
      historyLength: 8,
    })
    expect(JournalEvent.compactionEnd(3, EMPTY_USAGE)).toEqual({
      type: "compaction_end",
      turn: 3,
      usage: EMPTY_USAGE,
    })
  })

  it("constructs cutoff, warning, and error events", () => {
    expect(JournalEvent.cutoff(2, 4)).toEqual({
      type: "cutoff",
      turn: 2,
      count: 4,
    })
    expect(JournalEvent.warning(2, "watch it")).toEqual({
      type: "warning",
      turn: 2,
      message: "watch it",
    })
    expect(JournalEvent.error(2, "boom")).toEqual({
      type: "error",
      turn: 2,
      message: "boom",
    })
  })
})

describe("@ronde/core journal contract", () => {
  it("treats scan() as the active durable slice for replay and resume", async () => {
    const journal = new TestJournal()
    const first = JournalEvent.message(userMessage("first"))
    const second = JournalEvent.message(userMessage("second"))

    await journal.event(first)
    await journal.event(second)

    expect(await collect(journal)).toEqual([first, second])
  })

  it("treats commit() as the durable resume-point boundary hook", async () => {
    const journal = new TestJournal()

    await expect(journal.commit()).resolves.toBeUndefined()
    expect(journal.commits).toBe(1)
  })

  it("treats partition() as an active-slice replacement", async () => {
    const journal = new TestJournal()
    const oldEvent = JournalEvent.message(userMessage("old"))
    const nextEvents = [JournalEvent.message(userMessage("new"))]

    await journal.event(oldEvent)
    await journal.partition("compaction", nextEvents)

    expect(await collect(journal)).toEqual(nextEvents)
    expect(journal.archived).toEqual([
      { reason: "compaction", events: [oldEvent] },
    ])
  })

  it("forbids duplicating message content under a second durable event shape", () => {
    expect("toolCall" in JournalEvent).toBe(false)
    expect("toolResult" in JournalEvent).toBe(false)
    expect("thinking" in JournalEvent).toBe(false)
    expect("text" in JournalEvent).toBe(false)
  })
})

class TestJournal extends Journal {
  readonly id = "test-journal"
  readonly kind = "test"
  readonly archived: { reason: string; events: JournalEvent[] }[] = []
  readonly active: JournalEvent[] = []
  commits = 0

  async event(event: JournalEvent): Promise<void> {
    this.active.push(event)
  }

  override async commit(): Promise<void> {
    this.commits += 1
  }

  async scan(
    onEvent: (event: JournalEvent) => Awaitable<boolean | void>,
  ): Promise<void> {
    for (const event of this.active) {
      if (onEvent(event)) {
        return
      }
    }
  }

  async partition(
    reason: string,
    nextEvents: readonly JournalEvent[] = [],
  ): Promise<void> {
    this.archived.push({ reason, events: [...this.active] })
    this.active.length = 0
    this.active.push(...nextEvents)
  }
}

async function collect(journal: Journal): Promise<JournalEvent[]> {
  const items: JournalEvent[] = []
  await journal.scan((item) => {
    items.push(item)
  })
  return items
}
