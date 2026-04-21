import { describe, expect, it } from "vitest"
import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from "@ronde/core/message"
import { splitResponse, translateBufferedMessages } from "../src/replay.js"

describe("@ronde/engine splitResponse", () => {
  it("splits tool_use parts out of assistant messages, preserving order", () => {
    const { messages, pendingCalls } = splitResponse([
      assistantMessage([
        textPart(Role.Assistant, "calling first"),
        toolCallPart({
          toolCallId: "call-1",
          name: "first",
          arguments: { q: 1 },
        }),
      ]),
      assistantMessage([
        toolCallPart({
          toolCallId: "call-2",
          name: "second",
          arguments: { q: 2 },
        }),
      ]),
    ])

    expect(pendingCalls.map((call) => call.name)).toEqual(["first", "second"])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts).toEqual([
      textPart(Role.Assistant, "calling first"),
    ])
  })

  it("preserves per-message segmentation in the text stream", () => {
    const { messages } = splitResponse([
      assistantMessage([textPart(Role.Assistant, "one")]),
      assistantMessage([textPart(Role.Assistant, "two")]),
    ])

    expect(messages).toHaveLength(2)
    expect(messages[0]?.parts).toEqual([textPart(Role.Assistant, "one")])
    expect(messages[1]?.parts).toEqual([textPart(Role.Assistant, "two")])
  })

  it("drops empty text-message shells when every part was a tool_use", () => {
    const { messages, pendingCalls } = splitResponse([
      assistantMessage([
        toolCallPart({
          toolCallId: "call-1",
          name: "only",
          arguments: {},
        }),
      ]),
    ])

    expect(pendingCalls).toHaveLength(1)
    expect(messages).toEqual([])
  })

  it("carries the message id through on the text shard", () => {
    const { messages } = splitResponse([
      assistantMessage([textPart(Role.Assistant, "hi")], "msg-abc"),
    ])

    expect(messages[0]?.id).toBe("msg-abc")
  })
})

describe("@ronde/engine translateBufferedMessages", () => {
  it("drops reasoning artifacts from buffered current-turn content", () => {
    const replay = translateBufferedMessages([
      assistantMessage([
        thinkingPart("secret plan"),
        textPart(Role.Assistant, "visible text"),
      ]),
    ])

    expect(replay).toHaveLength(1)
    expect(replay[0]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      content: "[assistant text]\nvisible text",
    })
  })

  it("converts assistant text into provider-neutral replay text", () => {
    const replay = translateBufferedMessages([
      assistantMessage([textPart(Role.Assistant, "hello")]),
    ])

    expect(replay[0]).toEqual(
      assistantMessage([textPart(Role.Assistant, "[assistant text]\nhello")]),
    )
  })

  it("converts tool calls into text-only replay messages", () => {
    const replay = translateBufferedMessages([
      assistantMessage([
        toolCallPart({
          toolCallId: "call-1",
          name: "search",
          arguments: { q: "docs" },
        }),
      ]),
    ])

    expect(replay[0]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      content: '[assistant tool call] search\nid: call-1\nargs: {"q":"docs"}',
    })
  })

  it("converts tool results into text-only replay messages with status", () => {
    const replay = translateBufferedMessages([
      assistantMessage([
        toolCallPart({
          toolCallId: "call-1",
          name: "search",
          arguments: { q: "docs" },
        }),
      ]),
      {
        parts: [
          toolResultPart({
            toolCallId: "call-1",
            ok: false,
            content: "permission denied",
          }),
        ],
      },
    ])

    expect(replay[1]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      content:
        "[user tool result] search\nid: call-1\nstatus: failure\ncontent:\npermission denied",
    })
  })

  it("emits the tool call alongside its result when buffered as a pair", () => {
    const replay = translateBufferedMessages([
      {
        parts: [
          toolCallPart({
            toolCallId: "call-1",
            name: "search",
            arguments: { q: "docs" },
          }),
          toolResultPart({
            toolCallId: "call-1",
            ok: true,
            content: "found it",
          }),
        ],
      },
    ])

    expect(replay).toHaveLength(2)
    expect(replay[0]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      content: '[assistant tool call] search\nid: call-1\nargs: {"q":"docs"}',
    })
    expect(replay[1]?.parts[0]).toMatchObject({
      type: MessageType.Text,
      content:
        "[user tool result] search\nid: call-1\nstatus: success\ncontent:\nfound it",
    })
  })
})
