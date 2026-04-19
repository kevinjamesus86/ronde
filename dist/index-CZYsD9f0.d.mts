import { F as ToolResult, M as Awaitable, N as Lax, P as ToolCall, _ as Message, a as CompletionRequest, c as ConfiguredBackend, d as Effort, f as ResolvedBackendConfig, g as UsageStats, h as ToolSchema, m as StopReason, n as CompletionError, o as CompletionResponse, p as SettleReason, t as CompletionBackend } from "./completion-D7rwko-L.mjs";
import { n as JournalEvent, r as JournalSink, t as Journal } from "./journal-XXruz723.mjs";
import { DirectoryWorkspace, PathSpillResult, SpillOpts, SpillResult, Workspace } from "./workspace.mjs";
import { ToolOutput, Toolkit } from "./toolkit.mjs";
import { z } from "zod/v4";

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
//#region packages/engine/src/compaction.d.ts
interface CompactionContext {
  backend: CompletionBackend;
  model: string;
  effort: Lax<Effort> | null;
  system?: string;
  history: Message[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}
type CompactionResult = {
  kind: "compacted";
  summary: Message;
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
type Variants<Kind extends string, Events extends Record<string, object>> = { [Type in keyof Events & string]: EventVariant<Kind, Type, Events[Type]> }[keyof Events & string];
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
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  compactionCount: number;
}
interface PreStepResult {
  messages?: Message[];
  toolSchemas?: ToolSchema[];
  model?: string;
  effort?: Lax<Effort> | null;
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
 * `executeToolCalls` — assistant messages here strip `ToolUse` parts
 * before writing, so the durable record never contains an orphaned
 * call without its result.
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
//#region packages/fs/src/workspace.d.ts
interface FsSpillResult extends PathSpillResult {}
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
type FsRuntime = Runtime<FsWorkspace>;
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
//#endregion
//#region packages/ronde/src/managed-runtime.d.ts
interface ManagedRuntimeOptions {
  root?: string;
  project?: string;
  name?: string;
}
/**
 * Open an existing managed fs-backed runtime.
 *
 * Named mode opens `<root>/projects/<project>/<name>/`. Unnamed mode
 * selects the latest valid runtime under that project bucket using
 * active-segment mtime, then `createdAt`, then `id`.
 */
declare function openRuntime(opts?: ManagedRuntimeOptions): Promise<FsRuntime>;
declare function openRuntime(name: string, opts?: Omit<ManagedRuntimeOptions, "name">): Promise<FsRuntime>;
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
  schema?: z.ZodType;
  /** Maximum turns. 0 = unlimited. Default: 0 for agentic, 1 for generate. */
  maxTurns?: number;
  effort?: Lax<Effort>;
  signal?: AbortSignal;
  hooks?: EngineHooks;
  /**
   * `undefined` uses `DefaultCompactionStrategy`. `false` disables.
   * `generate()` disables by default — a single-turn call shouldn't
   * silently round-trip through the model a second time.
   */
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
}
/** Configuration for `agenticStream()`. Stream consumers receive `EngineEvent` directly, so `observers` is not accepted. */
type AgenticStreamConfig<W extends Workspace = Workspace> = Omit<AgenticConfig<W>, "observers">;
/** Result from `agentic()` and `generate()`. */
interface AgenticResult<T = string> {
  /** Final output — text, or parsed object when `schema` is provided. Omitted when no output was produced. */
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
declare function agentic<S extends z.ZodType, W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | AgenticConfig<W>, maybeConfig?: AgenticConfig<W>): Promise<AgenticResult<S extends z.ZodType ? z.infer<S> : string>>;
/**
 * Generate a single completion. Equivalent to `agentic()` with
 * `maxTurns: 1`, and with compaction disabled by default — a one-shot
 * call shouldn't silently make an extra model round-trip. Pass an
 * explicit `compaction` to opt in.
 *
 * ```
 * const { output } = await generate({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "Explain monads in one sentence.",
 * })
 * ```
 */
declare function generate<S extends z.ZodType, W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | (AgenticConfig<W> & {
  schema: S;
}), maybeConfig?: AgenticConfig<W> & {
  schema: S;
}): Promise<AgenticResult<z.infer<S>>>;
declare function generate<W extends Workspace = Workspace>(backendOrConfig: ConfiguredBackend | AgenticConfig<W>, maybeConfig?: AgenticConfig<W>): Promise<AgenticResult<string>>;
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
declare function agenticStream(backendOrConfig: ConfiguredBackend | AgenticStreamConfig, maybeConfig?: AgenticStreamConfig): AsyncGenerator<EngineEvent, AgenticResult<string>>;
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
//#region packages/ronde/src/default-runtime.d.ts
/**
 * Create a fresh runtime pair.
 *
 * Default (no options): returns a managed fs runtime under ronde's
 * managed layout policy. This is the batteries-included path:
 * durable by default, with explicit `@ronde/mem` opt-in for callers
 * who want ephemeral runtimes instead.
 */
declare function createRuntime(opts?: ManagedRuntimeOptions): Promise<Runtime>;
//#endregion
//#region packages/ronde/src/compaction.d.ts
/** Options for customizing `DefaultCompactionStrategy`. */
interface DefaultCompactionOptions {
  compactionSystemPrompt?: string;
  compactionUserMessage?: string;
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
  private userMessage;
  private resumeMessage;
  constructor(options?: DefaultCompactionOptions);
  compact(ctx: CompactionContext): Promise<CompactionResult>;
}
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
//#region packages/providers/src/types.d.ts
interface BackendConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  effort?: Lax<Effort>;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}
interface InternalBackendConfig {
  /** True only for first-party OpenAI — gates reasoning features. */
  nativeOpenAI: boolean;
  apiKey: string;
  baseURL: string | undefined;
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
//#region packages/mem/src/journal.d.ts
declare class MemoryJournal extends Journal {
  readonly id: string;
  readonly kind: "memory";
  readonly generations: {
    reason: string | null;
    events: JournalEvent[];
  }[];
  private activeGeneration;
  constructor(id?: string);
  event(event: JournalEvent): Promise<void>;
  partition(reason: string, nextEvents?: readonly JournalEvent[]): Promise<void>;
  scan(onEvent: JournalSink): Promise<void>;
}
//#endregion
//#region packages/mem/src/workspace.d.ts
declare class MemoryWorkspace extends Workspace {
  readonly id: string;
  readonly kind: "memory";
  readonly resources: Map<string, string>;
  constructor(id?: string);
  spill(content: string, o?: SpillOpts): Promise<SpillResult>;
  read(uri: string): string | undefined;
}
//#endregion
//#region packages/mem/src/runtime.d.ts
declare function createMemRuntime(): Runtime<MemoryWorkspace>;
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
 * Find files by glob pattern. Capped at {@link MAX_RESULTS} matches;
 * `.gitignore` is respected by default.
 */
declare const globFiles: (pathCtx: PathContext, opts?: GlobOptions) => Toolkit<DirectoryWorkspace>;
//#endregion
//#region packages/tools/src/grep-files.d.ts
interface GrepOptions {
  gitignore?: boolean;
}
/**
 * Search file contents with a JS regex. Skips binary files and files
 * larger than {@link MAX_FILE_SIZE}. Up to {@link MAX_INLINE} matches
 * return inline; on overflow the full `file:line: text` list spills to
 * the workspace and the model drills in via `read_file`. Respects
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
 * `depth: 5` for project overviews. Capped at {@link MAX_ENTRIES}.
 * Respects `.gitignore` by default.
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
 * Output over {@link INLINE_CAP} bytes is head+tail-previewed inline
 * and spilled in full to the workspace; the model drills into the
 * spill via `read_file`.
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
  /** True when the returned window doesn't cover the whole file. */
  truncated: boolean;
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
  truncated: boolean;
}
interface GrepMatch {
  file: string;
  line: number;
  text: string;
}
interface GrepData {
  /** Inline preview — first N matches. */
  matches: GrepMatch[];
  fileCount: number;
  /** Total matches found, capped at a hard search limit. */
  totalMatches: number;
  /** True when more matches exist than the inline preview contains. */
  truncated: boolean;
  /** Full match list (`file:line: text` lines) spilled to the workspace. */
  fullMatchesPath?: string;
}
interface ListDirectoryEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
}
interface ListDirectoryData {
  path: string;
  entries: ListDirectoryEntry[];
  truncated: boolean;
}
interface ShellData {
  exitCode: number;
  /** Middle-truncated (head+tail) when the full output exceeds the inline cap. */
  stdout: string;
  stderr: string;
  /** True when `stdout` is a preview and full output was spilled. */
  truncated: boolean;
  /** Full output spilled to the workspace when `truncated` is true. */
  fullStdoutPath?: string;
  /** Total bytes produced by the command, including any spilled output. */
  totalBytes: number;
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
export { FsRuntime as $, ProviderDescriptor as A, createRuntime as B, PathSpec as C, Runtime as Ct, createMemRuntime as D, rw as E, RetryOptions as F, agenticStream as G, AgenticResult as H, RetryingBackend as I, replay as J, generate as K, withRetry as L, getProvider as M, registerProvider as N, MemoryWorkspace as O, createBackend as P, openRuntime as Q, DefaultCompactionOptions as R, PathContext as S, CompactionStrategy as St, ro as T, AgenticStreamConfig as U, AgenticConfig as V, agentic as W, RunObserver as X, resume as Y, ManagedRuntimeOptions as Z, grepFiles as _, diagnosticEvent as _t, GrepData as a, AgentStep as at, writeFile as b, CompactionContext as bt, ListDirectoryEntry as c, EngineDiagnosticEvent as ct, WriteFileData as d, EngineHooks as dt, createFsRuntime as et, SandboxConfig as f, EngineLifecycleEvent as ft, listDirectory as g, PreStepResult as gt, Snapshot as h, PreStepInput as ht, GlobData as i, engine as it, allProviders as j, MemoryJournal as k, ReadFileData as l, EngineEvent as lt, ShellKind as m, EngineResult as mt, coreTools as n, FsSpillResult as nt, GrepMatch as o, AgentStepToolCall as ot, shell as p, EngineProgressEvent as pt, hydrate as q, EditFileData as r, FsWorkspace as rt, ListDirectoryData as s, EngineConfig as st, CoreToolsOptions as t, openFsRuntime as tt, ShellData as u, EngineEventKind as ut, globFiles as v, lifecycleEvent as vt, RootSpec as w, readFile as x, CompactionResult as xt, editFile as y, progressEvent as yt, DefaultCompactionStrategy as z };
//# sourceMappingURL=index-CZYsD9f0.d.mts.map