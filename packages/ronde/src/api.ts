/**
 * @module
 * High-level public API: `agentic()` and `generate()`.
 *
 * @example
 * ```ts
 * import { generate, agentic, coreTools } from "ronde"
 *
 * const { output } = await generate({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "Explain monads in one sentence.",
 * })
 *
 * const { output, steps } = await agentic({
 *   model: "anthropic/claude-sonnet-4-6",
 *   prompt: "Fix the failing tests.",
 *   tools: coreTools({ roots: [process.cwd()] }),
 * })
 * ```
 */
import { z } from "zod/v4"
import { ok, err, type Result } from "@ronde/core/result"
import { withRetry } from "@ronde/backend"
import type {
  EngineResult,
  AgentStep,
  CompactionStrategy,
  EngineConfig,
  EngineEvent,
  EngineHooks,
  SettleReason,
} from "@ronde/engine"
import { createBackend, allProviders } from "@ronde/providers"
import { DefaultCompactionStrategy } from "./compaction.js"
import { run, stream } from "./engine.js"
import { openRuntime, type ManagedRuntimeOptions } from "./managed.js"
import type { RunObserver } from "./observer.js"
import * as runtime from "./runtime.js"
import type { ConfiguredBackend, Effort } from "@ronde/core/completion"
import type { Lax } from "@ronde/core"
import type { Message } from "@ronde/core/message"
import type { Toolkit } from "@ronde/core/toolkit"
import { Journal } from "@ronde/core/journal"
import type { Workspace } from "@ronde/core/workspace"
import type { Runtime } from "@ronde/core/runtime"
import type { FsRuntime } from "@ronde/fs"

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for `agentic()` and `generate()`. */
export interface AgenticConfig<W extends Workspace = Workspace> {
  /**
   * `"provider/model"` format. API key read from the provider's env var
   * (ANTHROPIC_API_KEY, etc). Ignored when a backend is the first arg.
   */
  model?: string
  system?: string
  prompt?: string
  /**
   * Seed a fresh run from caller-owned history. Written into the new
   * journal before the engine starts so replay and resume reconstruct
   * them. Pairwise exclusive with `journal`/`workspace`/`resume` — for
   * existing runtime pairs, use `hydrate(messages, runtime)`.
   */
  messages?: Message[]
  tools?: Toolkit<W>
  /** Zod schema for structured output. Parsed from the final response. */
  schema?: z.ZodType
  /** Maximum turns. 0 = unlimited. Default: 0 for agentic, 1 for generate. */
  maxTurns?: number
  effort?: Lax<Effort>
  signal?: AbortSignal
  hooks?: EngineHooks
  /**
   * `undefined` uses `DefaultCompactionStrategy`. `false` disables.
   * `generate()` disables by default — a single-turn call shouldn't
   * silently round-trip through the model a second time.
   */
  compaction?: CompactionStrategy | false
  observers?: RunObserver | RunObserver[]
  /**
   * Resume a managed fs-backed runtime. A string opens a named runtime;
   * an object may omit `name` to open the latest active runtime in the
   * managed project bucket.
   */
  resume?: string | ManagedRuntimeOptions
  journal?: Journal
  workspace?: W
  /**
   * Framework truncation policy for tool-result rendering. Oversized
   * formatted output spills to the workspace and is replaced with a
   * sliced preview plus a neutral hint. See `truncate` on tool
   * definitions for per-tool slice strategy.
   */
  truncation?: { maxInline?: number }
}

/** Configuration for `agenticStream()`. Stream consumers receive `EngineEvent` directly, so `observers` is not accepted. */
export type AgenticStreamConfig<W extends Workspace = Workspace> = Omit<
  AgenticConfig<W>,
  "observers"
>

/** Result from `agentic()` and `generate()`. */
export interface AgenticResult<T = string> {
  /** Final output — text, or parsed object when `schema` is provided. Omitted when no output was produced. */
  output?: T
  steps: AgentStep[]
  history: Message[]
  /**
   * Why the loop settled. For schema-validated runs that needed a
   * retry, reflects the retry's exit, not the initial pass. Use
   * `output` as the success signal; `settleReason` diagnoses *why*
   * a run ended, not *whether* it produced usable output.
   */
  settleReason: SettleReason
  usage: {
    input: number
    output: number
    cached: number
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

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
export async function generate<
  S extends z.ZodType,
  W extends Workspace = Workspace,
>(
  backendOrConfig: ConfiguredBackend | (AgenticConfig<W> & { schema: S }),
  maybeConfig?: AgenticConfig<W> & { schema: S },
): Promise<AgenticResult<z.infer<S>>>

export async function generate<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticConfig<W>,
  maybeConfig?: AgenticConfig<W>,
): Promise<AgenticResult<string>>

export async function generate<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticConfig<W>,
  maybeConfig?: AgenticConfig<W>,
): Promise<AgenticResult<unknown>> {
  if (maybeConfig !== undefined) {
    return agentic(backendOrConfig as ConfiguredBackend, {
      ...maybeConfig,
      maxTurns: maybeConfig.maxTurns ?? 1,
      compaction: maybeConfig.compaction ?? false,
    })
  }
  const config = backendOrConfig as AgenticConfig
  return agentic({
    ...config,
    maxTurns: config.maxTurns ?? 1,
    compaction: config.compaction ?? false,
  })
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
export async function agentic<
  S extends z.ZodType,
  W extends Workspace = Workspace,
>(
  backendOrConfig: ConfiguredBackend | (AgenticConfig<W> & { schema: S }),
  maybeConfig?: AgenticConfig<W> & { schema: S },
): Promise<AgenticResult<z.infer<S>>>

export async function agentic<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticConfig<W>,
  maybeConfig?: AgenticConfig<W>,
): Promise<AgenticResult<string>>

export async function agentic<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticConfig<W>,
  maybeConfig?: AgenticConfig<W>,
): Promise<AgenticResult<unknown>> {
  let backend: ConfiguredBackend
  let config: AgenticConfig<W>

  if (maybeConfig !== undefined) {
    backend = backendOrConfig as ConfiguredBackend
    config = maybeConfig
  } else {
    config = backendOrConfig as AgenticConfig<W>
    if (!config.model) {
      throw new Error(
        'Either pass a backend as the first argument, or provide "model" in config.',
      )
    }
    backend = buildBackend(config.model)
  }

  let system = config.system
  if (config.schema) {
    const instruction = buildSchemaInstruction(config.schema)
    system = system ? system + instruction : instruction
  }

  const prepared = await runtime.prepare(config)

  // The engine reads history from the journal; we never hand it a
  // separate messages list. `runtime.prepare` ensures the journal
  // already holds any seeded/resumed history.
  const result = await run(
    backend,
    {
      system,
      prompt: config.prompt,
      toolkit: config.tools ?? (emptyToolkit as Toolkit<W>),
      maxTurns: config.maxTurns ?? 0,
      signal: config.signal,
      hooks: config.hooks,
      compaction: resolveCompaction(config.compaction),
      truncation: config.truncation,
      journal: prepared.journal,
      workspace: prepared.workspace,
    } as EngineConfig<W>,
    config.observers,
  )

  const lastText = result.steps.at(-1)?.text

  if (config.schema) {
    const first = tryParseSchema(lastText, config.schema)
    if (first.ok) {
      return buildResult(first.data, result)
    }

    // One retry on the shared journal/workspace — the engine replays
    // the first pass's history automatically; no messages hand-off.
    const retryResult = await run(
      backend,
      {
        system,
        prompt: repairPrompt(first.error),
        toolkit: config.tools ?? (emptyToolkit as Toolkit<W>),
        maxTurns: 1,
        signal: config.signal,
        hooks: config.hooks,
        compaction: resolveCompaction(config.compaction),
        truncation: config.truncation,
        journal: prepared.journal,
        workspace: prepared.workspace,
      } as EngineConfig<W>,
      config.observers,
    )

    const merged = mergeRuns(result, retryResult)
    const retryText = retryResult.steps.at(-1)?.text
    const second = tryParseSchema(retryText, config.schema)
    return buildResult(second.ok ? second.data : undefined, merged)
  }

  return buildResult(lastText, result)
}

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
export function agenticStream<
  S extends z.ZodType,
  W extends Workspace = Workspace,
>(
  backendOrConfig: ConfiguredBackend | (AgenticStreamConfig<W> & { schema: S }),
  maybeConfig?: AgenticStreamConfig<W> & { schema: S },
): AsyncGenerator<EngineEvent, AgenticResult<z.infer<S>>>

export function agenticStream<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticStreamConfig<W>,
  maybeConfig?: AgenticStreamConfig<W>,
): AsyncGenerator<EngineEvent, AgenticResult<string>>

export async function* agenticStream<W extends Workspace = Workspace>(
  backendOrConfig: ConfiguredBackend | AgenticStreamConfig<W>,
  maybeConfig?: AgenticStreamConfig<W>,
): AsyncGenerator<EngineEvent, AgenticResult<unknown>> {
  let backend: ConfiguredBackend
  let config: AgenticStreamConfig<W>

  if (maybeConfig !== undefined) {
    backend = backendOrConfig as ConfiguredBackend
    config = maybeConfig
  } else {
    config = backendOrConfig as AgenticStreamConfig<W>
    if (!config.model) {
      throw new Error(
        'Either pass a backend as the first argument, or provide "model" in config.',
      )
    }
    backend = buildBackend(config.model)
  }

  if (
    "observers" in config &&
    (config as AgenticConfig).observers !== undefined
  ) {
    throw new Error(
      'agenticStream() does not accept "observers". Consume emitted EngineEvent values directly.',
    )
  }

  let system = config.system
  if (config.schema) {
    const instruction = buildSchemaInstruction(config.schema)
    system = system ? system + instruction : instruction
  }

  const prepared = await runtime.prepare(config)
  const toolkit = config.tools ?? emptyToolkit

  const result = yield* stream(backend, {
    system,
    prompt: config.prompt,
    toolkit,
    maxTurns: config.maxTurns ?? 0,
    signal: config.signal,
    hooks: config.hooks,
    compaction: resolveCompaction(config.compaction),
    truncation: config.truncation,
    journal: prepared.journal,
    workspace: prepared.workspace,
  })

  const lastText = result.steps.at(-1)?.text

  if (config.schema) {
    const first = tryParseSchema(lastText, config.schema)
    if (first.ok) {
      return buildResult(first.data, result)
    }

    // Schema repair — one extra pass on the shared journal/workspace.
    // Each engine run emits its own event sequence including a
    // `run_end`; consumers see two run_ends when a retry happens.
    const retryResult = yield* stream(backend, {
      system,
      prompt: repairPrompt(first.error),
      toolkit,
      maxTurns: 1,
      signal: config.signal,
      hooks: config.hooks,
      compaction: resolveCompaction(config.compaction),
      truncation: config.truncation,
      journal: prepared.journal,
      workspace: prepared.workspace,
    })

    const merged = mergeRuns(result, retryResult)
    const retryText = retryResult.steps.at(-1)?.text
    const second = tryParseSchema(retryText, config.schema)
    return buildResult(second.ok ? second.data : undefined, merged)
  }

  return buildResult(lastText, result)
}

/** Open a prior managed durable runtime. Alias of `openRuntime()`. */
export async function resume(opts?: ManagedRuntimeOptions): Promise<FsRuntime>

export async function resume(
  name: string,
  opts?: Omit<ManagedRuntimeOptions, "name">,
): Promise<FsRuntime>

export async function resume(
  nameOrOpts: string | ManagedRuntimeOptions,
): Promise<FsRuntime>

export async function resume(
  nameOrOpts: string | ManagedRuntimeOptions = {},
  maybeOpts: Omit<ManagedRuntimeOptions, "name"> = {},
): Promise<FsRuntime> {
  return typeof nameOrOpts === "string"
    ? openRuntime(nameOrOpts, maybeOpts)
    : openRuntime(nameOrOpts)
}

/**
 * Reconstruct the active message history from a journal.
 *
 * ```ts
 * const messages = await replay("merger-experiment")
 * const messages = await replay()
 * const messages = await replay(journal)
 * ```
 */
export async function replay(journal: Journal): Promise<Message[]>

export async function replay(opts?: ManagedRuntimeOptions): Promise<Message[]>

export async function replay(
  name: string,
  opts?: Omit<ManagedRuntimeOptions, "name">,
): Promise<Message[]>

export async function replay(
  journalOrNameOrOpts: Journal | string | ManagedRuntimeOptions = {},
  maybeOpts: Omit<ManagedRuntimeOptions, "name"> = {},
): Promise<Message[]> {
  const runtimeJournal =
    journalOrNameOrOpts instanceof Journal
      ? journalOrNameOrOpts
      : typeof journalOrNameOrOpts === "string"
        ? (await openRuntime(journalOrNameOrOpts, maybeOpts)).journal
        : (await openRuntime(journalOrNameOrOpts)).journal

  const messages: Message[] = []
  await runtimeJournal.scan((ev) => {
    if (ev.type === "message") {
      messages.push(ev.message)
    }
  })
  return messages
}

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
export async function hydrate(
  messages: Message[],
  opts: Runtime | ManagedRuntimeOptions = {},
): Promise<Runtime> {
  const { journal, workspace } = await runtime.ensure(opts)
  await runtime.seed(journal, messages)
  return { journal, workspace }
}

// ─── Support: model strings ─────────────────────────────────────────────────

function parseModelString(model: string): {
  provider: string
  model: string
} {
  const slash = model.indexOf("/")
  if (slash === -1) {
    throw new Error(
      `Invalid model format: "${model}". ` +
        `Expected "provider/model" ` +
        `(e.g. "anthropic/claude-haiku-4-5").`,
    )
  }
  const prefix = model.slice(0, slash)
  const modelName = model.slice(slash + 1)

  for (const desc of allProviders()) {
    const p = desc.modelPrefix ?? desc.name
    if (p === prefix) {
      return { provider: desc.name, model: modelName }
    }
  }

  const known = [...allProviders()].map((d) => d.modelPrefix ?? d.name)
  throw new Error(
    `Unknown provider "${prefix}". ` + `Known providers: ${known.join(", ")}.`,
  )
}

function buildBackend(modelStr: string): ConfiguredBackend {
  const { provider, model } = parseModelString(modelStr)
  return withRetry(
    createBackend({
      provider,
      model,
    }),
  )
}

// ─── Support: schema ────────────────────────────────────────────────────────

function buildSchemaInstruction(schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" })
  return (
    "\n\n# Final output schema\n\n" +
    "Only your final response is parsed as structured output; intermediate turns are free-form. " +
    "When the work is complete, your final response must be valid JSON matching the schema below — " +
    "no prose, no markdown, no code fences, just the raw JSON.\n\n" +
    JSON.stringify(jsonSchema, null, 2)
  )
}

function repairPrompt(error: string): string {
  return (
    `Your previous response did not match the required JSON schema. ` +
    `Error: ${error}\n\nPlease respond with valid JSON matching the schema.`
  )
}

function tryParseSchema<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
): Result<T> {
  if (!text) {
    return err("No text output to parse")
  }
  let json = text.trim()
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
  }
  try {
    const parsed = JSON.parse(json)
    const result = schema.safeParse(parsed)
    if (result.success) {
      return ok(result.data)
    }
    return err(result.error.message)
  } catch (e) {
    return err(`Invalid JSON: ${(e as Error).message}`)
  }
}

// ─── Support: result shaping ────────────────────────────────────────────────

function buildResult(
  output: unknown,
  raw: {
    steps: AgentStep[]
    history: Message[]
    settleReason: SettleReason
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
  },
): AgenticResult<any> {
  return {
    output,
    steps: raw.steps,
    history: raw.history,
    settleReason: raw.settleReason,
    usage: {
      input: raw.totalInputTokens,
      output: raw.totalOutputTokens,
      cached: raw.totalCachedTokens,
    },
  }
}

function mergeRuns(first: EngineResult, retry: EngineResult): EngineResult {
  return {
    ...first,
    steps: [...first.steps, ...retry.steps],
    history: retry.history,
    settleReason: retry.settleReason,
    totalInputTokens: first.totalInputTokens + retry.totalInputTokens,
    totalOutputTokens: first.totalOutputTokens + retry.totalOutputTokens,
    totalCachedTokens: first.totalCachedTokens + retry.totalCachedTokens,
  }
}

// ─── Support: config defaults ───────────────────────────────────────────────

const emptyToolkit: Toolkit = {
  execute: async (name) => err(`Tool "${name}" not found`),
  schemas: [],
  formatters: {},
}

function resolveCompaction(
  value: CompactionStrategy | false | undefined,
): CompactionStrategy | undefined {
  if (value !== false) {
    return value ?? new DefaultCompactionStrategy()
  }
}
