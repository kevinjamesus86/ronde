//#region packages/core/src/tool.d.ts
/**
 * @module
 * Shared type aliases and interfaces used across modules.
 */
/** A tool call produced by the model. */
interface ToolCall {
    /** Provider-assigned identifier correlating the call to its result. */
    toolUseId: string;
    name: string;
    arguments: Record<string, unknown>;
}
/** The observable outcome of a tool call. */
interface ToolResult {
    ok: boolean;
    /** Formatted content the model sees. */
    content: string;
}
/**
 * Accept a const enum value OR its underlying string literal.
 * Lets consumers write `"low"` instead of `Effort.Low`.
 */
type Lax<E extends string> = E | `${E}`;
type Awaitable<T> = T | PromiseLike<T>;
//#endregion
//#region packages/core/src/message.d.ts
/**
 * @module
 * Canonical message types, parts, constructors, and utility types.
 *
 * A Message is a batch of parts that commit together — the atomic
 * unit of journal durability. Role is not carried on the Message
 * itself because a single durable unit may legitimately contain
 * contributions from multiple roles (e.g. a tool_use + tool_result
 * pair). Role lives on the parts:
 *
 * - `TextPart`        — explicit `role` field (user/assistant/system/developer)
 * - `ThinkingPart`    — implicit: always assistant (only the model produces reasoning)
 * - `ToolCallPart`    — implicit: always assistant (only the model invokes tools)
 * - `ToolResultPart`  — implicit: always user (tool outputs flow back to the model)
 *
 * Use `partRole(part)` to get a part's effective role.
 */
declare enum Role {
    User = "user",
    Assistant = "assistant",
    System = "system",
    Developer = "developer"
}
declare enum MessageType {
    Text = "text",
    Think = "think",
    ToolUse = "tool_call",
    ToolResult = "tool_result"
}
/** Plain text content. Role is explicit because text can come from any role. */
interface TextPart {
    type: MessageType.Text;
    role: Role;
    content: string;
    meta?: unknown;
}
/** Reasoning/thinking content from the model. Implicitly assistant-role. */
interface ThinkingPart {
    type: MessageType.Think;
    content: string;
    meta?: unknown;
}
/** A tool invocation from the model. Implicitly assistant-role. */
interface ToolCallPart {
    type: MessageType.ToolUse;
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    meta?: unknown;
}
/** The result of a tool invocation, sent back to the model. Implicitly user-role. */
interface ToolResultPart {
    type: MessageType.ToolResult;
    toolCallId: string;
    ok: boolean;
    content: string;
    meta?: unknown;
}
type MessagePart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart;
/**
 * A message — a batch of parts that durably commit together. Parts
 * carry role individually; a single message can span multiple roles.
 */
interface Message {
    parts: MessagePart[];
    /** Provider response ID (Anthropic msg id, OpenAI response id, etc). */
    id?: string;
}
declare function userMessage(content: string, meta?: unknown): Message;
declare function assistantMessage(parts: MessagePart[], id?: string): Message;
declare function toolResultMessage(toolCallId: string, ok: boolean, content: string, meta?: unknown): Message;
declare function textPart(role: Role, content: string, meta?: unknown): TextPart;
declare function thinkingPart(content: string, meta?: unknown): ThinkingPart;
declare function toolCallPart(opts: {
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    meta?: unknown;
}): ToolCallPart;
declare function toolResultPart(opts: {
    toolCallId: string;
    ok: boolean;
    content: string;
    meta?: unknown;
}): ToolResultPart;
//#endregion
//#region packages/core/src/completion.d.ts
/** Completion mode — controls thinking behavior. */
declare enum CompletionMode {
    Agentic = "agentic",
    Structured = "structured",
    /** Compaction mode — no thinking replay. */
    Compaction = "compaction"
}
/** Why the model stopped generating. */
declare enum StopReason {
    EndTurn = "end_turn",
    ToolUse = "tool_use",
    MaxTokens = "max_tokens",
    Refusal = "refusal",
    PauseTurn = "pause_turn",
    ContextWindow = "context_window",
    Unknown = "unknown"
}
/** Why the agent loop settled — a StopReason from the model, or an
 *  engine-owned reason like `"max_turns"` / `"aborted"`. */
type SettleReason = StopReason | "max_turns" | "aborted" | "compaction_failed" | "cutoff_breaker";
/** Reasoning effort level. Mapped to provider-specific values. */
declare enum Effort {
    Low = "low",
    Med = "med",
    High = "high",
    XHigh = "xhigh"
}
/** JSON Schema definition for a tool's parameters. */
interface ToolSchema {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    strict?: boolean;
}
interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
    reasoningTokens: number;
}
/** A warning emitted by a provider for an unsupported feature. */
interface CompletionWarning {
    type: "unsupported";
    feature: string;
    details?: string;
}
interface CompletionRequest {
    model: string;
    system?: string;
    messages: Message[];
    tools: ToolSchema[];
    mode: Lax<CompletionMode>;
    effort: Lax<Effort> | null;
    maxOutputTokens: number;
    providerOptions?: Record<string, unknown>;
    signal?: AbortSignal;
}
interface CompletionResponse {
    messages: Message[];
    stopReason: StopReason;
    usage: UsageStats;
    providerMeta: unknown;
    warnings: CompletionWarning[];
}
/** Live chunk from a streaming backend. Tagged by `kind`. */
type CompletionDelta = {
    kind: "text_delta";
    content: string;
} | {
    kind: "thinking_delta";
    content: string;
} | {
    kind: "tool_input_delta";
    toolCallId: string;
    chunk: string;
};
interface CompletionBackend {
    readonly specVersion: "v1";
    complete(request: CompletionRequest): Promise<CompletionResponse> | AsyncGenerator<CompletionDelta, CompletionResponse, void>;
}
declare const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
declare const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
/** Classified error kinds from completion backends. */
declare enum CompletionErrorKind {
    RateLimit = "rate_limit",
    ServerError = "server_error",
    NetworkError = "network_error",
    ContextLengthExceeded = "context_length_exceeded",
    ContentFiltered = "content_filtered",
    AuthError = "auth_error",
    InvalidRequest = "invalid_request",
    Aborted = "aborted",
    Unknown = "unknown"
}
/** Normalized error from any completion backend. */
declare class CompletionError extends Error {
    readonly kind: CompletionErrorKind;
    readonly statusCode: number | null;
    readonly retryable: boolean;
    constructor(kind: CompletionErrorKind, message: string, opts?: {
        statusCode?: number;
        cause?: unknown;
    });
}
interface ResolvedBackendConfig {
    model: string;
    effort: Lax<Effort> | null;
    contextWindowTokens: number;
    maxOutputTokens: number;
}
/**
 * A CompletionBackend that carries its resolved configuration.
 * The agent loop reads model/effort/budgets from `config`.
 */
interface ConfiguredBackend extends CompletionBackend {
    config: ResolvedBackendConfig;
}
//#endregion
export { toolResultPart as A, ToolCallPart as C, thinkingPart as D, textPart as E, ToolResult as F, Awaitable as M, Lax as N, toolCallPart as O, ToolCall as P, ThinkingPart as S, assistantMessage as T, Message as _, CompletionRequest as a, Role as b, ConfiguredBackend as c, Effort as d, ResolvedBackendConfig as f, UsageStats as g, ToolSchema as h, CompletionMode as i, userMessage as j, toolResultMessage as k, DEFAULT_CONTEXT_WINDOW_TOKENS as l, StopReason as m, CompletionError as n, CompletionResponse as o, SettleReason as p, CompletionErrorKind as r, CompletionWarning as s, CompletionBackend as t, DEFAULT_MAX_OUTPUT_TOKENS as u, MessagePart as v, ToolResultPart as w, TextPart as x, MessageType as y };
//# sourceMappingURL=completion-D7rwko-L.d.mts.map
