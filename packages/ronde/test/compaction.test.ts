import { describe, expect, it } from "vitest"
import {
  CompletionError,
  CompletionErrorKind,
  CompletionMode,
  emptyUsage,
  StopReason,
} from "@ronde/core/completion"
import { MessageType, Role, userMessage } from "@ronde/core/message"
import { DefaultCompactionStrategy } from "../src/compaction.js"
import { mockBackend, textResponse } from "./support.js"

describe("@ronde DefaultCompactionStrategy", () => {
  it("builds the structured continuation-context prompt", async () => {
    const backend = mockBackend([textResponse("summary")])
    const strategy = new DefaultCompactionStrategy()

    await strategy.compact({
      backend,
      model: "mock",
      effort: undefined,
      system: "system prompt",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    const request = backend.requests[0]!
    expect(request.mode).toBe(CompletionMode.Compaction)
    expect(request.system).toContain("continuation context")
    expect(request.messages[0]!.parts[0]!.type).toBe(MessageType.Text)
    if (request.messages[0]!.parts[0]!.type === MessageType.Text) {
      expect(request.messages[0]!.parts[0]!.content).toContain(
        "Original system prompt",
      )
    }
  })

  it("drops oldest history items when the compaction request overflows context", async () => {
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
      effort: undefined,
      system: "system prompt",
      history: [userMessage("first"), userMessage("second")],
      maxOutput: 1000,
    })

    expect(backend.requests).toHaveLength(2)
    expect(backend.requests[0]!.messages.length).toBeGreaterThan(
      backend.requests[1]!.messages.length,
    )
  })

  it("drops tool call and tool result pairs together during compaction trimming", async () => {
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

    await strategy.compact({
      backend,
      model: "mock",
      effort: undefined,
      system: "system prompt",
      history: [
        userMessage("keep"),
        {
          parts: [
            {
              type: "tool_use",
              toolCallId: "call_1",
              name: "search",
              arguments: { q: "x" },
            },
          ],
        },
        {
          parts: [
            {
              type: "tool_result",
              toolCallId: "call_1",
              content: "result",
              ok: true,
            },
          ],
        },
        userMessage("tail"),
      ],
      maxOutput: 1000,
    })

    const retriedHistory = backend.requests[2]!.messages
    expect(
      retriedHistory.some((message) =>
        message.parts.some((part) => part.type === MessageType.ToolUse),
      ),
    ).toBe(false)
    expect(
      retriedHistory.some((message) =>
        message.parts.some((part) => part.type === MessageType.ToolResult),
      ),
    ).toBe(false)
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
      effort: undefined,
      system: "system prompt",
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
      effort: undefined,
      system: "system prompt",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    expect(result.kind).toBe("compacted")
    if (result.kind === "compacted") {
      expect(result.summary.parts[0]!.type).toBe(MessageType.Text)
      if (result.summary.parts[0]!.type === MessageType.Text) {
        expect(result.summary.parts[0]!.role).toBe(Role.User)
        expect(result.summary.parts[0]!.content).toContain(
          "Continuation context",
        )
        expect(result.summary.parts[0]!.content).toContain("summary body")
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
      effort: undefined,
      system: "system prompt",
      history: [userMessage("prior")],
      maxOutput: 1000,
    })

    expect(result.usage.inputTokens).toBe(50)
    expect(result.usage.outputTokens).toBe(10)
  })
})
