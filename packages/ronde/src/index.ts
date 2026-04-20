/**
 * @module
 * ronde — agentic loop framework.
 *
 * @example
 * ```ts
 * import { generate, agentic, coreTools } from "ronde"
 *
 * const { output } = await generate({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "Explain monads in one sentence.",
 * })
 *
 * const { output, steps } = await agentic({
 *   model: "anthropic/claude-sonnet-4-6",
 *   prompt: "Fix the failing tests.",
 *   tools: coreTools({ roots: [process.cwd()] }),
 * })
 * ```
 */

export {
  agentic,
  agenticStream,
  generate,
  resume,
  hydrate,
  replay,
  type AgenticConfig,
  type AgenticStreamConfig,
  type AgenticResult,
} from "./api.js"

export { createRuntime } from "./default-runtime.js"
export {
  openRuntime,
  type FsRuntime,
  type ManagedRuntimeOptions,
  type Runtime,
} from "./managed-runtime.js"

export { engine } from "@ronde/engine"

export { ok, err, isOk, type Result } from "@ronde/core/result"

export {
  Role,
  MessageType,
  CompletionMode,
  StopReason,
  Effort,
  userMessage,
  assistantMessage,
  toolResultMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
  type Lax,
  type Awaitable,
  type TextPart,
  type ThinkingPart,
  type ToolCallPart,
  type ToolResultPart,
  type MessagePart,
  type Message,
  type ToolSchema,
  type UsageStats,
  type CompletionWarning,
  type CompletionRequest,
  type CompletionResponse,
  type CompletionBackend,
  type ConfiguredBackend,
  type ResolvedBackendConfig,
} from "@ronde/core"

export type { ToolCall, ToolResult } from "@ronde/core/tool"

export {
  tool,
  merge,
  defaultFormatter,
  formatToolOutput,
  bindToolkitRuntime,
  type Toolkit,
  type ToolOutput,
  type ToolExecutor,
  type ToolContext,
  type StatefulToolContext,
  type ToolFormatterFn,
  type StateConfig,
} from "@ronde/core/toolkit"

export { drain, asGenerator, isAsyncGenerator } from "@ronde/core/stream"

export type { RunObserver } from "./observer.js"
export {
  type AgentStep,
  type AgentStepToolCall,
  type EngineConfig,
  type EngineDiagnosticEvent,
  type EngineEvent,
  type EngineEventKind,
  type EngineHooks,
  type EngineLifecycleEvent,
  type EngineProgressEvent,
  diagnosticEvent,
  lifecycleEvent,
  type PreStepInput,
  type PreStepResult,
  progressEvent,
  type SettleReason,
  type EngineResult,
} from "@ronde/engine"

export { Journal, JournalEvent } from "@ronde/core/journal"

export {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"

export {
  DefaultCompactionStrategy,
  type DefaultCompactionOptions,
} from "./compaction.js"
export type {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
} from "@ronde/engine"

export {
  RetryingBackend,
  withRetry,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_OUTPUT,
  type RetryOptions,
} from "@ronde/backend"
export {
  registerProvider,
  getProvider,
  allProviders,
  type ProviderDescriptor,
  createBackend,
} from "@ronde/providers"
export { CompletionError, CompletionErrorKind } from "@ronde/core/completion"
export { classifyError, wrapSdkError } from "@ronde/backend"

export {
  createFsRuntime,
  openFsRuntime,
  FsWorkspace,
  type FsSpillResult,
} from "@ronde/fs"

export { createMemRuntime, MemoryJournal, MemoryWorkspace } from "@ronde/mem"

export {
  coreTools,
  readFile,
  writeFile,
  editFile,
  globFiles,
  grepFiles,
  listDirectory,
  shell,
  PathContext,
  ro,
  rw,
  type PathSpec,
  type RootSpec,
  type CoreToolsOptions,
  type SandboxConfig,
  type ReadFileData,
  type WriteFileData,
  type EditFileData,
  type GlobData,
  type GrepData,
  type GrepMatch,
  type ListDirectoryData,
  type ListDirectoryEntry,
  type ShellData,
} from "@ronde/tools"
