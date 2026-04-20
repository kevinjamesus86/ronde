import type { Journal } from "@ronde/core/journal"
import type {
  Effort,
  SettleReason,
  StopReason,
  ToolSchema,
  UsageStats,
} from "@ronde/core/completion"
export type { SettleReason } from "@ronde/core/completion"
import type { Message } from "@ronde/core/message"
import type { Awaitable, Lax } from "@ronde/core"
import type { ToolCall, ToolResult } from "@ronde/core/tool"
import type { Toolkit, ToolOutput } from "@ronde/core/toolkit"
import type { Workspace } from "@ronde/core/workspace"
import type { CompactionStrategy } from "./compaction.js"

type EventVariant<
  Kind extends string,
  Type extends string,
  Payload extends object = {},
> = Readonly<{ kind: Kind; type: Type } & Payload>

type Variants<Kind extends string, Events extends Record<string, object>> = {
  [Type in keyof Events & string]: EventVariant<Kind, Type, Events[Type]>
}[keyof Events & string]

export interface PreStepInput {
  turn: number
  messages: Message[]
  toolSchemas: ToolSchema[]
  steps: readonly AgentStep[]
  usage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
  }
  budget: {
    maxContext: number
    maxOutput: number
  }
  compactionCount: number
}

export interface PreStepResult {
  messages?: Message[]
  toolSchemas?: ToolSchema[]
  model?: string
  effort?: Lax<Effort>
}

export interface EngineHooks {
  approve?: (toolCall: ToolCall) => Awaitable<boolean>
  preStep?: (input: PreStepInput) => Awaitable<PreStepResult | void>
  postStep?: (step: AgentStep) => Awaitable<string | void>
}

/**
 * The journal is the single source of truth for history — the engine
 * replays its active partition at startup to reconstruct `history`.
 */
export interface EngineConfig<W extends Workspace = Workspace> {
  journal: Journal
  workspace: W
  toolkit: Toolkit<W>
  system?: string
  prompt?: string
  maxTurns?: number
  signal?: AbortSignal
  hooks?: EngineHooks
  compaction?: CompactionStrategy
  /**
   * Framework truncation policy for tool-result rendering. Oversized
   * formatted output spills to the workspace and is replaced with a
   * sliced preview plus a neutral hint. See `truncate` on tool
   * definitions for per-tool slice strategy.
   */
  truncation?: {
    /** Inline character budget per tool result. Default: 25_000. */
    maxInline?: number
  }
}

export interface AgentStepToolCall {
  name: string
  args: Record<string, unknown>
  output: ToolOutput
}

export interface AgentStep {
  turn: number
  reasoning: string[]
  toolCalls: AgentStepToolCall[]
  text?: string
  usage: UsageStats
  stopReason: StopReason
}

export type EngineEventKind = "lifecycle" | "progress" | "diagnostic"

export type LifecycleEvents = {
  turn_start: { turn: number }
  turn_end: { turn: number; step: AgentStep }
  compaction_start: { turn: number; historyLength: number }
  compaction_end: { turn: number; usage: UsageStats }
  cutoff: { turn: number; count: number }
  run_end: { result: EngineResult }
}

export type ProgressEvents = {
  thinking: { turn: number; content: string }
  thinking_delta: { turn: number; content: string }
  text: { turn: number; content: string }
  text_delta: { turn: number; content: string }
  tool_call: { turn: number; call: ToolCall }
  tool_delta: { turn: number; call: ToolCall; chunk: string }
  tool_input_delta: { turn: number; toolCallId: string; chunk: string }
  tool_result: { turn: number; call: ToolCall; result: ToolResult }
}

export type DiagnosticEvents = {
  warning: { turn: number; message: string }
  error: { turn: number; message: string }
}

export type EngineLifecycleEvent = Variants<"lifecycle", LifecycleEvents>
export type EngineProgressEvent = Variants<"progress", ProgressEvents>
export type EngineDiagnosticEvent = Variants<"diagnostic", DiagnosticEvents>

export type EngineEvent =
  | EngineLifecycleEvent
  | EngineProgressEvent
  | EngineDiagnosticEvent

function makeEvent<
  Kind extends EngineEventKind,
  Type extends string,
  Payload extends object,
>(kind: Kind, type: Type, data: Payload): EventVariant<Kind, Type, Payload> {
  return { kind, type, ...data }
}

export function lifecycleEvent<Type extends keyof LifecycleEvents & string>(
  type: Type,
  data: LifecycleEvents[Type],
): Extract<EngineLifecycleEvent, { type: Type }> {
  return makeEvent("lifecycle", type, data) as unknown as Extract<
    EngineLifecycleEvent,
    { type: Type }
  >
}

export function progressEvent<Type extends keyof ProgressEvents & string>(
  type: Type,
  data: ProgressEvents[Type],
): Extract<EngineProgressEvent, { type: Type }> {
  return makeEvent("progress", type, data) as unknown as Extract<
    EngineProgressEvent,
    { type: Type }
  >
}

export function diagnosticEvent<Type extends keyof DiagnosticEvents & string>(
  type: Type,
  data: DiagnosticEvents[Type],
): Extract<EngineDiagnosticEvent, { type: Type }> {
  return makeEvent("diagnostic", type, data) as unknown as Extract<
    EngineDiagnosticEvent,
    { type: Type }
  >
}

export interface EngineResult {
  steps: AgentStep[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  compactionCount: number
  history: Message[]
  settleReason: SettleReason
}
