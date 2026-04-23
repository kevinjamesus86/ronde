import type { ToolCall } from "@ronde/core/tool"
import type { ToolResult } from "@ronde/core/toolkit"
import type { UsageStats } from "@ronde/core/completion"
import type { AgentStep, EngineEvent, EngineResult } from "@ronde/engine"

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
  onToolResult?(
    turn: number,
    toolCall: ToolCall,
    content: string,
    result: ToolResult,
  ): void
  onCompactionStart?(turn: number, historyLength: number): void
  onCompactionEnd?(turn: number, usage: UsageStats): void
  onCutoff?(turn: number, consecutiveCount: number): void
  onWarning?(turn: number, message: string): void
  onError?(turn: number, message: string): void
  onRunEnd?(result: EngineResult): void
}

export function dispatch(event: EngineEvent, observers: RunObserver[]): void {
  switch (event.type) {
    case "turn_start":
      notify(observers, (o) => o.onTurnStart?.(event.turn))
      break

    case "thinking_delta":
      notify(observers, (o) => o.onThinkingDelta?.(event.turn, event.content))
      break
    case "thinking":
      notify(observers, (o) => o.onThinking?.(event.turn, event.content))
      break
    case "text_delta":
      notify(observers, (o) => o.onTextDelta?.(event.turn, event.content))
      break
    case "text":
      notify(observers, (o) => o.onText?.(event.turn, event.content))
      break
    case "tool_input_delta":
      notify(observers, (o) =>
        o.onToolInputDelta?.(event.turn, event.toolCallId, event.chunk),
      )
      break
    case "tool_call":
      notify(observers, (o) => o.onToolCall?.(event.turn, event.call))
      break
    case "tool_delta":
      notify(observers, (o) =>
        o.onToolDelta?.(event.turn, event.call, event.chunk),
      )
      break
    case "tool_result":
      notify(observers, (o) =>
        o.onToolResult?.(event.turn, event.call, event.content, event.result),
      )
      break

    case "turn_end":
      notify(observers, (o) => o.onTurnEnd?.(event.turn, event.step))
      break
    case "cutoff":
      notify(observers, (o) => o.onCutoff?.(event.turn, event.count))
      break

    case "compaction_start":
      notify(observers, (o) =>
        o.onCompactionStart?.(event.turn, event.historyLength),
      )
      break
    case "compaction_end":
      notify(observers, (o) => o.onCompactionEnd?.(event.turn, event.usage))
      break

    case "warning":
      notify(observers, (o) => o.onWarning?.(event.turn, event.message))
      break
    case "error":
      notify(observers, (o) => o.onError?.(event.turn, event.message))
      break

    case "run_end":
      notify(observers, (o) => o.onRunEnd?.(event.result))
      break

    default: {
      const _: never = event
    }
  }
}

function notify(observers: RunObserver[], fn: (o: RunObserver) => void): void {
  for (const observer of observers) {
    try {
      fn(observer)
    } catch {}
  }
}
