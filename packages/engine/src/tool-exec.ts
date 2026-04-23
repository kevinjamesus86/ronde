import { err } from "@ronde/core/result"
import { type Message, type ToolCallPart } from "@ronde/core/message"
import type { ToolCall } from "@ronde/core/tool"
import {
  formatToolResult,
  type Toolkit,
  type ToolContext,
  type ToolResult,
} from "@ronde/core/toolkit"
import { asGenerator } from "@ronde/core/stream"
import type { Workspace } from "@ronde/core/workspace"
import { progressEvent, type EngineEvent } from "./types.js"

const MAX_TOOL_CONCURRENCY = 10

export interface ExecuteToolCallsInput<W extends Workspace> {
  calls: ToolCallPart[]
  toolkit: Toolkit<W>
  turn: number
  abort: AbortSignal
  history: readonly Message[]
  workspace: W
  approvals?: Map<number, boolean>
  maxInline?: number
}

type Settled = {
  result: ToolResult
  content: string
}

const ABORTED = Symbol("aborted")

/**
 * Runs pending tool calls in parallel (up to MAX_TOOL_CONCURRENCY),
 * yielding progress events. Each tool produces a `tool_result` event
 * carrying both the formatted `content` (what the model sees) and the
 * raw `result` (the structured `ok(data) | err(msg)` for trajectory
 * export).
 *
 * Invariant: every tool_use in `input.calls` yields exactly one
 * `tool_result`. External abort, consumer tear-down, and formatter
 * failures all synthesize `err("Cancelled")` / best-effort fallback
 * rather than leaving orphans in the stream.
 *
 * Pure compute — no journal writes, no out-parameter mutation.
 */
export async function* executeToolCalls<W extends Workspace>(
  input: ExecuteToolCallsInput<W>,
): AsyncGenerator<EngineEvent, void, unknown> {
  const {
    calls,
    toolkit,
    turn,
    abort: abortSignal,
    history,
    workspace,
    approvals,
    maxInline,
  } = input

  if (calls.length === 0) {
    return
  }

  const toolCalls: ToolCall[] = calls.map((tc) => ({
    toolUseId: tc.toolCallId,
    name: tc.name,
    arguments: tc.arguments || {},
  }))

  for (const call of toolCalls) {
    yield progressEvent("tool_call", { turn, call })
  }

  // Siblings cancel as a group when any tool throws — preserves the
  // atomicity of "the model asked for N things, got N results" under
  // partial failure.
  const siblingController = new AbortController()
  const siblingSignal = siblingController.signal
  if (abortSignal.aborted) {
    siblingController.abort(abortSignal.reason)
  } else {
    abortSignal.addEventListener(
      "abort",
      () => siblingController.abort(abortSignal.reason),
      { once: true },
    )
  }

  const settled: (Settled | undefined)[] = Array.from({
    length: calls.length,
  })

  // External abort → force-cancel live tools via Promise.race. Bound
  // to the caller's signal, not siblingSignal: a crashing sibling
  // leaves the rest to finish gracefully (they observe ctx.abort and
  // return on their own terms), but the caller's signal is the "stop
  // everything now" escape hatch.
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (abortSignal.aborted) {
      resolve(ABORTED)
    } else {
      abortSignal.addEventListener("abort", () => resolve(ABORTED), {
        once: true,
      })
    }
  })

  async function finalize(i: number, result: ToolResult): Promise<void> {
    const tc = calls[i]!
    let content: string
    try {
      content = await formatToolResult(toolkit, tc.name, result, {
        workspace,
        toolUseId: tc.toolCallId,
        maxInline,
      })
    } catch (e) {
      // Formatter failure cannot orphan a tool pair — the model needs
      // a result for every tool_use.
      content = `Formatter failed: ${(e as Error).message}`
      result = err(content)
    }
    settled[i] = { result, content }
  }

  async function* driveTool(
    i: number,
    tc: ToolCallPart,
  ): AsyncGenerator<string, ToolResult> {
    if (siblingSignal.aborted) {
      return err("Cancelled")
    }
    if (approvals?.has(i) && !approvals.get(i)) {
      return err(`Tool call "${tc.name}" was rejected`)
    }
    const call = toolCalls[i]!
    const toolCtx: ToolContext<W> = {
      turn,
      abort: siblingSignal,
      messages: history,
      workspace,
      call,
    }
    const gen = asGenerator(toolkit.execute(tc.name, tc.arguments, toolCtx))
    try {
      while (true) {
        const winner = await Promise.race([gen.next(), aborted])
        if (winner === ABORTED) {
          void gen.return(undefined as never).catch(() => {})
          return err("Cancelled")
        }
        if (winner.done) {
          return winner.value
        }
        yield winner.value
      }
    } catch (e) {
      siblingController.abort("sibling_error")
      return err((e as Error).message)
    }
  }

  async function* runTask(i: number): AsyncGenerator<string, void> {
    const tc = calls[i]!
    const result = yield* driveTool(i, tc)
    await finalize(i, result)
  }

  type Waiter = Promise<{
    i: number
    iter: IteratorResult<string, void>
  }>
  type Active = {
    gen: AsyncGenerator<string, void>
    waiter: Waiter
  }
  const armNext = (i: number, gen: AsyncGenerator<string, void>): Waiter =>
    gen.next().then((iter) => ({ i, iter }))

  const active = new Map<number, Active>()
  let nextToLaunch = 0
  const fillSlots = () => {
    while (nextToLaunch < calls.length && active.size < MAX_TOOL_CONCURRENCY) {
      const i = nextToLaunch++
      const gen = runTask(i)
      active.set(i, {
        waiter: armNext(i, gen),
        gen,
      })
    }
  }

  function emitSettled(i: number): EngineEvent {
    const s = settled[i]!
    return progressEvent("tool_result", {
      turn,
      call: toolCalls[i]!,
      content: s.content,
      result: s.result,
    })
  }

  try {
    fillSlots()
    while (active.size > 0) {
      const waiters: Waiter[] = []
      for (const task of active.values()) {
        waiters.push(task.waiter)
      }
      const { i, iter } = await Promise.race(waiters)
      const task = active.get(i)!
      if (iter.done) {
        active.delete(i)
        fillSlots()
        yield emitSettled(i)
      } else {
        task.waiter = armNext(i, task.gen)
        yield progressEvent("tool_delta", {
          call: toolCalls[i]!,
          chunk: iter.value,
          turn,
        })
      }
    }
  } finally {
    // Consumer-side tear-down (gen.return on us): stop any still-live
    // task generators. Outcomes for those slots go unsettled — the
    // synthesis loop below closes the gap on normal completion.
    for (const { gen } of active.values()) {
      void gen.return(undefined as never).catch(() => {})
    }
    active.clear()
  }

  // Belt-and-braces: every slot must settle. Under normal completion
  // and external abort the scheduler already drained everything; this
  // loop only matters if the scheduler exited without processing a
  // slot (it shouldn't — keep the invariant visible at the boundary).
  for (let i = 0; i < calls.length; i++) {
    if (settled[i]) {
      continue
    }
    await finalize(i, err("Cancelled"))
    yield emitSettled(i)
  }
}
