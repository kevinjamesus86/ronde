/**
 * @module
 * Provider-facing backend configuration types.
 */
import type { Effort } from "@ronde/core/completion"
import type { Lax } from "@ronde/core"

export interface BackendConfig {
  provider: string
  model: string
  apiKey: string
  baseURL?: string
  effort?: Lax<Effort>
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export interface InternalBackendConfig {
  /** True only for first-party OpenAI — gates reasoning features. */
  nativeOpenAI: boolean
  apiKey: string
  baseURL: string | undefined
}
