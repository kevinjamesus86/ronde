import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import { MessageType, userMessage } from "@ronde/core/message"
import { ok } from "@ronde/core/result"
import { tool } from "@ronde/core/toolkit"
import type { PreStepInput } from "@ronde/engine"
import {
  driveEngine,
  mockBackend,
  textResponse,
  toolResponse,
} from "./support.js"

describe("@ronde/engine preStep hook", () => {
  it("receives turn, messages, tool schemas, usage, budget, and prior steps", async () => {
    const backend = mockBackend([textResponse("done")])
    const seen: PreStepInput[] = []

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep(input) {
          seen.push(input)
        },
      },
    })

    expect(seen[0]).toMatchObject({
      turn: 1,
      messages: [expect.any(Object)],
      toolSchemas: [],
      steps: expect.any(Array),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
      },
      budget: expect.objectContaining({
        maxContext: expect.any(Number),
        maxOutput: expect.any(Number),
      }),
      compactionCount: 0,
    })
  })

  it("allows model and effort override for the next completion", async () => {
    const backend = mockBackend([textResponse("done")])

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep: () => ({ model: "override-model", effort: "high" }),
      },
    })

    expect(backend.requests[0]).toMatchObject({
      model: "override-model",
      effort: "high",
    })
  })

  it("allows message and tool-schema override for the next completion", async () => {
    const backend = mockBackend([textResponse("done")])
    const customTool = {
      name: "custom",
      description: "Custom",
      inputSchema: { type: "object" },
    }

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep: () => ({
          messages: [],
          toolSchemas: [customTool],
        }),
      },
    })

    expect(backend.requests[0]?.messages).toEqual([])
    expect(backend.requests[0]?.tools).toEqual([customTool])
  })

  it("leaves defaults unchanged when it returns void", async () => {
    const backend = mockBackend([textResponse("done")])

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep: () => {},
      },
    })

    expect(backend.requests[0]?.messages).toHaveLength(1)
    expect(backend.requests[0]?.model).toBe("mock")
  })

  it("supports async preStep implementations", async () => {
    const backend = mockBackend([textResponse("done")])

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return { model: "async-model" }
        },
      },
    })

    expect(backend.requests[0]?.model).toBe("async-model")
  })

  it("scopes overrides to the turn they were returned for", async () => {
    const backend = mockBackend([textResponse("one"), textResponse("two")])
    let turnSeen = 0

    await driveEngine(backend, {
      prompt: "go",
      maxTurns: 2,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        preStep: () => {
          turnSeen++
          // Override only on turn 1 — turn 2 returns void.
          return turnSeen === 1
            ? { model: "override-1", effort: "high" }
            : undefined
        },
        // Force a second turn (a clean text turn would otherwise
        // break out via settleReason = step.stopReason).
        postStep: (step) => (step.turn === 1 ? "continue" : undefined),
      },
    })

    // Turn 1 sees the override; turn 2 must revert to the config default
    // (not leak the turn-1 model/effort into the next completion).
    expect(backend.requests[0]).toMatchObject({
      model: "override-1",
      effort: "high",
    })
    expect(backend.requests[1]).toMatchObject({
      model: "mock",
    })
  })

  it("falls through to the configured effort when preStep omits it", async () => {
    const backend = mockBackend([textResponse("one"), textResponse("two")])

    await driveEngine(backend, {
      prompt: "go",
      maxTurns: 2,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        // Both turns omit effort. The merge must leave model/effort/etc
        // at their configured defaults, not clobber them with undefined.
        preStep: () => ({}),
        postStep: (step) => (step.turn === 1 ? "continue" : undefined),
      },
    })

    expect(backend.requests[0]?.model).toBe("mock")
    expect(backend.requests[1]?.model).toBe("mock")
  })
})

describe("@ronde/engine approve hook", () => {
  it("approves tools by default when no hook is provided", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { result } = await driveEngine(
      mockBackend([toolResponse("echo", { text: "hi" }), textResponse("done")]),
      {
        prompt: "go",
        toolkit: echo,
      },
    )

    expect(result.steps[0]?.toolCalls[0]?.result).toEqual(ok("hi"))
  })

  it("rejects tool calls when approve returns false", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { result } = await driveEngine(
      mockBackend([toolResponse("echo", { text: "hi" }), textResponse("done")]),
      {
        prompt: "go",
        toolkit: echo,
        hooks: {
          approve: () => false,
        },
      },
    )

    const toolResult = result.steps[0]?.toolCalls[0]?.result
    expect(toolResult?.ok).toBe(false)
    if (toolResult && !toolResult.ok) {
      expect(toolResult.error).toContain("rejected")
    }
  })

  it("supports async approval", async () => {
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const { result } = await driveEngine(
      mockBackend([toolResponse("echo", { text: "hi" }), textResponse("done")]),
      {
        prompt: "go",
        toolkit: echo,
        hooks: {
          approve: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            return true
          },
        },
      },
    )

    expect(result.steps[0]?.toolCalls[0]?.result).toEqual(ok("hi"))
  })

  it("runs approvals before parallel tool execution begins", async () => {
    const approveOrder: string[] = []
    const executeOrder: string[] = []
    const tracked = tool({
      name: "tracked",
      description: "Tracked",
      parameters: z.object({ id: z.string() }),
      execute: async (args) => {
        executeOrder.push(args.id)
        return ok(args.id)
      },
    })

    await driveEngine(
      mockBackend([
        {
          messages: [
            {
              parts: [
                {
                  type: MessageType.ToolUse,
                  toolCallId: "a",
                  name: "tracked",
                  arguments: { id: "a" },
                },
                {
                  type: MessageType.ToolUse,
                  toolCallId: "b",
                  name: "tracked",
                  arguments: { id: "b" },
                },
              ],
            },
          ],
          stopReason: StopReason.ToolUse,
          usage: emptyUsage(),
          providerMeta: null,
          warnings: [],
        },
        textResponse("done"),
      ]),
      {
        prompt: "go",
        toolkit: tracked,
        hooks: {
          approve: ({ arguments: args }) => {
            approveOrder.push((args as { id: string }).id)
            return true
          },
        },
      },
    )

    expect(approveOrder).toEqual(["a", "b"])
    expect(executeOrder).toEqual(["a", "b"])
  })
})

describe("@ronde/engine postStep hook", () => {
  it("fires after each completed step", async () => {
    const backend = mockBackend([textResponse("done")])
    const steps: number[] = []

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep(step) {
          steps.push(step.turn)
        },
      },
    })

    expect(steps).toEqual([1])
  })

  it("receives the fully-populated step", async () => {
    const backend = mockBackend([textResponse("done")])
    const seen: string[] = []

    await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep(step) {
          seen.push(step.text ?? "")
        },
      },
    })

    expect(seen).toEqual(["done"])
  })

  it("injects returned feedback as a user message for the next turn", async () => {
    const backend = mockBackend([textResponse("first"), textResponse("second")])
    const { result } = await driveEngine(backend, {
      prompt: "go",
      maxTurns: 5,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep(step) {
          return step.turn === 1 ? "try again" : undefined
        },
      },
    })

    expect(result.steps).toHaveLength(2)
    expect(result.history.at(-2)).toEqual(userMessage("try again"))
  })

  it("can continue a non-tool turn by returning feedback", async () => {
    const backend = mockBackend([
      textResponse("first"),
      textResponse("second"),
      textResponse("third"),
      textResponse("fourth"),
      textResponse("fifth"),
    ])
    const { result } = await driveEngine(backend, {
      prompt: "go",
      maxTurns: 5,
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep: () => "continue",
      },
    })

    expect(result.steps).toHaveLength(5)
    expect(result.settleReason).toBe("max_turns")
  })

  it("continues normally when it returns void", async () => {
    const backend = mockBackend([textResponse("done")])
    const { result } = await driveEngine(backend, {
      prompt: "go",
      toolkit: {
        schemas: [],
        async execute() {
          return ok(null)
        },
        formatters: {},
      },
      hooks: {
        postStep: () => {},
      },
    })

    expect(result.settleReason).toBe(StopReason.EndTurn)
  })
})
