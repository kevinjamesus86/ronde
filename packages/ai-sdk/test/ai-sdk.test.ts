import { describe, expect, it } from "vitest"
import {
  CompletionMode,
  MessageType,
  Role,
  StopReason,
  assistantMessage,
  textPart,
  thinkingPart,
  userMessage,
} from "@ronde/core"
import { DEFAULT_MAX_CONTEXT, DEFAULT_MAX_OUTPUT } from "@ronde/backend"
import { drain } from "@ronde/core/stream"
import { fromAiSdk } from "../src/index.js"

/**
 * Mock model that routes `doStream` calls through `handler` — the
 * handler keeps its original `doGenerate` shape (returns
 * `{ content, finishReason, usage, warnings }`), and we synthesize a
 * stream from that shape so existing conversion-level tests keep
 * working after the adapter's switch to `doStream`. For tests that
 * want raw stream control, use `mockAiSdkStream` below.
 */
function mockAiSdkModel(
  handler: (options: any) => any,
  modelId = "test-model",
) {
  return {
    specificationVersion: "v3" as const,
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used — adapter calls doStream")
    },
    doStream: async (options: any) => ({
      stream: streamFromGenerateResult(handler(options)),
    }),
  }
}

/** Mock model that emits the given stream parts verbatim — for testing
 *  the streaming path end-to-end. */
function mockAiSdkStream(
  parts: any[],
  modelId = "test-model",
  onOptions?: (options: any) => void,
) {
  return {
    specificationVersion: "v3" as const,
    provider: "test",
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("doGenerate not used")
    },
    doStream: async (options: any) => {
      onOptions?.(options)
      return { stream: readableFrom(parts) }
    },
  }
}

/** Synthesize a doStream-shaped ReadableStream from a doGenerate-
 *  shaped result object. One content block in, one *-start / *-delta
 *  (full text) / *-end trio out, followed by a `finish` part. */
function streamFromGenerateResult(result: any): ReadableStream<any> {
  const parts: any[] = []
  parts.push({ type: "stream-start", warnings: result.warnings ?? [] })
  let idCounter = 0
  for (const c of result.content ?? []) {
    const id = `p-${++idCounter}`
    if (c.type === "text") {
      parts.push({ type: "text-start", id })
      parts.push({ type: "text-delta", id, delta: c.text ?? "" })
      parts.push({ type: "text-end", id })
    } else if (c.type === "reasoning") {
      parts.push({ type: "reasoning-start", id })
      parts.push({ type: "reasoning-delta", id, delta: c.text ?? "" })
      parts.push({ type: "reasoning-end", id })
    } else if (c.type === "tool-call") {
      parts.push({ ...c })
    }
  }
  parts.push({
    type: "finish",
    finishReason: result.finishReason,
    usage: result.usage,
  })
  return readableFrom(parts)
}

function readableFrom(parts: any[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) {
        controller.enqueue(p)
      }
      controller.close()
    },
  })
}

describe("@ronde/ai-sdk request conversion", () => {
  it("converts canonical messages into AI SDK prompt messages", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    await drain(
      backend.complete({
        model: "test",
        system: "system prompt",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(calls[0]!.prompt[0]).toEqual({
      role: "system",
      content: "system prompt",
    })
    expect(calls[0]!.prompt[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    })
  })

  it("preserves assistant text messages in prior conversation history", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    await drain(
      backend.complete({
        model: "test",
        messages: [
          userMessage("q"),
          assistantMessage([textPart(Role.Assistant, "answer")]),
          userMessage("follow up"),
        ],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    const assistantPrompt = calls[0]!.prompt.find(
      (message: any) => message.role === "assistant",
    )
    expect(assistantPrompt).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    })
  })

  it("replays thinking parts only when the mode policy allows it", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    const assistantWithThinking = assistantMessage([
      thinkingPart("reasoning"),
      textPart(Role.Assistant, "answer"),
    ])

    await drain(
      backend.complete({
        model: "test",
        messages: [assistantWithThinking],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      } as any),
    )

    await drain(
      backend.complete({
        model: "test",
        messages: [assistantWithThinking],
        tools: [],
        mode: CompletionMode.Compaction,
        effort: undefined,
        maxOutput: 100,
      } as any),
    )

    expect(calls[0]!.prompt[0].content).toContainEqual({
      type: "reasoning",
      text: "reasoning",
    })
    expect(
      calls[1]!.prompt[0].content.some(
        (part: any) => part.type === "reasoning",
      ),
    ).toBe(false)
  })

  it("converts tool schemas into AI SDK function tools", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: { type: "object" },
          },
        ],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(calls[0]!.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
        strict: undefined,
      },
    ])
  })

  it("passes through strict tool schemas unchanged", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [
          {
            name: "search",
            description: "Search",
            inputSchema: { type: "object" },
            strict: true,
          },
        ],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(calls[0]!.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
        strict: true,
      },
    ])
  })
})

describe("@ronde/ai-sdk response conversion", () => {
  it("converts text, reasoning, and tool-call output back into canonical messages", async () => {
    const backend = fromAiSdk(
      mockAiSdkModel(() => ({
        content: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "search",
            input: { q: "x" },
          },
          { type: "text", text: "done" },
        ],
        finishReason: { unified: "tool-calls" },
        usage: {
          inputTokens: { total: 10 },
          outputTokens: { total: 5, reasoning: 2 },
        },
        warnings: [],
      })),
    )

    const result = await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(result.messages[0]!.parts.map((part) => part.type)).toEqual([
      MessageType.Think,
      MessageType.ToolUse,
      MessageType.Text,
    ])
  })

  it("maps AI SDK finish reasons into ronde stop reasons", async () => {
    const backend = fromAiSdk(
      mockAiSdkModel(() => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "length" },
        usage: {
          inputTokens: { total: 10 },
          outputTokens: { total: 5 },
        },
        warnings: [],
      })),
    )

    const result = await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(result.stopReason).toBe(StopReason.MaxTokens)
  })

  it("converts AI SDK usage into canonical usage stats", async () => {
    const backend = fromAiSdk(
      mockAiSdkModel(() => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 20, cacheRead: 3, cacheWrite: 2 },
          outputTokens: { total: 7, reasoning: 4 },
        },
        warnings: [],
      })),
    )

    const result = await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 7,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
      reasoningTokens: 4,
    })
  })

  it("surfaces AI SDK warnings as canonical completion warnings", async () => {
    const backend = fromAiSdk(
      mockAiSdkModel(() => ({
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 10 },
          outputTokens: { total: 5 },
        },
        warnings: [
          {
            type: "unsupported",
            feature: "reasoning",
            details: "provider ignored it",
          },
          { type: "other" },
        ],
      })),
    )

    const result = await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Agentic,
        effort: undefined,
        maxOutput: 100,
      }),
    )

    expect(result.warnings).toEqual([
      {
        type: "unsupported",
        feature: "reasoning",
        details: "provider ignored it",
      },
    ])
  })
})

describe("@ronde/ai-sdk adapter", () => {
  it("wraps a LanguageModelV4 into a configured backend", () => {
    const backend = fromAiSdk(
      mockAiSdkModel(() => ({
        content: [],
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 0 },
          outputTokens: { total: 0 },
        },
        warnings: [],
      })),
    )

    expect(backend.specVersion).toBe("v1")
    expect(backend.config.model).toBe("test-model")
  })

  it("preserves the configured model id and default token budgets", () => {
    const backend = fromAiSdk(
      mockAiSdkModel(
        () => ({
          content: [],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 0 },
            outputTokens: { total: 0 },
          },
          warnings: [],
        }),
        "model-123",
      ),
    )

    expect(backend.config.model).toBe("model-123")
    expect(backend.config.maxContext).toBe(DEFAULT_MAX_CONTEXT)
    expect(backend.config.maxOutput).toBe(DEFAULT_MAX_OUTPUT)
  })

  it("supports structured mode response-format requests", async () => {
    const calls: any[] = []
    const backend = fromAiSdk(
      mockAiSdkModel((options) => {
        calls.push(options)
        return {
          content: [{ type: "text", text: '{"ok":true}' }],
          finishReason: { unified: "stop" },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
          },
          warnings: [],
        }
      }),
    )

    await drain(
      backend.complete({
        model: "test",
        messages: [userMessage("hi")],
        tools: [],
        mode: CompletionMode.Structured,
        effort: undefined,
        maxOutput: 100,
        providerOptions: {
          openai: {
            responseFormat: {
              type: "json",
              schema: { type: "object" },
            },
          },
        },
      }),
    )

    expect(calls[0]!.providerOptions).toEqual({
      openai: {
        responseFormat: {
          type: "json",
          schema: { type: "object" },
        },
      },
    })
  })

  it("yields text, thinking, and tool_input deltas from the stream", async () => {
    const backend = fromAiSdk(
      mockAiSdkStream([
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: "thinking " },
        { type: "reasoning-delta", id: "r1", delta: "about it" },
        { type: "reasoning-end", id: "r1" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hi " },
        { type: "text-delta", id: "t1", delta: "there" },
        { type: "text-end", id: "t1" },
        { type: "tool-input-delta", id: "call-1", delta: '{"x":' },
        { type: "tool-input-delta", id: "call-1", delta: "1}" },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "echo",
          input: '{"x":1}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls" },
          usage: {
            inputTokens: { total: 5 },
            outputTokens: { total: 3 },
          },
        },
      ]),
    )

    const deltas: any[] = []
    const gen = backend.complete({
      model: "test",
      messages: [userMessage("go")],
      tools: [],
      mode: CompletionMode.Agentic,
      effort: undefined,
      maxOutput: 100,
    }) as AsyncGenerator<any, any, void>
    let next = await gen.next()
    while (!next.done) {
      deltas.push(next.value)
      next = await gen.next()
    }
    const response = next.value

    expect(deltas).toEqual([
      { kind: "thinking_delta", content: "thinking " },
      { kind: "thinking_delta", content: "about it" },
      { kind: "text_delta", content: "hi " },
      { kind: "text_delta", content: "there" },
      { kind: "tool_input_delta", toolCallId: "call-1", chunk: '{"x":' },
      { kind: "tool_input_delta", toolCallId: "call-1", chunk: "1}" },
    ])
    expect(response.stopReason).toBe(StopReason.ToolUse)
    expect(response.usage.inputTokens).toBe(5)
    expect(response.usage.outputTokens).toBe(3)
    expect(response.messages[0].parts.map((p: any) => p.type)).toEqual([
      MessageType.Think,
      MessageType.Text,
      MessageType.ToolUse,
    ])
  })
})
