import type {
  CompletionBackend,
  Effort,
  UsageStats,
} from "@ronde/core/completion"
import type { Message } from "@ronde/core/message"
import type { Lax } from "@ronde/core"

export interface CompactionContext {
  backend: CompletionBackend
  model: string
  effort?: Lax<Effort>
  history: Message[]
  maxOutput: number
  signal?: AbortSignal
}

export type CompactionResult =
  | {
      kind: "compacted"
      summary: Message
      // Messages the strategy couldn't fit in its compaction call.
      // The engine replays these verbatim alongside the summary so
      // retry-shrink never silently loses history.
      deferred: Message[]
      usage: UsageStats
    }
  | {
      kind: "not_compacted"
      usage: UsageStats
    }

export interface CompactionStrategy {
  compact(context: CompactionContext): Promise<CompactionResult>
}
