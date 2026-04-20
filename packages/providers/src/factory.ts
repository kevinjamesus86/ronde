import { getProvider } from "./registry.js"
import { Effort, type ConfiguredBackend } from "@ronde/core/completion"
import { DEFAULT_MAX_CONTEXT, DEFAULT_MAX_OUTPUT } from "@ronde/backend"
import type { BackendConfig, InternalBackendConfig } from "./types.js"

export function createBackend(config: BackendConfig): ConfiguredBackend {
  const desc = getProvider(config.provider)
  if (!desc) {
    throw new Error(
      `Unknown provider "${config.provider}". ` +
        `Register it with registerProvider().`,
    )
  }

  const effort = config.effort as Effort | undefined
  const maxContext = config.maxContext ?? DEFAULT_MAX_CONTEXT
  const maxOutput = config.maxOutput ?? DEFAULT_MAX_OUTPUT

  const internal: InternalBackendConfig = {
    nativeOpenAI: config.provider === "openai",
    apiKey: resolveApiKey(config, desc.envVar),
    baseURL: config.baseURL ?? desc.defaultURL,
  }

  const inner = desc.create(internal)

  return {
    specVersion: "v1",
    complete: (req) => inner.complete(req),
    config: {
      model: config.model,
      effort,
      maxContext,
      maxOutput,
    },
  }
}

// Explicit `apiKey` wins. Otherwise fall back to the provider's
// declared env var. `envVar === null` means a local provider (e.g.
// llamacpp) with no key requirement.
function resolveApiKey(config: BackendConfig, envVar: string | null): string {
  if (config.apiKey) {
    return config.apiKey
  }
  if (envVar === null) {
    return ""
  }
  const fromEnv = process.env[envVar]
  if (fromEnv) {
    return fromEnv
  }
  throw new Error(
    `Missing ${envVar} environment variable ` +
      `for provider "${config.provider}". ` +
      `Pass { apiKey } or set ${envVar}.`,
  )
}
