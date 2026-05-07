import Anthropic from "@anthropic-ai/sdk"
import {
  coalesceByRole,
  canonicalize,
  wrapSdkError,
  type NormalizedPart,
} from "@ronde/backend"
import type {
  Message as AnthropicMessage,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js"
import {
  Effort,
  StopReason,
  type CompletionBackend,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResponse,
  type ToolSchema,
} from "@ronde/core/completion"
import type { Lax } from "@ronde/core"
import { blocksToText } from "@ronde/core/block"
import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  type Message,
  type MessagePart,
} from "@ronde/core/message"
import type { InternalBackendConfig } from "./types.js"
import type { ProviderDescriptor } from "./registry.js"

// `self` is defined in every browser-like runtime (Window, Web/Service/Shared
// Worker) and absent in Node, even versions that expose other web globals like
// `globalThis.crypto`. Bun exposes `self` too — a harmless false positive; the
// flags set below are no-ops in a server context.
function isBrowser(): boolean {
  return typeof (globalThis as { self?: unknown }).self !== "undefined"
}

export const anthropicDescriptor: ProviderDescriptor = {
  name: "anthropic",
  defaultURL: "https://api.anthropic.com",
  envVar: "ANTHROPIC_API_KEY",
  create: (config) => new AnthropicCompletionBackend(config),
}

interface AnthropicMeta {
  provider: "anthropic"
  signature: string
}

function isAnthropicMeta(meta: unknown): meta is AnthropicMeta {
  return (
    meta != null &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).provider === "anthropic"
  )
}

const ANTHROPIC_VERSION = "2023-06-01"

function anthropicMeta(signature?: string): AnthropicMeta | undefined {
  if (signature) {
    return { provider: "anthropic", signature }
  }
}

function anthropicRole(role: Role): "assistant" | "user" {
  return role === Role.Assistant ? "assistant" : "user"
}

function serializePart(
  part: NormalizedPart<AnthropicMeta>,
  toolNamesById: Map<string, string>,
): Record<string, unknown> | undefined {
  switch (part.type) {
    case MessageType.Text:
      return { type: "text", text: part.content }
    case MessageType.Think:
      if (part.meta) {
        return {
          type: "thinking",
          thinking: part.content,
          signature: part.meta.signature,
        }
      }
      if (!part.content.trim()) {
        return undefined
      }
      return { type: "text", text: part.content }
    case MessageType.ToolUse:
      toolNamesById.set(part.toolCallId, part.name)
      return {
        type: "tool_use",
        id: part.toolCallId,
        name: part.name,
        input: part.arguments || {},
      }
    case MessageType.ToolResult:
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: blocksToText(part.content),
        is_error: !part.ok,
      }
  }
}

export function serializeMessages(
  messages: Message[],
): Array<{ role: string; content: Record<string, unknown>[] }> {
  const normalized = canonicalize(messages, isAnthropicMeta)
  const toolNamesById = new Map<string, string>()
  return coalesceByRole(normalized, anthropicRole, (part) =>
    serializePart(part, toolNamesById),
  ).map(({ role, parts }) => ({ role, content: parts }))
}

function serializeTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || "Tool",
    input_schema: tool.inputSchema || { type: "object" },
  }))
}

function parseContentBlocks(
  blocks: ContentBlock[],
  responseId?: string,
): Message[] {
  const parts: MessagePart[] = []

  for (const block of blocks) {
    if (block.type === "text") {
      const tb = block as TextBlock
      if (tb.text?.trim()) {
        parts.push(textPart(Role.Assistant, tb.text))
      }
      continue
    }
    if (block.type === "thinking") {
      const tb = block as ThinkingBlock
      const content = tb.thinking || ""
      const meta = anthropicMeta(tb.signature || undefined)
      if (!content && !meta) {
        continue
      }
      parts.push(thinkingPart(content, meta))
      continue
    }
    if (block.type === "tool_use") {
      const tb = block as ToolUseBlock
      if (tb.id && tb.name) {
        parts.push(
          toolCallPart({
            toolCallId: tb.id,
            name: tb.name,
            arguments: (tb.input as Record<string, unknown>) || {},
          }),
        )
      }
    }
  }

  if (parts.length === 0) {
    return []
  }
  return [assistantMessage(parts, responseId)]
}

function normalizeStopReason(stopReason: string | null): StopReason {
  switch (stopReason) {
    case "end_turn":
      return StopReason.EndTurn
    case "tool_use":
      return StopReason.ToolUse
    case "max_tokens":
      return StopReason.MaxTokens
    case "refusal":
      return StopReason.Refusal
    case "pause_turn":
      return StopReason.PauseTurn
    case "model_context_window_exceeded":
      return StopReason.ContextWindow
    default:
      return StopReason.Unknown
  }
}

function anthropicModelSupportsEffort(model: string): boolean {
  return (
    model.startsWith("claude-opus-4-6") ||
    model.startsWith("claude-sonnet-4-6") ||
    model.startsWith("claude-opus-4-5")
  )
}

function anthropicModelSupportsAdaptiveThinking(model: string): boolean {
  return (
    model.startsWith("claude-opus-4-6") || model.startsWith("claude-sonnet-4-6")
  )
}

function normalizeAnthropicEffort(
  model: string,
  effort?: Lax<Effort>,
): string | null {
  switch (effort) {
    case Effort.Low:
      return "low"
    case Effort.Med:
      return "medium"
    case Effort.High:
      return "high"
    case Effort.XHigh:
      return model.startsWith("claude-opus-4-6") ? "max" : "high"
    default:
      return null
  }
}

function buildPayload(request: CompletionRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutput,
    messages: serializeMessages(request.messages || []),
  }

  if (request.system?.trim()) {
    payload.system = request.system
  }
  if (request.tools?.length) {
    payload.tools = serializeTools(request.tools)
  }

  const effort = normalizeAnthropicEffort(request.model, request.effort)
  if (effort && anthropicModelSupportsEffort(request.model)) {
    payload.output_config = { effort }
  }
  if (anthropicModelSupportsAdaptiveThinking(request.model)) {
    payload.thinking = { type: "adaptive" }
  }

  return payload
}

function buildResponse(data: AnthropicMessage): CompletionResponse {
  const usage = data.usage
  return {
    messages: parseContentBlocks(data.content, data.id),
    stopReason: normalizeStopReason(data.stop_reason),
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedReadTokens: usage.cache_read_input_tokens || 0,
      cachedWriteTokens: usage.cache_creation_input_tokens || 0,
      reasoningTokens: 0,
    },
    providerMeta: {
      provider: "anthropic",
      responseId: data.id,
      stopReason: data.stop_reason,
    },
    warnings: [],
  }
}

export class AnthropicCompletionBackend implements CompletionBackend {
  readonly specVersion = "v1" as const
  private resolved: InternalBackendConfig
  private client: Anthropic

  constructor(resolved: InternalBackendConfig) {
    this.resolved = resolved
    this.client = new Anthropic({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      ...(isBrowser() && {
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          // Anthropic gates direct-from-browser requests behind this opt-in
          // header; without it CORS preflight fails.
          "anthropic-dangerous-direct-browser-access": "true",
        },
      }),
    })
  }

  async *complete(
    request: CompletionRequest,
  ): AsyncGenerator<CompletionDelta, CompletionResponse, void> {
    const payload = buildPayload(request)

    let data: AnthropicMessage
    try {
      const stream = this.client.messages.stream(
        payload as Parameters<typeof this.client.messages.stream>[0],
        {
          headers: {
            "anthropic-version": ANTHROPIC_VERSION,
          },
          signal: request.signal,
        },
      )

      // Map content_block index → tool_use id so input_json_delta chunks
      // can be tagged to the right tool call. Only tool_use blocks need this;
      // text and thinking blocks don't carry an id.
      const toolCallIdByIndex = new Map<number, string>()

      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "tool_use") {
            toolCallIdByIndex.set(ev.index, ev.content_block.id)
          }
          continue
        }
        if (ev.type !== "content_block_delta") {
          continue
        }
        const d = ev.delta
        if (d.type === "text_delta") {
          yield { kind: "text_delta", content: d.text }
        } else if (d.type === "thinking_delta") {
          yield { kind: "thinking_delta", content: d.thinking }
        } else if (d.type === "input_json_delta") {
          const id = toolCallIdByIndex.get(ev.index)
          if (id) {
            yield {
              kind: "tool_input_delta",
              toolCallId: id,
              chunk: d.partial_json,
            }
          }
        }
      }

      data = await stream.finalMessage()
    } catch (err) {
      throw wrapSdkError(err)
    }

    return buildResponse(data)
  }
}
