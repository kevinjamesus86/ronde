/**
 * @module
 * Provider registry. Each provider registers a descriptor that owns its
 * identity — name, default URL, env var, and factory. Core never enumerates
 * providers.
 */
import type { CompletionBackend } from "@ronde/core/completion"
import type { InternalBackendConfig } from "./types.js"

export interface ProviderDescriptor {
  name: string
  /** undefined = caller must supply a baseURL. */
  defaultURL: string | undefined
  /** null = local provider, no API key env var. */
  envVar: string | null
  /** Defaults to `name` when omitted. */
  modelPrefix?: string
  create(config: InternalBackendConfig): CompletionBackend
}

const registry = new Map<string, ProviderDescriptor>()

export function registerProvider(desc: ProviderDescriptor): void {
  registry.set(desc.name, desc)
}

export function getProvider(name: string): ProviderDescriptor | undefined {
  return registry.get(name)
}

export function allProviders(): IterableIterator<ProviderDescriptor> {
  return registry.values()
}

import { openaiDescriptor } from "./openai.js"
import { anthropicDescriptor } from "./anthropic.js"
import { geminiDescriptor } from "./gemini.js"
import { llamacppDescriptor } from "./llamacpp.js"

registerProvider(openaiDescriptor)
registerProvider(anthropicDescriptor)
registerProvider(geminiDescriptor)
registerProvider(llamacppDescriptor)
