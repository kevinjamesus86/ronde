import { describe, expect, it } from "vitest"
import {
  CompletionMode,
  StopReason,
  type CompletionRequest,
} from "@ronde/core/completion"
import {
  MessageType,
  Role,
  thinkingPart,
  assistantMessage,
} from "@ronde/core/message"
import {
  LlamaCppCompletionBackend,
  llamacppDescriptor,
} from "../src/llamacpp.js"

const baseRequest: CompletionRequest = {
  model: "llama-3.3",
  system: "",
  messages: [assistantMessage([thinkingPart("private")])],
  tools: [],
  mode: CompletionMode.Agentic,
  effort: undefined,
  maxOutput: 256,
}

class TestLlamaBackend extends LlamaCppCompletionBackend {
  payload?: Record<string, unknown>
  protected override async doRequest(
    _client: unknown,
    payload: Record<string, unknown>,
  ): Promise<any> {
    this.payload = payload
    return {
      id: "resp-1",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg-1",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      incomplete_details: null,
    }
  }
}

describe("@ronde/providers llamacpp descriptor", () => {
  it("publishes the llamacpp identity and local-runtime defaults", () => {
    expect(llamacppDescriptor).toMatchObject({
      name: "llamacpp",
      defaultURL: "http://127.0.0.1:8000/v1",
    })
  })

  it("omits an API key env var for local inference", () => {
    expect(llamacppDescriptor.envVar).toBeNull()
  })
})

describe("@ronde/providers llamacpp backend", () => {
  it("serializes canonical messages into llama.cpp OpenAI-compatible format", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    await backend.complete(baseRequest)

    expect(backend.payload?.input).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "private" }],
      },
    ])
  })

  it("serializes tool schemas for llama.cpp tool calling", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    await backend.complete({
      ...baseRequest,
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object" },
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
    ])
  })

  it("maps llama.cpp finish reasons into ronde stop reasons", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    const result = await backend.complete(baseRequest)

    expect(result.stopReason).toBe(StopReason.EndTurn)
  })

  it("converts assistant text back into canonical messages", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    const result = await backend.complete(baseRequest)

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].parts).toEqual([
      {
        type: MessageType.Text,
        role: Role.Assistant,
        content: "hello",
        meta: { provider: "openai", itemId: "msg-1" },
      },
    ])
  })

  it("converts llama.cpp usage into canonical usage stats", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    const result = await backend.complete(baseRequest)

    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  it("labels provider metadata as llamacpp", async () => {
    const backend = new TestLlamaBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "http://127.0.0.1:8000/v1",
    })

    const result = await backend.complete(baseRequest)

    expect(result.providerMeta).toEqual({
      provider: "llamacpp",
      responseId: "resp-1",
      status: "completed",
      incompleteReason: null,
    })
  })
})
