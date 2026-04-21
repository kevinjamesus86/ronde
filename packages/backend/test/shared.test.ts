import { describe, expect, it } from "vitest"
import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
  userMessage,
  type Message,
} from "@ronde/core/message"
import {
  canonicalize,
  coalesceByRole,
  type NormalizedPart,
} from "../src/shared.js"

interface OwnMeta {
  provider: "own"
  id: string
}

function isOwnMeta(meta: unknown): meta is OwnMeta {
  return (
    typeof meta === "object" &&
    meta !== null &&
    "provider" in meta &&
    (meta as { provider?: unknown }).provider === "own"
  )
}

function textContent(part: NormalizedPart<OwnMeta>): string | undefined {
  return "content" in part && typeof part.content === "string"
    ? part.content
    : undefined
}

describe("@ronde/backend canonicalize", () => {
  it("preserves provider-owned meta untouched", () => {
    const meta: OwnMeta = { provider: "own", id: "1" }
    const messages = [
      assistantMessage([textPart(Role.Assistant, "hello", meta)]),
    ]

    const normalized = canonicalize(messages, isOwnMeta)

    expect(normalized[0].parts[0].meta).toBe(meta)
  })

  it("keeps meta absent on parts that carry no provider state", () => {
    const messages = [assistantMessage([textPart(Role.Assistant, "hello")])]

    const normalized = canonicalize(messages, isOwnMeta)

    expect(normalized[0].parts[0]).not.toHaveProperty("meta")
  })

  it("drops foreign thinking parts", () => {
    const messages = [
      assistantMessage([
        thinkingPart("private", { provider: "other" }),
        textPart(Role.Assistant, "public", { provider: "other" }),
      ]),
    ]

    const normalized = canonicalize(messages, isOwnMeta)

    expect(normalized[0].parts).toHaveLength(1)
    expect(normalized[0].parts[0]).toMatchObject({
      type: MessageType.Text,
      content: "public",
    })
    expect(normalized[0].parts[0]).not.toHaveProperty("meta")
  })

  it("strips foreign meta from text, tool call, and tool result parts", () => {
    const messages: Message[] = [
      assistantMessage([
        textPart(Role.Assistant, "hello", { provider: "other" }),
        toolCallPart({
          toolCallId: "call-1",
          name: "read_file",
          arguments: { path: "README.md" },
          meta: { provider: "other" },
        }),
      ]),
      {
        parts: [
          toolResultPart({
            toolCallId: "call-1",
            ok: true,
            content: "done",
            meta: { provider: "other" },
          }),
        ],
      },
    ]

    const normalized = canonicalize(messages, isOwnMeta)

    expect(normalized[0].parts[0]).not.toHaveProperty("meta")
    expect(normalized[0].parts[1]).not.toHaveProperty("meta")
    expect(normalized[1].parts[0]).not.toHaveProperty("meta")
  })

  it("retains message ids while rewriting part metadata", () => {
    const messages = [
      assistantMessage(
        [textPart(Role.Assistant, "hello", { provider: "other" })],
        "msg-1",
      ),
    ]

    const normalized = canonicalize(messages, isOwnMeta)

    expect(normalized[0].id).toBe("msg-1")
    expect(normalized[0].parts[0]).not.toHaveProperty("meta")
  })
})

describe("@ronde/backend coalesceByRole", () => {
  it("merges consecutive parts with the same mapped role", () => {
    const grouped = coalesceByRole(
      canonicalize([userMessage("one"), userMessage("two")], isOwnMeta),
      (role) => role,
      textContent,
    )

    expect(grouped).toEqual([{ role: Role.User, parts: ["one", "two"] }])
  })

  it("starts a new group when the mapped role changes", () => {
    const grouped = coalesceByRole(
      canonicalize(
        [
          userMessage("one"),
          assistantMessage([textPart(Role.Assistant, "two")]),
        ],
        isOwnMeta,
      ),
      (role) => role,
      textContent,
    )

    expect(grouped).toEqual([
      { role: Role.User, parts: ["one"] },
      { role: Role.Assistant, parts: ["two"] },
    ])
  })

  it("skips parts whose serializer returns undefined", () => {
    const grouped = coalesceByRole(
      canonicalize(
        [
          userMessage("one"),
          assistantMessage([textPart(Role.Assistant, "two")]),
        ],
        isOwnMeta,
      ),
      (role) => role,
      (part) =>
        part.type === MessageType.Text && part.role === Role.User
          ? part.content
          : undefined,
    )

    expect(grouped).toEqual([{ role: Role.User, parts: ["one"] }])
  })

  it("preserves part order across merged groups", () => {
    const grouped = coalesceByRole(
      canonicalize(
        [
          userMessage("one"),
          userMessage("two"),
          assistantMessage([textPart(Role.Assistant, "three")]),
          assistantMessage([textPart(Role.Assistant, "four")]),
        ],
        isOwnMeta,
      ),
      (role) => role,
      textContent,
    )

    expect(grouped).toEqual([
      { role: Role.User, parts: ["one", "two"] },
      { role: Role.Assistant, parts: ["three", "four"] },
    ])
  })

  it("splits a single mixed-role message into adjacent groups", () => {
    const mixed: Message = {
      parts: [
        toolCallPart({
          toolCallId: "call-1",
          name: "search",
          arguments: {},
        }),
        toolResultPart({ toolCallId: "call-1", ok: true, content: "done" }),
      ],
    }

    const grouped = coalesceByRole(
      canonicalize([mixed], isOwnMeta),
      (role) => role,
      (part) => part.type,
    )

    expect(grouped).toEqual([
      { role: Role.Assistant, parts: [MessageType.ToolUse] },
      { role: Role.User, parts: [MessageType.ToolResult] },
    ])
  })
})
