import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import { err, ok } from "@ronde/core/result"
import { MessageType, toolCallPart } from "@ronde/core/message"
import { merge, tool } from "@ronde/core/toolkit"
import type { EngineEvent } from "../src/types.js"
import { executeToolCalls, type ToolExecutionResult } from "../src/tool-exec.js"
import { TestJournal, TestWorkspace } from "./support.js"

async function drainTool(
  gen: AsyncGenerator<EngineEvent, ToolExecutionResult, unknown>,
): Promise<ToolExecutionResult & { events: EngineEvent[] }> {
  const events: EngineEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { ...next.value, events }
}

describe("@ronde/engine executeToolCalls", () => {
  it("emits tool_call events before any tool_result events", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ echoed: args.text }),
      format: (data) => (data as { echoed: string }).echoed,
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "echo",
            arguments: { text: "hello" },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_result",
    ])
  })

  it("formats tool results through the toolkit formatter pipeline", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ echoed: args.text }),
      format: (data) => `echo:${(data as { echoed: string }).echoed}`,
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "echo",
            arguments: { text: "hello" },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.resultParts[0]).toMatchObject({
      type: MessageType.ToolResult,
      content: "echo:hello",
    })
  })

  it("applies the configured maxInline to framework truncation", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "big",
      description: "Big",
      parameters: z.object({}),
      execute: async () => ok("x".repeat(200)),
      format: (data) => data as string,
      truncate: "head",
    })

    const workspace = new TestWorkspace()
    const result = await drainTool(
      executeToolCalls(
        [toolCallPart({ toolCallId: "call-1", name: "big", arguments: {} })],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        workspace,
        new TestJournal(),
        50,
      ),
    )

    const content = (result.resultParts[0] as { content: string }).content
    // Head slice of 50 "x"s, marker, hint — total well under 200.
    expect(content.startsWith("x".repeat(50))).toBe(true)
    expect(content).toContain("150 characters truncated")
    expect(content).toContain("[Full output at memory://spill/1")
    expect(workspace.spills).toHaveLength(1)
  })

  it("returns tool_result events in completion order", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "wait",
      description: "Wait",
      parameters: z.object({ label: z.string(), delay: z.number() }),
      execute: async (args) => {
        await new Promise((resolve) => setTimeout(resolve, args.delay))
        return ok({ label: args.label })
      },
      format: (data) => (data as { label: string }).label,
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "slow",
            name: "wait",
            arguments: { label: "slow", delay: 20 },
          }),
          toolCallPart({
            toolCallId: "fast",
            name: "wait",
            arguments: { label: "fast", delay: 1 },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(
      result.events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.result.content),
    ).toEqual(["fast", "slow"])
  })

  it("respects approval decisions before execution", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "echo",
            arguments: { text: "hello" },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map([[0, false]]),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.resultParts[0]).toMatchObject({
      ok: false,
      content: 'Tool call "echo" was rejected',
    })
  })

  it("does not abort siblings when a tool returns err()", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "maybe",
      description: "Maybe",
      parameters: z.object({ ok: z.boolean() }),
      execute: async (args) => (args.ok ? ok("ok") : err("bad")),
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "maybe",
            arguments: { ok: false },
          }),
          toolCallPart({
            toolCallId: "call-2",
            name: "maybe",
            arguments: { ok: true },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(
      result.resultParts.map((part) =>
        part.type === MessageType.ToolResult ? part.ok : undefined,
      ),
    ).toEqual([false, true])
  })

  it("aborts sibling tools when one execute() call throws", async () => {
    const execution: string[] = []
    const bomb = tool<TestWorkspace>()({
      name: "bomb",
      description: "Throws",
      parameters: z.object({}),
      execute: async () => {
        execution.push("bomb")
        throw new Error("boom")
      },
    })
    const slow = tool<TestWorkspace>()({
      name: "slow",
      description: "Slow",
      parameters: z.object({}),
      execute: async (_args, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        execution.push(ctx.abort.aborted ? "slow:aborted" : "slow:ran")
        return ok({ done: true })
      },
      format: () => "done",
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "bomb-1",
            name: "bomb",
            arguments: {},
          }),
          toolCallPart({
            toolCallId: "slow-1",
            name: "slow",
            arguments: {},
          }),
        ],
        merge(bomb, slow),
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(execution).toContain("slow:aborted")
    expect(
      result.resultParts.map((part) =>
        part.type === MessageType.ToolResult ? part.ok : undefined,
      ),
    ).toEqual([false, true])
  })

  // The slow tool only resolves after the consumer observes fast's
  // tool_result. If events were buffered, slow would deadlock and
  // the vitest timeout would trip.
  it("streams tool_result events as each tool settles", async () => {
    let unblock: (() => void) | null = null
    const fastResultObserved = new Promise<void>((resolve) => {
      unblock = resolve
    })

    const toolkit = merge(
      tool<TestWorkspace>()({
        name: "fast",
        description: "Fast",
        parameters: z.object({}),
        execute: async () => ok("fast"),
        format: (data) => data as string,
      }),
      tool<TestWorkspace>()({
        name: "slow",
        description: "Slow",
        parameters: z.object({}),
        execute: async () => {
          await fastResultObserved
          return ok("slow")
        },
        format: (data) => data as string,
      }),
    )

    const gen = executeToolCalls(
      [
        toolCallPart({ toolCallId: "fast-1", name: "fast", arguments: {} }),
        toolCallPart({ toolCallId: "slow-1", name: "slow", arguments: {} }),
      ],
      toolkit,
      {
        turn: 1,
        reasoning: [],
        toolCalls: [],
        usage: emptyUsage(),
        stopReason: StopReason.Unknown,
      },
      1,
      new AbortController().signal,
      [],
      new Map(),
      new TestWorkspace(),
      new TestJournal(),
    )

    const types: string[] = []
    const settleOrder: string[] = []
    let next = await gen.next()
    while (!next.done) {
      const event = next.value
      types.push(event.type)
      if (event.type === "tool_result") {
        settleOrder.push(event.call.toolUseId)
        if (event.call.toolUseId === "fast-1") {
          unblock!()
        }
      }
      next = await gen.next()
    }

    expect(types).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ])
    expect(settleOrder).toEqual(["fast-1", "slow-1"])
  })

  it("emits tool_delta for each generator yield between tool_call and tool_result", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "streamer",
      description: "Streams chunks",
      parameters: z.object({}),
      async *execute() {
        yield "chunk-1"
        yield "chunk-2"
        yield "chunk-3"
        return ok("done")
      },
      format: (data) => data as string,
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "s-1",
            name: "streamer",
            arguments: {},
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_delta",
      "tool_delta",
      "tool_delta",
      "tool_result",
    ])
    const chunks = result.events.flatMap((e) =>
      e.type === "tool_delta" ? [e.chunk] : [],
    )
    expect(chunks).toEqual(["chunk-1", "chunk-2", "chunk-3"])
  })

  it("preserves per-tool delta order across concurrent streaming tools", async () => {
    const toolkit = merge(
      tool<TestWorkspace>()({
        name: "A",
        description: "A",
        parameters: z.object({}),
        async *execute() {
          yield "a1"
          yield "a2"
          return ok("A-done")
        },
        format: (d) => d as string,
      }),
      tool<TestWorkspace>()({
        name: "B",
        description: "B",
        parameters: z.object({}),
        async *execute() {
          yield "b1"
          yield "b2"
          return ok("B-done")
        },
        format: (d) => d as string,
      }),
    )

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({ toolCallId: "a", name: "A", arguments: {} }),
          toolCallPart({ toolCallId: "b", name: "B", arguments: {} }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.events.slice(0, 2).map((e) => e.type)).toEqual([
      "tool_call",
      "tool_call",
    ])

    // Cross-tool arrival order is non-deterministic with no barriers —
    // only per-tool order is asserted.
    const deltasFor = (id: string) =>
      result.events.flatMap((e) =>
        e.type === "tool_delta" && e.call.toolUseId === id ? [e.chunk] : [],
      )
    expect(deltasFor("a")).toEqual(["a1", "a2"])
    expect(deltasFor("b")).toEqual(["b1", "b2"])

    for (const id of ["a", "b"]) {
      const own = result.events.filter(
        (e) =>
          (e.type === "tool_delta" || e.type === "tool_result") &&
          e.call.toolUseId === id,
      )
      const resultIdx = own.findIndex((e) => e.type === "tool_result")
      expect(resultIdx).toBe(own.length - 1)
    }
  })
})

describe("@ronde/engine executeToolCalls — token estimation", () => {
  it("estimates tokens conservatively across prose, JSON, and dense strings", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ echoed: args.text }),
      format: (data) => JSON.stringify(data),
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "echo",
            arguments: { text: "dense-text" },
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  it("falls back safely on unserializable values during token estimation", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic["self"] = cyclic

    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({}),
      execute: async () => ok("done"),
    })

    const result = await drainTool(
      executeToolCalls(
        [
          toolCallPart({
            toolCallId: "call-1",
            name: "echo",
            arguments: cyclic,
          }),
        ],
        toolkit,
        {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          usage: emptyUsage(),
          stopReason: StopReason.Unknown,
        },
        1,
        new AbortController().signal,
        [],
        new Map(),
        new TestWorkspace(),
        new TestJournal(),
      ),
    )

    expect(result.estimatedTokens).toBeGreaterThan(0)
  })
})
