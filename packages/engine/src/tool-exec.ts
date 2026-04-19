import { err } from "@ronde/core/result"
import {
  toolResultPart,
  type Message,
  type MessagePart,
  type ToolCallPart,
  type ToolResultPart,
} from "@ronde/core/message"
import { JournalEvent, type Journal } from "@ronde/core/journal"
import type { ToolCall } from "@ronde/core/tool"
import {
  formatToolOutput,
  type Toolkit,
  type ToolContext,
  type ToolOutput,
} from "@ronde/core/toolkit"
import { asGenerator } from "@ronde/core/stream"
import type { Workspace } from "@ronde/core/workspace"
import { estimateTokens } from "@ronde/core/tokens"
import { progressEvent, type AgentStep, type EngineEvent } from "./types.js"

const MAX_TOOL_CONCURRENCY = 10

export interface ToolExecutionResult {
  resultParts: MessagePart[]
  estimatedTokens: number
}

type TaskOutcome = {
  output: ToolOutput
  formatted: string
  resultPart: ToolResultPart
}

/**
 * Yields all tool_call events up front, then interleaves tool_delta and
 * tool_result events in settle order. Returned parts are in call order.
 */
export async function* executeToolCalls<W extends Workspace>(
  pendingToolCalls: ToolCallPart[],
  toolkit: Toolkit<W>,
  step: AgentStep,
  turn: number,
  abortSignal: AbortSignal,
  history: readonly Message[],
  approvals: Map<number, boolean>,
  workspace: W,
  journal: Journal,
): AsyncGenerator<EngineEvent, ToolExecutionResult, unknown> {
  if (pendingToolCalls.length === 0) {
    return { resultParts: [], estimatedTokens: 0 }
  }

  const toolCalls: ToolCall[] = pendingToolCalls.map((tc) => ({
    toolUseId: tc.toolCallId,
    name: tc.name,
    arguments: tc.arguments || {},
  }))

  for (const call of toolCalls) {
    yield progressEvent("tool_call", { turn, call })
  }

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

  const outcomes: (TaskOutcome | undefined)[] = Array.from({
    length: pendingToolCalls.length,
  })

  async function* runTask(i: number): AsyncGenerator<string, TaskOutcome> {
    const tc = pendingToolCalls[i]!
    let output: ToolOutput
    if (siblingSignal.aborted) {
      output = err("Aborted")
    } else if (approvals.has(i) && !approvals.get(i)) {
      output = err(`Tool call "${tc.name}" was rejected`)
    } else {
      const call = toolCalls[i]!
      const toolCtx: ToolContext<W> = {
        turn,
        abort: siblingSignal,
        messages: history,
        workspace,
        call,
        spill: (content, opts) =>
          workspace.spill(content, {
            ...opts,
            name: `${call.name}-${call.toolUseId}`,
          }) as ReturnType<W["spill"]>,
      }
      try {
        const gen = asGenerator(toolkit.execute(tc.name, tc.arguments, toolCtx))
        let next = await gen.next()
        while (!next.done) {
          yield next.value
          next = await gen.next()
        }
        output = next.value
      } catch (e) {
        siblingController.abort("sibling_error")
        output = err((e as Error).message)
      }
    }

    const formatted = formatToolOutput(toolkit, tc.name, output)
    const resultPart = toolResultPart({
      toolCallId: tc.toolCallId,
      content: formatted,
      ok: output.ok,
    })
    outcomes[i] = {
      output,
      formatted,
      resultPart,
    }

    // The pair is the engine's atomic unit for a completed tool — one
    // canonical Message, one journal event, so replay can't observe a
    // tool_use without its result.
    await journal.event(
      JournalEvent.message({
        parts: [tc, resultPart],
      } satisfies Message),
    )

    return { output, formatted, resultPart }
  }

  type Waiter = Promise<{
    i: number
    iter: IteratorResult<string, TaskOutcome>
  }>
  type Active = {
    gen: AsyncGenerator<string, TaskOutcome>
    waiter: Waiter
  }
  const armNext = (
    i: number,
    gen: AsyncGenerator<string, TaskOutcome>,
  ): Waiter =>
    gen.next().then((iter) => ({
      i,
      iter,
    }))

  const active = new Map<number, Active>()
  let nextToLaunch = 0
  const fillSlots = () => {
    while (
      nextToLaunch < pendingToolCalls.length &&
      active.size < MAX_TOOL_CONCURRENCY
    ) {
      const i = nextToLaunch++
      const gen = runTask(i)
      active.set(i, {
        waiter: armNext(i, gen),
        gen,
      })
    }
  }

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
      yield progressEvent("tool_result", {
        turn,
        call: toolCalls[i]!,
        result: {
          ok: iter.value.output.ok,
          content: iter.value.formatted,
        },
      })
    } else {
      task.waiter = armNext(i, task.gen)
      yield progressEvent("tool_delta", {
        call: toolCalls[i]!,
        chunk: iter.value,
        turn,
      })
    }
  }

  const resultParts: MessagePart[] = []
  let estimatedTokens = 0

  for (let i = 0; i < pendingToolCalls.length; i++) {
    const tc = pendingToolCalls[i]!
    const outcome = outcomes[i]!

    step.toolCalls.push({
      name: tc.name,
      args: tc.arguments,
      output: outcome.output,
    })

    estimatedTokens +=
      estimateTokens(tc.arguments) + estimateTokens(outcome.formatted)

    resultParts.push(outcome.resultPart)
  }

  return {
    resultParts,
    estimatedTokens,
  }
}
