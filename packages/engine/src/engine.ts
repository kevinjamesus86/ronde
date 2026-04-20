import {
  CompletionError,
  CompletionErrorKind,
  StopReason,
  emptyUsage,
  type CompletionDelta,
  type CompletionResponse,
  type ConfiguredBackend,
  type Effort,
  type ToolSchema,
  type UsageStats,
} from "@ronde/core/completion"
import {
  MessageType,
  Role,
  type Message,
  userMessage,
} from "@ronde/core/message"
import { JournalEvent, type Journal } from "@ronde/core/journal"
import type { Lax } from "@ronde/core"
import type { ToolCall } from "@ronde/core/tool"
import { bindToolkitRuntime } from "@ronde/core/toolkit"
import { asGenerator } from "@ronde/core/stream"
import type { Workspace } from "@ronde/core/workspace"
import type { CompactionResult } from "./compaction.js"
import {
  diagnosticEvent,
  lifecycleEvent,
  progressEvent,
  type AgentStep,
  type EngineConfig,
  type EngineEvent,
  type EngineHooks,
  type EngineResult,
  type PreStepInput,
  type SettleReason,
} from "./types.js"
import { executeToolCalls } from "./tool-exec.js"
import { extractToolCalls, translateBufferedMessages } from "./replay.js"

/**
 * Subset of EngineEvent that is also shaped as a JournalEvent — these
 * can be dual-written through `record()` with a single argument (the
 * event itself is valid journal payload). Any event outside this set
 * must supply an explicit JournalEvent entry to be recorded.
 *
 * Keep this list in sync with EngineEvent types that share a structural
 * shape with JournalEvent; the `_DurableFitsJournalEvent` check below
 * is the compile-time guard.
 */
type DurableEngineEvent = Extract<
  EngineEvent,
  {
    type: "compaction_start" | "compaction_end" | "cutoff" | "warning" | "error"
  }
>

// Compile-time assertion: every DurableEngineEvent is assignable to
// JournalEvent. If this breaks, either the EngineEvent shape drifted
// from JournalEvent or an event was added to DurableEngineEvent that
// isn't journal-shaped. Fix the taxonomy, not the assertion.
type _DurableFitsJournalEvent = DurableEngineEvent extends JournalEvent
  ? true
  : false
const _durableFitsJournalEvent: _DurableFitsJournalEvent = true
void _durableFitsJournalEvent

/**
 * Per-turn completion inputs resolved after `preStep` has had a chance
 * to override them. Scoped to one turn — overrides never leak into the
 * next iteration of the loop.
 */
interface TurnConfig {
  messages: Message[]
  toolSchemas: ToolSchema[]
  model: string
  effort?: Lax<Effort>
}

/**
 * Breaker threshold for consecutive truncated responses (stopReason
 * MaxTokens with no tool calls). On the Nth in a row, the loop settles
 * with `cutoff_breaker` — the model is looping on "continue where you
 * left off" nudges without making progress.
 */
const MAX_CONSECUTIVE_INCOMPLETE = 3

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
export async function* engine<W extends Workspace = Workspace>(
  backend: ConfiguredBackend,
  config: EngineConfig<W>,
): AsyncGenerator<EngineEvent, EngineResult, unknown> {
  const {
    system,
    prompt,
    maxTurns = 0,
    toolkit,
    signal,
    hooks,
    compaction,
    truncation,
  } = config

  const { model, effort, maxContext, maxOutput } = backend.config
  const { journal, workspace } = resolveRuntimeResources(config)
  const compactSafetyMargin = clamp(
    Math.floor(maxContext * 0.025),
    4_000,
    10_000,
  )
  const toolkitRuntime = bindToolkitRuntime(toolkit)

  const abortController = new AbortController()
  const abortSignal = abortController.signal
  if (signal) {
    if (signal.aborted) {
      abortController.abort(signal.reason)
    } else {
      signal.addEventListener(
        "abort",
        () => abortController.abort(signal.reason),
        { once: true },
      )
    }
  }

  const history: Message[] = []
  const steps: AgentStep[] = []
  let turn = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedTokens = 0
  let consecutiveIncomplete = 0
  let compactionCount = 0
  let compactionFailures = 0
  let settleReason: SettleReason = "max_turns"

  function applyUsage(usage: UsageStats): void {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCachedTokens += usage.cachedReadTokens
  }

  async function* emitCompactionStart(): AsyncGenerator<EngineEvent, void> {
    const entry = JournalEvent.compactionStart(turn, history.length)
    yield await record(
      lifecycleEvent("compaction_start", {
        historyLength: history.length,
        turn,
      }),
      entry,
    )
  }

  async function* emitCompactionEnd(
    usage: UsageStats,
  ): AsyncGenerator<EngineEvent, void> {
    yield await record(
      lifecycleEvent("compaction_end", {
        turn,
        usage,
      }),
    )
  }

  async function* handleCutoff(): AsyncGenerator<EngineEvent, boolean> {
    consecutiveIncomplete++
    if (consecutiveIncomplete >= MAX_CONSECUTIVE_INCOMPLETE) {
      const message = `${MAX_CONSECUTIVE_INCOMPLETE} consecutive incomplete responses. Stopping.`
      yield await record(
        diagnosticEvent("error", {
          message,
          turn,
        }),
      )
      settleReason = "cutoff_breaker"
      return true
    }
    yield await record(
      lifecycleEvent("cutoff", {
        count: consecutiveIncomplete,
        turn,
      }),
    )
    await send(
      userMessage(
        "Your previous response was cut off due to output length limits. Continue where you left off.",
      ),
    )
    return false
  }

  function append(message: Message): void {
    history.push(message)
  }

  // Dual-write an event: append to the journal and return it for
  // yielding. The first overload takes events whose shape is already
  // assignable to JournalEvent (see DurableEngineEvent) so the caller
  // writes one expression; the second overload handles events that
  // need a distinct JournalEvent payload (e.g. `turn_end` is a
  // lifecycle event but the journal entry is shaped by
  // `JournalEvent.turnEnd`).
  function record<E extends DurableEngineEvent>(observed: E): Promise<E>
  function record<E extends EngineEvent>(
    observed: E,
    entry: JournalEvent,
  ): Promise<E>
  async function record<E extends EngineEvent>(
    observed: E,
    entry?: JournalEvent,
  ): Promise<E> {
    await journal.event(entry ?? (observed as unknown as JournalEvent))
    return observed
  }

  async function recordTurnEnd(step: AgentStep) {
    const entry = JournalEvent.turnEnd(step.turn, step.usage, step.stopReason)
    const event = await record(
      lifecycleEvent("turn_end", {
        turn: step.turn,
        step,
      }),
      entry,
    )
    // Engine owns commit policy. Turn boundaries are the natural
    // checkpoint, so resume lands at a coherent turn edge.
    await journal.commit()
    return event
  }

  async function doCompact(): Promise<CompactionResult> {
    if (!compaction || compactionFailures >= 3) {
      return { kind: "not_compacted", usage: emptyUsage() }
    }

    compactionCount++

    const result = await compaction.compact({
      backend,
      model,
      effort,
      history,
      maxOutput,
      signal: abortSignal,
    })

    if (result.kind === "compacted") {
      compactionFailures = 0
      history.length = 0
    } else {
      compactionFailures++
    }

    applyUsage(result.usage)
    return result
  }

  function canAttemptCompaction(): boolean {
    return Boolean(compaction) && compactionFailures < 3
  }

  // Two paths call compaction:
  //   - reactive:  the backend threw ContextLengthExceeded. The failed
  //                completion produced no parts worth replaying, so
  //                only the summary is restored into history.
  //   - preemptive: the budget heuristic tripped after a successful
  //                 tool-result step. The tool-result message from
  //                 this turn is `buffered` so it can be translated
  //                 and replayed after the summary — preserving the
  //                 model's most-recent context across compaction.
  type CompactionMode =
    | { kind: "reactive" }
    | { kind: "preemptive"; buffered: Message[] }

  // "continue" — compaction succeeded or failed recoverably; caller
  //              re-enters the loop.
  // "fatal"    — retry budget exhausted; caller sets settleReason to
  //              "compaction_failed" and breaks.
  type CompactionOutcome = "continue" | "fatal"

  async function* attemptCompaction(
    mode: CompactionMode,
  ): AsyncGenerator<EngineEvent, CompactionOutcome, unknown> {
    if (!canAttemptCompaction()) {
      yield await record(
        diagnosticEvent("error", {
          message: "Compaction failed. Stopping.",
          turn,
        }),
      )
      return "fatal"
    }
    yield* emitCompactionStart()
    const result = await doCompact()
    if (result.kind === "compacted") {
      yield* emitCompactionEnd(result.usage)
      if (mode.kind === "reactive") {
        await journal.partition("compaction", [
          JournalEvent.message(result.summary),
        ])
        await send(result.summary, false)
      } else {
        const replay = translateBufferedMessages(mode.buffered)
        const nextMessages = [result.summary, ...replay]
        await journal.partition(
          "compaction",
          nextMessages.map((message) => JournalEvent.message(message)),
        )
        await send(result.summary, false)
        await sendAll(replay, false)
      }
      return "continue"
    }
    if (compactionFailures >= 3) {
      yield await record(
        diagnosticEvent("error", {
          message: "Compaction failed. Stopping.",
          turn,
        }),
      )
      return "fatal"
    }
    return "continue"
  }

  async function send(msg: Message, durable = true): Promise<void> {
    append(msg)
    if (durable) {
      await journal.event(JournalEvent.message(msg))
    }
  }

  async function sendAll(
    messages: readonly Message[],
    durable = true,
  ): Promise<void> {
    for (const message of messages) {
      await send(message, durable)
    }
  }

  // tool_use parts are stripped from the durable record — they land
  // as atomic pairs alongside their results (see executeToolCalls).
  // In-memory history keeps the full shape for downstream turns.
  async function sendAssistantResponse(message: Message): Promise<void> {
    append(message)
    const durableParts = message.parts.filter(
      (p) => p.type !== MessageType.ToolUse,
    )
    if (durableParts.length > 0) {
      await journal.event(
        JournalEvent.message({
          ...message,
          parts: durableParts,
        }),
      )
    }
  }

  await journal.scan((ev) => {
    if (ev.type === "message") {
      append(ev.message)
    }
  })

  if (prompt) {
    await send(userMessage(prompt))
  }

  try {
    while (maxTurns === 0 || turn < maxTurns) {
      if (abortSignal.aborted) {
        settleReason = "aborted"
        break
      }

      turn++
      yield lifecycleEvent("turn_start", { turn })

      const step: AgentStep = {
        turn,
        reasoning: [],
        toolCalls: [],
        usage: emptyUsage(),
        stopReason: StopReason.Unknown,
      }
      let stepFinalized = false
      async function* finalizeStep() {
        if (stepFinalized) {
          return
        }
        stepFinalized = true
        steps.push(step)
        yield await recordTurnEnd(step)
      }

      try {
        const turnConfig = await resolvePreStepOverrides(
          hooks,
          {
            turn,
            messages: [...history],
            toolSchemas: [...toolkitRuntime.schemas],
            steps,
            usage: {
              totalInputTokens,
              totalOutputTokens,
              totalCachedTokens,
            },
            budget: { maxContext, maxOutput },
            compactionCount,
          },
          {
            messages: history,
            toolSchemas: toolkitRuntime.schemas,
            model,
            effort,
          },
        )

        let response: CompletionResponse
        try {
          response = yield* forwardCompletion(
            backend.complete({
              model: turnConfig.model,
              system,
              messages: turnConfig.messages,
              tools: turnConfig.toolSchemas,
              effort: turnConfig.effort,
              maxOutput,
              signal: abortSignal,
            }),
            turn,
          )
        } catch (e) {
          if (
            e instanceof CompletionError &&
            e.kind === CompletionErrorKind.ContextLengthExceeded
          ) {
            yield await record(
              diagnosticEvent("warning", {
                turn,
                message: "Context length exceeded — compacting.",
              }),
            )
            yield* finalizeStep()
            const outcome = yield* attemptCompaction({ kind: "reactive" })
            if (outcome === "fatal") {
              settleReason = "compaction_failed"
              break
            }
            continue
          }
          throw e
        }

        step.usage = response.usage
        step.stopReason = response.stopReason
        applyUsage(response.usage)

        yield* emitResponseProgress(response, turn, step)

        const pendingToolCalls = extractToolCalls(response.messages)

        if (
          pendingToolCalls.length === 0 &&
          response.stopReason === StopReason.MaxTokens
        ) {
          await sendAll(response.messages)
          yield* finalizeStep()
          if (yield* handleCutoff()) {
            break
          }
          continue
        }

        consecutiveIncomplete = 0

        for (const msg of response.messages) {
          await sendAssistantResponse(msg)
        }

        if (pendingToolCalls.length === 0) {
          let override: string | void = undefined
          if (hooks?.postStep) {
            override = await hooks.postStep(step)
          }

          yield* finalizeStep()

          if (override) {
            await send(userMessage(override))
            continue
          }

          settleReason = step.stopReason
          break
        }

        const approvals = new Map<number, boolean>()
        if (hooks?.approve) {
          for (let i = 0; i < pendingToolCalls.length; i++) {
            const tc = pendingToolCalls[i]!
            const call: ToolCall = {
              toolUseId: tc.toolCallId,
              name: tc.name,
              arguments: tc.arguments,
            }
            approvals.set(i, await hooks.approve(call))
          }
        }

        const { resultParts, estimatedTokens } = yield* executeToolCalls(
          pendingToolCalls,
          toolkitRuntime,
          step,
          turn,
          abortSignal,
          history,
          approvals,
          workspace,
          journal,
          truncation?.maxInline,
        )

        // Pairs were already journaled inside executeToolCalls; this
        // batched message only keeps in-memory history in shape.
        const toolResultMsg: Message = { parts: resultParts }
        await send(toolResultMsg, false)

        const nextTurnInput =
          (response.usage?.inputTokens ?? 0) +
          (response.usage?.outputTokens ?? 0) +
          estimatedTokens

        if (nextTurnInput + compactSafetyMargin >= maxContext) {
          yield* finalizeStep()
          const outcome = yield* attemptCompaction({
            kind: "preemptive",
            buffered: [toolResultMsg],
          })
          if (outcome === "fatal") {
            settleReason = "compaction_failed"
            break
          }
          continue
        }

        yield* finalizeStep()
      } catch (e) {
        step.stopReason = StopReason.Unknown
        yield* finalizeStep()
        throw e
      }
    }

    const result: EngineResult = {
      steps,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      compactionCount,
      history,
      settleReason,
    }
    const runEndEvent = await record(
      lifecycleEvent("run_end", { result }),
      JournalEvent.runEnd(settleReason, {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedTokens: totalCachedTokens,
        compactionCount,
      }),
    )
    // run_end at the journal tail is the "finished cleanly" signal
    // reload consumers key off — commit so it's durable.
    await journal.commit()
    yield runEndEvent
    return result
  } finally {
    try {
      await toolkitRuntime.dispose?.()
    } catch {
      // Never mask the original outcome.
    }
  }
}

export function resolveRuntimeResources<W extends Workspace>(
  cfg: Pick<EngineConfig<W>, "journal" | "workspace">,
): { journal: Journal; workspace: W } {
  if (!cfg.journal || !cfg.workspace) {
    throw new Error('Pass both "journal" and "workspace".')
  }
  return {
    journal: cfg.journal,
    workspace: cfg.workspace,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

async function resolvePreStepOverrides(
  hooks: EngineHooks | undefined,
  input: PreStepInput,
  defaults: TurnConfig,
): Promise<TurnConfig> {
  if (!hooks?.preStep) {
    return defaults
  }
  const result = await hooks.preStep(input)
  if (!result) {
    return defaults
  }
  return {
    messages: result.messages ?? defaults.messages,
    toolSchemas: result.toolSchemas ?? defaults.toolSchemas,
    model: result.model ?? defaults.model,
    effort: result.effort ?? defaults.effort,
  }
}

async function* forwardCompletion(
  ret:
    | AsyncGenerator<CompletionDelta, CompletionResponse, void>
    | Promise<CompletionResponse>,
  turn: number,
): AsyncGenerator<EngineEvent, CompletionResponse, unknown> {
  const gen = asGenerator(ret)
  let next = await gen.next()
  while (!next.done) {
    const d = next.value
    switch (d.kind) {
      case "text_delta":
        yield progressEvent("text_delta", { turn, content: d.content })
        break
      case "thinking_delta":
        yield progressEvent("thinking_delta", { turn, content: d.content })
        break
      case "tool_input_delta":
        yield progressEvent("tool_input_delta", {
          toolCallId: d.toolCallId,
          chunk: d.chunk,
          turn,
        })
        break
      default: {
        const _: never = d
      }
    }
    next = await gen.next()
  }
  return next.value
}

async function* emitResponseProgress(
  response: CompletionResponse,
  turn: number,
  step: AgentStep,
): AsyncGenerator<EngineEvent, void, unknown> {
  for (const msg of response.messages) {
    for (const part of msg.parts) {
      if (part.type === MessageType.Think && part.content.trim()) {
        step.reasoning.push(part.content)
        yield progressEvent("thinking", { turn, content: part.content })
      } else if (
        part.type === MessageType.Text &&
        part.role === Role.Assistant &&
        part.content.trim()
      ) {
        step.text = step.text ? step.text + part.content : part.content
        yield progressEvent("text", { turn, content: part.content })
      }
    }
  }
}
