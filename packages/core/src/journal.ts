/**
 * @module
 * Journal primitive. A Journal owns ordered durable events and the
 * active-history boundary used for replay and resume.
 */

import type { Message } from "./message.js"
import type { SettleReason, StopReason, UsageStats } from "./completion.js"
import type { Awaitable } from "./tool.js"

/** Aggregate totals at run end. Excludes history/steps — those are
 *  replayable via the journal or carried on EngineResult's TReturn. */
export interface RunTotals {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  compactionCount: number
}

/**
 * Lean durable journal events written by the engine and hydrate helpers.
 *
 * Only replay-relevant content and small, non-duplicative operational
 * metadata belong here. Transient observer/UI events do not. In
 * particular, content that already appears in `message` events (model
 * reasoning, assistant text, tool calls, tool results) must not be
 * journaled again under a second event shape.
 */
export type JournalEvent =
  | { type: "message"; message: Message }
  | {
      type: "turn_end"
      turn: number
      usage: UsageStats
      stopReason: StopReason
    }
  | { type: "compaction_start"; turn: number; historyLength: number }
  | { type: "compaction_end"; turn: number; usage: UsageStats }
  | { type: "cutoff"; turn: number; count: number }
  | { type: "warning"; turn: number; message: string }
  | { type: "error"; turn: number; message: string }
  | { type: "run_end"; settleReason: SettleReason; totals: RunTotals }

export const JournalEvent = {
  message(message: Message): JournalEvent {
    return { type: "message", message }
  },
  turnEnd(
    turn: number,
    usage: UsageStats,
    stopReason: StopReason,
  ): JournalEvent {
    return { type: "turn_end", turn, usage, stopReason }
  },
  compactionStart(turn: number, historyLength: number): JournalEvent {
    return { type: "compaction_start", turn, historyLength }
  },
  compactionEnd(turn: number, usage: UsageStats): JournalEvent {
    return { type: "compaction_end", turn, usage }
  },
  cutoff(turn: number, count: number): JournalEvent {
    return { type: "cutoff", turn, count }
  },
  warning(turn: number, message: string): JournalEvent {
    return { type: "warning", turn, message }
  },
  error(turn: number, message: string): JournalEvent {
    return { type: "error", turn, message }
  },
  runEnd(settleReason: SettleReason, totals: RunTotals): JournalEvent {
    return { type: "run_end", settleReason, totals }
  },
} as const

/**
 * Sink invoked by `Journal.scan()`.
 *
 * Return `true` to stop scanning early. Any other return value keeps
 * scanning.
 */
export type JournalSink = (event: JournalEvent) => Awaitable<boolean | void>

/**
 * Ordered durable event history for replay, audit, and resume.
 * Implementations may be fs-backed, in-memory, remote, or custom.
 */
export abstract class Journal {
  /** Stable unique ID for this journal. */
  abstract readonly id: string
  /** Implementation discriminator. */
  abstract readonly kind: string

  /** Append an event to the journal. */
  abstract event(event: JournalEvent): Promise<void>

  /**
   * Mark the current active slice as a durable resume point.
   *
   * Semantically: when this resolves, all events appended before the
   * call are on stable storage; a crash afterward can recover from
   * this point. The engine calls `commit()` at natural checkpoints
   * (turn_end, run_end) so resume lands at a coherent boundary.
   *
   * Implementations may no-op when their `event()` path is already
   * synchronous-on-disk, or when durability isn't a concern (memory
   * journal). Implementations that buffer appends must flush here.
   */
  async commit(): Promise<void> {}

  /**
   * Scan events from the latest partition forward — the active
   * conversation visible to resume and the runtime. The sink may stop
   * early by returning `true`.
   *
   * Implementations may invoke the sink for a valid prefix and then
   * throw later if a subsequent record is malformed. Callers must treat
   * a thrown scan as "history is not trustworthy", even if they already
   * observed earlier events.
   */
  abstract scan(onEvent: JournalSink): Promise<void>

  /**
   * Advance the active-history boundary.
   *
   * When `nextEvents` is empty, subsequent calls to `scan()` observe
   * an empty active slice. When `nextEvents` is provided, the
   * replacement slice is published atomically: readers observe either
   * the old active slice or the full replacement slice, never a
   * partially written handoff.
   */
  abstract partition(
    reason: string,
    nextEvents?: readonly JournalEvent[],
  ): Promise<void>
}
