import {
  MessageType,
  Role,
  assistantMessage,
  textPart,
  userMessage,
  type Message,
  type MessagePart,
  type ToolCallPart,
} from "@ronde/core/message"

export function splitResponse(response: Message[]): {
  messages: Message[]
  pendingCalls: ToolCallPart[]
} {
  const messages: Message[] = []
  const pendingCalls: ToolCallPart[] = []
  for (const msg of response) {
    const parts: MessagePart[] = []
    for (const part of msg.parts) {
      if (part.type === MessageType.ToolUse) {
        pendingCalls.push(part)
      } else {
        parts.push(part)
      }
    }
    if (parts.length > 0) {
      messages.push({ ...msg, parts })
    }
  }
  return { messages, pendingCalls }
}

function replayTextMessage(role: Role, content: string): Message {
  return role === Role.Assistant
    ? assistantMessage([textPart(Role.Assistant, content)])
    : userMessage(content)
}

/**
 * Flatten current-turn content into provider-neutral text for post-compaction
 * replay. Reasoning is dropped; tool calls and results are stringified.
 */
export function translateBufferedMessages(messages: Message[]): Message[] {
  const translated: Message[] = []
  const toolNamesById = new Map<string, string>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === MessageType.ToolUse) {
        toolNamesById.set(part.toolCallId, part.name)
      }
    }
  }

  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case MessageType.Think:
          break
        case MessageType.Text: {
          const content = part.content.trim()
          if (!content) {
            break
          }
          translated.push(
            replayTextMessage(part.role, `[${part.role} text]\n${content}`),
          )
          break
        }
        case MessageType.ToolUse:
          translated.push(
            replayTextMessage(
              Role.Assistant,
              `[assistant tool call] ${part.name}\n` +
                `id: ${part.toolCallId}\n` +
                `args: ${JSON.stringify(part.arguments || {})}`,
            ),
          )
          break
        case MessageType.ToolResult: {
          const toolName = toolNamesById.get(part.toolCallId)
          translated.push(
            replayTextMessage(
              Role.User,
              `${toolName ? `[user tool result] ${toolName}` : "[user tool result]"}\n` +
                `id: ${part.toolCallId}\n` +
                `status: ${part.ok ? "success" : "failure"}\n` +
                `content:\n${part.content}`,
            ),
          )
          break
        }
        default: {
          const _: never = part
        }
      }
    }
  }

  return translated
}
