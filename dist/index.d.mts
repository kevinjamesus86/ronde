import { z } from "zod/v4";
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
//#region packages/core/src/result.d.ts
/**
 * @module
 * Discriminated result type with `ok()` and `err()` constructors.
 *
 * @example
 * ```ts
 * import { ok, err } from "@ronde/core/result"
 *
 * fetchWeather(city).then(ok).catch(err)
 * ```
 */
type Result<D = unknown> = {
    ok: true;
    data: D;
} | {
    ok: false;
    error: string;
    data?: D;
};
declare function ok<D>(data: D): Result<D> & {
    ok: true;
};
/** Construct a failure result. Accepts a string or Error. */
declare function err(error: string | Error): Result<never> & {
    ok: false;
};
declare function err<D>(error: string | Error, data: D): Result<D> & {
    ok: false;
};
declare function isOk<D>(r: Result<D>): r is Result<D> & {
    ok: true;
};
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
/**
 * The effective role of a part. Text carries role explicitly;
 * everything else is fixed by part type.
 */
declare function partRole(part: MessagePart): Role;
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
declare const EMPTY_USAGE: Readonly<UsageStats>;
declare function emptyUsage(): UsageStats;
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
    effort?: Lax<Effort>;
    maxOutput: number;
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
    readonly statusCode: number | undefined;
    readonly retryable: boolean;
    constructor(kind: CompletionErrorKind, message: string, opts?: {
        statusCode?: number;
        cause?: unknown;
    });
}
interface ResolvedBackendConfig {
    model: string;
    effort?: Lax<Effort>;
    maxContext: number;
    maxOutput: number;
}
/**
 * A CompletionBackend that carries its resolved configuration.
 * The agent loop reads model/effort/budgets from `config`.
 */
interface ConfiguredBackend extends CompletionBackend {
    config: ResolvedBackendConfig;
}
//#endregion
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
//#region packages/core/src/workspace.d.ts
/**
 * @module
 * Workspace primitive. A Workspace owns artifact spill URIs and
 * run-associated resources.
 */
interface SpillOpts {
    /** Filename stem or resource label. Default: `"spill"`. */
    name?: string;
}
interface SpillResult {
    /** Opaque URI for the full content. */
    uri: string;
    bytes: number;
}
/** Spill result for workspaces that persist content to a local path. */
interface PathSpillResult extends SpillResult {
    path: string;
}
/**
 * Base workspace abstraction. Portable tools should target this
 * interface and rely on `spill()` for artifact persistence.
 */
declare abstract class Workspace<R extends SpillResult = SpillResult> {
    /** Stable unique ID shared with the paired journal when applicable. */
    abstract readonly id: string;
    abstract readonly kind: string;
    /** Persist content and return a URI. */
    abstract spill(content: string, opts?: SpillOpts): Promise<R>;
}
/**
 * Workspace capability for backends that expose a concrete directory
 * and pathful spill results.
 */
declare abstract class DirectoryWorkspace extends Workspace<PathSpillResult> {
    abstract readonly dir: string;
}
declare function isDirectoryWorkspace(workspace: Workspace): workspace is DirectoryWorkspace;
/**
 * Sanitize a filename base for fs use. Replaces characters reserved
 * by Windows or POSIX, plus control characters, with `_`. Trims
 * leading/trailing `_`. Caps at `max` chars. Returns empty string
 * if the input sanitizes to nothing — callers must handle that.
 */
declare function sanitizeFilename(s: string, max?: number): string;
//#endregion
//#region packages/core/src/runtime.d.ts
/**
 * Coherent durable runtime pair. The engine only consumes these two
 * primitives; managed wrappers may extend the shape structurally.
 */
interface Runtime<W extends Workspace = Workspace> {
    journal: Journal;
    workspace: W;
}
//#endregion
//#region packages/core/src/toolkit.d.ts
/** Default inline-output budget (characters) before the framework spills and truncates. */
declare const DEFAULT_MAX_INLINE = 25000;
type ToolOutput<D = unknown> = Result<D>;
/** Tool execute may return a Promise or an AsyncGenerator whose
 *  yields are textual progress deltas and whose return is the output. */
type ToolExecuteReturn<D = unknown> = Promise<ToolOutput<D>> | AsyncGenerator<string, ToolOutput<D>, void>;
interface ToolContext<W extends Workspace = Workspace> {
    turn: number;
    abort: AbortSignal;
    messages: readonly Message[];
    workspace: W;
    call: ToolCall;
}
interface StatefulToolContext<S, W extends Workspace = Workspace> extends ToolContext<W> {
    /** Per-tool managed state, lazily initialized from `state.init`. */
    state: S;
}
/** Dispatches a tool call by name. Can be local, remote, or lazy. */
type ToolExecutor<W extends Workspace = Workspace> = (name: string, args: Record<string, unknown>, ctx: ToolContext<W>) => ToolExecuteReturn;
/** Converts structured tool data into the string the model sees. */
type ToolFormatterFn = (data: unknown) => string;
/**
 * How the framework cuts oversized formatted tool output before sending
 * to the model. The full output is spilled to the workspace either way;
 * this governs which slice of it survives inline.
 *
 * - `head`   — keep the beginning, drop the tail. Default.
 * - `tail`   — keep the end, drop the head.
 * - `middle` — keep beginning + end, drop the middle.
 */
type TruncateStrategy = "head" | "tail" | "middle";
interface Toolkit<W extends Workspace = Workspace> {
    schemas: ToolSchema[];
    execute: ToolExecutor<W>;
    formatters: Record<string, ToolFormatterFn>;
    /**
     * Per-tool truncation strategy. Missing entries default to `"head"`
     * when read by the framework. Hand-built toolkits may omit this.
     */
    truncate?: Record<string, TruncateStrategy>;
    dispose?: () => Promise<void>;
}
/**
 * Bind a toolkit to a fresh runtime instance. Toolkits created by `tool()`
 * and `merge()` expose an internal runtime factory so each engine execution
 * gets isolated stateful tool cells. Hand-built toolkits fall back to
 * themselves and remain responsible for any lifecycle they implement.
 */
declare function bindToolkitRuntime<W extends Workspace = Workspace>(toolkit: Toolkit<W>): Toolkit<W>;
/** Default formatter: returns error string, passes through strings, JSON.stringify for objects. */
declare function defaultFormatter(_toolName: string, output: ToolOutput): string;
/**
 * Context for framework-level truncation. When passed, `formatToolOutput`
 * checks the rendered string against `maxInline` and, if over, spills the
 * full content to the workspace and returns a truncated slice with a
 * neutral hint appended. The slice strategy comes from the toolkit's
 * declared `truncate` map (defaulting to `"head"`).
 */
interface FormatContext {
    workspace: Workspace;
    /** Used to derive the spill filename: `<toolName>-<toolUseId>`. */
    toolUseId: string;
    /** Inline character budget. Defaults to {@link DEFAULT_MAX_INLINE}. */
    maxInline?: number;
}
/**
 * Resolve the formatted string for a tool output. When `ctx` is supplied,
 * the framework additionally enforces an inline size budget: oversized
 * output is spilled to the workspace and replaced with a size-strategy
 * slice plus a neutral hint. When `ctx` is omitted (tests, non-engine
 * callers), the function just renders — no spill, no size check.
 */
declare function formatToolOutput(toolkit: Toolkit<any>, toolName: string, output: ToolOutput, ctx?: FormatContext): Promise<string>;
/** State lifecycle for stateful tools. */
interface StateConfig<S> {
    /** Called lazily on first tool invocation. Can be async (e.g. DB pool). */
    init: () => Awaitable<S>;
    /** Called when the owning runtime instance is disposed. Errors are swallowed. */
    dispose?: (state: S) => Awaitable<void>;
}
interface ToolDefBase {
    name: string;
    description: string;
    strict?: boolean;
}
/**
 * Define a single tool. Returns a Toolkit containing just this tool.
 *
 * **Stateless** — args inferred from Zod schema:
 * ```
 * tool({
 *   parameters: z.object({ city: z.string() }),
 *   execute: async (args) => ok({ city: args.city }),
 * })
 * ```
 *
 * **Stateful** — add `state`, S inferred from `init` return:
 * ```
 * tool({
 *   parameters: z.object({ command: z.string() }),
 *   state: { init: () => ({ cwd: "/" }) },
 *   execute: async (args, ctx) => ok({ cwd: ctx.state.cwd }),
 * })
 * ```
 *
 * **Workspace-pinned** — curry with W, everything else inferred:
 * ```
 * tool<FsWorkspace>()({
 *   parameters: z.object({ path: z.string() }),
 *   execute: async (args, ctx) => ok({ dir: ctx.workspace.dir }),
 * })
 * ```
 */
type ExecuteFn<Args, Ctx, D> = (args: Args, ctx: Ctx) => Awaitable<ToolOutput<D>> | AsyncGenerator<string, ToolOutput<D>, void>;
declare function tool<T extends z.ZodType, D = unknown>(def: ToolDefBase & {
    parameters: T;
    state?: undefined;
    execute: ExecuteFn<z.infer<T>, ToolContext, D>;
    format?: (data: D) => string;
    truncate?: TruncateStrategy;
}): Toolkit;
declare function tool<S, T extends z.ZodType, D = unknown>(def: ToolDefBase & {
    parameters: T;
    state: StateConfig<S>;
    execute: ExecuteFn<z.infer<T>, StatefulToolContext<S>, D>;
    format?: (data: D) => string;
    truncate?: TruncateStrategy;
}): Toolkit;
declare function tool<W extends Workspace>(): {
    <T extends z.ZodType, D = unknown>(def: ToolDefBase & {
        parameters: T;
        state?: undefined;
        execute: ExecuteFn<z.infer<T>, ToolContext<W>, D>;
        format?: (data: D) => string;
        truncate?: TruncateStrategy;
    }): Toolkit<W>;
    <S, T extends z.ZodType, D = unknown>(def: ToolDefBase & {
        parameters: T;
        state: StateConfig<S>;
        execute: ExecuteFn<z.infer<T>, StatefulToolContext<S, W>, D>;
        format?: (data: D) => string;
        truncate?: TruncateStrategy;
    }): Toolkit<W>;
};
/**
 * Merge multiple toolkits into one. Later toolkits override
 * earlier ones on name collision (schemas, formatters).
 * Dispose calls all child dispose functions.
 */
type WorkspaceOf<T> = T extends Toolkit<infer W> ? W : never;
type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends ((arg: infer I) => void) ? I : never;
type MergedWorkspace<T extends readonly Toolkit<any>[]> = UnionToIntersection<WorkspaceOf<T[number]>> & Workspace;
declare function merge<T extends readonly Toolkit<any>[]>(...toolkits: T): Toolkit<MergedWorkspace<T>>;
//#endregion
//#region packages/core/src/stream.d.ts
/**
 * @module
 * Async stream primitives — Promise-or-AsyncGenerator detection and
 * normalization for tool `execute` and backend `complete`.
 */
declare function isAsyncGenerator<Y = unknown, R = unknown, N = unknown>(x: unknown): x is AsyncGenerator<Y, R, N>;
/** Normalize a Promise-or-AsyncGenerator into a generator. A Promise becomes a zero-yield generator; a generator passes through. */
declare function asGenerator<Y, R>(ret: Promise<R> | AsyncGenerator<Y, R, void>): AsyncGenerator<Y, R, void>;
/** Drain a Promise-or-AsyncGenerator, discarding yields, returning the final value. */
declare function drain<Y, R>(ret: Promise<R> | AsyncGenerator<Y, R, void>): Promise<R>;
//#endregion
//#region packages/core/src/tokens.d.ts
declare function estimateTokens(input: string | unknown): number;
//#endregion
//#region packages/core/src/bytes.d.ts
/**
 * @module
 * Platform-agnostic UTF-8 byte counting. Uses `TextEncoder` so it runs
 * in Node, browsers, Deno, and workers alike. Shared buffer avoids
 * per-call allocation — strings larger than the buffer loop through it.
 */
/** UTF-8 byte length of `str`. */
declare function utf8ByteLength(str: string): number;
//#endregion
//#region packages/core/src/id.d.ts
/** Random hex string. `bytes` random bytes → 2×bytes hex chars. */
declare function genHex(bytes?: number): string;
/** Sortable id: `<prefix>-<base36 time>_<hex>`. */
declare function genId(prefix: string): string;
//#endregion
//#region packages/backend/src/errors.d.ts
declare function classifyError(statusCode: number | undefined, message: string): CompletionErrorKind;
/**
 * Wrap a raw SDK error into a CompletionError, extracting status from
 * common SDK shapes (`status`, `statusCode`, numeric `code`) and
 * preferring nested `error.message` over the outer message.
 */
declare function wrapSdkError(err: unknown): CompletionError;
//#endregion
//#region packages/backend/src/shared.d.ts
type NormalizedPart<M> = MessagePart & {
    meta?: M;
};
interface NormalizedMessage<M> {
    parts: NormalizedPart<M>[];
    id?: string;
}
/**
 * Canonicalize message history for a specific provider. After this
 * pass, every part's meta is either the provider's own type or absent.
 *
 * - Own meta → passed through untouched
 * - Foreign thinking → dropped (reasoning traces stay private)
 * - Foreign text / tool call / tool result → meta stripped; content kept
 */
declare function canonicalize<M>(messages: Message[], isOwn: (meta: unknown) => meta is M): NormalizedMessage<M>[];
/**
 * Bucket parts into role-tagged messages for providers that require
 * role-at-message-level on the wire (Anthropic, Gemini). Role is
 * resolved per-part via `partRole()`.
 *
 * Tool_use and tool_result parts pool across consecutive messages and
 * flush together when a non-tool part arrives or the walk ends —
 * pooled tool_uses land in one assistant bucket, pooled tool_results
 * in one user bucket. This restores the batched wire shape the model
 * originally produced even though canonical history stores each tool
 * as its own pair message for atomic durability.
 */
declare function coalesceByRole<M, T>(messages: NormalizedMessage<M>[], mapRole: (role: Role) => string, serializePart: (part: NormalizedPart<M>) => T | undefined): Array<{
    role: string;
    parts: T[];
}>;
//#endregion
//#region packages/backend/src/retry.d.ts
interface RetryAttempt {
    attempt: number;
    maxRetries: number;
    error: CompletionError;
    delayMs: number;
}
interface RetryOptions {
    /** Default: 5. */
    maxRetries?: number;
    /** Default: 30_000. */
    maxDelayMs?: number;
    /** Invoked before each backoff sleep. Silent by default. */
    onRetry?: (event: RetryAttempt) => void;
}
/**
 * Retry decorator over `ConfiguredBackend`. Retries errors where
 * `retryable` is true with exponential backoff + jitter; other errors
 * propagate untouched. Abort signals cancel the in-flight attempt and
 * short-circuit any pending backoff.
 *
 * Streams are drained into a single `CompletionResponse` before returning
 * — mid-stream failures are retryable, but the caller sees no partial
 * events across attempts.
 */
declare class RetryingBackend implements ConfiguredBackend {
    readonly specVersion: "v1";
    private inner;
    private maxRetries;
    private maxDelayMs;
    private onRetry?;
    readonly config: ResolvedBackendConfig;
    constructor(inner: ConfiguredBackend, options?: RetryOptions);
    complete(request: CompletionRequest): Promise<CompletionResponse>;
}
declare function withRetry(backend: ConfiguredBackend, options?: RetryOptions): ConfiguredBackend;
//#endregion
//#region packages/backend/src/defaults.d.ts
/**
 * @module
 * Framework-default budgets applied by adapter layers when the caller
 * doesn't specify their own. See `createBackend` and `fromAiSdk`.
 */
/**
 * Default `maxContext` ceiling when a caller doesn't supply one.
 * Safe floor across major reasoning models as of 2026 — below the
 * 1M-context frontier (Claude 4.6+, GPT-5.4 extended, Gemini 2.0),
 * above the 272K / 200K smaller-window models (GPT-5.4 standard,
 * Gemini 3 Flash).
 */
declare const DEFAULT_MAX_CONTEXT = 400000;
/**
 * Default `maxOutput` ceiling when a caller doesn't supply one.
 * Broadest-compatibility output cap: matches Claude Opus 4.7 standard
 * (exactly 32K), clamps under Sonnet 4.6 (64K) and GPT-5.4 (128K),
 * stays within Gemini Flash's 8-32K output range.
 */
declare const DEFAULT_MAX_OUTPUT = 32000;
//#endregion
//#region packages/engine/src/compaction.d.ts
interface CompactionContext {
    backend: CompletionBackend;
    model: string;
    effort?: Lax<Effort>;
    history: Message[];
    maxOutput: number;
    signal?: AbortSignal;
}
type CompactionResult = {
    kind: "compacted";
    summary: Message;
    deferred: Message[];
    usage: UsageStats;
} | {
    kind: "not_compacted";
    usage: UsageStats;
};
interface CompactionStrategy {
    compact(context: CompactionContext): Promise<CompactionResult>;
}
//#endregion
//#region packages/engine/src/types.d.ts
type EventVariant<Kind extends string, Type extends string, Payload extends object = {}> = Readonly<{
    kind: Kind;
    type: Type;
} & Payload>;
type Variants<Kind extends string, Events extends Record<string, object>> = {
    [Type in keyof Events & string]: EventVariant<Kind, Type, Events[Type]>;
}[keyof Events & string];
interface PreStepInput {
    turn: number;
    messages: Message[];
    toolSchemas: ToolSchema[];
    steps: readonly AgentStep[];
    usage: {
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCachedTokens: number;
    };
    budget: {
        maxContext: number;
        maxOutput: number;
    };
    compactionCount: number;
}
interface PreStepResult {
    messages?: Message[];
    toolSchemas?: ToolSchema[];
    model?: string;
    effort?: Lax<Effort>;
}
interface EngineHooks {
    approve?: (toolCall: ToolCall) => Awaitable<boolean>;
    preStep?: (input: PreStepInput) => Awaitable<PreStepResult | void>;
    postStep?: (step: AgentStep) => Awaitable<string | void>;
}
/**
 * The journal is the single source of truth for history — the engine
 * replays its active partition at startup to reconstruct `history`.
 */
interface EngineConfig<W extends Workspace = Workspace> {
    journal: Journal;
    workspace: W;
    toolkit: Toolkit<W>;
    system?: string;
    prompt?: string;
    maxTurns?: number;
    signal?: AbortSignal;
    hooks?: EngineHooks;
    compaction?: CompactionStrategy;
    /**
     * Framework truncation policy for tool-result rendering. Oversized
     * formatted output spills to the workspace and is replaced with a
     * sliced preview plus a neutral hint. See `truncate` on tool
     * definitions for per-tool slice strategy.
     */
    truncation?: {
        /** Inline character budget per tool result. Default: 25_000. */ maxInline?: number;
    };
}
interface AgentStepToolCall {
    name: string;
    args: Record<string, unknown>;
    output: ToolOutput;
}
interface AgentStep {
    turn: number;
    reasoning: string[];
    toolCalls: AgentStepToolCall[];
    text?: string;
    usage: UsageStats;
    stopReason: StopReason;
}
type EngineEventKind = "lifecycle" | "progress" | "diagnostic";
type LifecycleEvents = {
    turn_start: {
        turn: number;
    };
    turn_end: {
        turn: number;
        step: AgentStep;
    };
    compaction_start: {
        turn: number;
        historyLength: number;
    };
    compaction_end: {
        turn: number;
        usage: UsageStats;
    };
    cutoff: {
        turn: number;
        count: number;
    };
    run_end: {
        result: EngineResult;
    };
};
type ProgressEvents = {
    thinking: {
        turn: number;
        content: string;
    };
    thinking_delta: {
        turn: number;
        content: string;
    };
    text: {
        turn: number;
        content: string;
    };
    text_delta: {
        turn: number;
        content: string;
    };
    tool_call: {
        turn: number;
        call: ToolCall;
    };
    tool_delta: {
        turn: number;
        call: ToolCall;
        chunk: string;
    };
    tool_input_delta: {
        turn: number;
        toolCallId: string;
        chunk: string;
    };
    tool_result: {
        turn: number;
        call: ToolCall;
        result: ToolResult;
    };
};
type DiagnosticEvents = {
    warning: {
        turn: number;
        message: string;
    };
    error: {
        turn: number;
        message: string;
    };
};
type EngineLifecycleEvent = Variants<"lifecycle", LifecycleEvents>;
type EngineProgressEvent = Variants<"progress", ProgressEvents>;
type EngineDiagnosticEvent = Variants<"diagnostic", DiagnosticEvents>;
type EngineEvent = EngineLifecycleEvent | EngineProgressEvent | EngineDiagnosticEvent;
declare function lifecycleEvent<Type extends keyof LifecycleEvents & string>(type: Type, data: LifecycleEvents[Type]): Extract<EngineLifecycleEvent, {
    type: Type;
}>;
declare function progressEvent<Type extends keyof ProgressEvents & string>(type: Type, data: ProgressEvents[Type]): Extract<EngineProgressEvent, {
    type: Type;
}>;
declare function diagnosticEvent<Type extends keyof DiagnosticEvents & string>(type: Type, data: DiagnosticEvents[Type]): Extract<EngineDiagnosticEvent, {
    type: Type;
}>;
interface EngineResult {
    steps: AgentStep[];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    compactionCount: number;
    history: Message[];
    settleReason: SettleReason;
}
//#endregion
//#region packages/engine/src/engine.d.ts
/**
 * The agentic loop, as an async generator.
 *
 * Runs completions against `backend`, executes tool calls, compacts
 * history when the context budget tightens, and records every durable
 * event to the configured journal. Consumers drive it with `for await`:
 *
 *     const gen = engine(backend, config)
 *     let next = await gen.next()
 *     while (!next.done) {
 *       // next.value is an EngineEvent — switch on .type / .kind
 *       next = await gen.next()
 *     }
 *     const result: EngineResult = next.value
 *
 * `EngineEvent`s flow out as the yield type; `EngineResult` is the
 * generator's return (TReturn) value, available on the terminal
 * `{ done: true, value }` frame. Higher-level helpers (`drive`,
 * `runEngine`) wrap this for promise-style callers.
 *
 * ## Event taxonomy (see types.ts)
 *
 *   - lifecycle:  turn_start, turn_end, compaction_start, compaction_end,
 *                 cutoff, run_end
 *   - progress:   text, text_delta, thinking, thinking_delta, tool_call,
 *                 tool_delta, tool_input_delta, tool_result
 *   - diagnostic: warning, error
 *
 * ## Durability
 *
 * History is reconstructed on entry by replaying the journal's active
 * partition (see resume docs). Each turn commits at `turn_end`; the run
 * commits again at `run_end`. Consumers that reopen the same journal
 * after a crash pick up cleanly at the last turn boundary.
 *
 * Tool-call/tool-result pairs are journaled atomically from inside
 * `executeToolCalls` as a single `{ parts: [tool_use, tool_result] }`
 * message, so the durable record never contains an orphaned call
 * without its result.
 *
 * ## Settle reasons (EngineResult.settleReason)
 *
 *   - `StopReason.*`       — the backend reported a natural stop
 *                            (EndTurn, ContentFilter, etc.)
 *   - `"max_turns"`        — `config.maxTurns` cap reached; default 0
 *                            means no cap
 *   - `"aborted"`          — `config.signal` fired before completion
 *   - `"cutoff_breaker"`   — MAX_CONSECUTIVE_INCOMPLETE truncations
 *                            in a row
 *   - `"compaction_failed"`— compaction was needed but exhausted its
 *                            retry budget (3 consecutive failures)
 *
 * ## Hooks (config.hooks)
 *
 *   - `preStep`  — may rewrite messages, toolSchemas, model, or effort
 *                  for the next completion. Scoped to that turn only —
 *                  overrides never carry forward.
 *   - `approve`  — may veto a tool call before execution. Returning
 *                  false turns the call into an `err()` output without
 *                  running the tool.
 *   - `postStep` — may return a string to inject as a user message and
 *                  force another turn, or void to let the natural
 *                  stopReason settle the loop.
 *
 * ## Resource lifecycle
 *
 * The toolkit's runtime state is bound on entry and `dispose`'d in a
 * `finally` on exit — consumer `break`, backend throws mid-stream, hook
 * errors, and normal completion all run through the same teardown.
 * `dispose` throws are swallowed so they never mask the original error.
 *
 * @param backend  A ConfiguredBackend — model, effort, and budget are
 *                 read from `backend.config`.
 * @param config   EngineConfig; `journal` and `workspace` are required.
 */
declare function engine<W extends Workspace = Workspace>(backend: ConfiguredBackend, config: EngineConfig<W>): AsyncGenerator<EngineEvent, EngineResult, unknown>;
declare function resolveRuntimeResources<W extends Workspace>(cfg: Pick<EngineConfig<W>, "journal" | "workspace">): {
    journal: Journal;
    workspace: W;
};
//#endregion
//#region packages/providers/src/types.d.ts
interface BackendConfig {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    effort?: Lax<Effort>;
    maxContext?: number;
    maxOutput?: number;
}
interface InternalBackendConfig {
    /** True only for first-party OpenAI — gates reasoning features. */
    nativeOpenAI: boolean;
    apiKey: string;
    baseURL?: string;
}
//#endregion
//#region packages/providers/src/factory.d.ts
declare function createBackend(config: BackendConfig): ConfiguredBackend;
//#endregion
//#region packages/providers/src/registry.d.ts
interface ProviderDescriptor {
    name: string;
    /** undefined = caller must supply a baseURL. */
    defaultURL: string | undefined;
    /** null = local provider, no API key env var. */
    envVar: string | null;
    /** Defaults to `name` when omitted. */
    modelPrefix?: string;
    create(config: InternalBackendConfig): CompletionBackend;
}
declare function registerProvider(desc: ProviderDescriptor): void;
declare function getProvider(name: string): ProviderDescriptor | undefined;
declare function allProviders(): IterableIterator<ProviderDescriptor>;
//#endregion
//#region packages/tools/src/context.d.ts
type PathResult = {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
interface PathSpec {
    path: string;
    access: "r" | "rw";
}
declare function ro(p: string): PathSpec;
declare function rw(p: string): PathSpec;
/** Bare strings default to rw. Use {@link ro}/{@link rw} to be explicit. */
type RootSpec = string | PathSpec;
/**
 * Jails paths to a set of root directories. Resolves symlinks through
 * realpath before enforcing boundaries, so a symlink inside a root that
 * escapes to an outside target is rejected.
 */
declare class PathContext {
    private _roots;
    constructor(roots: RootSpec[]);
    get roots(): string[];
    get writableRoots(): string[];
    addRoot(root: RootSpec): void;
    removeRoot(root: RootSpec): void;
    cloneWithRoot(root: RootSpec): PathContext;
    /** Path is inside any declared root. */
    safePath(filePath: string, argName?: string): PathResult;
    /** Any declared root permits reads, so this is equivalent to {@link safePath}. */
    safeRead(filePath: string, argName?: string): PathResult;
    /** Path is inside an `rw` root. Read-only roots are rejected. */
    safeWrite(filePath: string, argName?: string): PathResult;
    canRead(filePath: string): boolean;
    canWrite(filePath: string): boolean;
    safeDirectoryPath(dirPath: string, argName?: string): PathResult;
    /**
     * Generate a macOS sandbox-exec profile.
     *
     * - `reads`: default `"*"` (unrestricted). `"roots"` restricts
     *   to declared roots + system paths.
     * - `writes`: default `"roots"` (restricted to rw roots).
     *   `"*"` unrestricts.
     * - `network`: default `true` (allowed). `false` denies.
     */
    sandboxProfile(options?: {
        reads?: "roots" | "*";
        writes?: "roots" | "*";
        network?: boolean;
    }): string;
    private _resolve;
    private _accessFor;
}
//#endregion
//#region packages/tools/src/read-file.d.ts
/**
 * Read a file with 1-indexed line pagination. Defaults to the first
 * {@link DEFAULT_LIMIT} lines; page larger files with `offset`/`limit`.
 * Individual lines over {@link MAX_LINE_CHARS} chars are truncated.
 */
declare const readFile: (pathCtx: PathContext) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/write-file.d.ts
/**
 * Write a file. Overwrites existing content, creates parent
 * directories, and rejects targets outside any `rw` root.
 */
declare const writeFile: (pathCtx: PathContext) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/edit-file.d.ts
/**
 * Exact string replacement. `old_string` must occur exactly once; zero
 * or multiple matches return an error rather than guessing.
 */
declare const editFile: (pathCtx: PathContext) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/glob-files.d.ts
interface GlobOptions {
    gitignore?: boolean;
}
/**
 * Find files by glob pattern. Respects `.gitignore` by default.
 */
declare const globFiles: (pathCtx: PathContext, opts?: GlobOptions) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/grep-files.d.ts
interface GrepOptions {
    gitignore?: boolean;
}
/**
 * Search file contents with a JS regex. Skips binary files and files
 * larger than {@link MAX_FILE_SIZE}. Matches are collected up to
 * {@link HARD_LIMIT} and returned grouped by file. Respects
 * `.gitignore` by default.
 */
declare const grepFiles: (pathCtx: PathContext, opts?: GrepOptions) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/list-directory.d.ts
interface ListOptions {
    gitignore?: boolean;
}
/**
 * List a directory as a tree. `depth: 1` is a flat listing; up to
 * `depth: 5` for project overviews. Respects `.gitignore` by default.
 */
declare const listDirectory: (pathCtx: PathContext, opts?: ListOptions) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/shell-snapshot.d.ts
/**
 * @module
 * Shell-state snapshotting for zsh and bash.
 *
 * A snapshot is a captured image of a login shell's state — env vars,
 * aliases, functions, and shell options — serialized to a `.sh` script
 * that downstream invocations can `source` to inherit that state
 * without re-initializing from rc files every time.
 *
 * Three primitives:
 *   - `capture(kind)`  spawns a login shell, sources rc files, and
 *                      introspects the resulting state.
 *   - `parse(output, kind)`  converts extraction stdout into a Snapshot
 *                      (exposed separately so callers can drive the
 *                      subprocess themselves — e.g. under a sandbox).
 *   - `toScript(snapshot)`  serializes a Snapshot back to a `.sh`
 *                      reconstruction script.
 */
type ShellKind = "zsh" | "bash";
interface Snapshot {
    kind: ShellKind;
    envVars: Record<string, string>;
    aliases: Record<string, string>;
    functions: Record<string, string>;
    shellOptions: string[];
}
//#endregion
//#region packages/tools/src/shell.d.ts
/** Sandbox policy for the shell subprocess. */
interface SandboxConfig {
    /** File read policy. Default: `"*"` (unrestricted). `"roots"` restricts to declared roots + system paths. */
    reads?: "roots" | "*";
    /** File write policy. Default: `"roots"` (restricted to rw roots). `"*"` unrestricts. */
    writes?: "roots" | "*";
    /** Network access. Default: true (allowed). */
    network?: boolean;
}
interface ShellOptions {
    cwd?: string;
    sandbox?: boolean | SandboxConfig;
    snapshot?: boolean | Snapshot;
}
/**
 * Run zsh commands with a cwd that persists across calls — a `cd` in
 * one call affects the next. Runs under `sandbox-exec` by default
 * (writes restricted to rw roots; reads unrestricted).
 *
 * @param opts.cwd - Starting working directory (default: first root).
 * @param opts.sandbox - `true` (default) restricts writes, `false`
 *   disables sandboxing, {@link SandboxConfig} gives fine-grained
 *   control over reads/writes/network.
 * @param opts.snapshot - `true` (default) captures the user's shell rc
 *   state (aliases, functions, options, PATH) once on first
 *   invocation and sources it into every subsequent command. `false`
 *   runs commands with a bare env. Pass a {@link Snapshot} to supply
 *   a pre-built one.
 */
declare const shell: (pathCtx: PathContext, opts?: ShellOptions) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/types.d.ts
interface ReadFileData {
    path: string;
    /** Content for the requested window; individual lines may be truncated. */
    content: string;
    totalLines: number;
    /** 1-indexed, inclusive. */
    startLine: number;
    /** 1-indexed, inclusive. */
    endLine: number;
}
interface WriteFileData {
    path: string;
    bytesWritten: number;
}
interface EditFileData {
    path: string;
}
interface GlobData {
    matches: string[];
    totalMatches: number;
}
interface GrepMatch {
    file: string;
    line: number;
    text: string;
}
interface GrepData {
    matches: GrepMatch[];
    fileCount: number;
    /** Total matches found, capped at a hard search limit. */
    totalMatches: number;
}
interface ListDirectoryEntry {
    name: string;
    type: "file" | "directory";
    sizeBytes?: number;
}
interface ListDirectoryData {
    path: string;
    entries: ListDirectoryEntry[];
}
interface ShellData {
    exitCode: number;
    stdout: string;
    stderr: string;
}
//#endregion
//#region packages/tools/src/index.d.ts
interface CoreToolsOptions {
    roots: (string | PathSpec)[];
    /** Respect .gitignore in traversal tools (glob, grep, list). Default: true. */
    gitignore?: boolean;
    shell?: {
        cwd?: string;
        sandbox?: boolean | SandboxConfig;
        snapshot?: boolean | Snapshot;
    };
}
/**
 * Assemble the 7 core tools over one shared `PathContext`. The same
 * `roots` config drives file access and the seatbelt profile.
 *
 * For finer control, compose the individual tool factories directly
 * with `merge()`.
 */
declare function coreTools(opts: CoreToolsOptions): Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/fs/src/internal.d.ts
/**
 * @module
 * Module-private capability token for the fs runtime backend.
 *
 * `rebase` keys the repoint-to-new-path method on FsJournal and
 * FsWorkspace. Symbol-keyed so the method has no string name — it does
 * not surface in autocomplete or property lookup for callers that have
 * not imported the symbol.
 *
 * Exported only from this file and never re-exported through a public
 * subpath. Relative imports from outside `packages/fs/` are visible in
 * code review and obviously wrong.
 */
declare const rebase: unique symbol;
//#endregion
//#region packages/fs/src/journal.d.ts
interface FsJournalState {
    v: 1;
    id: string;
    createdAt: string;
    activeGeneration: number;
}
/**
 * Each active-history generation lives in its own append-only JSONL
 * segment; current state is reduced from an append-only metadata ledger.
 */
declare class FsJournal extends Journal {
    #private;
    readonly id: string;
    private state;
    readonly kind: "fs";
    private writes;
    private writableGeneration?;
    private activeDirty;
    get dir(): string;
    constructor(id: string, dir: string, state: FsJournalState);
    [rebase](dir: string): void;
    event(event: JournalEvent): Promise<void>;
    /**
     * Fsyncs the active segment iff something was appended since the last
     * commit. Callers pick the boundary — the journal makes no assumption
     * about which events warrant a flush.
     */
    commit(): Promise<void>;
    partition(reason: string, nextEvents?: readonly JournalEvent[]): Promise<void>;
    scan(onEvent: JournalSink): Promise<void>;
    private activeSegmentPath;
    private ensureActiveGenerationWritable;
    /**
     * Serialize a mutation against the active generation and repair only
     * its writable tail before mutating. Interior corruption is a
     * scan-time concern.
     */
    private runExclusiveOnActive;
    private runExclusive;
}
//#endregion
//#region packages/fs/src/workspace.d.ts
interface FsSpillResult extends PathSpillResult {
}
declare class FsWorkspace extends DirectoryWorkspace {
    #private;
    readonly id: string;
    readonly kind: "fs";
    get dir(): string;
    constructor(id: string, dir: string);
    /** Repoint at the same inode reached via a new path. */
    [rebase](dir: string): void;
    spill(content: string, o?: SpillOpts): Promise<FsSpillResult>;
}
//#endregion
//#region packages/fs/src/runtime.d.ts
interface FsRuntime extends Runtime<FsWorkspace> {
    journal: FsJournal;
}
interface FsRuntimeStat {
    id: string;
    mtime: number;
    createdAt: string;
}
/**
 * Create a new fs-backed runtime at an exact directory. Fails if the
 * target already exists. Creation is staged in a sibling temp dir then
 * renamed into place — the final path never appears partially
 * initialized.
 */
declare function createFsRuntime(dir: string): Promise<FsRuntime>;
/**
 * Open an existing fs-backed runtime at an exact directory. Validates
 * required files; never creates missing paths.
 *
 * Reentrant: a second same-process open returns the cached
 * journal+workspace pair, so every caller sees one reduced metadata
 * state and a partition on one handle is visible on every other.
 */
declare function openFsRuntime(dir: string): Promise<FsRuntime>;
declare function statFsRuntime(dir: string): Promise<FsRuntimeStat>;
//#endregion
//#region packages/mem/src/journal.d.ts
declare class MemoryJournal extends Journal {
    #private;
    readonly id: string;
    readonly kind: "memory";
    constructor(id?: string);
    event(event: JournalEvent): Promise<void>;
    partition(reason: string, nextEvents?: readonly JournalEvent[]): Promise<void>;
    scan(onEvent: JournalSink): Promise<void>;
}
//#endregion
//#region packages/mem/src/workspace.d.ts
declare class MemoryWorkspace extends Workspace {
    #private;
    readonly id: string;
    readonly kind: "memory";
    constructor(id?: string);
    spill(content: string, o?: SpillOpts): Promise<SpillResult>;
    read(uri: string): string | undefined;
}
//#endregion
//#region packages/mem/src/runtime.d.ts
declare function createMemRuntime(): Runtime<MemoryWorkspace>;
//#endregion
//#region packages/ronde/src/managed.d.ts
interface ManagedRuntimeOptions {
    root?: string;
    project?: string;
    name?: string;
}
/**
 * Create a fresh runtime pair.
 *
 * Default (no options): returns a managed fs runtime under ronde's
 * managed layout policy. This is the batteries-included path:
 * durable by default, with explicit `@ronde/mem` opt-in for callers
 * who want ephemeral runtimes instead.
 */
declare function createRuntime(opts?: ManagedRuntimeOptions): Promise<FsRuntime>;
declare function createManagedRuntime(opts?: ManagedRuntimeOptions): Promise<FsRuntime>;
/**
 * Open an existing managed fs-backed runtime.
 *
 * Named mode opens `<root>/projects/<project>/<name>/`. Unnamed mode
 * selects the latest valid runtime under that project bucket using
 * active-segment mtime, then `createdAt`, then `id`.
 */
declare function openRuntime(opts?: ManagedRuntimeOptions): Promise<FsRuntime>;
declare function openRuntime(name: string, opts?: Omit<ManagedRuntimeOptions, "name">): Promise<FsRuntime>;
declare function openRuntime(nameOrOpts: string | ManagedRuntimeOptions): Promise<FsRuntime>;
//#endregion
//#region packages/ronde/src/observer.d.ts
/** Callback interface layered over emitted engine events. */
interface RunObserver {
    onTurnStart?(turn: number): void;
    onTurnEnd?(turn: number, step: AgentStep): void;
    onThinking?(turn: number, content: string): void;
    onThinkingDelta?(turn: number, content: string): void;
    onText?(turn: number, content: string): void;
    onTextDelta?(turn: number, content: string): void;
    onToolCall?(turn: number, toolCall: ToolCall): void;
    onToolDelta?(turn: number, toolCall: ToolCall, chunk: string): void;
    onToolInputDelta?(turn: number, toolCallId: string, chunk: string): void;
    onToolResult?(turn: number, toolCall: ToolCall, result: ToolResult): void;
    onCompactionStart?(turn: number, historyLength: number): void;
    onCompactionEnd?(turn: number, usage: UsageStats): void;
    onCutoff?(turn: number, consecutiveCount: number): void;
    onWarning?(turn: number, message: string): void;
    onError?(turn: number, message: string): void;
    onRunEnd?(result: EngineResult): void;
}
//#endregion
//#region packages/ronde/src/api.d.ts
/** Configuration for `agentic()` and `generate()`. */
interface AgenticConfig<W extends Workspace = Workspace> {
    /**
     * `"provider/model"` format. API key read from the provider's env var
     * (ANTHROPIC_API_KEY, etc). Ignored when a backend is the first arg.
     */
    model?: string;
    system?: string;
    prompt?: string;
    /**
     * Seed a fresh run from caller-owned history. Written into the new
     * journal before the engine starts so replay and resume reconstruct
     * them. Pairwise exclusive with `journal`/`workspace`/`resume` — for
     * existing runtime pairs, use `hydrate(messages, runtime)`.
     */
    messages?: Message[];
    tools?: Toolkit<W>;
    /** Zod schema for structured output. Parsed from the final response. */
    output?: z.ZodType;
    /** Maximum turns. 0 = unlimited. Default: 0. */
    maxTurns?: number;
    effort?: Lax<Effort>;
    signal?: AbortSignal;
    hooks?: EngineHooks;
    /** `undefined` uses `DefaultCompactionStrategy`. `false` disables. */
    compaction?: CompactionStrategy | false;
    observers?: RunObserver | RunObserver[];
    /**
     * Resume a managed fs-backed runtime. A string opens a named runtime;
     * an object may omit `name` to open the latest active runtime in the
     * managed project bucket.
     */
    resume?: string | ManagedRuntimeOptions;
    journal?: Journal;
    workspace?: W;
    /**
     * Framework truncation policy for tool-result rendering. Oversized
     * formatted output spills to the workspace and is replaced with a
     * sliced preview plus a neutral hint. See `truncate` on tool
     * definitions for per-tool slice strategy.
     */
    truncation?: {
        maxInline?: number;
    };
}
/** Configuration for `agenticStream()`. Stream consumers receive `EngineEvent` directly, so `observers` is not accepted. */
type AgenticStreamConfig<W extends Workspace = Workspace> = Omit<AgenticConfig<W>, "observers">;
/** Result from `agentic()` and `generate()`. */
interface AgenticResult<T = string> {
    /** Final output — text, or parsed object when `output` schema is provided. Omitted when no output was produced. */
    output?: T;
    steps: AgentStep[];
    history: Message[];
    /**
     * Why the loop settled. For schema-validated runs that needed a
     * retry, reflects the retry's exit, not the initial pass. Use
     * `output` as the success signal; `settleReason` diagnoses *why*
     * a run ended, not *whether* it produced usable output.
     */
    settleReason: SettleReason;
    usage: {
        input: number;
        output: number;
        cached: number;
    };
}
/**
 * Naming alias over `agentic()` for callers reaching for "generate
 * from a prompt" semantics. Forwards every argument unchanged.
 *
 * ```
 * const { output } = await generate({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "Explain monads in one sentence.",
 * })
 * ```
 */
declare function generate<S extends z.ZodType, W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | (AgenticConfig<W> & {
    output: S;
}), maybeConfig?: AgenticConfig<W> & {
    output: S;
}): Promise<AgenticResult<z.infer<S>>>;
declare function generate<W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | AgenticConfig<W>, maybeConfig?: AgenticConfig<W>): Promise<AgenticResult<string>>;
/**
 * Run an agentic loop. The agent completes turns, calls tools,
 * and returns structured or text output.
 *
 * Convenience mode — model string, env keys, auto-retry:
 * ```
 * await agentic({ model: "anthropic/claude-haiku-4-5", prompt: "...", tools })
 * ```
 *
 * Power mode — bring your own backend:
 * ```
 * await agentic(backend, { prompt: "...", tools })
 * ```
 */
declare function agentic<S extends z.ZodType, W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | (AgenticConfig<W> & {
    output: S;
}), maybeConfig?: AgenticConfig<W> & {
    output: S;
}): Promise<AgenticResult<z.infer<S>>>;
declare function agentic<W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | AgenticConfig<W>, maybeConfig?: AgenticConfig<W>): Promise<AgenticResult<string>>;
/**
 * Streaming agentic loop. Yields observation events as they happen.
 * Hooks handle decisions internally. Use `for await` to consume.
 * `observers` are not accepted here — stream consumers already
 * receive the raw `EngineEvent` values directly.
 *
 * ```
 * for await (const event of agenticStream(backend, config)) {
 *   if (event.type === "text") process.stdout.write(event.content)
 *   if (event.type === "tool_call") console.log(event.call.name)
 * }
 * ```
 */
declare function agenticStream<S extends z.ZodType, W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | (AgenticStreamConfig<W> & {
    output: S;
}), maybeConfig?: AgenticStreamConfig<W> & {
    output: S;
}): AsyncGenerator<EngineEvent, AgenticResult<z.infer<S>>>;
declare function agenticStream<W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | AgenticStreamConfig<W>, maybeConfig?: AgenticStreamConfig<W>): AsyncGenerator<EngineEvent, AgenticResult<string>>;
/** Open a prior managed durable runtime. Alias of `openRuntime()`. */
declare function resume(opts?: ManagedRuntimeOptions): Promise<FsRuntime>;
declare function resume(name: string, opts?: Omit<ManagedRuntimeOptions, "name">): Promise<FsRuntime>;
declare function resume(nameOrOpts: string | ManagedRuntimeOptions): Promise<FsRuntime>;
/**
 * Reconstruct the active message history from a journal.
 *
 * ```ts
 * const messages = await replay("merger-experiment")
 * const messages = await replay()
 * const messages = await replay(journal)
 * ```
 */
declare function replay(journal: Journal): Promise<Message[]>;
declare function replay(opts?: ManagedRuntimeOptions): Promise<Message[]>;
declare function replay(name: string, opts?: Omit<ManagedRuntimeOptions, "name">): Promise<Message[]>;
/**
 * Create a fresh runtime pair pre-populated with the given messages.
 * The messages are written to the journal as `message` events, so
 * subsequent `replay()` calls reconstruct them. Returns the same
 * `{ journal, workspace }` shape as `resume()`.
 *
 * Use when starting a new conversation from a hand-crafted history
 * (e.g. from another store) and you want the journal to reflect it.
 *
 * ```ts
 * const { journal, workspace } = await hydrate(priorMessages)
 * await agentic({ model, journal, workspace, prompt: "continue" })
 * ```
 */
declare function hydrate(messages: Message[], opts?: Runtime | ManagedRuntimeOptions): Promise<Runtime>;
//#endregion
//#region packages/ronde/src/compaction.d.ts
/** Options for customizing `DefaultCompactionStrategy`. */
interface DefaultCompactionOptions {
    compactionSystemPrompt?: string;
    resumeMessage?: string;
}
/**
 * Default compaction: asks the model to produce a structured
 * continuation context ("## Goal", "## Progress", etc.). Drops
 * oldest history items one at a time if the compaction call hits
 * the provider's context limit.
 */
declare class DefaultCompactionStrategy implements CompactionStrategy {
    private compactionSystem;
    private resumeMessage;
    constructor(options?: DefaultCompactionOptions);
    compact(ctx: CompactionContext): Promise<CompactionResult>;
}
//#endregion
export { AgentStep, AgentStepToolCall, AgenticConfig, AgenticResult, AgenticStreamConfig, Awaitable, type BackendConfig, type CompactionContext, type CompactionResult, type CompactionStrategy, CompletionBackend, CompletionDelta, CompletionError, CompletionErrorKind, CompletionRequest, CompletionResponse, CompletionWarning, ConfiguredBackend, CoreToolsOptions, DEFAULT_MAX_CONTEXT, DEFAULT_MAX_INLINE, DEFAULT_MAX_OUTPUT, DefaultCompactionOptions, DefaultCompactionStrategy, DiagnosticEvents, DirectoryWorkspace, EMPTY_USAGE, type EditFileData, Effort, EngineConfig, EngineDiagnosticEvent, EngineEvent, EngineEventKind, EngineHooks, EngineLifecycleEvent, EngineProgressEvent, EngineResult, FormatContext, FsJournal, type FsRuntime, FsRuntimeStat, FsSpillResult, FsWorkspace, type GlobData, type GrepData, type GrepMatch, type InternalBackendConfig, Journal, JournalEvent, JournalSink, Lax, LifecycleEvents, type ListDirectoryData, type ListDirectoryEntry, ManagedRuntimeOptions, MemoryJournal, MemoryWorkspace, Message, MessagePart, MessageType, NormalizedMessage, NormalizedPart, PathContext, type PathSpec, PathSpillResult, PreStepInput, PreStepResult, ProgressEvents, type ProviderDescriptor, type ReadFileData, ResolvedBackendConfig, Result, RetryOptions, RetryingBackend, Role, type RootSpec, type RunObserver, RunTotals, type Runtime, type SandboxConfig, type SettleReason, type ShellData, type ShellKind, type Snapshot, SpillOpts, SpillResult, StateConfig, StatefulToolContext, StopReason, TextPart, ThinkingPart, ToolCall, ToolCallPart, ToolContext, ToolDefBase, ToolExecuteReturn, ToolExecutor, ToolFormatterFn, ToolOutput, ToolResult, ToolResultPart, ToolSchema, Toolkit, TruncateStrategy, UsageStats, Workspace, type WriteFileData, agentic, agenticStream, allProviders, asGenerator, assistantMessage, bindToolkitRuntime, canonicalize, classifyError, coalesceByRole, coreTools, createBackend, createFsRuntime, createManagedRuntime, createMemRuntime, createRuntime, defaultFormatter, diagnosticEvent, drain, editFile, emptyUsage, engine, err, estimateTokens, formatToolOutput, genHex, genId, generate, getProvider, globFiles, grepFiles, hydrate, isAsyncGenerator, isDirectoryWorkspace, isOk, lifecycleEvent, listDirectory, merge, ok, openFsRuntime, openRuntime, partRole, progressEvent, readFile, registerProvider, replay, resolveRuntimeResources, resume, ro, rw, sanitizeFilename, shell, statFsRuntime, textPart, thinkingPart, tool, toolCallPart, toolResultMessage, toolResultPart, userMessage, utf8ByteLength, withRetry, wrapSdkError, writeFile };
//# sourceMappingURL=index.d.mts.map
