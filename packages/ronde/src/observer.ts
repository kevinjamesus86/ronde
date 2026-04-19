import type { ToolCall, ToolResult } from "@ronde/core/tool"
import type { UsageStats } from "@ronde/core/completion"
import type { EngineResult, AgentStep } from "@ronde/engine"

/** Callback interface layered over emitted engine events. */
export interface RunObserver {
  onTurnStart?(turn: number): void
  onTurnEnd?(turn: number, step: AgentStep): void
  onThinking?(turn: number, content: string): void
  onThinkingDelta?(turn: number, content: string): void
  onText?(turn: number, content: string): void
  onTextDelta?(turn: number, content: string): void
  onToolCall?(turn: number, toolCall: ToolCall): void
  onToolDelta?(turn: number, toolCall: ToolCall, chunk: string): void
  onToolInputDelta?(turn: number, toolCallId: string, chunk: string): void
  onToolResult?(turn: number, toolCall: ToolCall, result: ToolResult): void
  onCompactionStart?(turn: number, historyLength: number): void
  onCompactionEnd?(turn: number, usage: UsageStats): void
  onCutoff?(turn: number, consecutiveCount: number): void
  onWarning?(turn: number, message: string): void
  onError?(turn: number, message: string): void
  onRunEnd?(result: EngineResult): void
}
