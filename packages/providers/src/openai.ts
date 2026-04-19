import OpenAI from "openai"
import type {
  Response as OAIResponse,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseReasoningItem,
  ResponseUsage,
} from "openai/resources/responses/responses.js"
import {
  CompletionError,
  CompletionErrorKind,
  Effort,
  StopReason,
  emptyUsage,
  type CompletionBackend,
  type CompletionRequest,
  type CompletionResponse,
  type ToolSchema,
} from "@ronde/core/completion"
import type { Lax } from "@ronde/core"
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
import {
  canonicalize,
  normalizeCompletionMode,
  modeWantsThoughtText,
  modeWantsThoughtReplay,
  wrapSdkError,
  type NormalizedPart,
} from "@ronde/backend"
import type { ProviderDescriptor } from "./registry.js"

// `self` is defined in every browser-like runtime (Window, Web/Service/Shared
// Worker) and absent in Node, even versions that expose other web globals like
// `globalThis.crypto`. Bun exposes `self` too — a harmless false positive; the
// flag set below is a no-op in a server context.
function isBrowser(): boolean {
  return typeof (globalThis as { self?: unknown }).self !== "undefined"
}

export const openaiDescriptor: ProviderDescriptor = {
  name: "openai",
  defaultURL: "https://api.openai.com/v1",
  envVar: "OPENAI_API_KEY",
  create: (config) => new OpenAICompletionBackend(config),
}

interface OpenAIMeta {
  provider: "openai"
  itemId?: string
  encryptedContent?: string
}

function isOpenAIMeta(meta: unknown): meta is OpenAIMeta {
  return (
    meta != null &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).provider === "openai"
  )
}

function openAIMeta(
  itemId?: string,
  encryptedContent?: string,
): OpenAIMeta | undefined {
  if (!itemId && !encryptedContent) {
    return undefined
  }
  return {
    provider: "openai",
    ...(itemId === undefined ? {} : { itemId }),
    ...(encryptedContent === undefined ? {} : { encryptedContent }),
  }
}

function serializePart(
  part: NormalizedPart<OpenAIMeta>,
  options: { replayReasoningItems: boolean },
): Record<string, unknown> | undefined {
  switch (part.type) {
    case MessageType.Text: {
      // Only assistant text reaches here; non-assistant text is buffered
      // and coalesced into role-tagged `message` items by the caller.
      const item: Record<string, unknown> = {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: part.content }],
      }
      if (part.meta?.itemId) {
        item.id = part.meta.itemId
      }
      return item
    }
    case MessageType.Think: {
      const { replayReasoningItems } = options
      if (replayReasoningItems && part.meta?.itemId) {
        const reasoning: Record<string, unknown> = {
          type: "reasoning",
          id: part.meta.itemId,
          summary: [] as unknown[],
        }
        if (part.content.trim()) {
          reasoning.summary = [{ type: "summary_text", text: part.content }]
        }
        if (part.meta.encryptedContent) {
          reasoning.encrypted_content = part.meta.encryptedContent
        }
        return reasoning
      }
      if (!part.content.trim()) {
        return undefined
      }
      return {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: part.content }],
      }
    }
    case MessageType.ToolUse: {
      const item: Record<string, unknown> = {
        type: "function_call",
        call_id: part.toolCallId,
        name: part.name,
        arguments: JSON.stringify(part.arguments || {}),
        status: "completed",
      }
      if (part.meta?.itemId) {
        item.id = part.meta.itemId
      }
      return item
    }
    case MessageType.ToolResult:
      return {
        type: "function_call_output",
        call_id: part.toolCallId,
        output: part.content,
      }
  }
}

export function serializeMessages(
  messages: Message[],
  options: { replayReasoningItems?: boolean } = {},
): Record<string, unknown>[] {
  const { replayReasoningItems = true } = options
  const normalized = canonicalize(messages, isOpenAIMeta)
  const items: Record<string, unknown>[] = []

  // Adjacent non-assistant text parts coalesce into one role-tagged `message`
  // item with multiple content entries — OpenAI's expected shape.
  type TextBuffer = { role: "user" | "developer"; texts: string[] }
  let pendingText: TextBuffer | undefined
  const flushText = () => {
    if (pendingText && pendingText.texts.length > 0) {
      items.push({
        role: pendingText.role,
        content: pendingText.texts.map((text) => ({
          type: "input_text",
          text,
        })),
      })
    }
    pendingText = undefined
  }

  // function_call and function_call_output items pool across contiguous
  // pair messages and emit batched — preserves the model's original
  // parallel-tool-call shape when the canonical history stores each tool
  // as its own pair message.
  const pendingCalls: Record<string, unknown>[] = []
  const pendingCallOutputs: Record<string, unknown>[] = []
  const flushTools = () => {
    for (const item of pendingCalls) {
      items.push(item)
    }
    pendingCalls.length = 0
    for (const item of pendingCallOutputs) {
      items.push(item)
    }
    pendingCallOutputs.length = 0
  }

  for (const message of normalized) {
    for (const part of message.parts) {
      if (part.type === MessageType.Text && part.role !== Role.Assistant) {
        flushTools()
        const wireRole: "user" | "developer" =
          part.role === Role.System || part.role === Role.Developer
            ? "developer"
            : "user"
        if (pendingText && pendingText.role === wireRole) {
          pendingText.texts.push(part.content)
        } else {
          flushText()
          pendingText = { role: wireRole, texts: [part.content] }
        }
        continue
      }

      const serialized = serializePart(part, { replayReasoningItems })
      if (!serialized) {
        continue
      }

      if (part.type === MessageType.ToolUse) {
        flushText()
        pendingCalls.push(serialized)
      } else if (part.type === MessageType.ToolResult) {
        flushText()
        pendingCallOutputs.push(serialized)
      } else {
        flushText()
        flushTools()
        items.push(serialized)
      }
    }
  }
  flushText()
  flushTools()

  return items
}

function serializeTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return (tools || []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "Tool",
    parameters: tool.inputSchema || { type: "object" },
    strict: tool.strict !== false,
  }))
}

function parseOutputItems(
  items: ResponseOutputItem[],
  responseId?: string,
): Message[] {
  const parts: MessagePart[] = []

  for (const item of items) {
    if (item.type === "message") {
      const msg = item as ResponseOutputMessage
      const textParts = msg.content.filter(
        (c): c is ResponseOutputText => c.type === "output_text",
      )
      const text = textParts
        .map((p) => p.text)
        .join("")
        .trim()
      if (text) {
        parts.push(
          textPart(
            Role.Assistant,
            text,
            msg.status === "completed"
              ? openAIMeta(msg.id || undefined)
              : undefined,
          ),
        )
      }
    } else if (item.type === "reasoning") {
      const r = item as ResponseReasoningItem
      const summaryText = r.summary
        .filter((s) => s.type === "summary_text")
        .map((s) => s.text)
        .join("\n\n")
        .trim()
      const contentText = (r.content || [])
        .filter((c) => c.type === "reasoning_text")
        .map((c) => c.text)
        .join("\n\n")
        .trim()
      const text = summaryText || contentText
      const meta =
        r.id || r.encrypted_content
          ? openAIMeta(r.id || undefined, r.encrypted_content || undefined)
          : undefined
      if (text || meta) {
        parts.push(thinkingPart(text, meta))
      }
    } else if (item.type === "function_call") {
      const fc = item as ResponseFunctionToolCall
      if (fc.status === "completed" && fc.call_id) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(fc.arguments)
        } catch {}
        parts.push(
          toolCallPart({
            toolCallId: fc.call_id,
            name: fc.name,
            arguments: args,
            meta: openAIMeta(fc.id || undefined),
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

function normalizeStopReason(
  response: OAIResponse,
  parts: MessagePart[],
): StopReason {
  if (response.status === "completed") {
    return parts.some((p) => p.type === MessageType.ToolUse)
      ? StopReason.ToolUse
      : StopReason.EndTurn
  }
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return StopReason.MaxTokens
      case "content_filter":
        return StopReason.Refusal
      default:
        return StopReason.Unknown
    }
  }
  return StopReason.Unknown
}

function isNativeOpenAI(resolved: InternalBackendConfig): boolean {
  return resolved.nativeOpenAI
}

function normalizeOpenAIEffort(effort: Lax<Effort> | null): string | null {
  switch (effort) {
    case Effort.Low:
      return "low"
    case Effort.Med:
      return "medium"
    case Effort.High:
      return "high"
    case Effort.XHigh:
      return "xhigh"
    default:
      return null
  }
}

function buildUsage(
  usage: ResponseUsage | undefined,
): CompletionResponse["usage"] {
  if (!usage) {
    return emptyUsage()
  }
  const cachedReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const inputTokens = usage.input_tokens - cachedReadTokens
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: usage.output_tokens,
    cachedReadTokens,
    cachedWriteTokens: 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

export class OpenAICompletionBackend implements CompletionBackend {
  readonly specVersion = "v1" as const
  protected resolved: InternalBackendConfig
  protected client: OpenAI

  constructor(resolved: InternalBackendConfig) {
    this.resolved = resolved
    this.client = new OpenAI({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      ...(isBrowser() && { dangerouslyAllowBrowser: true }),
    })
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const mode = normalizeCompletionMode(request.mode)
    const payload: Record<string, unknown> = {
      model: request.model,
      instructions: request.system,
      input: serializeMessages(request.messages || [], this.serializeOptions()),
      tools: serializeTools(request.tools),
      max_output_tokens: request.maxOutputTokens,
    }

    const effort = normalizeOpenAIEffort(request.effort)
    if (isNativeOpenAI(this.resolved)) {
      if (effort || modeWantsThoughtText(mode)) {
        payload.reasoning = {} as Record<string, unknown>
      }
      if (effort) {
        ;(payload.reasoning as Record<string, unknown>).effort = effort
      }
      if (modeWantsThoughtText(mode)) {
        ;(payload.reasoning as Record<string, unknown>).summary = "auto"
      }
    }

    if (isNativeOpenAI(this.resolved) && modeWantsThoughtReplay(mode)) {
      payload.include = ["reasoning.encrypted_content"]
    }

    const response = await this.doRequest(this.client, payload, request.signal)

    if (response.status === "failed") {
      throw new CompletionError(
        CompletionErrorKind.Unknown,
        response.error?.message || "OpenAI completion failed",
        { statusCode: undefined },
      )
    }

    const messages = parseOutputItems(response.output, response.id)
    const allParts = messages.flatMap((m) => m.parts)

    return {
      messages,
      stopReason: normalizeStopReason(response, allParts),
      usage: buildUsage(response.usage),
      providerMeta: this.buildProviderMeta(response),
      warnings: [],
    }
  }

  protected async doRequest(
    client: OpenAI,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OAIResponse> {
    try {
      const stream = client.responses.stream(
        payload as Parameters<typeof client.responses.stream>[0],
        { signal },
      )
      return await stream.finalResponse()
    } catch (err) {
      throw wrapSdkError(err)
    }
  }

  protected buildProviderMeta(response: OAIResponse): unknown {
    return {
      provider: "openai",
      responseId: response.id,
      status: response.status ?? null,
      incompleteReason: response.incomplete_details?.reason ?? null,
    }
  }

  protected serializeOptions(): {
    replayReasoningItems: boolean
  } {
    return { replayReasoningItems: true }
  }
}
