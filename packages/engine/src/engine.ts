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
  toolResultPart,
  type Message,
  userMessage,
} from "@ronde/core/message"
import { JournalEvent, type Journal } from "@ronde/core/journal"
import type { Lax } from "@ronde/core"
import type { ToolCall } from "@ronde/core/tool"
import { bindToolkitRuntime, type ToolResult } from "@ronde/core/toolkit"
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
import { splitResponse, translateBufferedMessages } from "./replay.js"
import { estimateTokens } from "@ronde/core/tokens"

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

function toList<T extends object>(v: T | readonly T[]): readonly T[] {
  return Array.isArray(v) ? v : [v as T]
}

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
 * Tool-call/tool-result pairs are journaled atomically as a single
 * `{ parts: [tool_use, tool_result] }` message, so the durable record
 * never contains an orphaned call without its result.
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

  // Seeded from the journal on startup; wiped and rebuilt on compaction.
  const history: Message[] = []
  // Per-turn digest accumulated across the run.
  const steps: AgentStep[] = []
  // Ticks on every loop iteration, including retry-after-compaction.
  let turn = 0
  // Totals across every completion call, including compaction calls.
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedTokens = 0
  // MaxTokens-without-tools breaker. Hits MAX_CONSECUTIVE_INCOMPLETE →
  // settleReason "cutoff_breaker".
  let consecutiveIncomplete = 0
  let compactionCount = 0
  // Consecutive compactions without a successful completion in between.
  // Reset when a completion returns. Hits 3 → fatal, catching both
  // pathological single-message overflows and compaction spirals.
  let compactionAttempts = 0
  // Default "max_turns" so bounded runs settle cleanly without a
  // natural stopReason.
  let settleReason: SettleReason = "max_turns"

  // Accumulate a per-call usage delta into the run totals.
  function applyUsage(usage: UsageStats): void {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCachedTokens += usage.cachedReadTokens
  }

  // Lifecycle events are observed and journaled together — the journal
  // entry shape differs from the observed event, so record() takes both.
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

  // Breaker for MaxTokens-without-tools: inject a "continue where you
  // left off" nudge up to MAX_CONSECUTIVE_INCOMPLETE times, then bail.
  // Returns true when the run should settle; false to stay in the loop.
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

  // In-memory only — no journal write. Use when the journal already
  // owns the message (atomic tool pairs, partition rewrites).
  function append(arg: Message | readonly Message[]): void {
    for (const m of toList(arg)) {
      history.push(m)
    }
  }

  // Durable commit: append to history AND journal each message.
  async function send(arg: Message | readonly Message[]): Promise<void> {
    append(arg)
    for (const m of toList(arg)) {
      await journal.event(JournalEvent.message(m))
    }
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

  // Run the configured strategy. On success, active history is wiped —
  // attemptCompaction rebuilds it from the summary (+ buffered replay).
  // Every attempt ticks compactionAttempts; only a successful completion
  // call clears it. Three consecutive attempts without a completion in
  // between is fatal.
  async function doCompact(): Promise<CompactionResult> {
    if (!compaction || compactionAttempts >= 3) {
      return { kind: "not_compacted", usage: emptyUsage() }
    }

    compactionCount++
    compactionAttempts++

    const result = await compaction.compact({
      backend,
      model,
      effort,
      history,
      maxOutput,
      signal: abortSignal,
    })

    if (result.kind === "compacted") {
      history.length = 0
    }

    applyUsage(result.usage)
    return result
  }

  function canAttemptCompaction(): boolean {
    return Boolean(compaction) && compactionAttempts < 3
  }

  // Two paths call compaction:
  //   - reactive:  the backend threw ContextLengthExceeded. The failed
  //                completion produced no parts worth replaying, so
  //                only the summary is restored into history.
  //   - preemptive: the budget heuristic tripped after a successful
  //                 tool step. The current turn's tool pairs are
  //                 `buffered` so they can be translated and replayed
  //                 after the summary — preserving the model's most-
  //                 recent context across compaction.
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
      const deferredReplay = translateBufferedMessages(result.deferred)
      const turnReplay =
        mode.kind === "preemptive"
          ? translateBufferedMessages(mode.buffered)
          : []
      const nextMessages = [result.summary, ...deferredReplay, ...turnReplay]
      await journal.partition(
        "compaction",
        nextMessages.map((message) => JournalEvent.message(message)),
      )
      append(nextMessages)
      return "continue"
    }
    if (compactionAttempts >= 3) {
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
        compactionAttempts = 0

        yield* emitResponseProgress(response, turn, step)

        const { messages, pendingCalls } = splitResponse(response.messages)

        if (
          pendingCalls.length === 0 &&
          response.stopReason === StopReason.MaxTokens
        ) {
          await send(messages)
          yield* finalizeStep()
          if (yield* handleCutoff()) {
            break
          }
          continue
        }

        consecutiveIncomplete = 0

        await send(messages)

        if (pendingCalls.length === 0) {
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
          for (let i = 0; i < pendingCalls.length; i++) {
            const tc = pendingCalls[i]!
            const call: ToolCall = {
              toolUseId: tc.toolCallId,
              name: tc.name,
              arguments: tc.arguments,
            }
            approvals.set(i, await hooks.approve(call))
          }
        }

        // Per-pair budget check: commit what fits, buffer the rest.
        // Once we start buffering we must keep buffering — tool pairs
        // are ordered, and replaying a later pair before an earlier
        // one that got deferred would scramble the transcript.
        let runningEstimate =
          (response.usage?.inputTokens ?? 0) +
          (response.usage?.outputTokens ?? 0)
        const buffered: Message[] = []
        const pendingByCallId = new Map(
          pendingCalls.map((tc) => [tc.toolCallId, tc]),
        )
        const settledByCallId = new Map<
          string,
          { content: string; result: ToolResult }
        >()

        for await (const event of executeToolCalls({
          calls: pendingCalls,
          toolkit: toolkitRuntime,
          turn,
          abort: abortSignal,
          history,
          workspace,
          approvals,
          maxInline: truncation?.maxInline,
        })) {
          if (event.type === "tool_result") {
            const toolUse = pendingByCallId.get(event.call.toolUseId)!
            const resultPart = toolResultPart({
              toolCallId: event.call.toolUseId,
              content: event.content,
              ok: event.result.ok,
            })
            settledByCallId.set(event.call.toolUseId, {
              content: event.content,
              result: event.result,
            })
            // Args already counted in response.outputTokens — only
            // the result content adds new pressure.
            runningEstimate += estimateTokens(event.content)
            const pair: Message = { parts: [toolUse, resultPart] }
            if (
              buffered.length === 0 &&
              runningEstimate + compactSafetyMargin < maxContext
            ) {
              await send(pair)
            } else {
              buffered.push(pair)
            }
          }
          yield event
        }

        // Call order, not settle order — stable trajectory export.
        for (const tc of pendingCalls) {
          const s = settledByCallId.get(tc.toolCallId)!
          step.toolCalls.push({
            id: tc.toolCallId,
            name: tc.name,
            args: tc.arguments,
            content: s.content,
            result: s.result,
          })
        }

        if (buffered.length > 0) {
          yield* finalizeStep()
          const outcome = yield* attemptCompaction({
            kind: "preemptive",
            buffered,
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
