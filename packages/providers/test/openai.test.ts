import { describe, expect, it, vi } from "vitest"
import {
  CompletionErrorKind,
  CompletionMode,
  Effort,
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
import {
  openaiDescriptor,
  serializeMessages,
  OpenAICompletionBackend,
} from "../src/openai.js"

const baseRequest: CompletionRequest = {
  model: "gpt-5.4",
  system: "be helpful",
  messages: [],
  tools: [],
  mode: CompletionMode.Agentic,
  effort: null,
  maxOutputTokens: 256,
}

class TestOpenAIBackend extends OpenAICompletionBackend {
  payload?: Record<string, unknown>
  signal: AbortSignal | undefined
  response?: Record<string, unknown>
  thrown: unknown = null

  protected override async doRequest(
    _client: unknown,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    this.payload = payload
    this.signal = signal
    if (this.thrown) {
      throw this.thrown
    }
    return this.response
  }
}

describe("@ronde/providers openai descriptor", () => {
  it("publishes the openai identity, env var, and default URL", () => {
    expect(openaiDescriptor).toMatchObject({
      name: "openai",
      envVar: "OPENAI_API_KEY",
      defaultURL: "https://api.openai.com/v1",
    })
  })

  it("uses the openai name as the default model-string prefix", () => {
    expect(openaiDescriptor.modelPrefix).toBeUndefined()
    expect(openaiDescriptor.name).toBe("openai")
  })
})

describe("@ronde/providers openai backend", () => {
  it("serializes canonical messages into the OpenAI wire format", () => {
    const items = serializeMessages([
      { parts: [textPart(Role.System, "sys")] },
      userMessage("user"),
      assistantMessage([
        thinkingPart("think", {
          provider: "openai",
          itemId: "r1",
          encryptedContent: "enc",
        }),
        textPart(Role.Assistant, "reply", {
          provider: "openai",
          itemId: "m1",
        }),
        toolCallPart({
          toolCallId: "call-1",
          name: "read_file",
          arguments: { path: "README.md" },
          meta: { provider: "openai", itemId: "fc1" },
        }),
      ]),
      toolResultMessage("call-1", true, "done"),
    ])

    expect(items).toEqual([
      {
        role: "developer",
        content: [{ type: "input_text", text: "sys" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "user" }],
      },
      {
        type: "reasoning",
        id: "r1",
        summary: [{ type: "summary_text", text: "think" }],
        encrypted_content: "enc",
      },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "reply" }],
      },
      {
        type: "function_call",
        id: "fc1",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "done",
      },
    ])
  })

  it("serializes tool schemas and strict flags", async () => {
    const backend = new TestOpenAIBackend({
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    })
    backend.response = {
      id: "resp-1",
      status: "completed",
      output: [],
      usage: undefined,
      incomplete_details: null,
    }

    await backend.complete({
      ...baseRequest,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
        {
          name: "write_file",
          description: "Write a file",
          inputSchema: { type: "object" },
          strict: false,
        },
      ],
    })

    expect(backend.payload?.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
        strict: true,
      },
      {
        type: "function",
        name: "write_file",
        description: "Write a file",
        parameters: { type: "object" },
        strict: false,
      },
    ])
  })

  it("maps reasoning effort and nativeOpenAI options", async () => {
    const backend = new TestOpenAIBackend({
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    })
    const controller = new AbortController()
    backend.response = {
      id: "resp-1",
      status: "completed",
      output: [],
      usage: undefined,
      incomplete_details: null,
    }

    await backend.complete({
      ...baseRequest,
      effort: Effort.High,
      signal: controller.signal,
    })

    expect(backend.payload).toMatchObject({
      model: "gpt-5.4",
      instructions: "be helpful",
      max_output_tokens: 256,
      reasoning: {
        effort: "high",
        summary: "auto",
      },
      include: ["reasoning.encrypted_content"],
    })
    expect(backend.signal).toBe(controller.signal)
  })

  it("converts assistant text, reasoning, and tool calls back into canonical messages", async () => {
    const backend = new TestOpenAIBackend({
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    })
    backend.response = {
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "r1",
          summary: [{ type: "summary_text", text: "think" }],
          encrypted_content: "enc",
        },
        {
          type: "message",
          id: "m1",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
        {
          type: "function_call",
          id: "fc1",
          status: "completed",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
      incomplete_details: null,
    }

    const result = await backend.complete(baseRequest)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].parts).toEqual([
      {
        type: MessageType.Think,
        content: "think",
        meta: {
          provider: "openai",
          itemId: "r1",
          encryptedContent: "enc",
        },
      },
      {
        type: MessageType.Text,
        role: Role.Assistant,
        content: "hello",
        meta: {
          provider: "openai",
          itemId: "m1",
        },
      },
      {
        type: MessageType.ToolUse,
        toolCallId: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        meta: {
          provider: "openai",
          itemId: "fc1",
        },
      },
    ])
    expect(result.stopReason).toBe(StopReason.ToolUse)
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 9,
      cachedReadTokens: 2,
      cachedWriteTokens: 0,
      reasoningTokens: 4,
    })
    expect(result.providerMeta).toEqual({
      provider: "openai",
      responseId: "resp-1",
      status: "completed",
      incompleteReason: null,
    })
    expect(result.warnings).toEqual([])
  })

  it("maps provider finish reasons into ronde stop reasons", async () => {
    const backend = new TestOpenAIBackend({
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    })
    backend.response = {
      id: "resp-2",
      status: "incomplete",
      output: [],
      usage: undefined,
      incomplete_details: { reason: "content_filter" },
    }

    const result = await backend.complete(baseRequest)

    expect(result.stopReason).toBe(StopReason.Refusal)
  })

  it("wraps sdk failures into the shared completion error contract", async () => {
    const backend = new OpenAICompletionBackend({
      nativeOpenAI: true,
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
    })
    ;(backend as any).client = {
      responses: {
        stream: vi.fn(() => {
          throw { status: 429, message: "too many requests" }
        }),
      },
    }

    await expect(backend.complete(baseRequest)).rejects.toMatchObject({
      kind: CompletionErrorKind.RateLimit,
      retryable: true,
    })
  })
})
