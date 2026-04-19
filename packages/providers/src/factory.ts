import { getProvider } from "./registry.js"
import {
  Effort,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type ConfiguredBackend,
} from "@ronde/core/completion"
import type { BackendConfig, InternalBackendConfig } from "./types.js"

export function createBackend(config: BackendConfig): ConfiguredBackend {
  const desc = getProvider(config.provider)
  if (!desc) {
    throw new Error(
      `Unknown provider "${config.provider}". ` +
        `Register it with registerProvider().`,
    )
  }

  const effort = (config.effort as Effort) ?? null
  const contextWindowTokens =
    config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS

  const internal: InternalBackendConfig = {
    nativeOpenAI: config.provider === "openai",
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? desc.defaultURL,
  }

  const inner = desc.create(internal)

  return {
    specVersion: "v1",
    complete: (req) => inner.complete(req),
    config: {
      model: config.model,
      effort,
      contextWindowTokens,
      maxOutputTokens,
    },
  }
}
