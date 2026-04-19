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
import { extractToolCalls, translateBufferedMessages } from "../src/replay.js"

describe("@ronde/engine extractToolCalls", () => {
  it("extracts tool-call parts from assistant messages in order", () => {
    const calls = extractToolCalls([
      assistantMessage([
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

    expect(calls.map((call) => call.name)).toEqual(["first", "second"])
  })

  it("ignores text, thinking, and tool-result parts", () => {
    expect(
      extractToolCalls([
        assistantMessage([
          textPart(Role.Assistant, "hi"),
          thinkingPart("plan"),
        ]),
        {
          parts: [
            toolResultPart({
              toolCallId: "call-1",
              ok: true,
              content: "done",
            }),
          ],
        },
      ]),
    ).toEqual([])
  })

  it("returns an empty list when no tool calls are present", () => {
    expect(
      extractToolCalls([assistantMessage([textPart(Role.Assistant, "done")])]),
    ).toEqual([])
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
})
