import { describe, expect, it, vi } from "vitest"
import { text } from "@ronde/core/block"
import {
  CompletionErrorKind,
  StopReason,
  type CompletionRequest,
} from "@ronde/core/completion"
import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultMessage,
  userMessage,
} from "@ronde/core/message"
import { drain } from "@ronde/core/stream"
import {
  AnthropicCompletionBackend,
  anthropicDescriptor,
  serializeMessages,
} from "../src/anthropic.js"

function fakeStream(
  finalMessage: () => Promise<any>,
  events: any[] = [],
): AsyncIterable<any> & { finalMessage: () => Promise<any> } {
  return {
    finalMessage,
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        yield ev
      }
    },
  }
}

const baseRequest: CompletionRequest = {
  model: "claude-sonnet-4-6",
  system: "be helpful",
  messages: [],
  tools: [],
  maxOutput: 256,
}

describe("@ronde/providers anthropic descriptor", () => {
  it("publishes the anthropic identity, env var, and default URL", () => {
    expect(anthropicDescriptor).toMatchObject({
      name: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      defaultURL: "https://api.anthropic.com",
    })
  })

  it("uses the anthropic name as the default model-string prefix", () => {
    expect(anthropicDescriptor.modelPrefix).toBeUndefined()
    expect(anthropicDescriptor.name).toBe("anthropic")
  })
})

describe("@ronde/providers anthropic backend", () => {
  it("coalesces canonical messages into anthropic role groups", () => {
    const payload = serializeMessages([
      userMessage("first"),
      userMessage("second"),
      assistantMessage([
        thinkingPart("think", { provider: "anthropic", signature: "sig-1" }),
        textPart(Role.Assistant, "reply"),
        toolCallPart({
          toolCallId: "call-1",
          name: "read_file",
          arguments: { path: "README.md" },
        }),
      ]),
      toolResultMessage("call-1", true, "done"),
    ])

    expect(payload).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think", signature: "sig-1" },
          { type: "text", text: "reply" },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "done",
            is_error: false,
          },
        ],
      },
    ])
  })

  it("projects pair-message canonical history into batched anthropic shape", () => {
    // Two pair messages — the canonical form the engine journals for a
    // parallel two-tool turn. Wire shape must keep both tool_uses in one
    // assistant turn and both tool_results in one user turn so thinking
    // signatures stay attached and the model sees the original inference.
    const payload = serializeMessages([
      userMessage("go"),
      {
        parts: [
          toolCallPart({
            toolCallId: "call-1",
            name: "read_file",
            arguments: { path: "a.md" },
          }),
          {
            type: MessageType.ToolResult,
            toolCallId: "call-1",
            ok: true,
            content: [text("first")],
          },
        ],
      },
      {
        parts: [
          toolCallPart({
            toolCallId: "call-2",
            name: "read_file",
            arguments: { path: "b.md" },
          }),
          {
            type: MessageType.ToolResult,
            toolCallId: "call-2",
            ok: true,
            content: [text("second")],
          },
        ],
      },
    ])

    expect(payload).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "go" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "a.md" },
          },
          {
            type: "tool_use",
            id: "call-2",
            name: "read_file",
            input: { path: "b.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "first",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "call-2",
            content: "second",
            is_error: false,
          },
        ],
      },
    ])
  })

  it("serializes system prompts and tool schemas into anthropic request bodies", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    const finalMessage = vi.fn(async () => ({
      id: "msg-1",
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }))
    const stream = vi.fn(() => fakeStream(finalMessage))
    ;(backend as any).client = { messages: { stream } }

    await drain(
      backend.complete({
        ...baseRequest,
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object" },
          },
        ],
      }),
    )

    expect(stream).toHaveBeenCalledOnce()
    const [payload, options] = stream.mock.calls.at(0) as unknown as [any, any]
    expect(payload).toMatchObject({
      model: "claude-sonnet-4-6",
      system: "be helpful",
      max_tokens: 256,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object" },
        },
      ],
    })
    expect(options.headers).toEqual({ "anthropic-version": "2023-06-01" })
  })

  it("maps effort and max token budgets onto anthropic options", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    const stream = vi.fn(() =>
      fakeStream(async () => ({
        id: "msg-1",
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })),
    )
    ;(backend as any).client = { messages: { stream } }

    await drain(
      backend.complete({
        ...baseRequest,
        effort: "xhigh",
      }),
    )

    expect(stream).toHaveBeenCalledOnce()
    const [payload] = stream.mock.calls.at(0) as unknown as [any]
    expect(payload).toMatchObject({
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      max_tokens: 256,
    })
  })

  it("converts text, thinking, and tool_use blocks back into canonical messages", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    ;(backend as any).client = {
      messages: {
        stream: vi.fn(() =>
          fakeStream(async () => ({
            id: "msg-1",
            content: [
              { type: "thinking", thinking: "think", signature: "sig-1" },
              { type: "text", text: "hello" },
              {
                type: "tool_use",
                id: "call-1",
                name: "read_file",
                input: { path: "README.md" },
              },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
          })),
        ),
      },
    }

    const result = await drain(backend.complete(baseRequest))

    expect(result.messages[0].parts).toEqual([
      {
        type: MessageType.Think,
        content: "think",
        meta: { provider: "anthropic", signature: "sig-1" },
      },
      {
        type: MessageType.Content,
        role: Role.Assistant,
        content: [text("hello")],
      },
      {
        type: MessageType.ToolUse,
        toolCallId: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    ])
    expect(result.stopReason).toBe(StopReason.ToolUse)
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 2,
      cachedWriteTokens: 1,
      reasoningTokens: 0,
    })
  })

  it("maps anthropic stop reasons into ronde stop reasons", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    ;(backend as any).client = {
      messages: {
        stream: vi.fn(() =>
          fakeStream(async () => ({
            id: "msg-1",
            content: [],
            stop_reason: "model_context_window_exceeded",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          })),
        ),
      },
    }

    const result = await drain(backend.complete(baseRequest))
    expect(result.stopReason).toBe(StopReason.ContextWindow)
  })

  it("wraps sdk failures into the shared completion error contract", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    ;(backend as any).client = {
      messages: {
        stream: vi.fn(() => {
          throw { status: 429, message: "slow down" }
        }),
      },
    }

    await expect(drain(backend.complete(baseRequest))).rejects.toMatchObject({
      kind: CompletionErrorKind.RateLimit,
      retryable: true,
    })
  })

  it("yields text, thinking, and tool_input deltas while streaming", async () => {
    const backend = new AnthropicCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://api.anthropic.com",
    })
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "plan" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "hi " },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "there" },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call-1" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"x"' },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: ":1}" },
      },
    ]
    ;(backend as any).client = {
      messages: {
        stream: vi.fn(() =>
          fakeStream(
            async () => ({
              id: "msg-1",
              content: [],
              stop_reason: "tool_use",
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            }),
            events,
          ),
        ),
      },
    }

    const yields: unknown[] = []
    const gen = backend.complete(baseRequest)
    let next = await gen.next()
    while (!next.done) {
      yields.push(next.value)
      next = await gen.next()
    }

    expect(yields).toEqual([
      { kind: "thinking_delta", content: "plan" },
      { kind: "text_delta", content: "hi " },
      { kind: "text_delta", content: "there" },
      { kind: "tool_input_delta", toolCallId: "call-1", chunk: '{"x"' },
      { kind: "tool_input_delta", toolCallId: "call-1", chunk: ":1}" },
    ])
  })
})
