import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import { MessageType, userMessage } from "@ronde/core/message"
import { JournalEvent } from "@ronde/core/journal"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import { engine, resolveRuntimeResources } from "@ronde/engine"
import {
  contextLengthExceeded,
  cutoffResponse,
  createRuntime,
  driveEngine,
  mockBackend,
  mockHandler,
  streamingBackend,
  TestJournal,
  TestWorkspace,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine resolveRuntimeResources", () => {
  it("returns the provided journal/workspace pair when both are present", () => {
    const journal = new TestJournal()
    const workspace = new TestWorkspace()

    expect(resolveRuntimeResources({ journal, workspace })).toEqual({
      journal,
      workspace,
    })
  })

  it('throws when "journal" is missing', () => {
    expect(() =>
      resolveRuntimeResources({
        journal: undefined as never,
        workspace: new TestWorkspace(),
      }),
    ).toThrow('Pass both "journal" and "workspace".')
  })

  it('throws when "workspace" is missing', () => {
    expect(() =>
      resolveRuntimeResources({
        journal: new TestJournal(),
        workspace: undefined as never,
      }),
    ).toThrow('Pass both "journal" and "workspace".')
  })
})

describe("@ronde/engine loop progression", () => {
  it("replays the active journal slice into history before the first turn", async () => {
    const runtime = createRuntime()
    await runtime.journal.event(JournalEvent.message(userMessage("seeded")))

    const { result } = await driveEngine(mockBackend([textResponse("done")]), {
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(result.history[0]).toEqual(userMessage("seeded"))
  })

  it("yields turn_start and turn_end in order for each turn", async () => {
    const runtime = createRuntime()
    const gen = engine(mockBackend([textResponse("done")]), {
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    const events: string[] = []
    try {
      let next = await gen.next()
      while (!next.done) {
        events.push(next.value.type)
        next = await gen.next()
      }
    } finally {
      await gen.return(undefined as never).catch(() => {})
    }

    expect(events.indexOf("turn_start")).toBeLessThan(
      events.indexOf("turn_end"),
    )
  })

  it("returns EngineResult with steps, history, usage totals, and settleReason", async () => {
    const { result } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(result.steps).toHaveLength(1)
    expect(result.history.length).toBeGreaterThan(0)
    expect(result.totalInputTokens).toBeGreaterThan(0)
    expect(result.totalOutputTokens).toBeGreaterThan(0)
    expect(result.settleReason).toBe(StopReason.EndTurn)
  })
})

describe("@ronde/engine settle reasons", () => {
  it("settles with the model stopReason on a clean natural exit", async () => {
    const { result } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(result.settleReason).toBe(StopReason.EndTurn)
  })

  it("settles with max_turns when the safety cap is reached", async () => {
    const echo = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })
    const { result } = await driveEngine(
      mockBackend([
        toolResponse("echo", { text: "one" }),
        toolResponse("echo", { text: "two" }),
      ]),
      {
        prompt: "go",
        toolkit: echo,
        maxTurns: 1,
      },
    )

    expect(result.settleReason).toBe("max_turns")
  })

  it("settles with aborted when the abort signal trips at a turn boundary", async () => {
    const controller = new AbortController()
    controller.abort()

    const { result } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      signal: controller.signal,
    })

    expect(result.settleReason).toBe("aborted")
    expect(result.steps).toHaveLength(0)
  })

  it("settles with cutoff_breaker after repeated incomplete responses", async () => {
    const { result } = await driveEngine(
      mockBackend([
        cutoffResponse("partial"),
        cutoffResponse("partial"),
        cutoffResponse("partial"),
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

    expect(result.settleReason).toBe("cutoff_breaker")
  })

  it("settles with compaction_failed after repeated compaction failure", async () => {
    const { result } = await driveEngine(
      mockHandler(() => contextLengthExceeded(), {
        config: { contextWindowTokens: 1000, maxOutputTokens: 200 },
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
          async compact() {
            return { kind: "not_compacted", usage: emptyUsage() }
          },
        },
      },
    )

    expect(result.settleReason).toBe("compaction_failed")
  })
})

describe("@ronde/engine startup coherence", () => {
  it("accepts replay history with paired tool call and tool result messages", async () => {
    const runtime = createRuntime()
    await runtime.journal.event(
      JournalEvent.message({
        parts: [
          {
            type: MessageType.ToolUse,
            toolCallId: "call-1",
            name: "echo",
            arguments: {},
          },
        ],
      }),
    )
    await runtime.journal.event(
      JournalEvent.message({
        parts: [
          {
            type: MessageType.ToolResult,
            toolCallId: "call-1",
            ok: true,
            content: "done",
          },
        ],
      }),
    )

    await expect(
      driveEngine(mockBackend([textResponse("done")]), {
        journal: runtime.journal,
        workspace: runtime.workspace,
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      }),
    ).resolves.toBeDefined()
  })

  it("replays tool-pair messages from the journal as-is into history", async () => {
    const runtime = createRuntime()
    for (const id of ["call-1", "call-2"]) {
      await runtime.journal.event(
        JournalEvent.message({
          parts: [
            {
              type: MessageType.ToolUse,
              toolCallId: id,
              name: "echo",
              arguments: {},
            },
            {
              type: MessageType.ToolResult,
              toolCallId: id,
              ok: true,
              content: `done-${id}`,
            },
          ],
        }),
      )
    }

    const backend = mockBackend([textResponse("done")])
    await driveEngine(backend, {
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    const messagesAtRequest = backend.requests[0]!.messages
    const allParts = messagesAtRequest.flatMap((m) => m.parts)
    const toolUses = allParts.filter((p) => p.type === MessageType.ToolUse)
    const toolResults = allParts.filter(
      (p) => p.type === MessageType.ToolResult,
    )
    expect(
      toolUses.map((p) => p.type === MessageType.ToolUse && p.toolCallId),
    ).toEqual(["call-1", "call-2"])
    expect(
      toolResults.map((p) => p.type === MessageType.ToolResult && p.toolCallId),
    ).toEqual(["call-1", "call-2"])
  })

  it("recovers from a mid-batch crash: only completed pairs are in history", async () => {
    const runtime = createRuntime()
    await runtime.journal.event(
      JournalEvent.message({
        parts: [
          {
            type: MessageType.ToolUse,
            toolCallId: "complete-1",
            name: "echo",
            arguments: {},
          },
          {
            type: MessageType.ToolResult,
            toolCallId: "complete-1",
            ok: true,
            content: "done",
          },
        ],
      }),
    )

    const backend = mockBackend([textResponse("done")])
    await driveEngine(backend, {
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    const allParts = backend.requests[0]!.messages.flatMap((m) => m.parts)
    const toolUses = allParts.filter((p) => p.type === MessageType.ToolUse)
    const toolResults = allParts.filter(
      (p) => p.type === MessageType.ToolResult,
    )
    expect(toolUses).toHaveLength(1)
    expect(toolResults).toHaveLength(1)
    expect(
      toolUses[0]?.type === MessageType.ToolUse
        ? toolUses[0].toolCallId
        : undefined,
    ).toBe("complete-1")
    expect(
      toolResults[0]?.type === MessageType.ToolResult
        ? toolResults[0].toolCallId
        : undefined,
    ).toBe("complete-1")
  })

  it("does not re-journal replayed startup history", async () => {
    const runtime = createRuntime()
    const seeded = JournalEvent.message(userMessage("seeded"))
    await runtime.journal.event(seeded)

    await driveEngine(mockBackend([textResponse("done")]), {
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    expect(
      runtime.journal.active.filter((event) => event === seeded),
    ).toHaveLength(1)
  })
})

describe("@ronde/engine streaming completion", () => {
  it("forwards text_delta and thinking_delta events before the batched message events", async () => {
    const backend = streamingBackend(async function* () {
      yield { kind: "thinking_delta", content: "plan-1" }
      yield { kind: "thinking_delta", content: "plan-2" }
      yield { kind: "text_delta", content: "hello " }
      yield { kind: "text_delta", content: "world" }
      return {
        messages: [
          {
            parts: [
              { type: MessageType.Think, content: "plan-1plan-2" },
              {
                type: MessageType.Text,
                role: "assistant" as const,
                content: "hello world",
              },
            ],
          },
        ],
        stopReason: StopReason.EndTurn,
        usage: emptyUsage(),
        providerMeta: null,
        warnings: [],
      }
    })

    const { events } = await driveEngine(backend, {
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    const progress = events.filter((e) => e.kind === "progress")
    expect(progress.map((e) => e.type)).toEqual([
      "thinking_delta",
      "thinking_delta",
      "text_delta",
      "text_delta",
      "thinking",
      "text",
    ])
    const chunks = progress.flatMap((e) =>
      e.type === "thinking_delta" || e.type === "text_delta"
        ? [`${e.type}:${e.content}`]
        : [],
    )
    expect(chunks).toEqual([
      "thinking_delta:plan-1",
      "thinking_delta:plan-2",
      "text_delta:hello ",
      "text_delta:world",
    ])
  })

  it("forwards tool_input_delta events before tool_call events", async () => {
    const backend = streamingBackend(async function* (_req, call) {
      if (call === 0) {
        yield { kind: "tool_input_delta", toolCallId: "echo-1", chunk: '{"te' }
        yield { kind: "tool_input_delta", toolCallId: "echo-1", chunk: 'xt":' }
        yield { kind: "tool_input_delta", toolCallId: "echo-1", chunk: '"hi"}' }
        return {
          messages: [
            {
              parts: [
                {
                  type: MessageType.ToolUse,
                  toolCallId: "echo-1",
                  name: "echo",
                  arguments: { text: "hi" },
                },
              ],
            },
          ],
          stopReason: StopReason.ToolUse,
          usage: emptyUsage(),
          providerMeta: null,
          warnings: [],
        }
      }
      return textResponse("done")
    })

    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { events } = await driveEngine(backend, { toolkit })

    const progress = events.filter((e) => e.kind === "progress")
    const firstCallIdx = progress.findIndex((e) => e.type === "tool_call")
    expect(firstCallIdx).toBeGreaterThan(0)
    expect(progress.slice(0, firstCallIdx).map((e) => e.type)).toEqual([
      "tool_input_delta",
      "tool_input_delta",
      "tool_input_delta",
    ])
    const inputChunks = progress.flatMap((e) =>
      e.type === "tool_input_delta" ? [e.chunk] : [],
    )
    expect(inputChunks.join("")).toBe('{"text":"hi"}')
  })
})
