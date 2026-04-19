/**
 * @module
 * Shared helpers for provider implementations.
 */
import type { CompletionWarning } from "@ronde/core/completion"

export function mapEffort<T>(
  effort: string | null | undefined,
  table: Record<string, T>,
): T | null {
  if (!effort) {
    return null
  }
  return table[effort] ?? null
}

export function unsupported(
  feature: string,
  details?: string,
): CompletionWarning {
  return { type: "unsupported", feature, details }
}
