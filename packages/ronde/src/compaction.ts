import {
  CompletionError,
  CompletionErrorKind,
  emptyUsage,
} from "@ronde/core/completion"
import {
  MessageType,
  Role,
  type Message,
  userMessage,
} from "@ronde/core/message"
import { drain } from "@ronde/core/stream"
import type {
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
} from "@ronde/engine"

const DEFAULT_SYSTEM_PROMPT =
  "You produce continuation context for an agent that will resume this work. " +
  "Your output will replace the conversation history, so completeness matters " +
  "more than brevity. Extract and preserve all specific values, paths, identifiers, " +
  "and decisions. Never fabricate details that aren't in the conversation."

const DEFAULT_USER_MESSAGE =
  "Construct a continuation context so another agent can pick up this work. " +
  "Use this structure:\n\n" +
  "## Goal\nWhat is the task? What constraints or requirements apply?\n\n" +
  "## Progress\nWhat has been accomplished? What is still in progress? What remains?\n\n" +
  "## Key decisions\nImportant choices made and their reasoning.\n\n" +
  "## Discoveries\nNotable findings, errors encountered, values learned during the work.\n\n" +
  "## Relevant files\nFiles read, created, or modified that pertain to the task.\n\n" +
  "## Next steps\nWhat should the next agent do first?"

/** Options for customizing `DefaultCompactionStrategy`. */
export interface DefaultCompactionOptions {
  compactionSystemPrompt?: string
  compactionUserMessage?: string
  resumeMessage?: string
}

/**
 * Default compaction: asks the model to produce a structured
 * continuation context ("## Goal", "## Progress", etc.). Drops
 * oldest history items one at a time if the compaction call hits
 * the provider's context limit.
 */
export class DefaultCompactionStrategy implements CompactionStrategy {
  private compactionSystem: string
  private userMessage: string
  private resumeMessage: string

  constructor(options: DefaultCompactionOptions = {}) {
    this.compactionSystem =
      options.compactionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT
    this.userMessage = options.compactionUserMessage ?? DEFAULT_USER_MESSAGE
    this.resumeMessage =
      options.resumeMessage ?? "Resume the workflow from where you left off."
  }

  async compact(ctx: CompactionContext): Promise<CompactionResult> {
    const { backend, model, effort, history } = ctx
    const working = history.map(stripThinking).filter((m) => m.parts.length > 0)

    while (working.length > 0) {
      const compactInput: Message[] = [
        ...working,
        userMessage(this.userMessage),
      ]

      let compactResponse
      try {
        compactResponse = await drain(
          backend.complete({
            model,
            system: this.compactionSystem,
            messages: compactInput,
            tools: [],
            // Agentic mode keeps thinking enabled for this call so the
            // model can reason through distillation. Historical thinking
            // is stripped above; we only extract text parts from the
            // response, so any thinking output is discarded too.
            effort,
            maxOutput: ctx.maxOutput,
            signal: ctx.signal,
          }),
        )
      } catch (err) {
        if (
          err instanceof CompletionError &&
          err.kind === CompletionErrorKind.ContextLengthExceeded
        ) {
          if (working.length <= 1) {
            break
          }
          popHistoryItem(working)
          continue
        }
        throw err
      }

      let summary = ""
      for (const message of compactResponse.messages) {
        for (const part of message.parts) {
          if (
            part.type === MessageType.Text &&
            part.role === Role.Assistant &&
            part.content
          ) {
            summary += part.content
          }
        }
      }

      if (!summary.trim()) {
        return { kind: "not_compacted", usage: compactResponse.usage }
      }

      return {
        kind: "compacted",
        summary: userMessage(
          "## Continuation context (compacted from prior conversation)\n\n" +
            summary +
            "\n\n---\n\n" +
            this.resumeMessage,
        ),
        usage: compactResponse.usage,
      }
    }

    return { kind: "not_compacted", usage: emptyUsage() }
  }
}

function stripThinking(message: Message): Message {
  return {
    ...message,
    parts: message.parts.filter((p) => p.type !== MessageType.Think),
  }
}

function popHistoryItem(hist: Message[]): number {
  if (hist.length === 0) {
    return 0
  }
  const last = hist[hist.length - 1]!
  const hasToolResult = last.parts.some(
    (p) => p.type === MessageType.ToolResult,
  )
  if (hasToolResult && hist.length > 1) {
    hist.pop()
    hist.pop()
    return 2
  }
  hist.pop()
  return 1
}

export type { CompactionContext, CompactionResult, CompactionStrategy }
