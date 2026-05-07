import { describe, expect, it } from "vitest"
import {
  CompletionError,
  CompletionErrorKind,
  emptyUsage,
  StopReason,
} from "@ronde/core/completion"
import { blocksToText, text } from "@ronde/core/block"
import { MessageType, partRole, Role, userMessage } from "@ronde/core/message"
import { DefaultCompactionStrategy } from "../src/compaction.js"
import { mockBackend, textResponse } from "./support.js"

describe("@ronde DefaultCompactionStrategy", () => {
  it("builds the structured continuation-context prompt", async () => {
    const backend = mockBackend([textResponse("summary")])
    const strategy = new DefaultCompactionStrategy()

    await strategy.compact({
      backend,
      model: "mock",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    const request = backend.requests[0]!
    // Compaction system prompt drives the summary.
    expect(request.system).toContain("continuation context")
    // No system-prompt-prepended user message — history flows through
    // directly. First message is the history's first message.
    expect(request.messages[0]!.parts[0]!.type).toBe(MessageType.Content)
    if (request.messages[0]!.parts[0]!.type === MessageType.Content) {
      expect(blocksToText(request.messages[0]!.parts[0]!.content)).toBe("prior")
    }
  })

  // Compaction must be safe to call on any history tail — in particular
  // a completed session naturally ends with an assistant text reply.
  // Anthropic rejects this outright ("last message must be user");
  // OpenAI chat and Gemini have equivalent constraints. Enforce at the
  // strategy layer so no provider ever sees an assistant-tailed request.
  it("always ends the compaction request with a user-role part, even when history tail is assistant text", async () => {
    const backend = mockBackend([textResponse("continuation")])
    const strategy = new DefaultCompactionStrategy()

    await strategy.compact({
      backend,
      model: "mock",
      history: [
        userMessage("start"),
        {
          parts: [
            {
              type: MessageType.Content,
              role: Role.Assistant,
              content: [text("final reply")],
            },
          ],
        },
      ],
      maxOutput: 1000,
    })

    const lastMessage = backend.requests[0]!.messages.at(-1)!
    const lastPart = lastMessage.parts.at(-1)!
    expect(partRole(lastPart)).toBe(Role.User)
  })

  it("shrinks the compaction request and retries when it overflows context", async () => {
    const backend = mockBackend([
      new CompletionError(
        CompletionErrorKind.ContextLengthExceeded,
        "too large",
      ),
      textResponse("trimmed summary"),
    ])
    const strategy = new DefaultCompactionStrategy()

    await strategy.compact({
      backend,
      model: "mock",
      history: [userMessage("first"), userMessage("second")],
      maxOutput: 1000,
    })

    expect(backend.requests).toHaveLength(2)
    expect(backend.requests[0]!.messages.length).toBeGreaterThan(
      backend.requests[1]!.messages.length,
    )
  })

  it("buffers popped messages into deferred so they survive compaction retry", async () => {
    const backend = mockBackend([
      new CompletionError(
        CompletionErrorKind.ContextLengthExceeded,
        "too large",
      ),
      new CompletionError(
        CompletionErrorKind.ContextLengthExceeded,
        "still too large",
      ),
      textResponse("trimmed summary"),
    ])
    const strategy = new DefaultCompactionStrategy()

    const result = await strategy.compact({
      backend,
      model: "mock",
      history: [
        userMessage("keep"),
        {
          parts: [
            {
              type: MessageType.ToolUse,
              toolCallId: "call_1",
              name: "search",
              arguments: { q: "x" },
            },
            {
              type: MessageType.ToolResult,
              toolCallId: "call_1",
              content: [text("result")],
              ok: true,
            },
          ],
        },
        userMessage("tail"),
      ],
      maxOutput: 1000,
    })

    expect(result.kind).toBe("compacted")
    if (result.kind !== "compacted") {
      return
    }
    expect(result.deferred).toHaveLength(2)
    expect(result.deferred[0]!.parts[0]!.type).toBe(MessageType.ToolUse)
    expect(result.deferred[1]!.parts[0]!.type).toBe(MessageType.Content)
  })

  it("returns not_compacted when the compacted response has no assistant text", async () => {
    const backend = mockBackend([
      {
        messages: [],
        stopReason: StopReason.EndTurn,
        usage: emptyUsage(),
        providerMeta: { provider: "mock" },
        warnings: [],
      },
    ])
    const strategy = new DefaultCompactionStrategy()

    const result = await strategy.compact({
      backend,
      model: "mock",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    expect(result).toEqual({
      kind: "not_compacted",
      usage: emptyUsage(),
    })
  })

  it("wraps the summary in a user continuation message when compaction succeeds", async () => {
    const backend = mockBackend([textResponse("summary body")])
    const strategy = new DefaultCompactionStrategy()

    const result = await strategy.compact({
      backend,
      model: "mock",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    expect(result.kind).toBe("compacted")
    if (result.kind === "compacted") {
      expect(result.summary.parts[0]!.type).toBe(MessageType.Content)
      if (result.summary.parts[0]!.type === MessageType.Content) {
        expect(result.summary.parts[0]!.role).toBe(Role.User)
        const summaryText = blocksToText(result.summary.parts[0]!.content)
        expect(summaryText).toContain("Continuation context")
        expect(summaryText).toContain("summary body")
      }
    }
  })

  it("surfaces backend usage from the compaction call", async () => {
    const backend = mockBackend([
      textResponse("summary", { inputTokens: 50, outputTokens: 10 }),
    ])
    const strategy = new DefaultCompactionStrategy()

    const result = await strategy.compact({
      backend,
      model: "mock",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    expect(result.usage.inputTokens).toBe(50)
    expect(result.usage.outputTokens).toBe(10)
  })
})
