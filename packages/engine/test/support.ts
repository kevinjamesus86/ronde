import {
  CompletionError,
  CompletionErrorKind,
  EMPTY_USAGE,
  StopReason,
  type CompletionDelta,
  type CompletionRequest,
  type CompletionResponse,
  type ConfiguredBackend,
  type ResolvedBackendConfig,
  type UsageStats,
} from "@ronde/core/completion"
import { type JournalEvent, Journal } from "@ronde/core/journal"
import { err } from "@ronde/core/result"
import {
  type Awaitable,
  MessageType,
  Role,
  type Message,
  type MessagePart,
  type ToolCallPart,
} from "@ronde/core/message"
import { type ToolCall } from "@ronde/core/tool"
import { type Toolkit } from "@ronde/core/toolkit"
import {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"
import {
  engine,
  type EngineResult,
  type EngineConfig,
  type EngineEvent,
} from "@ronde/engine"

const DEFAULT_CONFIG: ResolvedBackendConfig = {
  model: "mock",
  effort: undefined,
  maxContext: 200_000,
  maxOutput: 64_000,
}

const DEFAULT_USAGE: UsageStats = {
  ...EMPTY_USAGE,
  inputTokens: 100,
  outputTokens: 20,
}

export function mockBackend(
  responses: CompletionResponse[],
  options: {
    config?: Partial<ResolvedBackendConfig>
  } = {},
): ConfiguredBackend & { requests: CompletionRequest[] } {
  let call = 0
  const requests: CompletionRequest[] = []

  return {
    specVersion: "v1",
    config: { ...DEFAULT_CONFIG, ...options.config },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] })
      const response = responses[call]
      if (!response) {
        throw new Error(`No mock response for call ${call}`)
      }
      call += 1
      return response
    },
  }
}

export function mockHandler(
  handler: (
    req: CompletionRequest,
    call: number,
  ) => CompletionResponse | Promise<CompletionResponse>,
  options: {
    config?: Partial<ResolvedBackendConfig>
  } = {},
): ConfiguredBackend & { requests: CompletionRequest[] } {
  let call = 0
  const requests: CompletionRequest[] = []

  return {
    specVersion: "v1",
    config: { ...DEFAULT_CONFIG, ...options.config },
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] })
      return await handler(req, call++)
    },
  }
}

export function streamingBackend(
  produce: (
    req: CompletionRequest,
    call: number,
  ) => AsyncGenerator<CompletionDelta, CompletionResponse, void>,
  options: {
    config?: Partial<ResolvedBackendConfig>
  } = {},
): ConfiguredBackend & { requests: CompletionRequest[] } {
  let call = 0
  const requests: CompletionRequest[] = []

  return {
    specVersion: "v1",
    config: { ...DEFAULT_CONFIG, ...options.config },
    requests,
    complete(req) {
      requests.push({ ...req, messages: [...req.messages] })
      return produce(req, call++)
    },
  }
}

export function textResponse(
  text: string,
  options: { usage?: Partial<UsageStats> } = {},
): CompletionResponse {
  return {
    messages: [
      {
        parts: [
          { type: MessageType.Text, role: Role.Assistant, content: text },
        ],
      },
    ],
    stopReason: StopReason.EndTurn,
    usage: { ...DEFAULT_USAGE, ...options.usage },
    providerMeta: null,
    warnings: [],
  }
}

export function thinkingAndTextResponse(
  thinking: string,
  text: string,
): CompletionResponse {
  return {
    messages: [
      {
        parts: [
          { type: MessageType.Think, content: thinking },
          { type: MessageType.Text, role: Role.Assistant, content: text },
        ],
      },
    ],
    stopReason: StopReason.EndTurn,
    usage: { ...DEFAULT_USAGE, reasoningTokens: 12 },
    providerMeta: null,
    warnings: [],
  }
}

export function toolResponse(
  name: string,
  arguments_: Record<string, unknown>,
): CompletionResponse {
  return {
    messages: [
      {
        parts: [
          {
            type: MessageType.ToolUse,
            toolCallId: `${name}-call-1`,
            name,
            arguments: arguments_,
          },
        ],
      },
    ],
    stopReason: StopReason.ToolUse,
    usage: { ...DEFAULT_USAGE, outputTokens: 30 },
    providerMeta: null,
    warnings: [],
  }
}

export function multiToolResponse(
  calls: { name: string; arguments: Record<string, unknown> }[],
): CompletionResponse {
  return {
    messages: [
      {
        parts: calls.map(
          (call, index) =>
            ({
              type: MessageType.ToolUse,
              toolCallId: `${call.name}-call-${index + 1}`,
              name: call.name,
              arguments: call.arguments,
            }) satisfies ToolCallPart,
        ),
      },
    ],
    stopReason: StopReason.ToolUse,
    usage: { ...DEFAULT_USAGE, outputTokens: 30 },
    providerMeta: null,
    warnings: [],
  }
}

export function cutoffResponse(text: string): CompletionResponse {
  return {
    messages: [
      {
        parts: [
          { type: MessageType.Text, role: Role.Assistant, content: text },
        ],
      },
    ],
    stopReason: StopReason.MaxTokens,
    usage: { ...DEFAULT_USAGE, outputTokens: 4000 },
    providerMeta: null,
    warnings: [],
  }
}

export function contextLengthExceeded(message = "prompt too long"): never {
  throw new CompletionError(CompletionErrorKind.ContextLengthExceeded, message)
}

export class TestJournal extends Journal {
  readonly id = "journal-1"
  readonly kind = "test"
  readonly archived: { reason: string; events: JournalEvent[] }[] = []
  readonly active: JournalEvent[] = []
  // Each entry records the last event written before the commit fired.
  // Lets tests assert commits happen immediately after specific
  // boundary events (turn_end, run_end) rather than just counting them.
  readonly commitLog: { afterEvent: JournalEvent }[] = []

  get commits(): number {
    return this.commitLog.length
  }

  async event(event: JournalEvent): Promise<void> {
    this.active.push(event)
  }

  override async commit(): Promise<void> {
    const afterEvent = this.active.at(-1)
    if (!afterEvent) {
      // The engine only ever commits after writing an event (turn_end,
      // run_end). A commit with nothing in the active slice is a bug
      // we want the test to surface, not silently absorb.
      throw new Error("TestJournal.commit() called before any event written")
    }
    this.commitLog.push({ afterEvent })
  }

  async scan(
    onEvent: (event: JournalEvent) => Awaitable<boolean | void>,
  ): Promise<void> {
    for (const event of this.active) {
      if (await onEvent(event)) {
        return
      }
    }
  }

  async partition(
    reason: string,
    nextEvents: readonly JournalEvent[] = [],
  ): Promise<void> {
    this.archived.push({ reason, events: [...this.active] })
    this.active.length = 0
    this.active.push(...nextEvents)
  }
}

export class TestWorkspace extends Workspace {
  readonly id = "workspace-1"
  readonly kind = "test"
  readonly spills: { content: string; opts: SpillOpts }[] = []

  async spill(content: string, opts: SpillOpts = {}): Promise<SpillResult> {
    this.spills.push({ content, opts })
    return {
      uri: `memory://spill/${this.spills.length}`,
      preview: content,
      truncated: false,
      bytes: Buffer.byteLength(content, "utf8"),
    }
  }
}

export function createRuntime() {
  return {
    journal: new TestJournal(),
    workspace: new TestWorkspace(),
  }
}

export async function driveEngine(
  backend: ConfiguredBackend,
  config: Omit<EngineConfig<TestWorkspace>, "journal" | "workspace"> & {
    journal?: TestJournal
    workspace?: TestWorkspace
  },
): Promise<{
  events: EngineEvent[]
  result: EngineResult
  journal: TestJournal
  workspace: TestWorkspace
}> {
  const runtime = {
    journal: config.journal ?? new TestJournal(),
    workspace: config.workspace ?? new TestWorkspace(),
  }

  const gen = engine(backend, {
    ...config,
    journal: runtime.journal,
    workspace: runtime.workspace,
  })

  const events: EngineEvent[] = []
  try {
    let next = await gen.next()
    while (!next.done) {
      events.push(next.value)
      next = await gen.next()
    }
    return {
      events,
      result: next.value,
      journal: runtime.journal,
      workspace: runtime.workspace,
    }
  } finally {
    try {
      await gen.return(undefined as never)
    } catch {}
  }
}

export function emptyToolkit(): Toolkit<TestWorkspace> {
  return {
    schemas: [],
    async execute() {
      return err("Unknown tool")
    },
    formatters: {},
  }
}

export function toolCall(
  name: string,
  arguments_: Record<string, unknown>,
  toolUseId = `${name}-call`,
): ToolCall {
  return { toolUseId, name, arguments: arguments_ }
}

export function assistantMessage(parts: MessagePart[]): Message {
  return { parts }
}
