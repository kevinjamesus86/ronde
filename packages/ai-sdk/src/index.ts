/**
 * @module
 * Adapter for Vercel AI SDK providers.
 *
 * Wraps any `LanguageModelV3` from `@ai-sdk/provider` into a ronde
 * `CompletionBackend`, giving instant access to 50+ providers.
 *
 * @example
 * ```ts
 * import { createGroq } from "@ai-sdk/groq"
 * import { fromAiSdk } from "@ronde/ai-sdk"
 * import { agentic } from "ronde"
 *
 * const { output } = await agentic(
 *   fromAiSdk(createGroq().languageModel("llama-4-scout")),
 *   { prompt: "Summarize the README.", tools },
 * )
 * ```
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import {
  StopReason,
  emptyUsage,
  type CompletionBackend,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResponse,
  type CompletionWarning,
  type ConfiguredBackend,
  type ToolSchema,
  type UsageStats,
} from "@ronde/core/completion"
import { type Block, BlockKind, blocksToText } from "@ronde/core/block"
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
import {
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_OUTPUT,
  canonicalize,
} from "@ronde/backend"

// All types come from `@ai-sdk/provider` via peer dep — consumers who
// call `fromAiSdk()` must have it installed.
type AiSdkLanguageModel = LanguageModelV3
type AiSdkCallOptions = LanguageModelV3CallOptions
type AiSdkMessage = LanguageModelV3Message
type AiSdkToolResultPart = LanguageModelV3ToolResultPart
type AiSdkFunctionTool = LanguageModelV3FunctionTool
type AiSdkContent = LanguageModelV3Content
type AiSdkFinishReason = LanguageModelV3FinishReason
type AiSdkUsage = LanguageModelV3Usage
type AiSdkWarning = SharedV3Warning
type AiSdkUserPart = Extract<AiSdkMessage, { role: "user" }>["content"][number]
type AiSdkAssistantPart = Extract<
  AiSdkMessage,
  { role: "assistant" }
>["content"][number]

// -------------------------------------------------------
// Request conversion: ronde → AI SDK
// -------------------------------------------------------

/**
 * Map a `Block[]` to an AI SDK tool-result output. Pure-text content
 * uses the cheap `{ type: "text" }` form; anything multimodal goes
 * through the `{ type: "content", value: [...] }` envelope so file/url
 * blocks ride alongside text.
 */
function blocksToToolResultOutput(
  blocks: readonly Block[],
): LanguageModelV3ToolResultPart["output"] {
  const allText = blocks.every((b) => b.kind === BlockKind.Text)
  if (allText) {
    return { type: "text", value: blocksToText(blocks) }
  }
  const value: Array<
    | { type: "text"; text: string }
    | { type: "file-data"; data: string; mediaType: string; filename?: string }
    | { type: "file-url"; url: string }
  > = []
  for (const b of blocks) {
    switch (b.kind) {
      case BlockKind.Text:
        value.push({ type: "text", text: b.text })
        break
      case BlockKind.Binary:
        if (b.data instanceof URL) {
          value.push({ type: "file-url", url: b.data.href })
        } else {
          value.push({
            type: "file-data",
            data: b.data,
            mediaType: b.mediaType,
            ...(b.filename === undefined ? {} : { filename: b.filename }),
          })
        }
        break
      case BlockKind.Ref:
        if (tryParseUrl(b.uri)) {
          value.push({ type: "file-url", url: b.uri })
        } else {
          value.push({ type: "text", text: refDescriptor(b) })
        }
        break
      default: {
        const _: never = b
        throw new Error(`unreachable: ${_}`)
      }
    }
  }
  return { type: "content", value }
}

function tryParseUrl(uri: string): URL | undefined {
  try {
    return new URL(uri)
  } catch {
    return undefined
  }
}

function refDescriptor(b: Extract<Block, { kind: BlockKind.Ref }>): string {
  const summary = b.summary ?? `${b.bytes ?? "?"} bytes`
  return `[${b.mediaType ?? "ref"} ${b.uri} (${summary})]`
}

/**
 * Map a `Block[]` from a ContentPart into AI SDK's user/assistant
 * content vocabulary — `TextPart | FilePart`.
 *
 * - text   → { type: "text", text }
 * - binary → { type: "file", mediaType, data, filename? }
 * - ref    → { type: "file", mediaType?, data: new URL(uri) } when the
 *            URI parses; otherwise a text descriptor with the URI.
 */
function blocksToAiSdkContent(blocks: readonly Block[]): AiSdkUserPart[] {
  const out: AiSdkUserPart[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case BlockKind.Text:
        out.push({ type: "text", text: b.text })
        break
      case BlockKind.Binary: {
        const part: Extract<AiSdkUserPart, { type: "file" }> = {
          type: "file",
          data: b.data,
          mediaType: b.mediaType,
        }
        if (b.filename !== undefined) {
          part.filename = b.filename
        }
        out.push(part)
        break
      }
      case BlockKind.Ref: {
        const parsed = tryParseUrl(b.uri)
        if (parsed) {
          out.push({
            type: "file",
            data: parsed,
            mediaType: b.mediaType ?? "application/octet-stream",
          })
        } else {
          out.push({ type: "text", text: refDescriptor(b) })
        }
        break
      }
      default: {
        const _: never = b
        throw new Error(`unreachable: ${_}`)
      }
    }
  }
  return out
}

function convertMessages(messages: Message[]): AiSdkMessage[] {
  const out: AiSdkMessage[] = []
  const toolNamesById = new Map<string, string>()

  // AI SDK expects role at message level; canonical messages carry role on
  // parts. Bucket parts by effective role and coalesce adjacent same-role
  // runs into one output message.
  type Pending =
    | {
        kind: "user"
        texts: AiSdkUserPart[]
        toolResults: AiSdkToolResultPart[]
      }
    | { kind: "assistant"; parts: AiSdkAssistantPart[] }
    | { kind: "system"; texts: string[] }
    | null

  let pending: Pending = null

  const flush = () => {
    if (!pending) {
      return
    }
    if (pending.kind === "user") {
      if (pending.texts.length > 0) {
        out.push({ role: "user", content: pending.texts })
      }
      if (pending.toolResults.length > 0) {
        out.push({ role: "tool", content: pending.toolResults })
      }
    } else if (pending.kind === "assistant") {
      if (pending.parts.length > 0) {
        out.push({ role: "assistant", content: pending.parts })
      }
    } else if (pending.kind === "system") {
      const joined = pending.texts.join("\n")
      if (joined.trim()) {
        out.push({ role: "system", content: joined })
      }
    }
    pending = null
  }

  const ensure = (kind: "user" | "assistant" | "system"): Pending => {
    if (!pending || pending.kind !== kind) {
      flush()
      if (kind === "user") {
        pending = { kind, texts: [], toolResults: [] }
      } else if (kind === "assistant") {
        pending = { kind, parts: [] }
      } else {
        pending = { kind, texts: [] }
      }
    }
    return pending
  }

  const partRoleBucket = (role: Role): "user" | "assistant" | "system" => {
    if (role === Role.Assistant) {
      return "assistant"
    }
    if (role === Role.System || role === Role.Developer) {
      return "system"
    }
    return "user"
  }

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === MessageType.Content) {
        const bucket = partRoleBucket(part.role)
        const slot = ensure(bucket)
        if (slot?.kind === "user") {
          for (const aiPart of blocksToAiSdkContent(part.content)) {
            slot.texts.push(aiPart)
          }
        } else if (slot?.kind === "assistant") {
          // blocksToAiSdkContent produces text/file parts — both are
          // structurally assignable to AssistantPart's wider union.
          for (const aiPart of blocksToAiSdkContent(part.content)) {
            slot.parts.push(aiPart)
          }
        } else if (slot?.kind === "system") {
          // System content is string-only; flatten.
          slot.texts.push(blocksToText(part.content))
        }
      } else if (part.type === MessageType.Think) {
        if (!part.content.trim()) {
          continue
        }
        const slot = ensure("assistant")
        if (slot?.kind === "assistant") {
          slot.parts.push({ type: "reasoning", text: part.content })
        }
      } else if (part.type === MessageType.ToolUse) {
        toolNamesById.set(part.toolCallId, part.name)
        const slot = ensure("assistant")
        if (slot?.kind === "assistant") {
          slot.parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.name,
            input: part.arguments,
          })
        }
      } else if (part.type === MessageType.ToolResult) {
        const slot = ensure("user")
        if (slot?.kind === "user") {
          slot.toolResults.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: toolNamesById.get(part.toolCallId) ?? part.toolCallId,
            output: part.ok
              ? blocksToToolResultOutput(part.content)
              : { type: "error-text", value: blocksToText(part.content) },
          })
        }
      }
    }
  }
  flush()

  return out
}

function convertTools(tools: ToolSchema[]): AiSdkFunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    strict: t.strict,
  }))
}

// -------------------------------------------------------
// Response conversion: AI SDK → ronde
// -------------------------------------------------------

function convertContent(content: AiSdkContent[]): Message[] {
  const parts: MessagePart[] = []

  for (const c of content) {
    if (c.type === "text" && c.text?.trim()) {
      parts.push(textPart(Role.Assistant, c.text))
    } else if (c.type === "reasoning" && c.text) {
      parts.push(thinkingPart(c.text))
    } else if (c.type === "tool-call" && c.toolCallId && c.toolName) {
      let args: Record<string, unknown> = {}
      if (typeof c.input === "string") {
        try {
          args = JSON.parse(c.input)
        } catch {}
      } else if (c.input && typeof c.input === "object") {
        args = c.input as Record<string, unknown>
      }
      parts.push(
        toolCallPart({
          toolCallId: c.toolCallId,
          name: c.toolName,
          arguments: args,
        }),
      )
    }
  }

  if (parts.length === 0) {
    return []
  }
  return [assistantMessage(parts)]
}

function convertFinishReason(reason: AiSdkFinishReason): StopReason {
  switch (reason.unified) {
    case "stop":
      return StopReason.EndTurn
    case "tool-calls":
      return StopReason.ToolUse
    case "length":
      return StopReason.MaxTokens
    case "content-filter":
      return StopReason.Refusal
    default:
      return StopReason.Unknown
  }
}

function convertUsage(usage: AiSdkUsage): UsageStats {
  const cacheRead = usage.inputTokens.cacheRead ?? 0
  const cacheWrite = usage.inputTokens.cacheWrite ?? 0
  const inputTotal = usage.inputTokens.total ?? 0
  return {
    inputTokens: Math.max(0, inputTotal - cacheRead),
    outputTokens: usage.outputTokens.total ?? 0,
    cachedReadTokens: cacheRead,
    cachedWriteTokens: cacheWrite,
    reasoningTokens: usage.outputTokens.reasoning ?? 0,
  }
}

function convertWarnings(warnings: AiSdkWarning[]): CompletionWarning[] {
  const out: CompletionWarning[] = []
  for (const w of warnings) {
    if (w.type !== "unsupported" || !w.feature) {
      continue
    }
    out.push({
      type: "unsupported" as const,
      feature: w.feature,
      ...(w.details ? { details: w.details } : {}),
    })
  }
  return out
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

async function* completeStream(
  model: AiSdkLanguageModel,
  request: CompletionRequest,
): AsyncGenerator<CompletionDelta, CompletionResponse, void> {
  const canonical = canonicalize(
    request.messages,
    (_meta: unknown): _meta is never => false,
  )
  const prompt = convertMessages(canonical)

  if (request.system?.trim()) {
    prompt.unshift({ role: "system", content: request.system })
  }

  const callOptions: AiSdkCallOptions = {
    maxOutputTokens: request.maxOutput,
    prompt,
  }

  if (request.tools?.length) {
    callOptions.tools = convertTools(request.tools)
    callOptions.toolChoice = { type: "auto" }
  }

  // V3 has no top-level reasoning field — effort must flow through the
  // provider's own providerOptions, not a shared slot.
  if (request.providerOptions) {
    callOptions.providerOptions =
      request.providerOptions as AiSdkCallOptions["providerOptions"]
  }

  const { stream } = await model.doStream(callOptions)

  // Accumulated content assembled in emission order: text-end /
  // reasoning-end / tool-call push in the order the model produced
  // them, so the final CompletionResponse preserves the same
  // thinking → text → tool-call sequence doGenerate would've.
  const content: AiSdkContent[] = []
  const textBuffers = new Map<string, string>()
  const reasoningBuffers = new Map<string, string>()
  const warnings: AiSdkWarning[] = []
  let finishReason: AiSdkFinishReason | null = null
  let usage: AiSdkUsage | null = null

  for await (const part of stream as AsyncIterable<LanguageModelV3StreamPart>) {
    switch (part.type) {
      case "stream-start":
        warnings.push(...part.warnings)
        break
      case "text-start":
        textBuffers.set(part.id, "")
        break
      case "text-delta":
        textBuffers.set(part.id, (textBuffers.get(part.id) ?? "") + part.delta)
        yield { kind: "text_delta", content: part.delta }
        break
      case "text-end": {
        const text = textBuffers.get(part.id) ?? ""
        textBuffers.delete(part.id)
        if (text) {
          content.push({ type: "text", text })
        }
        break
      }
      case "reasoning-start":
        reasoningBuffers.set(part.id, "")
        break
      case "reasoning-delta":
        reasoningBuffers.set(
          part.id,
          (reasoningBuffers.get(part.id) ?? "") + part.delta,
        )
        yield { kind: "thinking_delta", content: part.delta }
        break
      case "reasoning-end": {
        const text = reasoningBuffers.get(part.id) ?? ""
        reasoningBuffers.delete(part.id)
        if (text) {
          content.push({ type: "reasoning", text })
        }
        break
      }
      case "tool-input-delta":
        yield {
          kind: "tool_input_delta",
          toolCallId: part.id,
          chunk: part.delta,
        }
        break
      case "tool-call":
        content.push(part)
        break
      case "finish":
        finishReason = part.finishReason
        usage = part.usage
        break
      // Ignored: response-metadata, raw, file, source, tool-result,
      // tool-approval-request, tool-input-start, tool-input-end, error.
      // Providers that surface errors via the "error" part will still
      // show up in the final response's unresolved state — the engine
      // treats "no usable content" the same way it does non-streaming.
    }
  }

  // Defensive: flush any buffers whose *-end part the provider never
  // emitted (shouldn't happen per spec; cheap safety net).
  for (const [, text] of textBuffers) {
    if (text) {
      content.push({ type: "text", text })
    }
  }
  for (const [, text] of reasoningBuffers) {
    if (text) {
      content.push({ type: "reasoning", text })
    }
  }

  return {
    messages: convertContent(content),
    stopReason: finishReason
      ? convertFinishReason(finishReason)
      : StopReason.Unknown,
    usage: usage ? convertUsage(usage) : emptyUsage(),
    providerMeta: {
      provider: "ai_sdk",
      modelId: model.modelId,
    },
    warnings: convertWarnings(warnings),
  }
}

export interface AiSdkAdapterOptions {
  /** Defaults to `DEFAULT_MAX_CONTEXT`. */
  maxContext?: number
  /** Defaults to `DEFAULT_MAX_OUTPUT`. */
  maxOutput?: number
}

/**
 * Wrap a Vercel AI SDK `LanguageModelV3` as a ronde `ConfiguredBackend`.
 * Uses the model's `doStream()`, yielding each chunk as a `CompletionDelta`
 * and returning the assembled `CompletionResponse` when the stream ends.
 *
 * ```ts
 * import { createGroq } from "@ai-sdk/groq"
 * import { fromAiSdk } from "@ronde/ai-sdk"
 *
 * const backend = fromAiSdk(
 *   createGroq().languageModel("llama-4-scout"),
 * )
 * ```
 */
export function fromAiSdk(
  model: AiSdkLanguageModel,
  options: AiSdkAdapterOptions = {},
): ConfiguredBackend {
  const backend: CompletionBackend = {
    specVersion: "v1",
    complete(
      request: CompletionRequest,
    ): AsyncGenerator<CompletionDelta, CompletionResponse, void> {
      return completeStream(model, request)
    },
  }

  return {
    ...backend,
    config: {
      model: model.modelId,
      maxContext: options.maxContext ?? DEFAULT_MAX_CONTEXT,
      maxOutput: options.maxOutput ?? DEFAULT_MAX_OUTPUT,
    },
  }
}
