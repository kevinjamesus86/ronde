import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CompletionError,
  CompletionErrorKind,
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type ConfiguredBackend,
  type ResolvedBackendConfig,
} from "@ronde/core/completion"
import {
  assistantMessage,
  partRole,
  Role,
  thinkingPart,
  textPart,
  toolCallPart,
  type Message,
} from "@ronde/core/message"
import { StopReason } from "@ronde/core/completion"

export interface TmpHandle {
  dir(prefix?: string): string
  cleanup(): void
}

export function useTmp(): TmpHandle {
  const created: string[] = []

  return {
    dir(prefix = "ronde-ronde-") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      created.push(dir)
      return dir
    },
    cleanup() {
      while (created.length > 0) {
        fs.rmSync(created.pop()!, { recursive: true, force: true })
      }
    },
  }
}

export async function withEnv<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const prev = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  try {
    return await run()
  } finally {
    if (prev === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = prev
    }
  }
}

const DEFAULT_CONFIG: ResolvedBackendConfig = {
  model: "mock-model",
  maxContext: 200_000,
  maxOutput: 64_000,
}

export function mockBackend(
  responses: Array<CompletionResponse | Error>,
  config: Partial<ResolvedBackendConfig> = {},
): ConfiguredBackend & { requests: CompletionRequest[] } {
  let call = 0
  const requests: CompletionRequest[] = []

  return {
    specVersion: "v1",
    config: { ...DEFAULT_CONFIG, ...config },
    requests,
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] })
      const next = responses[call++]
      if (!next) {
        throw new Error(`No mock response for call ${call - 1}`)
      }
      if (next instanceof Error) {
        throw next
      }
      return next
    },
  }
}

export function mockHandler(
  handler: (
    request: CompletionRequest,
    call: number,
  ) => CompletionResponse | Promise<CompletionResponse>,
  config: Partial<ResolvedBackendConfig> = {},
): ConfiguredBackend & { requests: CompletionRequest[] } {
  let call = 0
  const requests: CompletionRequest[] = []

  return {
    specVersion: "v1",
    config: { ...DEFAULT_CONFIG, ...config },
    requests,
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] })
      return await handler(request, call++)
    },
  }
}

export function textResponse(
  text: string,
  usage: Partial<CompletionResponse["usage"]> = {},
): CompletionResponse {
  return {
    messages: [assistantMessage([textPart(Role.Assistant, text)])],
    stopReason: StopReason.EndTurn,
    usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 20, ...usage },
    providerMeta: { provider: "mock" },
    warnings: [],
  }
}

export function toolResponse(
  name: string,
  args: Record<string, unknown>,
): CompletionResponse {
  return {
    messages: [
      assistantMessage([
        toolCallPart({
          toolCallId: `call_${name}`,
          name,
          arguments: args,
        }),
      ]),
    ],
    stopReason: StopReason.ToolUse,
    usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 30 },
    providerMeta: { provider: "mock" },
    warnings: [],
  }
}

export function multiToolResponse(
  calls: { name: string; args: Record<string, unknown> }[],
): CompletionResponse {
  return {
    messages: [
      assistantMessage(
        calls.map((call, index) =>
          toolCallPart({
            toolCallId: `call_${call.name}_${index + 1}`,
            name: call.name,
            arguments: call.args,
          }),
        ),
      ),
    ],
    stopReason: StopReason.ToolUse,
    usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 30 },
    providerMeta: { provider: "mock" },
    warnings: [],
  }
}

export function thinkAndToolResponse(
  thinking: string,
  name: string,
  args: Record<string, unknown>,
): CompletionResponse {
  return {
    messages: [
      assistantMessage([
        thinkingPart(thinking),
        toolCallPart({
          toolCallId: `call_${name}`,
          name,
          arguments: args,
        }),
      ]),
    ],
    stopReason: StopReason.ToolUse,
    usage: {
      ...emptyUsage(),
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 30,
    },
    providerMeta: { provider: "mock" },
    warnings: [],
  }
}

export function cutoffResponse(text: string): CompletionResponse {
  return {
    messages: [assistantMessage([textPart(Role.Assistant, text)])],
    stopReason: StopReason.MaxTokens,
    usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 4000 },
    providerMeta: { provider: "mock" },
    warnings: [],
  }
}

export function retryableError(
  kind: CompletionErrorKind,
  message = kind,
): CompletionError {
  return new CompletionError(kind, message)
}

export function lastAssistantText(history: Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]!
      if (part.type === "text" && partRole(part) === Role.Assistant) {
        return part.content
      }
    }
  }
  return undefined
}
