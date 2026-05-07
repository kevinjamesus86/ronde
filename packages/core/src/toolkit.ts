/**
 * @module
 * Tool definition, composition, and execution.
 *
 * @example
 * ```ts
 * import { tool, merge } from "@ronde/core/toolkit";
 *
 * const weather = tool({
 *   name: "weather",
 *   description: "Get weather for a city",
 *   parameters: z.object({ city: z.string() }),
 *   execute: async (args) => ok({ temp: 22 }),
 *   format: (data) => `${data.temp}°C`,
 * });
 * ```
 */
import { z } from "zod/v4"
import type { Awaitable } from "./tool.js"
import { type Block, BlockKind, ref, text } from "./block.js"
import type { Message } from "./message.js"
import type { ToolSchema } from "./completion.js"
import { err, type Result } from "./result.js"
import { asGenerator } from "./stream.js"
import type { ToolCall } from "./tool.js"
import type { Workspace } from "./workspace.js"

/** Default inline-output budget (characters) before the framework spills and truncates. */
export const DEFAULT_MAX_INLINE = 25_000

export type ToolResult<D = unknown> = Result<D>

/** Tool execute may return a Promise or an AsyncGenerator whose
 *  yields are textual progress deltas and whose return is the output. */
export type ToolExecuteReturn<D = unknown> =
  | Promise<ToolResult<D>>
  | AsyncGenerator<string, ToolResult<D>, void>

export interface ToolContext<W extends Workspace = Workspace> {
  turn: number
  abort: AbortSignal
  messages: readonly Message[]
  workspace: W
  call: ToolCall
}

export interface StatefulToolContext<
  S,
  W extends Workspace = Workspace,
> extends ToolContext<W> {
  /** Per-tool managed state, lazily initialized from `state.init`. */
  state: S
}

/** Dispatches a tool call by name. Can be local, remote, or lazy. */
export type ToolExecutor<W extends Workspace = Workspace> = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext<W>,
) => ToolExecuteReturn

/**
 * Converts structured tool data into the content the model sees.
 * Returns a string (the 90% case — wrapped to a single text block by
 * the framework) or a `Block[]` directly for multimodal output.
 */
export type ToolFormatterFn = (data: unknown) => string | Block[]

/**
 * How the framework cuts oversized formatted tool output before sending
 * to the model. The full output is spilled to the workspace either way;
 * this governs which slice of it survives inline.
 *
 * - `head`   — keep the beginning, drop the tail. Default.
 * - `tail`   — keep the end, drop the head.
 * - `middle` — keep beginning + end, drop the middle.
 */
export type TruncateStrategy = "head" | "tail" | "middle"

export interface Toolkit<W extends Workspace = Workspace> {
  schemas: ToolSchema[]
  execute: ToolExecutor<W>
  formatters: Record<string, ToolFormatterFn>
  /**
   * Per-tool truncation strategy. Missing entries default to `"head"`
   * when read by the framework. Hand-built toolkits may omit this.
   */
  truncate?: Record<string, TruncateStrategy>
  dispose?: () => Promise<void>
}

const runtimeFactorySymbol = Symbol("ronde.toolkitRuntimeFactory")

type RuntimeFactory<W extends Workspace = Workspace> = () => Toolkit<W>

type RuntimeBindableToolkit<W extends Workspace = Workspace> = Toolkit<W> & {
  [runtimeFactorySymbol]?: RuntimeFactory<W>
}

/**
 * Bind a toolkit to a fresh runtime instance. Toolkits created by `tool()`
 * and `merge()` expose an internal runtime factory so each engine execution
 * gets isolated stateful tool cells. Hand-built toolkits fall back to
 * themselves and remain responsible for any lifecycle they implement.
 */
export function bindToolkitRuntime<W extends Workspace = Workspace>(
  toolkit: Toolkit<W>,
): Toolkit<W> {
  const bind = (toolkit as RuntimeBindableToolkit<W>)[runtimeFactorySymbol]
  const bound = bind ? bind() : toolkit
  // Idempotent dispose so overlapping cleanup paths can each call it safely.
  if (!bound.dispose) {
    return bound
  }
  const inner = bound.dispose
  let disposed = false
  return {
    ...bound,
    dispose: async () => {
      if (disposed) {
        return
      }
      disposed = true
      await inner()
    },
  }
}

/** Default formatter: returns error string, passes through strings, JSON.stringify for objects. */
export function defaultFormatter(
  _toolName: string,
  result: ToolResult,
): string {
  if (!result.ok) {
    return result.error
  }
  const { data } = result
  if (typeof data === "string") {
    return data
  }
  if (data == null) {
    return ""
  }
  return JSON.stringify(data)
}

/**
 * Context for framework-level truncation. When passed, `formatToolResult`
 * checks the rendered string against `maxInline` and, if over, spills the
 * full content to the workspace and returns a truncated slice with a
 * neutral hint appended. The slice strategy comes from the toolkit's
 * declared `truncate` map (defaulting to `"head"`).
 */
export interface FormatContext {
  workspace: Workspace
  /** Used to derive the spill filename: `<toolName>-<toolUseId>`. */
  toolUseId: string
  /** Inline character budget. Defaults to {@link DEFAULT_MAX_INLINE}. */
  maxInline?: number
}

/**
 * Resolve the formatted blocks for a tool output. When `ctx` is supplied,
 * the framework enforces an inline size budget via content-substitution:
 * oversized text blocks get sliced to fit; oversized binary blocks are
 * spilled to the workspace and replaced with a `ref` block addressing
 * the artifact. Ref blocks pass through unchanged. When `ctx` is omitted
 * (tests, non-engine callers), no size check or spill happens.
 */
export async function formatToolResult(
  toolkit: Toolkit<any>,
  toolName: string,
  result: ToolResult,
  ctx?: FormatContext,
): Promise<Block[]> {
  const formatter = toolkit.formatters[toolName]
  const rendered = formatter
    ? renderWithFormatter(formatter, result)
    : defaultFormatter(toolName, result)
  const blocks = normalizeFormatted(rendered)

  if (!ctx) {
    return blocks
  }

  const maxInline = ctx.maxInline ?? DEFAULT_MAX_INLINE
  const strategy = toolkit.truncate?.[toolName] ?? "head"
  return fitBlocksToBudget(blocks, {
    budget: maxInline,
    strategy,
    workspace: ctx.workspace,
    toolName,
    toolUseId: ctx.toolUseId,
  })
}

function normalizeFormatted(rendered: string | Block[]): Block[] {
  return typeof rendered === "string" ? [text(rendered)] : rendered
}

function renderWithFormatter(
  formatter: ToolFormatterFn,
  result: ToolResult,
): string | Block[] {
  if (result.ok) {
    return formatter(result.data)
  }
  if (result.data === undefined) {
    return result.error
  }
  const formatted = formatter(result.data)
  if (typeof formatted === "string") {
    return `${result.error}\n${formatted}`
  }
  return [text(result.error), ...formatted]
}

interface FitOpts {
  budget: number
  strategy: TruncateStrategy
  workspace: Workspace
  toolName: string
  toolUseId: string
}

/**
 * Walk a `Block[]` and bring its inline size within budget. Per-block
 * policy:
 *
 * - text > per-block ceiling: slice with the truncation strategy and
 *   append a hint ref block with the spilled artifact URI.
 * - binary > per-block ceiling: spill the bytes to the workspace,
 *   replace with a ref block carrying the URI + mediaType + summary.
 * - ref: passes through (already an addressable handle).
 *
 * The total inline size across all blocks is bounded by `budget`. If
 * the sum exceeds budget after per-block decisions, additional binary
 * blocks are substituted to a ref largest-first until under budget.
 */
async function fitBlocksToBudget(
  blocks: Block[],
  opts: FitOpts,
): Promise<Block[]> {
  const out: Block[] = []
  let remaining = opts.budget
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const fitted = await fitOne(b, remaining, i, opts)
    for (const piece of fitted) {
      out.push(piece)
      remaining -= inlineByteSize(piece)
    }
  }
  return out
}

async function fitOne(
  block: Block,
  remaining: number,
  index: number,
  opts: FitOpts,
): Promise<Block[]> {
  switch (block.kind) {
    case BlockKind.Text: {
      const size = utf8Size(block.text)
      if (size <= remaining) {
        return [block]
      }
      const strategy = opts.strategy
      const spill = await opts.workspace.spill(block.text, {
        name: spillName(opts, index),
        mediaType: "text/plain",
      })
      const slice = sliceByStrategy(
        block.text,
        Math.max(0, remaining),
        strategy,
      )
      return [
        text(slice),
        ref(spill.uri, {
          mediaType: "text/plain",
          bytes: spill.bytes,
          summary: truncationSummary(strategy, remaining, size),
        }),
      ]
    }
    case BlockKind.Binary: {
      const size = inlineByteSize(block)
      if (size <= remaining) {
        return [block]
      }
      // base64 strings can be spilled as their decoded bytes; URL-form
      // binary is already external. We don't decode here — let the
      // workspace receive the original payload form.
      const payload =
        typeof block.data === "string" ? base64ToBytes(block.data) : block.data
      if (payload instanceof URL) {
        // URL form has no inline cost; let it through as a ref.
        return [
          ref(payload.href, {
            mediaType: block.mediaType,
            bytes: undefined,
            summary: block.filename,
          }),
        ]
      }
      const spill = await opts.workspace.spill(payload, {
        name: spillName(opts, index),
        mediaType: block.mediaType,
      })
      return [
        ref(spill.uri, {
          mediaType: block.mediaType,
          bytes: spill.bytes,
          summary: block.filename,
        }),
      ]
    }
    case BlockKind.Ref:
      return [block]
    default: {
      const _: never = block
      throw new Error(`unreachable: ${_}`)
    }
  }
}

function spillName(opts: FitOpts, index: number): string {
  return `${opts.toolName}-${opts.toolUseId}-${index}`
}

function truncationSummary(
  strategy: TruncateStrategy,
  shown: number,
  total: number,
): string {
  switch (strategy) {
    case "head":
      return `truncated to first ${shown} of ${total} bytes`
    case "tail":
      return `truncated to last ${shown} of ${total} bytes`
    case "middle": {
      const half = Math.floor(shown / 2)
      return `truncated to first ${half} + last ${half} of ${total} bytes`
    }
  }
}

function utf8Size(s: string): number {
  // Mirrors Buffer.byteLength without depending on it.
  let size = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) {
      size += 1
    } else if (code < 0x800) {
      size += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      size += 4
      i++
    } else {
      size += 3
    }
  }
  return size
}

function inlineByteSize(block: Block): number {
  switch (block.kind) {
    case BlockKind.Text:
      return utf8Size(block.text)
    case BlockKind.Binary: {
      if (block.data instanceof URL) {
        return 0
      }
      // base64 expansion: 4 chars encode 3 bytes — but for budget
      // purposes the inline cost is the base64 length itself.
      return block.data.length
    }
    case BlockKind.Ref:
      return 0
    default: {
      const _: never = block
      throw new Error(`unreachable: ${_}`)
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  // Web-standard atob returns a binary string; map to Uint8Array.
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return bytes
}

/**
 * Chars we're willing to spend searching for a newline near the cut,
 * either direction. Bounded so a pathological line doesn't swallow
 * arbitrary tokens trying to end on a boundary.
 */
const SNAP_WINDOW = 200

/**
 * Walk backward from `maxCut` up to SNAP_WINDOW chars looking for a
 * newline; return the position just after it so the slice ends on a
 * clean line boundary. Falls through to `maxCut` if no newline sits
 * within the window.
 */
function snapHeadCut(content: string, maxCut: number): number {
  const minCut = Math.max(0, maxCut - SNAP_WINDOW)
  const nl = content.lastIndexOf("\n", maxCut - 1)
  return nl >= minCut ? nl + 1 : maxCut
}

/**
 * Walk forward from `minCut` up to SNAP_WINDOW chars looking for a
 * newline; return the position just after it so the following slice
 * starts on a clean line. Falls through to `minCut` if no newline
 * sits within the window.
 */
function snapTailCut(content: string, minCut: number): number {
  const maxCut = Math.min(content.length, minCut + SNAP_WINDOW)
  const nl = content.indexOf("\n", minCut)
  return nl >= 0 && nl < maxCut ? nl + 1 : minCut
}

function sliceByStrategy(
  content: string,
  size: number,
  strategy: TruncateStrategy,
): string {
  switch (strategy) {
    case "head": {
      const cut = snapHeadCut(content, size)
      const omitted = content.length - cut
      return `${content.slice(0, cut)}\n\n[... ${omitted} characters truncated ...]`
    }
    case "tail": {
      const cut = snapTailCut(content, content.length - size)
      const omitted = cut
      return `[... ${omitted} characters truncated ...]\n\n${content.slice(cut)}`
    }
    case "middle": {
      const half = Math.floor(size / 2)
      let headCut = snapHeadCut(content, half)
      let tailCut = snapTailCut(content, content.length - half)
      // Guard: with small budgets the two snap windows can cross. Fall
      // back to exact cuts when that happens.
      if (tailCut <= headCut) {
        headCut = half
        tailCut = content.length - half
      }
      const omitted = tailCut - headCut
      return `${content.slice(0, headCut)}\n\n[... ${omitted} characters truncated ...]\n\n${content.slice(tailCut)}`
    }
  }
}

/** State lifecycle for stateful tools. */
export interface StateConfig<S> {
  /** Called lazily on first tool invocation. Can be async (e.g. DB pool). */
  init: () => Awaitable<S>
  /** Called when the owning runtime instance is disposed. Errors are swallowed. */
  dispose?: (state: S) => Awaitable<void>
}

export interface ToolDefBase {
  name: string
  description: string
  strict?: boolean
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

type ExecuteFn<Args, Ctx, D> = (
  args: Args,
  ctx: Ctx,
) => Awaitable<ToolResult<D>> | AsyncGenerator<string, ToolResult<D>, void>

// stateless
export function tool<T extends z.ZodType, D = unknown>(
  def: ToolDefBase & {
    parameters: T
    state?: undefined
    execute: ExecuteFn<z.infer<T>, ToolContext, D>
    format?: (data: D) => string | Block[]
    truncate?: TruncateStrategy
  },
): Toolkit

// stateful — S inferred from state.init return type
export function tool<S, T extends z.ZodType, D = unknown>(
  def: ToolDefBase & {
    parameters: T
    state: StateConfig<S>
    execute: ExecuteFn<z.infer<T>, StatefulToolContext<S>, D>
    format?: (data: D) => string | Block[]
    truncate?: TruncateStrategy
  },
): Toolkit

// curried — pin workspace type, returns tool() with W baked in
export function tool<W extends Workspace>(): {
  <T extends z.ZodType, D = unknown>(
    def: ToolDefBase & {
      parameters: T
      state?: undefined
      execute: ExecuteFn<z.infer<T>, ToolContext<W>, D>
      format?: (data: D) => string | Block[]
      truncate?: TruncateStrategy
    },
  ): Toolkit<W>

  <S, T extends z.ZodType, D = unknown>(
    def: ToolDefBase & {
      parameters: T
      state: StateConfig<S>
      execute: ExecuteFn<z.infer<T>, StatefulToolContext<S, W>, D>
      format?: (data: D) => string | Block[]
      truncate?: TruncateStrategy
    },
  ): Toolkit<W>
}

export function tool(defOrNothing?: any): any {
  if (defOrNothing === undefined) {
    return (def: any) => _tool(def)
  }
  return _tool(defOrNothing)
}

function _tool(def: {
  name: string
  description: string
  parameters: z.ZodType
  state?: StateConfig<any>
  execute: (args: any, ctx: any) => ToolExecuteReturn
  format?: (data: unknown) => string
  truncate?: TruncateStrategy
  strict?: boolean
}): Toolkit<any> {
  const jsonSchema = z.toJSONSchema(def.parameters, {
    unrepresentable: "any",
  })

  const schema: ToolSchema = {
    name: def.name,
    description: def.description,
    inputSchema: jsonSchema as Record<string, unknown>,
    strict: def.strict,
  }
  const formatters = def.format ? { [def.name]: def.format } : {}
  const truncate = def.truncate ? { [def.name]: def.truncate } : {}
  const createRuntime = (): Toolkit<any> =>
    createSingleToolRuntime(def, schema, formatters, truncate)

  let directRuntime: Toolkit<any> | undefined
  const getDirectRuntime = () => (directRuntime ??= createRuntime())

  return {
    schemas: [schema],
    execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
    formatters,
    truncate,
    dispose: async () => {
      if (!directRuntime) {
        return
      }
      try {
        await directRuntime.dispose?.()
      } finally {
        directRuntime = undefined
      }
    },
    [runtimeFactorySymbol]: createRuntime,
  } as RuntimeBindableToolkit<any>
}

/**
 * Merge multiple toolkits into one. Later toolkits override
 * earlier ones on name collision (schemas, formatters).
 * Dispose calls all child dispose functions.
 */
type WorkspaceOf<T> = T extends Toolkit<infer W> ? W : never

type UnionToIntersection<U> = (
  U extends unknown ? (arg: U) => void : never
) extends (arg: infer I) => void
  ? I
  : never

type MergedWorkspace<T extends readonly Toolkit<any>[]> = UnionToIntersection<
  WorkspaceOf<T[number]>
> &
  Workspace

export function merge<T extends readonly Toolkit<any>[]>(
  ...toolkits: T
): Toolkit<MergedWorkspace<T>> {
  const formatters: Record<string, ToolFormatterFn> = {}
  const truncate: Record<string, TruncateStrategy> = {}
  const schemaMap = new Map<string, ToolSchema>()

  for (const tk of toolkits) {
    for (const schema of tk.schemas) {
      schemaMap.set(schema.name, schema)
    }
    Object.assign(formatters, tk.formatters)
    if (tk.truncate) {
      Object.assign(truncate, tk.truncate)
    }
  }

  const createRuntime = (): Toolkit<MergedWorkspace<T>> => {
    const runtimeChildren = toolkits.map((tk) => bindToolkitRuntime(tk))
    const runtimeRouting = new Map<string, Toolkit>()
    for (const tk of runtimeChildren) {
      for (const schema of tk.schemas) {
        runtimeRouting.set(schema.name, tk)
      }
    }

    const execute: ToolExecutor<MergedWorkspace<T>> = (name, args, ctx) => {
      const tk = runtimeRouting.get(name)
      if (!tk) {
        return Promise.resolve(err(`Unknown tool '${name}'`))
      }
      return tk.execute(name, args, ctx)
    }

    const disposables = runtimeChildren.filter((tk) => tk.dispose)
    const dispose =
      disposables.length > 0
        ? async () => {
            for (const tk of disposables) {
              try {
                await tk.dispose!()
              } catch {
                // one child's failure must not block siblings
              }
            }
          }
        : undefined

    return {
      schemas: [...schemaMap.values()],
      execute,
      formatters,
      truncate,
      dispose,
    }
  }

  let directRuntime: Toolkit<MergedWorkspace<T>> | undefined
  const getDirectRuntime = () => (directRuntime ??= createRuntime())

  return {
    schemas: [...schemaMap.values()],
    execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
    formatters,
    truncate,
    dispose: async () => {
      if (!directRuntime) {
        return
      }
      try {
        await directRuntime.dispose?.()
      } finally {
        directRuntime = undefined
      }
    },
    [runtimeFactorySymbol]: createRuntime,
  } as RuntimeBindableToolkit<MergedWorkspace<T>>
}

type ToolRuntimeSlot<S> =
  | { status: "cold" }
  | { status: "initializing"; promise: Promise<S> }
  | { status: "ready"; state: S }
  | { status: "disposed" }

function createSingleToolRuntime(
  def: {
    name: string
    description: string
    parameters: z.ZodType
    state?: StateConfig<any>
    execute: (args: any, ctx: any) => ToolExecuteReturn
    format?: (data: unknown) => string | Block[]
    truncate?: TruncateStrategy
    strict?: boolean
  },
  schema: ToolSchema,
  formatters: Record<string, ToolFormatterFn>,
  truncate: Record<string, TruncateStrategy>,
): Toolkit<any> {
  let slot: ToolRuntimeSlot<unknown> = { status: "cold" }

  async function ensureState(): Promise<unknown> {
    if (!def.state) {
      return undefined
    }

    while (true) {
      switch (slot.status) {
        case "ready":
          return slot.state
        case "initializing":
          return await slot.promise
        case "disposed":
          throw new Error(
            `Tool "${def.name}" executed after the engine has completed`,
          )
        case "cold": {
          const promise = (async () => {
            const state = await def.state!.init()
            slot = { status: "ready", state }
            return state
          })().catch((error) => {
            if (slot.status === "initializing" && slot.promise === promise) {
              slot = { status: "cold" }
            }
            throw error
          })
          slot = { status: "initializing", promise }
          return await promise
        }
      }
    }
  }

  const executeIsGenerator = isAsyncGeneratorFunction(def.execute)

  const execute: ToolExecutor<any> = (name, rawArgs, baseCtx) => {
    if (name !== def.name) {
      return Promise.resolve(err(`Tool '${name}' not found in this toolkit`))
    }
    const parsed = def.parameters.safeParse(rawArgs)
    if (!parsed.success) {
      return Promise.resolve(
        err(`Invalid arguments for ${def.name}: ${parsed.error.message}`),
      )
    }
    if (!def.state) {
      return def.execute(parsed.data, baseCtx) as ToolExecuteReturn
    }
    if (executeIsGenerator) {
      return wrapStatefulGenerator(
        def.execute,
        parsed.data,
        baseCtx,
        ensureState,
      )
    }
    return wrapStatefulPromise(def.execute, parsed.data, baseCtx, ensureState)
  }

  const dispose = def.state
    ? async () => {
        if (slot.status === "disposed" || slot.status === "cold") {
          slot = { status: "disposed" }
          return
        }

        if (slot.status === "initializing") {
          try {
            await slot.promise
          } catch {
            slot = { status: "disposed" }
            return
          }
        }

        if (slot.status === "ready") {
          try {
            await def.state!.dispose?.(slot.state)
          } catch {
            // dispose errors must not propagate
          }
        }

        slot = { status: "disposed" }
      }
    : undefined

  return {
    schemas: [schema],
    execute,
    formatters,
    truncate,
    dispose,
  }
}

const AsyncGeneratorFunction = async function* () {}.constructor as new () => (
  ...a: unknown[]
) => AsyncGenerator

function isAsyncGeneratorFunction(
  fn: unknown,
): fn is (...args: unknown[]) => AsyncGenerator {
  if (typeof fn !== "function") {
    return false
  }
  return (
    Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]" ||
    fn instanceof AsyncGeneratorFunction
  )
}

type StatefulExec = (args: unknown, ctx: unknown) => ToolExecuteReturn

async function* wrapStatefulGenerator(
  exec: StatefulExec,
  args: unknown,
  baseCtx: ToolContext,
  ensureState: () => Promise<unknown>,
): AsyncGenerator<string, ToolResult, void> {
  const state = await ensureState()
  return yield* asGenerator(exec(args, { ...baseCtx, state }))
}

async function wrapStatefulPromise(
  exec: StatefulExec,
  args: unknown,
  baseCtx: ToolContext,
  ensureState: () => Promise<unknown>,
): Promise<ToolResult> {
  const state = await ensureState()
  return (await exec(args, { ...baseCtx, state })) as ToolResult
}
