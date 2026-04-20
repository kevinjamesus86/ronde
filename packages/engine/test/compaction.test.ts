import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
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
          return { kind: "compacted", summary, usage: emptyUsage() }
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
            return { kind: "compacted" as const, summary, usage: emptyUsage() }
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
          return { kind: "compacted" as const, summary, usage: emptyUsage() }
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

  it("buffers current-turn output when context is exceeded mid-turn", async () => {
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
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(backend.requests[1]?.messages).toHaveLength(2)
    expect(backend.requests[1]?.messages[1]).toEqual(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: MessageType.Text,
            role: Role.User,
            content: expect.stringContaining("[user tool result]"),
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
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(backend.requests[1]?.messages[0]).toEqual(userMessage("summary"))
    const secondMsg = backend.requests[1]?.messages[1]
    expect(
      secondMsg?.parts.every(
        (p) => p.type === MessageType.Text && p.role === Role.User,
      ),
    ).toBe(true)
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
            usage: emptyUsage(),
          }
        },
      },
    })

    expect(backend.requests[1]?.messages[1]).toEqual({
      parts: [
        {
          type: MessageType.Text,
          role: Role.User,
          content: expect.stringContaining("[user tool result]"),
        },
      ],
    })
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

  it("trips the breaker after 3 not_compacted results from Path B", async () => {
    let compactionCalls = 0
    const backend = mockHandler(() => toolResponse("echo", { text: "hi" }), {
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
    // Path B never emits compaction_end on not_compacted — it's only
    // paired with a successful compact. Asserting that here protects
    // against any future refactor that moves the event placement.
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
            usage: emptyUsage(),
          }
        },
      },
    })

    // Exactly one partition with reason "compaction", carrying the
    // turn-1 slice: prompt, tool-pair, turn_end, plus the
    // compaction_start/end bracket (those are durable events that
    // happen before the partition call, so they ride along into the
    // archive).
    expect(journal.archived).toHaveLength(1)
    expect(journal.archived[0]?.reason).toBe("compaction")
    const archivedTypes = journal.archived[0]!.events.map((ev) => ev.type)
    expect(archivedTypes).toContain("turn_end")
    expect(
      archivedTypes.filter((t) => t === "message").length,
    ).toBeGreaterThanOrEqual(2)

    // The active slice after partition starts with the summary then
    // the translated tool-result buffer. The second turn's text +
    // turn_end + run_end land on top of that.
    const postPartition = journal.active.map((ev) => ev.type)
    expect(postPartition[0]).toBe("message") // summary
    expect(postPartition[1]).toBe("message") // translated tool_result replay
    expect(postPartition.at(-1)).toBe("run_end")
  })

  it("resets compactionFailures to 0 after a successful compact following prior not_compacted results", async () => {
    let compactionCalls = 0
    // Every turn overruns budget so Path B fires each time. The
    // strategy refuses twice, succeeds once, then refuses again —
    // the fourth refusal must NOT trip the 3-strike breaker, because
    // the successful compact in between resets the counter.
    const backend = mockHandler(() => toolResponse("echo", { text: "hi" }), {
      config: { maxContext: 1000, maxOutput: 200 },
    })

    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
      // Cap the run so we can observe without tripping another breaker.
      maxTurns: 5,
      compaction: {
        async compact() {
          compactionCalls++
          // fail, fail, succeed, fail, fail
          if (compactionCalls === 3) {
            return {
              kind: "compacted" as const,
              summary: userMessage("summary"),
              usage: emptyUsage(),
            }
          }
          return { kind: "not_compacted" as const, usage: emptyUsage() }
        },
      },
    })

    expect(compactionCalls).toBeGreaterThanOrEqual(5)
    // With the reset, we reach maxTurns instead of compaction_failed.
    // Without the reset, the breaker would trip on the 5th call
    // (2 fails + 1 success + 2 fails = breaker if counter didn't reset,
    //  but with reset the trailing streak is only 2 → no trip).
    expect(result.settleReason).toBe("max_turns")
  })
})
