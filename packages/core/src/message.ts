/**
 * @module
 * Canonical message types, parts, constructors, and utility types.
 *
 * A Message is a batch of parts that commit together — the atomic
 * unit of journal durability. Role is not carried on the Message
 * itself because a single durable unit may legitimately contain
 * contributions from multiple roles (e.g. a tool_use + tool_result
 * pair). Role lives on the parts:
 *
 * - `TextPart`        — explicit `role` field (user/assistant/system/developer)
 * - `ThinkingPart`    — implicit: always assistant (only the model produces reasoning)
 * - `ToolCallPart`    — implicit: always assistant (only the model invokes tools)
 * - `ToolResultPart`  — implicit: always user (tool outputs flow back to the model)
 *
 * Use `partRole(part)` to get a part's effective role.
 */

export const enum Role {
  User = "user",
  Assistant = "assistant",
  System = "system",
  Developer = "developer",
}

export const enum MessageType {
  Text = "text",
  Think = "think",
  ToolUse = "tool_call",
  ToolResult = "tool_result",
}

/** Plain text content. Role is explicit because text can come from any role. */
export interface TextPart {
  type: MessageType.Text
  role: Role
  content: string
  meta?: unknown
}

/** Reasoning/thinking content from the model. Implicitly assistant-role. */
export interface ThinkingPart {
  type: MessageType.Think
  content: string
  meta?: unknown
}

/** A tool invocation from the model. Implicitly assistant-role. */
export interface ToolCallPart {
  type: MessageType.ToolUse
  toolCallId: string
  name: string
  arguments: Record<string, unknown>
  meta?: unknown
}

/** The result of a tool invocation, sent back to the model. Implicitly user-role. */
export interface ToolResultPart {
  type: MessageType.ToolResult
  toolCallId: string
  ok: boolean
  content: string
  meta?: unknown
}

export type MessagePart =
  | TextPart
  | ThinkingPart
  | ToolCallPart
  | ToolResultPart

/**
 * A message — a batch of parts that durably commit together. Parts
 * carry role individually; a single message can span multiple roles.
 */
export interface Message {
  parts: MessagePart[]
  /** Provider response ID (Anthropic msg id, OpenAI response id, etc). */
  id?: string
}

/**
 * The effective role of a part. Text carries role explicitly;
 * everything else is fixed by part type.
 */
export function partRole(part: MessagePart): Role {
  switch (part.type) {
    case MessageType.Text:
      return part.role
    case MessageType.Think:
      return Role.Assistant
    case MessageType.ToolUse:
      return Role.Assistant
    case MessageType.ToolResult:
      return Role.User
  }
}

export function userMessage(content: string, meta?: unknown): Message {
  return {
    parts: [textPart(Role.User, content, meta)],
  }
}

export function assistantMessage(parts: MessagePart[], id?: string): Message {
  const msg: Message = { parts }
  if (id) {
    msg.id = id
  }
  return msg
}

export function toolResultMessage(
  toolCallId: string,
  ok: boolean,
  content: string,
  meta?: unknown,
): Message {
  return {
    parts: [toolResultPart({ toolCallId, ok, content, meta })],
  }
}

export function textPart(
  role: Role,
  content: string,
  meta?: unknown,
): TextPart {
  return {
    type: MessageType.Text,
    role,
    content,
    ...(meta === undefined ? {} : { meta }),
  }
}

export function thinkingPart(content: string, meta?: unknown): ThinkingPart {
  return {
    type: MessageType.Think,
    content,
    ...(meta === undefined ? {} : { meta }),
  }
}

export function toolCallPart(opts: {
  toolCallId: string
  name: string
  arguments: Record<string, unknown>
  meta?: unknown
}): ToolCallPart {
  return {
    type: MessageType.ToolUse,
    toolCallId: opts.toolCallId,
    name: opts.name,
    arguments: opts.arguments,
    ...(opts.meta === undefined ? {} : { meta: opts.meta }),
  }
}

export function toolResultPart(opts: {
  toolCallId: string
  ok: boolean
  content: string
  meta?: unknown
}): ToolResultPart {
  return {
    type: MessageType.ToolResult,
    toolCallId: opts.toolCallId,
    ok: opts.ok,
    content: opts.content,
    ...(opts.meta === undefined ? {} : { meta: opts.meta }),
  }
}
