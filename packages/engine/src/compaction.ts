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
  system?: string
  history: Message[]
  maxOutput: number
  signal?: AbortSignal
}

export type CompactionResult =
  | {
      kind: "compacted"
      summary: Message
      usage: UsageStats
    }
  | {
      kind: "not_compacted"
      usage: UsageStats
    }

export interface CompactionStrategy {
  compact(context: CompactionContext): Promise<CompactionResult>
}
