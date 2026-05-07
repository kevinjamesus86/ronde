import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { blocksToText } from "@ronde/core/block"
import { err, ok } from "@ronde/core/result"
import { toolCallPart } from "@ronde/core/message"
import { merge, tool } from "@ronde/core/toolkit"
import type { EngineEvent } from "../src/types.js"
import {
  executeToolCalls,
  type ExecuteToolCallsInput,
} from "../src/tool-exec.js"
import { TestWorkspace } from "./support.js"

function baseInput(
  overrides: Partial<ExecuteToolCallsInput<TestWorkspace>>,
): ExecuteToolCallsInput<TestWorkspace> {
  return {
    calls: [],
    toolkit: {
      schemas: [],
      async execute() {
        return err("unknown")
      },
      formatters: {},
    },
    turn: 1,
    abort: new AbortController().signal,
    history: [],
    workspace: new TestWorkspace(),
    ...overrides,
  }
}

async function drain(
  gen: AsyncGenerator<EngineEvent, void, unknown>,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

function resultsOnly(
  events: EngineEvent[],
): Extract<EngineEvent, { type: "tool_result" }>[] {
  return events.filter((e) => e.type === "tool_result")
}

describe("@ronde/engine executeToolCalls", () => {
  it("emits tool_call then tool_result per tool", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ echoed: args.text }),
      format: (data) => (data as { echoed: string }).echoed,
    })

    const events = await drain(
      executeToolCalls(
        baseInput({
          toolkit,
          calls: [
            toolCallPart({
              toolCallId: "call-1",
              name: "echo",
              arguments: { text: "hello" },
            }),
          ],
        }),
      ),
    )

    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"])
  })

  it("tool_result carries both formatted content and raw result", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ echoed: args.text }),
      format: (data) => `fmt:${(data as { echoed: string }).echoed}`,
    })

    const [settled] = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            calls: [
              toolCallPart({
                toolCallId: "call-1",
                name: "echo",
                arguments: { text: "hello" },
              }),
            ],
          }),
        ),
      ),
    )

    expect(blocksToText(settled!.content)).toBe("fmt:hello")
    expect(settled!.result).toEqual(ok({ echoed: "hello" }))
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
    const [settled] = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            workspace,
            maxInline: 50,
            calls: [
              toolCallPart({
                toolCallId: "call-1",
                name: "big",
                arguments: {},
              }),
            ],
          }),
        ),
      ),
    )

    const settledText = blocksToText(settled!.content)
    expect(settledText.startsWith("x".repeat(50))).toBe(true)
    expect(settledText).toContain("150 characters truncated")
    expect(settledText).toContain("memory://spill/1")
    expect(workspace.spills).toHaveLength(1)
  })

  it("yields tool_result events in completion order", async () => {
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

    const events = await drain(
      executeToolCalls(
        baseInput({
          toolkit,
          calls: [
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
        }),
      ),
    )

    expect(resultsOnly(events).map((e) => blocksToText(e.content))).toEqual([
      "fast",
      "slow",
    ])
  })

  it("respects approval decisions before execution", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const [settled] = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            approvals: new Map([[0, false]]),
            calls: [
              toolCallPart({
                toolCallId: "call-1",
                name: "echo",
                arguments: { text: "hello" },
              }),
            ],
          }),
        ),
      ),
    )

    expect(settled!.result.ok).toBe(false)
    expect(blocksToText(settled!.content)).toBe('Tool call "echo" was rejected')
  })

  it("does not abort siblings when a tool returns err()", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "maybe",
      description: "Maybe",
      parameters: z.object({ ok: z.boolean() }),
      execute: async (args) => (args.ok ? ok("ok") : err("bad")),
    })

    const results = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            calls: [
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
          }),
        ),
      ),
    )

    const byId = new Map(results.map((r) => [r.call.toolUseId, r.result.ok]))
    expect(byId.get("call-1")).toBe(false)
    expect(byId.get("call-2")).toBe(true)
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

    const results = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit: merge(bomb, slow),
            calls: [
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
          }),
        ),
      ),
    )

    expect(execution).toContain("slow:aborted")
    const byId = new Map(results.map((r) => [r.call.toolUseId, r.result.ok]))
    expect(byId.get("bomb-1")).toBe(false)
    expect(byId.get("slow-1")).toBe(true)
  })

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
      baseInput({
        toolkit,
        calls: [
          toolCallPart({ toolCallId: "fast-1", name: "fast", arguments: {} }),
          toolCallPart({ toolCallId: "slow-1", name: "slow", arguments: {} }),
        ],
      }),
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

    const events = await drain(
      executeToolCalls(
        baseInput({
          toolkit,
          calls: [
            toolCallPart({
              toolCallId: "s-1",
              name: "streamer",
              arguments: {},
            }),
          ],
        }),
      ),
    )

    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_delta",
      "tool_delta",
      "tool_delta",
      "tool_result",
    ])
    const chunks = events.flatMap((e) =>
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

    const events = await drain(
      executeToolCalls(
        baseInput({
          toolkit,
          calls: [
            toolCallPart({ toolCallId: "a", name: "A", arguments: {} }),
            toolCallPart({ toolCallId: "b", name: "B", arguments: {} }),
          ],
        }),
      ),
    )

    expect(events.slice(0, 2).map((e) => e.type)).toEqual([
      "tool_call",
      "tool_call",
    ])

    const deltasFor = (id: string) =>
      events.flatMap((e) =>
        e.type === "tool_delta" && e.call.toolUseId === id ? [e.chunk] : [],
      )
    expect(deltasFor("a")).toEqual(["a1", "a2"])
    expect(deltasFor("b")).toEqual(["b1", "b2"])
  })
})

describe("@ronde/engine executeToolCalls — cancellation", () => {
  it("synthesizes Cancelled for tools not yet launched when abort fires", async () => {
    const ac = new AbortController()
    const toolkit = tool<TestWorkspace>()({
      name: "noop",
      description: "noop",
      parameters: z.object({}),
      execute: async () => ok("done"),
      format: (d) => d as string,
    })
    ac.abort("external")

    const results = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            abort: ac.signal,
            calls: [
              toolCallPart({ toolCallId: "a", name: "noop", arguments: {} }),
              toolCallPart({ toolCallId: "b", name: "noop", arguments: {} }),
            ],
          }),
        ),
      ),
    )

    expect(results.map((r) => r.result.ok)).toEqual([false, false])
    expect(results.map((r) => blocksToText(r.content))).toEqual([
      "Cancelled",
      "Cancelled",
    ])
  })

  it("synthesizes Cancelled for tools interrupted mid-execution", async () => {
    const ac = new AbortController()
    const toolkit = tool<TestWorkspace>()({
      name: "hang",
      description: "hangs forever",
      parameters: z.object({}),
      execute: () =>
        new Promise<never>(() => {
          // never resolves — only abort unsticks this
        }),
      format: (d) => d as string,
    })

    const gen = executeToolCalls(
      baseInput({
        toolkit,
        abort: ac.signal,
        calls: [toolCallPart({ toolCallId: "a", name: "hang", arguments: {} })],
      }),
    )

    const events: EngineEvent[] = []
    const iter = (async () => {
      let next = await gen.next()
      while (!next.done) {
        events.push(next.value)
        next = await gen.next()
      }
    })()

    await new Promise((r) => setTimeout(r, 10))
    ac.abort("external")
    await iter

    const results = resultsOnly(events)
    expect(results).toHaveLength(1)
    expect(results[0]!.result.ok).toBe(false)
    expect(blocksToText(results[0]!.content)).toBe("Cancelled")
  })

  it("falls back to best-effort content if the formatter throws", async () => {
    const toolkit = tool<TestWorkspace>()({
      name: "boom-format",
      description: "format throws",
      parameters: z.object({}),
      execute: async () => ok("anything"),
      format: () => {
        throw new Error("format failed")
      },
    })

    const [settled] = resultsOnly(
      await drain(
        executeToolCalls(
          baseInput({
            toolkit,
            calls: [
              toolCallPart({
                toolCallId: "a",
                name: "boom-format",
                arguments: {},
              }),
            ],
          }),
        ),
      ),
    )

    expect(settled!.result.ok).toBe(false)
    const settledText = blocksToText(settled!.content)
    expect(settledText).toContain("Formatter failed")
    expect(settledText).toContain("format failed")
  })
})
