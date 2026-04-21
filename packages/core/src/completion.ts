/**
 * @module
 * Completion backend interfaces, request/response types.
 */
import type { Lax } from "./tool.js"
import type { Message } from "./message.js"

/** Why the model stopped generating. */
export const enum StopReason {
  EndTurn = "end_turn",
  ToolUse = "tool_use",
  MaxTokens = "max_tokens",
  Refusal = "refusal",
  PauseTurn = "pause_turn",
  ContextWindow = "context_window",
  Unknown = "unknown",
}

/** Why the agent loop settled — a StopReason from the model, or an
 *  engine-owned reason like `"max_turns"` / `"aborted"`. */
export type SettleReason =
  | StopReason
  | "max_turns"
  | "aborted"
  | "compaction_failed"
  | "cutoff_breaker"

/** Reasoning effort level. Mapped to provider-specific values. */
export const enum Effort {
  Low = "low",
  Med = "med",
  High = "high",
  XHigh = "xhigh",
}

/** JSON Schema definition for a tool's parameters. */
export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  strict?: boolean
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  reasoningTokens: number
}

export const EMPTY_USAGE: Readonly<UsageStats> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  reasoningTokens: 0,
})

export function emptyUsage(): UsageStats {
  return EMPTY_USAGE
}

/** A warning emitted by a provider for an unsupported feature. */
export interface CompletionWarning {
  type: "unsupported"
  feature: string
  details?: string
}

export interface CompletionRequest {
  model: string
  system?: string
  messages: Message[]
  tools: ToolSchema[]
  effort?: Lax<Effort>
  maxOutput: number
  providerOptions?: Record<string, unknown>
  signal?: AbortSignal
}

export interface CompletionResponse {
  messages: Message[]
  stopReason: StopReason
  usage: UsageStats
  providerMeta: unknown
  warnings: CompletionWarning[]
}

/** Live chunk from a streaming backend. Tagged by `kind`. */
export type CompletionDelta =
  | { kind: "text_delta"; content: string }
  | { kind: "thinking_delta"; content: string }
  | { kind: "tool_input_delta"; toolCallId: string; chunk: string }

export interface CompletionBackend {
  readonly specVersion: "v1"
  complete(
    request: CompletionRequest,
  ):
    | Promise<CompletionResponse>
    | AsyncGenerator<CompletionDelta, CompletionResponse, void>
}

/** Classified error kinds from completion backends. */
export const enum CompletionErrorKind {
  RateLimit = "rate_limit",
  ServerError = "server_error",
  NetworkError = "network_error",
  ContextLengthExceeded = "context_length_exceeded",
  ContentFiltered = "content_filtered",
  AuthError = "auth_error",
  InvalidRequest = "invalid_request",
  Aborted = "aborted",
  Unknown = "unknown",
}

const TRANSIENT_ERROR_KINDS = new Set<CompletionErrorKind>([
  CompletionErrorKind.RateLimit,
  CompletionErrorKind.ServerError,
  CompletionErrorKind.NetworkError,
])

/** Normalized error from any completion backend. */
export class CompletionError extends Error {
  readonly kind: CompletionErrorKind
  readonly statusCode: number | undefined
  readonly retryable: boolean

  constructor(
    kind: CompletionErrorKind,
    message: string,
    opts?: {
      statusCode?: number
      cause?: unknown
    },
  ) {
    super(message, { cause: opts?.cause })
    this.name = "CompletionError"
    this.kind = kind
    this.statusCode = opts?.statusCode
    this.retryable = TRANSIENT_ERROR_KINDS.has(kind)
  }
}

export interface ResolvedBackendConfig {
  model: string
  effort?: Lax<Effort>
  maxContext: number
  maxOutput: number
}

/**
 * A CompletionBackend that carries its resolved configuration.
 * The agent loop reads model/effort/budgets from `config`.
 */
export interface ConfiguredBackend extends CompletionBackend {
  config: ResolvedBackendConfig
}
