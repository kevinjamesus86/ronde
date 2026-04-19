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
import type { Message } from "./message.js"
import type { ToolSchema } from "./completion.js"
import { err, type Result } from "./result.js"
import { asGenerator } from "./stream.js"
import type { ToolCall } from "./tool.js"
import type { Workspace, SpillOpts } from "./workspace.js"

export type ToolOutput<D = unknown> = Result<D>

/** Tool execute may return a Promise or an AsyncGenerator whose
 *  yields are textual progress deltas and whose return is the output. */
export type ToolExecuteReturn<D = unknown> =
  | Promise<ToolOutput<D>>
  | AsyncGenerator<string, ToolOutput<D>, void>

export interface ToolContext<W extends Workspace = Workspace> {
  turn: number
  abort: AbortSignal
  messages: readonly Message[]
  workspace: W
  call: ToolCall
  /**
   * Spill large output to the workspace. Filename is pre-bound to
   * `<call.name>-<call.toolUseId>` so it correlates to a journal
   * event. For custom names, use `ctx.workspace.spill(content, { name })`.
   */
  spill(content: string, opts?: Omit<SpillOpts, "name">): ReturnType<W["spill"]>
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

/** Converts structured tool data into the string the model sees. */
export type ToolFormatterFn = (data: unknown) => string

export interface Toolkit<W extends Workspace = Workspace> {
  schemas: ToolSchema[]
  execute: ToolExecutor<W>
  formatters: Record<string, ToolFormatterFn>
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
  output: ToolOutput,
): string {
  if (!output.ok) {
    return output.error
  }
  const { data } = output
  if (typeof data === "string") {
    return data
  }
  if (data == null) {
    return ""
  }
  return JSON.stringify(data)
}

/** Resolve the formatted string for a tool output, falling back to `defaultFormatter`. */
export function formatToolOutput(
  toolkit: Toolkit<any>,
  toolName: string,
  output: ToolOutput,
): string {
  const formatter = toolkit.formatters[toolName]
  if (!formatter) {
    return defaultFormatter(toolName, output)
  }
  if (output.ok) {
    return formatter(output.data)
  }
  if (output.data === undefined) {
    return output.error
  }
  return `${output.error}\n${formatter(output.data)}`
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
) => Awaitable<ToolOutput<D>> | AsyncGenerator<string, ToolOutput<D>, void>

// stateless
export function tool<T extends z.ZodType, D = unknown>(
  def: ToolDefBase & {
    parameters: T
    state?: undefined
    execute: ExecuteFn<z.infer<T>, ToolContext, D>
    format?: (data: D) => string
  },
): Toolkit

// stateful — S inferred from state.init return type
export function tool<S, T extends z.ZodType, D = unknown>(
  def: ToolDefBase & {
    parameters: T
    state: StateConfig<S>
    execute: ExecuteFn<z.infer<T>, StatefulToolContext<S>, D>
    format?: (data: D) => string
  },
): Toolkit

// curried — pin workspace type, returns tool() with W baked in
export function tool<W extends Workspace>(): {
  <T extends z.ZodType, D = unknown>(
    def: ToolDefBase & {
      parameters: T
      state?: undefined
      execute: ExecuteFn<z.infer<T>, ToolContext<W>, D>
      format?: (data: D) => string
    },
  ): Toolkit<W>

  <S, T extends z.ZodType, D = unknown>(
    def: ToolDefBase & {
      parameters: T
      state: StateConfig<S>
      execute: ExecuteFn<z.infer<T>, StatefulToolContext<S, W>, D>
      format?: (data: D) => string
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
  const createRuntime = (): Toolkit<any> =>
    createSingleToolRuntime(def, schema, formatters)

  let directRuntime: Toolkit<any> | undefined
  const getDirectRuntime = () => (directRuntime ??= createRuntime())

  return {
    schemas: [schema],
    execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
    formatters,
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
  const schemaMap = new Map<string, ToolSchema>()

  for (const tk of toolkits) {
    for (const schema of tk.schemas) {
      schemaMap.set(schema.name, schema)
    }
    Object.assign(formatters, tk.formatters)
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
      dispose,
    }
  }

  let directRuntime: Toolkit<MergedWorkspace<T>> | undefined
  const getDirectRuntime = () => (directRuntime ??= createRuntime())

  return {
    schemas: [...schemaMap.values()],
    execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
    formatters,
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
    format?: (data: unknown) => string
    strict?: boolean
  },
  schema: ToolSchema,
  formatters: Record<string, ToolFormatterFn>,
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
): AsyncGenerator<string, ToolOutput, void> {
  const state = await ensureState()
  return yield* asGenerator(exec(args, { ...baseCtx, state }))
}

async function wrapStatefulPromise(
  exec: StatefulExec,
  args: unknown,
  baseCtx: ToolContext,
  ensureState: () => Promise<unknown>,
): Promise<ToolOutput> {
  const state = await ensureState()
  return (await exec(args, { ...baseCtx, state })) as ToolOutput
}
