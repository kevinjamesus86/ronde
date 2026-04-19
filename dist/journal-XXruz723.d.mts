import { M as Awaitable, _ as Message, g as UsageStats, m as StopReason, p as SettleReason } from "./completion-D7rwko-L.mjs";

//#region packages/core/src/journal.d.ts
/** Aggregate totals at run end. Excludes history/steps — those are
 *  replayable via the journal or carried on EngineResult's TReturn. */
interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  compactionCount: number;
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
type JournalEvent = {
  type: "message";
  message: Message;
} | {
  type: "turn_end";
  turn: number;
  usage: UsageStats;
  stopReason: StopReason;
} | {
  type: "compaction_start";
  turn: number;
  historyLength: number;
} | {
  type: "compaction_end";
  turn: number;
  usage: UsageStats;
} | {
  type: "cutoff";
  turn: number;
  count: number;
} | {
  type: "warning";
  turn: number;
  message: string;
} | {
  type: "error";
  turn: number;
  message: string;
} | {
  type: "run_end";
  settleReason: SettleReason;
  totals: RunTotals;
};
declare const JournalEvent: {
  readonly message: (message: Message) => JournalEvent;
  readonly turnEnd: (turn: number, usage: UsageStats, stopReason: StopReason) => JournalEvent;
  readonly compactionStart: (turn: number, historyLength: number) => JournalEvent;
  readonly compactionEnd: (turn: number, usage: UsageStats) => JournalEvent;
  readonly cutoff: (turn: number, count: number) => JournalEvent;
  readonly warning: (turn: number, message: string) => JournalEvent;
  readonly error: (turn: number, message: string) => JournalEvent;
  readonly runEnd: (settleReason: SettleReason, totals: RunTotals) => JournalEvent;
};
/**
 * Sink invoked by `Journal.scan()`.
 *
 * Return `true` to stop scanning early. Any other return value keeps
 * scanning.
 */
type JournalSink = (event: JournalEvent) => Awaitable<boolean | void>;
/**
 * Ordered durable event history for replay, audit, and resume.
 * Implementations may be fs-backed, in-memory, remote, or custom.
 */
declare abstract class Journal {
  /** Stable unique ID for this journal. */
  abstract readonly id: string;
  /** Implementation discriminator. */
  abstract readonly kind: string;
  /** Append an event to the journal. */
  abstract event(event: JournalEvent): Promise<void>;
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
  commit(): Promise<void>;
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
  abstract scan(onEvent: JournalSink): Promise<void>;
  /**
   * Advance the active-history boundary.
   *
   * When `nextEvents` is empty, subsequent calls to `scan()` observe
   * an empty active slice. When `nextEvents` is provided, the
   * replacement slice is published atomically: readers observe either
   * the old active slice or the full replacement slice, never a
   * partially written handoff.
   */
  abstract partition(reason: string, nextEvents?: readonly JournalEvent[]): Promise<void>;
}
//#endregion
export { RunTotals as i, JournalEvent as n, JournalSink as r, Journal as t };
//# sourceMappingURL=journal-XXruz723.d.mts.map