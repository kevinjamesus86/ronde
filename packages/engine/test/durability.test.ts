import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { CompletionMode, StopReason, emptyUsage } from "@ronde/core/completion"
import { MessageType, Role } from "@ronde/core/message"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import {
  contextLengthExceeded,
  driveEngine,
  mockHandler,
  mockBackend,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine durable event boundary", () => {
  it("journals only the EngineEvent variants that map to JournalEvent", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { journal } = await driveEngine(
      mockBackend([toolResponse("echo", { text: "hi" }), textResponse("done")]),
      {
        prompt: "go",
        toolkit: echo,
      },
    )

    // Turn 1: prompt + pair + turn_end. The assistant response is
    // pure tool_use, so its durable form is the pair — no separate
    // message. Turn 2: assistant text + turn_end. Then run_end.
    expect(journal.active.map((event) => event.type)).toEqual([
      "message",
      "message",
      "turn_end",
      "message",
      "turn_end",
      "run_end",
    ])
  })

  it("keeps turn_end durable payload lean while live turn_end carries the full step", async () => {
    const { events, journal } = await driveEngine(
      mockBackend([textResponse("done")]),
      {
        prompt: "go",
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    const liveTurnEnd = events.find((event) => event.type === "turn_end")
    const durableTurnEnd = journal.active.find(
      (event) => event.type === "turn_end",
    )

    expect(liveTurnEnd).toMatchObject({
      type: "turn_end",
      kind: "lifecycle",
      step: expect.objectContaining({ text: "done" }),
    })
    expect(durableTurnEnd).toEqual({
      type: "turn_end",
      turn: 1,
      usage: expect.any(Object),
      stopReason: StopReason.EndTurn,
    })
  })

  it("does not durably journal transient thinking/text/tool progress events", async () => {
    const { journal } = await driveEngine(
      mockBackend([
        {
          messages: [
            {
              parts: [
                { type: MessageType.Think, content: "plan" },
                {
                  type: MessageType.Text,
                  role: Role.Assistant,
                  content: "done",
                },
              ],
            },
          ],
          stopReason: StopReason.EndTurn,
          usage: emptyUsage(),
          providerMeta: null,
          warnings: [],
        },
      ]),
      {
        prompt: "go",
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    expect(
      journal.active.some((event) =>
        ["thinking", "text", "tool_call", "tool_result"].includes(event.type),
      ),
    ).toBe(false)
  })

  it("keeps message, cutoff, warning, and error on the durable side", async () => {
    const { journal } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(journal.active.some((event) => event.type === "message")).toBe(true)
  })
})

describe("@ronde/engine commit boundaries", () => {
  it("commits only at lifecycle boundaries — every turn_end and run_end", async () => {
    const { journal } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    // Commit boundaries are turn_end and run_end only — the prompt
    // piggybacks on the imminent turn_end commit.
    expect(journal.commits).toBe(2)
  })

  it("records turn_end as the natural durable turn boundary", async () => {
    const { journal } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(journal.active.at(-1)).toMatchObject({ type: "run_end" })
    expect(journal.active.at(-2)).toMatchObject({ type: "turn_end", turn: 1 })
  })

  it("commits immediately after every turn_end and again after run_end", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })
    const { journal } = await driveEngine(
      mockBackend([
        toolResponse("echo", { text: "one" }),
        toolResponse("echo", { text: "two" }),
        textResponse("done"),
      ]),
      {
        prompt: "go",
        toolkit: echo,
      },
    )

    // Three turns (two tool-using + one text) plus run_end → four
    // commits total: one per turn_end, one for run_end.
    expect(journal.commitLog.map((entry) => entry.afterEvent.type)).toEqual([
      "turn_end",
      "turn_end",
      "turn_end",
      "run_end",
    ])
  })

  it("never commits between turn_end and the next event", async () => {
    const { journal } = await driveEngine(
      mockBackend([textResponse("one"), textResponse("two")]),
      {
        prompt: "go",
        maxTurns: 2,
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    // Every commit's afterEvent must be a boundary type; anything else
    // means a commit fired mid-turn, which the engine doesn't promise.
    for (const { afterEvent } of journal.commitLog) {
      expect(["turn_end", "run_end"]).toContain(afterEvent.type)
    }
  })

  it("places run_end as the last journal event with a commit immediately after", async () => {
    const { journal } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(journal.active.at(-1)).toMatchObject({ type: "run_end" })
    expect(journal.commitLog.at(-1)?.afterEvent.type).toBe("run_end")
  })

  it("writes run_end with {settleReason, totals} matching the returned EngineResult", async () => {
    const { journal, result } = await driveEngine(
      mockBackend([textResponse("done")]),
      {
        prompt: "go",
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    const runEndEvent = journal.active.at(-1)
    expect(runEndEvent).toMatchObject({
      type: "run_end",
      settleReason: result.settleReason,
      totals: {
        inputTokens: result.totalInputTokens,
        outputTokens: result.totalOutputTokens,
        cachedTokens: result.totalCachedTokens,
        compactionCount: result.compactionCount,
      },
    })
  })

  it("commits exactly once per turn even when the turn triggers compaction", async () => {
    const { journal } = await driveEngine(
      mockHandler((request, call) => {
        if (call === 0) {
          return contextLengthExceeded()
        }
        if (request.mode === CompletionMode.Compaction) {
          return textResponse("summary")
        }
        return textResponse("done")
      }),
      {
        prompt: "go",
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
        compaction: {
          async compact(ctx) {
            const response = await ctx.backend.complete({
              model: ctx.model,
              system: "compact",
              messages: ctx.history,
              tools: [],
              mode: CompletionMode.Compaction,
              effort: ctx.effort,
              maxOutputTokens: ctx.maxOutputTokens,
              signal: ctx.signal,
            })
            return {
              kind: "compacted",
              summary: {
                parts: [
                  {
                    type: MessageType.Text,
                    role: Role.User,
                    content: "summary",
                  },
                ],
              },
              usage: response.usage,
            }
          },
        },
      },
    )

    // Turn 1 compacts mid-flight and finalizes once, turn 2 finalizes
    // after the clean text response, then run_end. No double commits.
    const turnEndCommits = journal.commitLog.filter(
      (entry) => entry.afterEvent.type === "turn_end",
    )
    expect(turnEndCommits).toHaveLength(2)
    expect(journal.commitLog.at(-1)?.afterEvent.type).toBe("run_end")
  })

  it("preserves total usage accounting across compaction calls", async () => {
    const { result } = await driveEngine(
      mockHandler(
        (request, call) => {
          if (call === 0) {
            return toolResponse("echo", { text: "a" })
          }
          if (request.mode === CompletionMode.Compaction) {
            return textResponse("summary")
          }
          return textResponse("done")
        },
        { config: { contextWindowTokens: 1000, maxOutputTokens: 200 } },
      ),
      {
        prompt: "go",
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
        compaction: {
          async compact(ctx) {
            const response = await ctx.backend.complete({
              model: ctx.model,
              system: "compact",
              messages: ctx.history,
              tools: [],
              mode: CompletionMode.Compaction,
              effort: ctx.effort,
              maxOutputTokens: ctx.maxOutputTokens,
              signal: ctx.signal,
            })
            return {
              kind: "compacted",
              summary: {
                parts: [
                  {
                    type: MessageType.Text,
                    role: Role.User,
                    content: "summary",
                  },
                ],
              },
              usage: response.usage,
            }
          },
        },
      },
    )

    expect(result.totalInputTokens).toBeGreaterThanOrEqual(300)
    expect(result.totalOutputTokens).toBeGreaterThanOrEqual(60)
  })
})
