import { CompletionMode } from "@ronde/core/completion"
import type { Lax } from "@ronde/core"

export function normalizeCompletionMode(
  mode: Lax<CompletionMode>,
): CompletionMode {
  switch (mode) {
    case CompletionMode.Agentic:
    case CompletionMode.Structured:
    case CompletionMode.Compaction:
      return mode as CompletionMode
    default:
      return CompletionMode.Agentic
  }
}

export function modeWantsThoughtText(mode: Lax<CompletionMode>): boolean {
  return mode === CompletionMode.Agentic
}

export function modeWantsThoughtReplay(mode: Lax<CompletionMode>): boolean {
  return mode !== CompletionMode.Compaction
}
