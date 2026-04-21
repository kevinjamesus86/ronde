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

const DEFAULT_SYSTEM_PROMPT = `
You produce continuation context for an agent that will resume this work.
Your output will replace the conversation history, so completeness matters
more than brevity. Extract and preserve all specific values, paths,
identifiers, and decisions — verbatim, in full, exactly as they appear.
Absolute paths stay absolute. Never abbreviate, truncate, or elide
references with \`...\`. Never fabricate details that aren't in the
conversation.

Do not answer any questions in the conversation — produce only the
continuation context.

Use this structure:

## Goal
What is the task? What constraints or requirements apply?

## Progress
What has been accomplished? What is still in progress? What remains?

## Key decisions
Important choices made and their reasoning.

## Discoveries
Notable findings, errors encountered, values learned during the work.

## Relevant files
Files read, created, or modified that pertain to the task.

## Next steps
What should the next agent do first?
`.trim()

/** Options for customizing `DefaultCompactionStrategy`. */
export interface DefaultCompactionOptions {
  compactionSystemPrompt?: string
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
  private resumeMessage: string

  constructor(options: DefaultCompactionOptions = {}) {
    this.compactionSystem =
      options.compactionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT
    this.resumeMessage =
      options.resumeMessage ?? "Resume the workflow from where you left off."
  }

  async compact(ctx: CompactionContext): Promise<CompactionResult> {
    const { backend, model, effort, history } = ctx
    const working = stripThinking(history)
    // Messages popped off `working` when the compaction call itself
    // overflows. Kept in chronological order via unshift so the engine
    // can splice them back into the post-compaction history.
    const deferred: Message[] = []

    while (working.length > 0) {
      const compactInput: Message[] = [
        ...working,
        // Minimal trigger: providers require the request to end with a
        // user-role message, which isn't guaranteed when compacting a
        // completed session (tail may be assistant text). All behavior
        // lives in the system prompt; this just kicks off the action.
        userMessage("Produce the continuation context now."),
      ]

      let compactResponse
      try {
        compactResponse = await drain(
          backend.complete({
            model,
            system: this.compactionSystem,
            messages: compactInput,
            tools: [],
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
          deferred.unshift(working.pop()!)
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
        deferred,
        usage: compactResponse.usage,
      }
    }

    return { kind: "not_compacted", usage: emptyUsage() }
  }
}

function stripThinking(messages: readonly Message[]): Message[] {
  return messages
    .map((m) => ({
      ...m,
      parts: m.parts.filter((p) => p.type !== MessageType.Think),
    }))
    .filter((m) => m.parts.length > 0)
}

export type { CompactionContext, CompactionResult, CompactionStrategy }
