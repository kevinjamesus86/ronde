import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { text } from "@ronde/core/block"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import { MessageType, Role, userMessage } from "@ronde/core/message"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import { engine } from "@ronde/engine"
import {
  contextLengthExceeded,
  createRuntime,
  driveEngine,
  emptyToolkit,
  mockHandler,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine compaction integration", () => {
  it("reacts to ContextLengthExceeded by invoking the configured compaction strategy", async () => {
    let compactionCalls = 0
    const summary = userMessage("summary")
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact(ctx) {
          compactionCalls++
          expect(ctx.history).toEqual([userMessage("go")])
          return {
            kind: "compacted",
            summary,
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(compactionCalls).toBe(1)
    expect(result.history[0]).toEqual(summary)
    expect(result.settleReason).toBe(StopReason.EndTurn)
  })

  it("emits compaction_start before the strategy runs", async () => {
    let compactionCalls = 0
    const runtime = createRuntime()
    const gen = engine(
      mockHandler(
        (_request, call) => {
          if (call === 0) {
            return contextLengthExceeded()
          }
          return textResponse("done")
        },
        { config: { maxContext: 1000, maxOutput: 200 } },
      ),
      {
        journal: runtime.journal,
        workspace: runtime.workspace,
        prompt: "go",
        toolkit: emptyToolkit(),
        compaction: {
          async compact() {
            compactionCalls++
            return {
              kind: "compacted" as const,
              summary: userMessage("summary"),
              deferred: [],
              usage: emptyUsage(),
            }
          },
        },
      },
    )

    try {
      for (;;) {
        const next = await gen.next()
        if (next.done) {
          break
        }
        if (next.value.type === "compaction_start") {
          expect(compactionCalls).toBe(0)
          break
        }
      }
    } finally {
      await gen.return(undefined as never).catch(() => {})
    }
  })

  it("emits compaction_end with the compaction call usage", async () => {
    const usage = {
      ...emptyUsage(),
      inputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 3,
    }
    const { events } = await driveEngine(
      mockHandler(
        (_request, call) => {
          if (call === 0) {
            return contextLengthExceeded()
          }
          return textResponse("done")
        },
        { config: { maxContext: 1000, maxOutput: 200 } },
      ),
      {
        prompt: "go",
        toolkit: emptyToolkit(),
        compaction: {
          async compact() {
            return {
              kind: "compacted" as const,
              summary: userMessage("summary"),
              deferred: [],
              usage,
            }
          },
        },
      },
    )

    expect(events.find((event) => event.type === "compaction_end")).toEqual({
      kind: "lifecycle",
      type: "compaction_end",
      turn: 1,
      usage,
    })
  })

  it("replaces active history with the compacted summary when compaction succeeds", async () => {
    const summary = userMessage("summary")
    const { journal } = await driveEngine(
      mockHandler(
        (_request, call) => {
          if (call === 0) {
            return contextLengthExceeded()
          }
          return textResponse("done")
        },
        { config: { maxContext: 1000, maxOutput: 200 } },
      ),
      {
        prompt: "go",
        toolkit: emptyToolkit(),
        compaction: {
          async compact() {
            return {
              kind: "compacted" as const,
              summary,
              deferred: [],
              usage: emptyUsage(),
            }
          },
        },
      },
    )

    expect(journal.archived).toHaveLength(1)
    expect(journal.archived[0]?.reason).toBe("compaction")
    expect(journal.active[0]).toEqual({
      type: "message",
      message: summary,
    })
  })

  it("continues the loop from the replacement active context", async () => {
    const summary = userMessage("summary")
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary,
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(backend.requests[1]?.messages).toEqual([summary])
  })
})

describe("@ronde/engine buffered-turn compaction", () => {
  const echo = tool()({
    name: "echo",
    description: "Echo",
    parameters: z.object({ text: z.string() }),
    execute: async (args) => ok(args.text),
  })

  it("buffers current-turn tool pairs when context is exceeded mid-turn", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(backend.requests[1]?.messages).toHaveLength(3)
    expect(backend.requests[1]?.messages[1]).toEqual(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: MessageType.Text,
            role: Role.Assistant,
            content: expect.stringContaining("[assistant tool call] echo"),
          }),
        ],
      }),
    )
    expect(backend.requests[1]?.messages[2]).toEqual(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: MessageType.Text,
            role: Role.User,
            content: expect.stringContaining("[user tool result] echo"),
          }),
        ],
      }),
    )
  })

  it("replays summary before buffered text-only current-turn content", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    const messages = backend.requests[1]?.messages ?? []
    expect(messages[0]).toEqual(userMessage("summary"))
    const replayed = messages.slice(1)
    expect(
      replayed.every((m) => m.parts.every((p) => p.type === MessageType.Text)),
    ).toBe(true)
  })

  it("per-pair budget — commits pairs that fit, buffers the excess", async () => {
    const big = tool()({
      name: "big",
      description: "returns a large payload",
      parameters: z.object({ size: z.number() }),
      execute: async (args) => ok("x".repeat(args.size)),
    })

    // Two tool calls in one response. Default usage has inputTokens=100,
    // outputTokens=30 → runningEstimate starts at 130.
    // compactSafetyMargin clamps to 4000.
    //
    //  - "small" adds ~5 tokens → 130+5+4000 = 4135 < maxContext (5000) → commits
    //  - "huge"  adds ~700 tokens → 135+700+4000 = 4835 ≥ maxContext (5000)? No,
    //    still under. Bump "huge" to ~2000 chars to push over: 135+~667+4000>5000 ✗
    //    Use size 3000 to be safe: estimated tokens >= 1000.
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return {
            messages: [
              {
                parts: [
                  {
                    type: MessageType.ToolUse as const,
                    toolCallId: "t-small",
                    name: "big",
                    arguments: { size: 1 },
                  },
                  {
                    type: MessageType.ToolUse as const,
                    toolCallId: "t-huge",
                    name: "big",
                    arguments: { size: 3000 },
                  },
                ],
              },
            ],
            stopReason: StopReason.ToolUse,
            usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 30 },
            providerMeta: null,
            warnings: [],
          }
        }
        return textResponse("done")
      },
      { config: { maxContext: 5000, maxOutput: 200 } },
    )

    const { journal } = await driveEngine(backend, {
      prompt: "go",
      toolkit: big,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    // The small pair was committed via send() before compaction, so it
    // lands in the archived slice as a real tool-use + tool-result
    // message (not as translated text). The archive contains the
    // prompt plus that one pair.
    const archivedMessages = journal.archived[0]!.events.filter(
      (ev) => ev.type === "message",
    ).map((ev) => ev.message)
    const archivedToolUses = archivedMessages.flatMap((m) =>
      m.parts.filter((p) => p.type === MessageType.ToolUse),
    )
    expect(archivedToolUses.map((p) => p.toolCallId)).toEqual(["t-small"])

    // The huge pair was buffered and replayed as translated text in
    // the new active slice — the next turn's request sees exactly
    // the huge pair's translation, not the small one (which is
    // already covered by the summary).
    const nextRequest = backend.requests[1]?.messages ?? []
    expect(nextRequest[0]).toEqual(userMessage("summary"))
    const translatedIds = nextRequest
      .slice(1)
      .flatMap((m) => m.parts)
      .flatMap((p) =>
        p.type === MessageType.Text
          ? [...p.content.matchAll(/id: (\S+)/g)].map((m) => m[1]!)
          : [],
      )
    expect(translatedIds).toEqual(["t-huge", "t-huge"])
  })

  it("drops provider-specific reasoning artifacts from buffered replay", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    const messages = backend.requests[1]?.messages ?? []
    const replayedParts = messages
      .slice(1)
      .flatMap((m) => m.parts.map((p) => p.type))
    expect(replayedParts.every((t) => t === MessageType.Text)).toBe(true)
  })
})

describe("@ronde/engine deferred replay", () => {
  const echo = tool()({
    name: "echo",
    description: "Echo",
    parameters: z.object({ text: z.string() }),
    execute: async (args) => ok(args.text),
  })

  it("splices deferred text messages after the summary on the reactive path", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [userMessage("older-thing")],
            usage: emptyUsage(),
          }
        },
      },
    })

    const messages = backend.requests[1]?.messages ?? []
    expect(messages[0]).toEqual(userMessage("summary"))
    expect(messages[1]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      role: Role.User,
      content: expect.stringContaining("older-thing"),
    })
  })

  it("flattens deferred tool pairs via translateBufferedMessages", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const deferredPair = {
      parts: [
        {
          type: MessageType.ToolUse as const,
          toolCallId: "call_prior",
          name: "search",
          arguments: { q: "prior" },
        },
        {
          type: MessageType.ToolResult as const,
          toolCallId: "call_prior",
          ok: true,
          content: [text("prior result")],
        },
      ],
    }

    await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [deferredPair],
            usage: emptyUsage(),
          }
        },
      },
    })

    const messages = backend.requests[1]?.messages ?? []
    expect(messages).toHaveLength(3)
    expect(messages[1]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      role: Role.Assistant,
      content: expect.stringContaining("[assistant tool call] search"),
    })
    expect(messages[2]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      role: Role.User,
      content: expect.stringContaining("[user tool result] search"),
    })
  })

  it("orders post-compaction history as [summary, ...deferred-replay, ...turn-replay]", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [userMessage("deferred-text")],
            usage: emptyUsage(),
          }
        },
      },
    })

    const messages = backend.requests[1]?.messages ?? []
    expect(messages[0]).toEqual(userMessage("summary"))
    expect(messages[1]?.parts[0]).toMatchObject({
      content: expect.stringContaining("deferred-text"),
    })
    expect(messages[2]?.parts[0]).toMatchObject({
      content: expect.stringContaining("[assistant tool call] echo"),
    })
    expect(messages[3]?.parts[0]).toMatchObject({
      content: expect.stringContaining("[user tool result] echo"),
    })
  })

  it("writes the full deferred replay into the new compaction partition", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { journal } = await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [userMessage("deferred-text")],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(journal.archived).toHaveLength(1)
    // First active event is the summary; second is the flattened deferred.
    expect(journal.active[0]).toMatchObject({
      type: "message",
      message: userMessage("summary"),
    })
    expect(journal.active[1]).toMatchObject({ type: "message" })
    const second = journal.active[1]
    if (second?.type === "message") {
      expect(second.message.parts[0]).toMatchObject({
        content: expect.stringContaining("deferred-text"),
      })
    }
  })
})

describe("@ronde/engine compaction breaker", () => {
  it("counts consecutive compaction failures", async () => {
    let compactionCalls = 0
    const backend = mockHandler(
      (_request, call) => {
        if (call < 3) {
          return contextLengthExceeded()
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { result, events } = await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          compactionCalls++
          if (compactionCalls < 3) {
            return { kind: "not_compacted" as const, usage: emptyUsage() }
          }
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(compactionCalls).toBe(3)
    expect(result.compactionCount).toBe(3)
    expect(
      events.filter((event) => event.type === "compaction_start"),
    ).toHaveLength(3)
    expect(
      events.filter((event) => event.type === "compaction_end"),
    ).toHaveLength(1)
    expect(result.settleReason).toBe(StopReason.EndTurn)
  })

  it("stops invoking compaction after the breaker threshold", async () => {
    let compactionCalls = 0
    const backend = mockHandler(() => contextLengthExceeded(), {
      config: { maxContext: 1000, maxOutput: 200 },
    })

    const { result, events } = await driveEngine(backend, {
      prompt: "go",
      toolkit: emptyToolkit(),
      compaction: {
        async compact() {
          compactionCalls++
          return { kind: "not_compacted" as const, usage: emptyUsage() }
        },
      },
    })

    expect(compactionCalls).toBe(3)
    expect(result.compactionCount).toBe(3)
    expect(
      events.filter((event) => event.type === "compaction_start"),
    ).toHaveLength(3)
    expect(result.settleReason).toBe("compaction_failed")
  })

  it("settles with compaction_failed when the breaker trips", async () => {
    const { result, events } = await driveEngine(
      mockHandler(() => contextLengthExceeded(), {
        config: { maxContext: 1000, maxOutput: 200 },
      }),
      {
        prompt: "go",
        toolkit: emptyToolkit(),
        compaction: {
          async compact() {
            return { kind: "not_compacted" as const, usage: emptyUsage() }
          },
        },
      },
    )

    const error = events.findLast((event) => event.type === "error")
    expect(result.settleReason).toBe("compaction_failed")
    expect(error).toEqual({
      kind: "diagnostic",
      type: "error",
      turn: 3,
      message: "Compaction failed. Stopping.",
    })
  })
})

/*
 * Path B is pre-emptive compaction after a successful tool turn whose
 * next-turn budget estimate overflows the context window. Path A (above)
 * is reactive — only fires when the backend actually throws
 * ContextLengthExceeded. The two share orchestration but reach it from
 * different edges, so the breaker / no-strategy / partition shape need
 * their own Path B coverage.
 */
describe("@ronde/engine Path B compaction boundaries", () => {
  const echo = tool()({
    name: "echo",
    description: "Echo",
    parameters: z.object({ text: z.string() }),
    execute: async (args) => ok(args.text),
  })

  it("settles with compaction_failed when the budget trips with no strategy configured", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { result, events } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      // compaction omitted — canAttemptCompaction() returns false
    })

    // No thrown ContextLengthExceeded — Path B tripped on the
    // post-tool budget heuristic, found no strategy, and settled.
    expect(result.settleReason).toBe("compaction_failed")
    expect(events.findLast((event) => event.type === "error")).toMatchObject({
      type: "error",
      message: "Compaction failed. Stopping.",
    })
  })

  it("trips the breaker after 3 consecutive compactions without a successful completion", async () => {
    let compactionCalls = 0
    const backend = mockHandler(() => contextLengthExceeded(), {
      config: { maxContext: 1000, maxOutput: 200 },
    })

    const { result, events } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          compactionCalls++
          return { kind: "not_compacted" as const, usage: emptyUsage() }
        },
      },
    })

    expect(compactionCalls).toBe(3)
    expect(result.compactionCount).toBe(3)
    expect(result.settleReason).toBe("compaction_failed")
    expect(
      events.filter((event) => event.type === "compaction_start"),
    ).toHaveLength(3)
    // not_compacted never emits compaction_end — only successful
    // compacts do.
    expect(
      events.filter((event) => event.type === "compaction_end"),
    ).toHaveLength(0)
  })

  it("partitions archived prior history and republishes [summary, ...replay] as the new active slice", async () => {
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          return toolResponse("echo", { text: "hi" })
        }
        return textResponse("done")
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { journal } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    // Exactly one partition with reason "compaction", carrying the
    // turn-1 slice: prompt, turn_end, plus the compaction_start/end
    // bracket. The tool pair itself is NOT in the archive — once
    // preemptive compaction trips, the current turn's pairs are
    // buffered in memory and replayed as translated text in the new
    // active slice instead of being durably written pre-partition.
    expect(journal.archived).toHaveLength(1)
    expect(journal.archived[0]?.reason).toBe("compaction")
    const archivedTypes = journal.archived[0]!.events.map((ev) => ev.type)
    expect(archivedTypes).toContain("turn_end")
    expect(archivedTypes).toContain("compaction_start")
    expect(archivedTypes).toContain("compaction_end")
    expect(archivedTypes.filter((t) => t === "message")).toHaveLength(1)

    // The active slice after partition starts with the summary then
    // the translated tool-result buffer. The second turn's text +
    // turn_end + run_end land on top of that.
    const postPartition = journal.active.map((ev) => ev.type)
    expect(postPartition[0]).toBe("message") // summary
    expect(postPartition[1]).toBe("message") // translated tool_result replay
    expect(postPartition.at(-1)).toBe("run_end")
  })

  it("resets compactionAttempts when a completion succeeds between compactions", async () => {
    let compactionCalls = 0
    // Alternate throwing and succeeding so each throw triggers a reactive
    // compaction but the next completion still returns — exercises the
    // "completion success clears the counter" path.
    const backend = mockHandler(
      (_request, call) => {
        if (call % 2 === 0) {
          return contextLengthExceeded()
        }
        return toolResponse("echo", { text: "hi" })
      },
      { config: { maxContext: 1000, maxOutput: 200 } },
    )

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      maxTurns: 4,
      compaction: {
        async compact() {
          compactionCalls++
          return { kind: "not_compacted" as const, usage: emptyUsage() }
        },
      },
    })

    // Each throw ticks compactionAttempts; each success resets it.
    // We never accumulate 3 strikes in a row, so maxTurns settles it.
    expect(compactionCalls).toBeGreaterThanOrEqual(3)
    expect(result.settleReason).toBe("max_turns")
  })
})

/*
 * Path B threshold formula:
 *   nextTurnInput = response.usage.inputTokens
 *                 + response.usage.outputTokens
 *                 + estimatedTokens   (tool result, not yet sent)
 *   fires when: nextTurnInput + compactSafetyMargin >= maxContext
 *
 * compactSafetyMargin = clamp(floor(maxContext * 0.025), 4_000, 10_000)
 * At maxContext = 100_000 → margin clamps to 4_000 (floor).
 *
 * So the trip line is nextTurnInput >= 96_000. The tests below set
 * measured inputTokens on either side of that line and assert
 * compaction fires / doesn't fire accordingly.
 */
describe("@ronde/engine Path B threshold formula", () => {
  const echo = tool()({
    name: "echo",
    description: "Echo",
    parameters: z.object({ text: z.string() }),
    execute: async (args) => ok(args.text),
  })

  it("fires when measured input + output + tool-result estimate + safety margin meets maxContext", async () => {
    let compactionCalls = 0
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          // inputTokens=99_000 + outputTokens=30 + tiny tool-result estimate
          // + 4_000 margin ≈ 103K, well over the 100K ceiling → fires.
          return toolResponse(
            "echo",
            { text: "hi" },
            { usage: { inputTokens: 99_000, outputTokens: 30 } },
          )
        }
        return textResponse("done")
      },
      { config: { maxContext: 100_000, maxOutput: 32_000 } },
    )

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          compactionCalls++
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(compactionCalls).toBe(1)
    expect(result.compactionCount).toBe(1)
  })

  it("does not fire when measured input + output + tool-result estimate + safety margin stays under maxContext", async () => {
    let compactionCalls = 0
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          // inputTokens=50_000 + outputTokens=30 + tiny estimate + 4_000 margin
          // ≈ 54K, well under the 100K ceiling → must not fire.
          return toolResponse(
            "echo",
            { text: "hi" },
            { usage: { inputTokens: 50_000, outputTokens: 30 } },
          )
        }
        return textResponse("done")
      },
      { config: { maxContext: 100_000, maxOutput: 32_000 } },
    )

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          compactionCalls++
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(compactionCalls).toBe(0)
    expect(result.compactionCount).toBe(0)
  })

  it("does not re-fire on the next tool turn when post-compaction measured inputTokens falls below the threshold", async () => {
    let compactionCalls = 0
    const backend = mockHandler(
      (_request, call) => {
        if (call === 0) {
          // Near threshold — triggers compaction.
          return toolResponse(
            "echo",
            { text: "hi" },
            {
              usage: { inputTokens: 99_000, outputTokens: 30 },
              toolCallId: "echo-call-1",
            },
          )
        }
        if (call === 1) {
          // Post-compaction tool turn: the provider now reports a small
          // inputTokens for the trimmed history, so the check must pass
          // even though we're still on a tool-using turn.
          return toolResponse(
            "echo",
            { text: "ok" },
            {
              usage: { inputTokens: 500, outputTokens: 20 },
              toolCallId: "echo-call-2",
            },
          )
        }
        return textResponse("done")
      },
      { config: { maxContext: 100_000, maxOutput: 32_000 } },
    )

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      compaction: {
        async compact() {
          compactionCalls++
          return {
            kind: "compacted" as const,
            summary: userMessage("summary"),
            deferred: [],
            usage: emptyUsage(),
          }
        },
      },
    })

    // Exactly one compaction. If the check re-fired on turn 2 despite
    // the drop in measured inputTokens, this would be ≥ 2.
    expect(compactionCalls).toBe(1)
    expect(result.compactionCount).toBe(1)
  })
})
