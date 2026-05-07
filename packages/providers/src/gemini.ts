import { GoogleGenAI } from "@google/genai"
import type {
  Candidate,
  GenerateContentResponse,
  GenerateContentResponsePromptFeedback,
  GenerateContentResponseUsageMetadata,
  Part,
} from "@google/genai"
import {
  Effort,
  StopReason,
  emptyUsage,
  type CompletionBackend,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResponse,
  type ToolSchema,
} from "@ronde/core/completion"
import type { Lax } from "@ronde/core"
import {
  type Block,
  BlockKind,
  blocksToText,
  image,
  text,
} from "@ronde/core/block"
import { estimateTokens } from "@ronde/core/tokens"
import {
  contentPart,
  MessageType,
  Role,
  assistantMessage,
  thinkingPart,
  toolCallPart,
  type Message,
  type MessagePart,
} from "@ronde/core/message"
import type { InternalBackendConfig } from "./types.js"
import {
  coalesceByRole,
  canonicalize,
  wrapSdkError,
  type NormalizedPart,
} from "@ronde/backend"
import type { ProviderDescriptor } from "./registry.js"

export const geminiDescriptor: ProviderDescriptor = {
  name: "gemini",
  defaultURL: "https://generativelanguage.googleapis.com/v1beta",
  envVar: "GEMINI_API_KEY",
  create: (config) => new GeminiCompletionBackend(config),
}

interface GeminiMeta {
  provider: "gemini"
  thoughtSignature: string
}

function isGeminiMeta(meta: unknown): meta is GeminiMeta {
  return (
    meta != null &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).provider === "gemini"
  )
}

function geminiMeta(thoughtSignature?: string): GeminiMeta | undefined {
  if (!thoughtSignature) {
    return undefined
  }
  return {
    provider: "gemini",
    thoughtSignature,
  }
}

function geminiRole(role: Role): "model" | "user" {
  return role === Role.Assistant ? "model" : "user"
}

function resolveToolName(
  toolNamesById: Map<string, string>,
  toolCallId: string,
): string {
  return toolNamesById.get(toolCallId) || `tool_${toolCallId}`
}

function serializePart(
  part: NormalizedPart<GeminiMeta>,
  toolNamesById: Map<string, string>,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  switch (part.type) {
    case MessageType.Content: {
      const parts = blocksToGeminiParts(part.content)
      // Attach the part-level thoughtSignature to the first emitted Part
      // — Gemini reads it as a per-Part annotation, not on the message.
      if (part.meta && parts.length > 0) {
        parts[0] = {
          ...parts[0],
          thoughtSignature: part.meta.thoughtSignature,
        }
      }
      return parts
    }
    case MessageType.Think:
      if (part.meta) {
        return {
          text: part.content,
          thought: true,
          thoughtSignature: part.meta.thoughtSignature,
        }
      }
      if (!part.content.trim()) {
        return undefined
      }
      return { text: part.content }
    case MessageType.ToolUse:
      toolNamesById.set(part.toolCallId, part.name)
      return {
        functionCall: {
          id: part.toolCallId,
          name: part.name,
          args: part.arguments || {},
        },
        ...(part.meta ? { thoughtSignature: part.meta.thoughtSignature } : {}),
      }
    case MessageType.ToolResult: {
      // Gemini functionResponse.response carries structured JSON, not
      // multimodal content. Block[] flattens via blocksToText with
      // mediaType + URI descriptors so the model still sees what was
      // produced even when the bytes themselves can't ride along.
      const text = blocksToText(part.content)
      return {
        functionResponse: {
          id: part.toolCallId,
          name: resolveToolName(toolNamesById, part.toolCallId),
          response: !part.ok
            ? {
                toolCallId: part.toolCallId,
                error: text,
              }
            : {
                toolCallId: part.toolCallId,
                content: text,
              },
        },
      }
    }
  }
}

export function serializeMessages(messages: Message[]): Array<{
  role: string
  parts: Record<string, unknown>[]
}> {
  const normalized = canonicalize(messages, isGeminiMeta)
  const toolNamesById = new Map<string, string>()
  return coalesceByRole<GeminiMeta, Record<string, unknown>>(
    normalized,
    geminiRole,
    (part) => serializePart(part, toolNamesById),
  )
}

/**
 * Map a `Block[]` from a ContentPart into Gemini's per-Part vocabulary.
 *
 * - text   → `{ text }`
 * - binary inline (base64 string) → `{ inlineData: { mimeType, data } }`
 * - binary URL → `{ fileData: { mimeType, fileUri } }`
 * - ref    → `{ fileData: { mimeType?, fileUri: uri } }`
 */
function blocksToGeminiParts(
  blocks: readonly Block[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case BlockKind.Text:
        out.push({ text: b.text })
        break
      case BlockKind.Binary:
        if (b.data instanceof URL) {
          out.push({
            fileData: { mimeType: b.mediaType, fileUri: b.data.href },
          })
        } else {
          out.push({
            inlineData: { mimeType: b.mediaType, data: b.data },
          })
        }
        break
      case BlockKind.Ref:
        out.push({
          fileData: {
            mimeType: b.mediaType ?? "application/octet-stream",
            fileUri: b.uri,
          },
        })
        break
      default: {
        const _: never = b
        throw new Error(`unreachable: ${_}`)
      }
    }
  }
  return out
}

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema)
  }
  if (!schema || typeof schema !== "object") {
    return schema
  }

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>,
  )) {
    if (key === "additionalProperties") {
      continue
    }
    if (key === "type" && Array.isArray(value)) {
      const concreteType = value.find((entry) => entry !== "null") || value[0]
      output.type = concreteType
      continue
    }
    output[key] = sanitizeGeminiSchema(value)
  }
  return output
}

function serializeTools(
  tools: ToolSchema[],
): Record<string, unknown>[] | undefined {
  if (!tools?.length) {
    return undefined
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "Tool",
        parametersJsonSchema: sanitizeGeminiSchema(
          tool.inputSchema || { type: "object" },
        ),
      })),
    },
  ]
}

function parseParts(
  geminiParts: Part[] | undefined,
  responseId?: string,
): Message[] {
  const parts: MessagePart[] = []
  let toolCallIndex = 0
  let lastThoughtSignature: string | undefined
  let pendingBlocks: Block[] = []
  let pendingMeta: GeminiMeta | undefined

  const flushContent = () => {
    if (pendingBlocks.length > 0) {
      parts.push(contentPart(Role.Assistant, pendingBlocks, pendingMeta))
      pendingBlocks = []
      pendingMeta = undefined
    }
  }

  for (const gp of geminiParts || []) {
    if (gp.thoughtSignature) {
      lastThoughtSignature = gp.thoughtSignature
    }

    if (gp.functionCall?.name) {
      flushContent()
      toolCallIndex += 1
      parts.push(
        toolCallPart({
          toolCallId: gp.functionCall.id || `gemini-call-${toolCallIndex}`,
          name: gp.functionCall.name,
          arguments: gp.functionCall.args || {},
          meta: lastThoughtSignature
            ? geminiMeta(lastThoughtSignature)
            : undefined,
        }),
      )
      continue
    }

    if (gp.text?.trim()) {
      if (gp.thought === true) {
        flushContent()
        const content = gp.text
        const meta = geminiMeta(gp.thoughtSignature || undefined)
        parts.push(thinkingPart(content, meta))
      } else {
        if (lastThoughtSignature && !pendingMeta) {
          pendingMeta = geminiMeta(lastThoughtSignature)
        }
        pendingBlocks.push(text(gp.text))
      }
      continue
    }

    if (gp.inlineData?.mimeType && typeof gp.inlineData.data === "string") {
      pendingBlocks.push(image(gp.inlineData.data, gp.inlineData.mimeType))
      continue
    }
    if (gp.fileData?.fileUri) {
      pendingBlocks.push(
        image(
          new URL(gp.fileData.fileUri),
          gp.fileData.mimeType ?? "application/octet-stream",
        ),
      )
      continue
    }
  }
  flushContent()

  if (parts.length === 0) {
    return []
  }
  return [assistantMessage(parts, responseId)]
}

function normalizeStopReason(
  finishReason: string | null | undefined,
  parts: MessagePart[],
  promptBlocked: boolean,
): StopReason {
  if (promptBlocked) {
    return StopReason.Refusal
  }
  if (parts.some((p) => p.type === MessageType.ToolUse)) {
    return StopReason.ToolUse
  }

  switch (finishReason) {
    case "STOP":
      return StopReason.EndTurn
    case "MAX_TOKENS":
      return StopReason.MaxTokens
    case "SAFETY":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return StopReason.Refusal
    default:
      return StopReason.Unknown
  }
}

function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:\.|-)/.test(model)
}

function isGemini25Model(model: string): boolean {
  return model.startsWith("gemini-2.5-")
}

function normalizeGemini3Effort(_model: string, effort?: Lax<Effort>): string {
  switch (effort) {
    case Effort.Low:
      return "low"
    case Effort.Med:
      return "medium"
    case Effort.High:
    case Effort.XHigh:
      return "high"
    default:
      return "high"
  }
}

function normalizeGemini25Effort(effort?: Lax<Effort>): number {
  switch (effort) {
    case Effort.Low:
      return 1024
    case Effort.Med:
      return 8192
    case Effort.High:
      return -1
    case Effort.XHigh:
      return 24576
    default:
      return -1
  }
}

function buildUsage(
  meta: GenerateContentResponseUsageMetadata | undefined,
  fallbackOutputText = "",
): CompletionResponse["usage"] {
  if (!meta) {
    return emptyUsage()
  }
  const input = meta.promptTokenCount || 0
  const reasoning = meta.thoughtsTokenCount || 0
  const total = meta.totalTokenCount || 0
  // candidatesTokenCount is often missing on streaming responses — derive
  // from total. Known Gemini 2.5-flash quirk in streaming+thinking mode:
  // `totalTokenCount = input + thoughts` even when visible text is
  // produced, leaving output at 0. Estimate from output text so budget
  // accounting still advances.
  let output =
    meta.candidatesTokenCount || Math.max(0, total - input - reasoning)
  if (output === 0 && fallbackOutputText) {
    output = estimateTokens(fallbackOutputText)
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: meta.cachedContentTokenCount || 0,
    cachedWriteTokens: 0,
    reasoningTokens: reasoning,
  }
}

export class GeminiCompletionBackend implements CompletionBackend {
  readonly specVersion = "v1" as const
  private resolved: InternalBackendConfig
  private client: GoogleGenAI

  constructor(resolved: InternalBackendConfig) {
    this.resolved = resolved
    this.client = new GoogleGenAI({
      apiKey: resolved.apiKey,
      httpOptions: resolved.baseURL
        ? {
            baseUrl: resolved.baseURL,
            apiVersion: "",
          }
        : undefined,
    })
  }

  async *complete(
    request: CompletionRequest,
  ): AsyncGenerator<CompletionDelta, CompletionResponse, void> {
    const config: Record<string, unknown> = {
      maxOutputTokens: request.maxOutput,
    }

    if (request.system?.trim()) {
      config.systemInstruction = request.system
    }

    if (isGemini3Model(request.model)) {
      config.thinkingConfig = {
        thinkingLevel: normalizeGemini3Effort(request.model, request.effort),
        includeThoughts: true,
      }
    } else if (isGemini25Model(request.model)) {
      config.thinkingConfig = {
        thinkingBudget: normalizeGemini25Effort(request.effort),
        includeThoughts: true,
      }
    }

    const tools = serializeTools(request.tools)
    if (tools) {
      config.tools = tools
    }

    const payload = {
      model: request.model,
      contents: serializeMessages(request.messages || []),
      config,
    }

    // Each chunk carries only the new parts from that step. finishReason
    // and usageMetadata only appear on the final chunk.
    const accumulatedParts: Part[] = []
    let lastChunk: GenerateContentResponse | undefined

    try {
      const stream = await this.client.models.generateContentStream(
        payload as Parameters<
          typeof this.client.models.generateContentStream
        >[0],
      )
      for await (const chunk of stream) {
        lastChunk = chunk
        const parts: Part[] = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          accumulatedParts.push(part)
          if (part.text) {
            if (part.thought) {
              yield { kind: "thinking_delta", content: part.text }
            } else {
              yield { kind: "text_delta", content: part.text }
            }
          } else if (part.functionCall) {
            yield {
              kind: "tool_input_delta",
              toolCallId: part.functionCall.id ?? "",
              chunk: JSON.stringify(part.functionCall.args ?? {}),
            }
          }
        }
      }
    } catch (err) {
      throw wrapSdkError(err)
    }

    const candidate: Candidate | null = lastChunk?.candidates?.[0] ?? null
    const messages = parseParts(
      accumulatedParts,
      lastChunk?.responseId ?? undefined,
    )
    const allParts = messages.flatMap((m) => m.parts)
    const promptFeedback: GenerateContentResponsePromptFeedback | undefined =
      lastChunk?.promptFeedback
    const promptBlocked = Boolean(promptFeedback?.blockReason)
    const outputText = accumulatedParts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")

    return {
      messages,
      stopReason: normalizeStopReason(
        candidate?.finishReason,
        allParts,
        promptBlocked,
      ),
      usage: buildUsage(lastChunk?.usageMetadata, outputText),
      providerMeta: {
        provider: "gemini",
        finishReason: candidate?.finishReason ?? null,
        promptBlockReason: promptFeedback?.blockReason ?? null,
      },
      warnings: [],
    }
  }
}
