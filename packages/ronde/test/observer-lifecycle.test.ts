import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import type { AgentStep } from "@ronde/engine"
import { agentic, ok, tool } from "../src/index.js"
import {
  mockBackend,
  multiToolResponse,
  textResponse,
  thinkAndToolResponse,
} from "./support.js"

const echoTool = tool({
  name: "echo",
  description: "Echo the input",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => ok({ echoed: args.text }),
})

describe("@ronde observer lifecycle", () => {
  it("fires observer callbacks in engine event order", async () => {
    const events: string[] = []

    await agentic(
      mockBackend([
        thinkAndToolResponse("Let me think...", "echo", { text: "hello" }),
        textResponse("Done!"),
      ]),
      {
        prompt: "Test",
        tools: echoTool,
        maxTurns: 5,
        observers: {
          onTurnStart(turn) {
            events.push(`turn_start:${turn}`)
          },
          onTurnEnd(turn) {
            events.push(`turn_end:${turn}`)
          },
          onThinking(turn) {
            events.push(`thinking:${turn}`)
          },
          onText(turn) {
            events.push(`text:${turn}`)
          },
          onToolCall(turn, call) {
            events.push(`tool_call:${turn}:${call.name}`)
          },
          onToolResult(turn, call) {
            events.push(`tool_result:${turn}:${call.name}`)
          },
        },
      },
    )

    expect(events).toEqual([
      "turn_start:1",
      "thinking:1",
      "tool_call:1:echo",
      "tool_result:1:echo",
      "turn_end:1",
      "turn_start:2",
      "text:2",
      "turn_end:2",
    ])
  })

  it("dispatches all onToolCall callbacks before any onToolResult callbacks", async () => {
    const events: string[] = []

    await agentic(
      mockBackend([
        multiToolResponse([
          { name: "echo", args: { text: "first" } },
          { name: "echo", args: { text: "second" } },
        ]),
        textResponse("done"),
      ]),
      {
        prompt: "Test",
        tools: echoTool,
        maxTurns: 5,
        observers: {
          onTurnStart(turn) {
            events.push(`turn_start:${turn}`)
          },
          onTurnEnd(turn) {
            events.push(`turn_end:${turn}`)
          },
          onToolCall(turn, call) {
            events.push(`tool_call:${turn}:${call.name}`)
          },
          onToolResult(turn, call) {
            events.push(`tool_result:${turn}:${call.name}`)
          },
        },
      },
    )

    expect(events).toEqual([
      "turn_start:1",
      "tool_call:1:echo",
      "tool_call:1:echo",
      "tool_result:1:echo",
      "tool_result:1:echo",
      "turn_end:1",
      "turn_start:2",
      "turn_end:2",
    ])
  })

  it("passes a fully-populated step into onTurnEnd", async () => {
    const endSteps: AgentStep[] = []

    await agentic(
      mockBackend([
        thinkAndToolResponse("reasoning here", "echo", { text: "hi" }),
        textResponse("Final answer"),
      ]),
      {
        prompt: "Test",
        tools: echoTool,
        maxTurns: 5,
        observers: {
          onTurnEnd(_turn, step) {
            endSteps.push(step)
          },
        },
      },
    )

    expect(endSteps[0]).toMatchObject({
      turn: 1,
      reasoning: ["reasoning here"],
      toolCalls: [expect.objectContaining({ name: "echo" })],
    })
    expect(endSteps[0]?.text).toBeUndefined()
    expect(endSteps[1]).toMatchObject({
      turn: 2,
      reasoning: [],
      toolCalls: [],
      text: "Final answer",
    })
  })

  it("keeps tool-only turns visible to observers", async () => {
    const events: string[] = []

    await agentic(
      mockBackend([
        multiToolResponse([{ name: "echo", args: { text: "a" } }]),
        multiToolResponse([{ name: "echo", args: { text: "b" } }]),
        textResponse("Done"),
      ]),
      {
        prompt: "Test",
        tools: echoTool,
        maxTurns: 5,
        observers: {
          onTurnStart(turn) {
            events.push(`turn_start:${turn}`)
          },
          onTurnEnd(turn) {
            events.push(`turn_end:${turn}`)
          },
          onText(turn) {
            events.push(`text:${turn}`)
          },
          onToolCall(turn) {
            events.push(`tool_call:${turn}`)
          },
          onToolResult(turn) {
            events.push(`tool_result:${turn}`)
          },
        },
      },
    )

    expect(events).toEqual([
      "turn_start:1",
      "tool_call:1",
      "tool_result:1",
      "turn_end:1",
      "turn_start:2",
      "tool_call:2",
      "tool_result:2",
      "turn_end:2",
      "turn_start:3",
      "text:3",
      "turn_end:3",
    ])
  })
})
