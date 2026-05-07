import {
  MessageType,
  partRole,
  Role,
  type Message,
  type MessagePart,
} from "@ronde/core/message"

export type NormalizedPart<M> = MessagePart & { meta?: M }

export interface NormalizedMessage<M> {
  parts: NormalizedPart<M>[]
  id?: string
}

/**
 * Canonicalize message history for a specific provider. After this
 * pass, every part's meta is either the provider's own type or absent.
 *
 * - Own meta → passed through untouched
 * - Foreign thinking → dropped (reasoning traces stay private)
 * - Foreign text / tool call / tool result → meta stripped; content kept
 */
export function canonicalize<M>(
  messages: Message[],
  isOwn: (meta: unknown) => meta is M,
): NormalizedMessage<M>[] {
  function liftPart(part: MessagePart): NormalizedPart<M> | undefined {
    if (part.meta === undefined || isOwn(part.meta)) {
      return part as NormalizedPart<M>
    }
    if (part.type === MessageType.Think) {
      return undefined
    }
    const { meta: _meta, ...rest } = part
    return rest as NormalizedPart<M>
  }

  return messages.map((msg) => ({
    ...msg,
    parts: msg.parts
      .map(liftPart)
      .filter((p): p is NormalizedPart<M> => p !== undefined),
  }))
}

/**
 * Bucket parts into role-tagged messages for providers that require
 * role-at-message-level on the wire (Anthropic, Gemini). Role is
 * resolved per-part via `partRole()`.
 *
 * Tool_use and tool_result parts pool across consecutive messages and
 * flush together when a non-tool part arrives or the walk ends —
 * pooled tool_uses land in one assistant bucket, pooled tool_results
 * in one user bucket. This restores the batched wire shape the model
 * originally produced even though canonical history stores each tool
 * as its own pair message for atomic durability.
 */
export function coalesceByRole<M, T>(
  messages: NormalizedMessage<M>[],
  mapRole: (role: Role) => string,
  serializePart: (part: NormalizedPart<M>) => T | T[] | undefined,
): Array<{ role: string; parts: T[] }> {
  const output: Array<{ role: string; parts: T[] }> = []
  const assistantRole = mapRole(Role.Assistant)
  const userRole = mapRole(Role.User)
  const pooledUses: T[] = []
  const pooledResults: T[] = []

  const pushBucket = (role: string, parts: T[]) => {
    if (parts.length === 0) {
      return
    }
    const last = output[output.length - 1]
    if (last && last.role === role) {
      last.parts.push(...parts)
    } else {
      output.push({ role, parts: [...parts] })
    }
  }

  const flushTools = () => {
    pushBucket(assistantRole, pooledUses)
    pooledUses.length = 0
    pushBucket(userRole, pooledResults)
    pooledResults.length = 0
  }

  for (const message of messages) {
    for (const part of message.parts) {
      const serialized = serializePart(part)
      if (serialized === undefined) {
        continue
      }
      const items = Array.isArray(serialized) ? serialized : [serialized]
      if (items.length === 0) {
        continue
      }

      if (part.type === MessageType.ToolUse) {
        pooledUses.push(...items)
      } else if (part.type === MessageType.ToolResult) {
        pooledResults.push(...items)
      } else {
        flushTools()
        pushBucket(mapRole(partRole(part)), items)
      }
    }
  }
  flushTools()

  return output
}
