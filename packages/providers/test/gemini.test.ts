import { describe, expect, it, vi } from "vitest"
import { image, ref, text } from "@ronde/core/block"
import {
  CompletionErrorKind,
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
import { drain } from "@ronde/core/stream"
import {
  GeminiCompletionBackend,
  geminiDescriptor,
  serializeMessages,
} from "../src/gemini.js"

async function* asSingleChunkStream(response: any): AsyncIterable<any> {
  yield response
}

// SDK throws synchronously on request-build errors.
function throwingStream(err: unknown): () => never {
  return () => {
    throw err
  }
}

const baseRequest: CompletionRequest = {
  model: "gemini-2.5-pro",
  system: "be helpful",
  messages: [],
  tools: [],
  maxOutput: 256,
}

describe("@ronde/providers gemini descriptor", () => {
  it("publishes the gemini identity, env var, and default URL", () => {
    expect(geminiDescriptor).toMatchObject({
      name: "gemini",
      envVar: "GEMINI_API_KEY",
      defaultURL: "https://generativelanguage.googleapis.com/v1beta",
    })
  })

  it("uses the gemini name as the default model-string prefix", () => {
    expect(geminiDescriptor.modelPrefix).toBeUndefined()
    expect(geminiDescriptor.name).toBe("gemini")
  })
})

describe("@ronde/providers gemini backend", () => {
  it("coalesces canonical messages into gemini role groups", () => {
    const payload = serializeMessages([
      userMessage("first"),
      userMessage("second"),
      assistantMessage([
        thinkingPart("think", {
          provider: "gemini",
          thoughtSignature: "sig-1",
        }),
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
        parts: [{ text: "first" }, { text: "second" }],
      },
      {
        role: "model",
        parts: [
          {
            text: "think",
            thought: true,
            thoughtSignature: "sig-1",
          },
          { text: "reply" },
          {
            functionCall: {
              id: "call-1",
              name: "read_file",
              args: { path: "README.md" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "read_file",
              response: {
                toolCallId: "call-1",
                content: "done",
              },
            },
          },
        ],
      },
    ])
  })

  it("flattens multimodal tool-result blocks into the response.content field", () => {
    const out = serializeMessages([
      assistantMessage([
        toolCallPart({
          toolCallId: "call-1",
          name: "screenshot",
          arguments: {},
        }),
      ]),
      toolResultMessage("call-1", true, [
        text("Captured."),
        image("aGVsbG8=", "image/png"),
        ref("file:///workspace/log.txt", {
          mediaType: "text/plain",
          bytes: 50_000,
          summary: "tail",
        }),
      ]),
    ])

    const userMessage = out.find((m) => m.role === "user")
    expect(userMessage).toBeDefined()
    const fr = userMessage!.parts[0]!.functionResponse as Record<
      string,
      unknown
    >
    expect(fr.id).toBe("call-1")
    const content = (fr.response as { content: string }).content
    expect(content).toContain("Captured.")
    expect(content).toContain("image/png")
    expect(content).toContain("file:///workspace/log.txt")
    expect(content).toContain("(tail)")
  })

  it("serializes tools and response schemas into gemini request bodies", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    const generateContentStream = vi.fn(async () =>
      asSingleChunkStream({
        candidates: [],
        usageMetadata: undefined,
        promptFeedback: undefined,
        responseId: "resp-1",
      }),
    )
    ;(backend as any).client = { models: { generateContentStream } }

    await drain(
      backend.complete({
        ...baseRequest,
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
              type: ["object", "null"],
              additionalProperties: false,
            },
          },
        ],
      }),
    )

    expect(generateContentStream).toHaveBeenCalledOnce()
    const [payload] = generateContentStream.mock.calls.at(0) as unknown as [any]
    expect(payload.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parametersJsonSchema: { type: "object" },
          },
        ],
      },
    ])
  })

  it("maps effort and budget options into gemini config", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    const generateContentStream = vi.fn(async () =>
      asSingleChunkStream({
        candidates: [],
        usageMetadata: undefined,
        promptFeedback: undefined,
        responseId: "resp-1",
      }),
    )
    ;(backend as any).client = { models: { generateContentStream } }

    await drain(
      backend.complete({
        ...baseRequest,
        model: "gemini-3-pro",
        effort: Effort.Med,
      }),
    )

    expect(generateContentStream).toHaveBeenCalledOnce()
    const [payload] = generateContentStream.mock.calls.at(0) as unknown as [any]
    expect(payload.config).toMatchObject({
      maxOutputTokens: 256,
      systemInstruction: "be helpful",
      thinkingConfig: {
        thinkingLevel: "medium",
        includeThoughts: true,
      },
    })
  })

  it("converts text, thinking, and tool calls back into canonical messages", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    ;(backend as any).client = {
      models: {
        generateContentStream: vi.fn(async () =>
          asSingleChunkStream({
            responseId: "resp-1",
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: "think",
                      thought: true,
                      thoughtSignature: "sig-1",
                    },
                    {
                      text: "hello",
                      thoughtSignature: "sig-1",
                    },
                    {
                      functionCall: {
                        id: "call-1",
                        name: "read_file",
                        args: { path: "README.md" },
                      },
                    },
                  ],
                },
              },
            ],
            promptFeedback: undefined,
            usageMetadata: {
              promptTokenCount: 10,
              thoughtsTokenCount: 4,
              totalTokenCount: 25,
              cachedContentTokenCount: 2,
            },
          }),
        ),
      },
    }

    const result = await drain(backend.complete(baseRequest))

    expect(result.messages[0].parts).toEqual([
      {
        type: MessageType.Think,
        content: "think",
        meta: { provider: "gemini", thoughtSignature: "sig-1" },
      },
      {
        type: MessageType.Content,
        role: Role.Assistant,
        content: [text("hello")],
        meta: { provider: "gemini", thoughtSignature: "sig-1" },
      },
      {
        type: MessageType.ToolUse,
        toolCallId: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        meta: { provider: "gemini", thoughtSignature: "sig-1" },
      },
    ])
    expect(result.stopReason).toBe(StopReason.ToolUse)
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 11,
      cachedReadTokens: 2,
      cachedWriteTokens: 0,
      reasoningTokens: 4,
    })
  })

  it("maps gemini finish reasons into ronde stop reasons", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    ;(backend as any).client = {
      models: {
        generateContentStream: vi.fn(async () =>
          asSingleChunkStream({
            responseId: "resp-1",
            candidates: [
              { finishReason: "MAX_TOKENS", content: { parts: [] } },
            ],
            promptFeedback: undefined,
            usageMetadata: undefined,
          }),
        ),
      },
    }

    const result = await drain(backend.complete(baseRequest))
    expect(result.stopReason).toBe(StopReason.MaxTokens)
  })

  it("wraps sdk failures into the shared completion error contract", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    ;(backend as any).client = {
      models: {
        generateContentStream: throwingStream({
          status: 429,
          message: "slow down",
        }),
      },
    }

    await expect(drain(backend.complete(baseRequest))).rejects.toMatchObject({
      kind: CompletionErrorKind.RateLimit,
      retryable: true,
    })
  })

  it("yields text, thinking, and tool_input deltas while streaming", async () => {
    const backend = new GeminiCompletionBackend({
      nativeOpenAI: false,
      apiKey: "secret",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
    })
    ;(backend as any).client = {
      models: {
        generateContentStream: vi.fn(async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: "plan", thought: true }],
                },
              },
            ],
          }
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: "hi " }],
                },
              },
            ],
          }
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: "there" }],
                },
              },
            ],
          }
          yield {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: "call-1",
                        name: "read_file",
                        args: { path: "README.md" },
                      },
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 5,
              totalTokenCount: 12,
            },
          }
        }),
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
      {
        kind: "tool_input_delta",
        toolCallId: "call-1",
        chunk: '{"path":"README.md"}',
      },
    ])
  })
})
