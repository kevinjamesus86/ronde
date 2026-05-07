import { describe, expect, it, vi } from "vitest"
import { z } from "zod/v4"
import { blocksToText } from "@ronde/core/block"
import {
  CompletionError,
  CompletionErrorKind,
  StopReason,
} from "@ronde/core/completion"
import { err, ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import { engine } from "@ronde/engine"
import {
  createRuntime,
  cutoffResponse,
  driveEngine,
  mockBackend,
  mockHandler,
  streamingBackend,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine lifecycle invariants", () => {
  it("pairs turn_start and turn_end even when a hook throws", async () => {
    const runtime = createRuntime()
    const gen = engine(mockBackend([textResponse("never")]), {
      prompt: "go",
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep() {
          throw new Error("preStep boom")
        },
      },
    })

    const events: string[] = []
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toThrow("preStep boom")

    expect(events).toEqual(["turn_start", "turn_end"])
    expect(runtime.journal.active.map((event) => event.type)).toEqual([
      "message",
      "turn_end",
    ])
  })

  it("disposes the bound toolkit runtime on normal completion", async () => {
    const dispose = vi.fn()
    const tracked = tool({
      name: "tracked",
      description: "Tracked",
      parameters: z.object({}),
      state: {
        init: () => ({ resource: "open" }),
        dispose,
      },
      execute: async (_args, ctx) => ok(ctx.state.resource),
    })

    await driveEngine(
      mockBackend([toolResponse("tracked", {}), textResponse("done")]),
      {
        prompt: "go",
        toolkit: tracked,
      },
    )

    expect(dispose).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledWith({ resource: "open" })
  })

  it("disposes the bound toolkit runtime on early consumer break", async () => {
    const dispose = vi.fn()
    const tracked = tool({
      name: "tracked",
      description: "Tracked",
      parameters: z.object({}),
      state: {
        init: () => ({ resource: "open" }),
        dispose,
      },
      execute: async (_args, ctx) => ok(ctx.state.resource),
    })

    const runtime = createRuntime()
    const gen = engine(
      mockBackend([toolResponse("tracked", {}), textResponse("done")]),
      {
        prompt: "go",
        journal: runtime.journal,
        workspace: runtime.workspace,
        toolkit: tracked,
      },
    )

    try {
      let next = await gen.next()
      while (!next.done) {
        if (next.value.type === "tool_result") {
          break
        }
        next = await gen.next()
      }
    } finally {
      await gen.return(undefined as never)
    }

    expect(dispose).toHaveBeenCalledOnce()
  })

  it("disposes initialized tool state when a later backend call throws", async () => {
    const dispose = vi.fn()
    const tracked = tool({
      name: "tracked",
      description: "Tracked",
      parameters: z.object({}),
      state: {
        init: () => ({ resource: "open" }),
        dispose,
      },
      execute: async (_args, ctx) => ok(ctx.state.resource),
    })

    await expect(
      driveEngine(
        mockHandler((_request, call) => {
          if (call === 0) {
            return toolResponse("tracked", {})
          }
          throw new Error("backend boom")
        }),
        {
          prompt: "go",
          toolkit: tracked,
        },
      ),
    ).rejects.toThrow("backend boom")

    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe("@ronde/engine error propagation", () => {
  it("propagates non-context-length backend errors after finalizing the turn", async () => {
    const runtime = createRuntime()
    const gen = engine(
      mockHandler(() => {
        throw new Error("rate limit")
      }),
      {
        prompt: "go",
        journal: runtime.journal,
        workspace: runtime.workspace,
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    const events: string[] = []
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toThrow("rate limit")

    expect(events).toEqual(["turn_start", "turn_end"])
    expect(runtime.journal.active.at(-1)).toMatchObject({
      type: "turn_end",
      turn: 1,
    })
  })

  it("converts thrown tool execution into err() output and continues", async () => {
    const throwingTool = tool({
      name: "boom",
      description: "Throws",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("tool exploded")
      },
    })

    const { result } = await driveEngine(
      mockBackend([toolResponse("boom", {}), textResponse("recovered")]),
      {
        prompt: "go",
        toolkit: throwingTool,
      },
    )

    expect(result.settleReason).toBe(StopReason.EndTurn)
    expect(result.steps[0]?.toolCalls[0]?.result).toMatchObject({
      ok: false,
      error: expect.stringContaining("tool exploded"),
    })
  })

  it("continues when a tool returns err() directly", async () => {
    const failingTool = tool({
      name: "fail",
      description: "Returns err",
      parameters: z.object({}),
      execute: async () => err("tool error"),
    })

    const { result } = await driveEngine(
      mockBackend([toolResponse("fail", {}), textResponse("recovered")]),
      {
        prompt: "go",
        toolkit: failingTool,
      },
    )

    expect(result.settleReason).toBe(StopReason.EndTurn)
    expect(result.steps[0]?.toolCalls[0]?.result).toEqual(err("tool error"))
  })

  it("finalizes the turn before propagating a CompletionError of kind other than ContextLengthExceeded", async () => {
    const runtime = createRuntime()
    const gen = engine(
      mockHandler(() => {
        throw new CompletionError(CompletionErrorKind.RateLimit, "slow down")
      }),
      {
        prompt: "go",
        journal: runtime.journal,
        workspace: runtime.workspace,
        toolkit: {
          schemas: [],
          async execute() {
            return ok(null)
          },
          formatters: {},
        },
      },
    )

    const events: string[] = []
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toMatchObject({ kind: CompletionErrorKind.RateLimit })

    expect(events).toContain("turn_end")
    expect(runtime.journal.active.at(-1)).toMatchObject({ type: "turn_end" })
  })

  it("finalizes the turn when the backend throws mid-stream", async () => {
    const runtime = createRuntime()
    const backend = streamingBackend(async function* () {
      yield { kind: "text_delta", content: "hello " }
      yield { kind: "text_delta", content: "world" }
      throw new Error("stream imploded")
    })

    const gen = engine(backend, {
      prompt: "go",
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
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toThrow("stream imploded")

    // Deltas streamed before the throw — consumer saw them — and the
    // turn still closed before the error propagated.
    expect(events).toContain("text_delta")
    expect(events).toContain("turn_end")
    expect(runtime.journal.active.at(-1)).toMatchObject({ type: "turn_end" })
  })

  it("propagates the original error when toolkit.dispose throws in finally", async () => {
    const tracked = tool({
      name: "tracked",
      description: "Tracked",
      parameters: z.object({}),
      state: {
        init: () => ({ resource: "open" }),
        dispose: () => {
          throw new Error("dispose blew up")
        },
      },
      execute: async (_args, ctx) => ok(ctx.state.resource),
    })

    const backend = mockHandler((_req, call) => {
      if (call === 0) {
        return toolResponse("tracked", {})
      }
      throw new Error("original backend error")
    })

    await expect(
      driveEngine(backend, { prompt: "go", toolkit: tracked }),
    ).rejects.toThrow("original backend error")
    // Never "dispose blew up" — that error is swallowed.
  })

  it("propagates approve throws after finalizing the turn", async () => {
    const runtime = createRuntime()
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const gen = engine(mockBackend([toolResponse("echo", { text: "hi" })]), {
      prompt: "go",
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: echo,
      hooks: {
        approve: () => {
          throw new Error("approve refused to run")
        },
      },
    })

    const events: string[] = []
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toThrow("approve refused to run")

    expect(events).toContain("turn_end")
  })

  it("propagates postStep throws after finalizing the turn", async () => {
    const runtime = createRuntime()
    const gen = engine(mockBackend([textResponse("done")]), {
      prompt: "go",
      journal: runtime.journal,
      workspace: runtime.workspace,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep: () => {
          throw new Error("postStep boom")
        },
      },
    })

    const events: string[] = []
    await expect(
      (async () => {
        let next = await gen.next()
        while (!next.done) {
          events.push(next.value.type)
          next = await gen.next()
        }
      })(),
    ).rejects.toThrow("postStep boom")

    expect(events).toContain("turn_end")
    expect(runtime.journal.active.at(-1)).toMatchObject({ type: "turn_end" })
  })
})

describe("@ronde/engine progress event taxonomy", () => {
  it("does not emit a 'message' progress event (message is journal-only per taxonomy)", async () => {
    const { events } = await driveEngine(mockBackend([textResponse("done")]), {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    // Message state event was dropped when the taxonomy collapsed to
    // three kinds (lifecycle / progress / diagnostic). This guards
    // against accidental reintroduction — durable "message" events
    // still land in the journal via sendAssistantResponse/send. Cast
    // widens the literal-union so the comparison compiles.
    expect(events.some((ev) => (ev.type as string) === "message")).toBe(false)
  })
})

describe("@ronde/engine journal invariants", () => {
  // AgentStepToolCall.result holds the raw ok(data)/err(msg) — useful
  // for trajectory export but never part of the durable record. The
  // model only ever sees the formatted content. If a future change
  // routes `result` into a journaled shape (e.g. by adding it to
  // ToolResultPart, or by journaling the whole AgentStep at turn_end),
  // this test catches it.
  it("never journals the raw ToolResult structure — only formatted content", async () => {
    const echo = tool()({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok({ structured: args.text, hidden: 42 }),
      format: (data) =>
        `formatted:${(data as { structured: string }).structured}`,
    })

    const backend = mockHandler((_req, call) => {
      if (call === 0) {
        return toolResponse("echo", { text: "hi" })
      }
      return textResponse("done")
    })

    const { journal } = await driveEngine(backend, {
      prompt: "go",
      toolkit: echo,
    })

    const flat = JSON.stringify(journal.active)
    // The raw ok payload contains "structured" and "hidden: 42" — they
    // live on ToolResult.data and must not leak into the journal.
    expect(flat).not.toContain('"hidden"')
    expect(flat).not.toContain('"structured"')
    // The formatted content is what the model sees and what the
    // journal records.
    expect(flat).toContain("formatted:hi")
  })
})

describe("@ronde/engine abort and cutoff invariants", () => {
  it("injects a continuation prompt on incomplete responses before the breaker trips", async () => {
    const backend = mockBackend([
      cutoffResponse("partial"),
      textResponse("complete"),
    ])

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
    })

    const secondRequest = backend.requests[1]
    expect(secondRequest).toBeDefined()
    const lastMessage = secondRequest!.messages.at(-1)
    const content = lastMessage?.parts
      .filter((part) => part.type === "content")
      .map((part) => blocksToText(part.content))
      .join("")

    expect(content?.toLowerCase()).toContain("cut off")
  })

  it("resets the incomplete-response counter after a non-cutoff turn", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { events, result } = await driveEngine(
      mockBackend([
        cutoffResponse("p1"),
        toolResponse("echo", { text: "ok" }),
        cutoffResponse("p2"),
        textResponse("done"),
      ]),
      {
        prompt: "go",
        toolkit: echo,
      },
    )

    expect(
      events
        .filter((event) => event.type === "cutoff")
        .map((event) => event.count),
    ).toEqual([1, 1])
    expect(result.settleReason).toBe(StopReason.EndTurn)
  })
})
