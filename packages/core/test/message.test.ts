import { describe, expect, it } from "vitest"
import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultMessage,
  toolResultPart,
  userMessage,
} from "@ronde/core/message"

describe("@ronde/core message constructors", () => {
  it("builds a user message with one text part", () => {
    expect(userMessage("hello")).toEqual({
      parts: [{ type: MessageType.Text, role: Role.User, content: "hello" }],
    })
  })

  it("builds an assistant message from an ordered part list", () => {
    const parts = [
      thinkingPart("plan"),
      textPart(Role.Assistant, "answer"),
      toolCallPart({
        toolCallId: "call-1",
        name: "search",
        arguments: { q: "ronde" },
      }),
    ]

    expect(assistantMessage(parts)).toEqual({ parts })
  })

  it("builds a tool-result user message", () => {
    expect(toolResultMessage("call-1", true, "done")).toEqual({
      parts: [
        {
          type: MessageType.ToolResult,
          toolCallId: "call-1",
          ok: true,
          content: "done",
        },
      ],
    })
  })

  it("builds individual text, thinking, tool-call, and tool-result parts", () => {
    expect(textPart(Role.User, "hello", { source: "user" })).toEqual({
      type: MessageType.Text,
      role: Role.User,
      content: "hello",
      meta: { source: "user" },
    })
    expect(thinkingPart("ponder", { hidden: true })).toEqual({
      type: MessageType.Think,
      content: "ponder",
      meta: { hidden: true },
    })
    expect(
      toolCallPart({
        toolCallId: "call-1",
        name: "search",
        arguments: { q: "ronde" },
        meta: { provider: "test" },
      }),
    ).toEqual({
      type: MessageType.ToolUse,
      toolCallId: "call-1",
      name: "search",
      arguments: { q: "ronde" },
      meta: { provider: "test" },
    })
    expect(
      toolResultPart({
        toolCallId: "call-1",
        ok: false,
        content: "failed",
        meta: { stderr: "boom" },
      }),
    ).toEqual({
      type: MessageType.ToolResult,
      toolCallId: "call-1",
      ok: false,
      content: "failed",
      meta: { stderr: "boom" },
    })
  })
})

describe("@ronde/core canonical message shape", () => {
  it("allows one assistant message to contain multiple ordered parts", () => {
    const message = assistantMessage([
      thinkingPart("step 1"),
      textPart(Role.Assistant, "step 2"),
      toolCallPart({
        toolCallId: "call-1",
        name: "search",
        arguments: { q: "docs" },
      }),
      textPart(Role.Assistant, "step 3"),
    ])

    expect(message.parts.map((part) => part.type)).toEqual([
      MessageType.Think,
      MessageType.Text,
      MessageType.ToolUse,
      MessageType.Text,
    ])
  })

  it("preserves optional message ids on assistant messages", () => {
    expect(
      assistantMessage([textPart(Role.Assistant, "done")], "msg-1").id,
    ).toBe("msg-1")
  })

  it("omits part meta when none is provided", () => {
    expect(textPart(Role.Assistant, "hello")).not.toHaveProperty("meta")
    expect(thinkingPart("plan")).not.toHaveProperty("meta")
    expect(
      toolCallPart({
        toolCallId: "call-1",
        name: "search",
        arguments: {},
      }),
    ).not.toHaveProperty("meta")
    expect(
      toolResultPart({
        toolCallId: "call-1",
        ok: true,
        content: "ok",
      }),
    ).not.toHaveProperty("meta")
  })
})
