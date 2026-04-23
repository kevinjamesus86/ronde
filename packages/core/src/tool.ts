/**
 * @module
 * Shared type aliases and interfaces used across modules.
 */

/** A tool call produced by the model. */
export interface ToolCall {
  /** Provider-assigned identifier correlating the call to its result. */
  toolUseId: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * Accept a const enum value OR its underlying string literal.
 * Lets consumers write `"low"` instead of `Effort.Low`.
 */
export type Lax<E extends string> = E | `${E}`

export type Awaitable<T> = T | PromiseLike<T>
