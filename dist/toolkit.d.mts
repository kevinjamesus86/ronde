import { M as Awaitable, P as ToolCall, _ as Message, h as ToolSchema } from "./completion-D7rwko-L.mjs";
import { t as Result } from "./result-BDAQVaWx.mjs";
import { SpillOpts, Workspace } from "./workspace.mjs";
import { z } from "zod/v4";

//#region packages/core/src/toolkit.d.ts
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
  /**
   * Spill large output to the workspace. Filename is pre-bound to
   * `<call.name>-<call.toolUseId>` so it correlates to a journal
   * event. For custom names, use `ctx.workspace.spill(content, { name })`.
   */
  spill(content: string, opts?: Omit<SpillOpts, "name">): ReturnType<W["spill"]>;
}
interface StatefulToolContext<S, W extends Workspace = Workspace> extends ToolContext<W> {
  /** Per-tool managed state, lazily initialized from `state.init`. */
  state: S;
}
/** Dispatches a tool call by name. Can be local, remote, or lazy. */
type ToolExecutor<W extends Workspace = Workspace> = (name: string, args: Record<string, unknown>, ctx: ToolContext<W>) => ToolExecuteReturn;
/** Converts structured tool data into the string the model sees. */
type ToolFormatterFn = (data: unknown) => string;
interface Toolkit<W extends Workspace = Workspace> {
  schemas: ToolSchema[];
  execute: ToolExecutor<W>;
  formatters: Record<string, ToolFormatterFn>;
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
/** Resolve the formatted string for a tool output, falling back to `defaultFormatter`. */
declare function formatToolOutput(toolkit: Toolkit<any>, toolName: string, output: ToolOutput): string;
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
}): Toolkit;
declare function tool<S, T extends z.ZodType, D = unknown>(def: ToolDefBase & {
  parameters: T;
  state: StateConfig<S>;
  execute: ExecuteFn<z.infer<T>, StatefulToolContext<S>, D>;
  format?: (data: D) => string;
}): Toolkit;
declare function tool<W extends Workspace>(): {
  <T extends z.ZodType, D = unknown>(def: ToolDefBase & {
    parameters: T;
    state?: undefined;
    execute: ExecuteFn<z.infer<T>, ToolContext<W>, D>;
    format?: (data: D) => string;
  }): Toolkit<W>;
  <S, T extends z.ZodType, D = unknown>(def: ToolDefBase & {
    parameters: T;
    state: StateConfig<S>;
    execute: ExecuteFn<z.infer<T>, StatefulToolContext<S, W>, D>;
    format?: (data: D) => string;
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
export { StateConfig, StatefulToolContext, ToolContext, ToolDefBase, ToolExecuteReturn, ToolExecutor, ToolFormatterFn, ToolOutput, Toolkit, bindToolkitRuntime, defaultFormatter, formatToolOutput, merge, tool };
//# sourceMappingURL=toolkit.d.mts.map