import type { FsRuntime } from "@ronde/fs"
import {
  createManagedRuntime,
  type ManagedRuntimeOptions,
} from "./managed-runtime.js"

/**
 * Create a fresh runtime pair.
 *
 * Default (no options): returns a managed fs runtime under ronde's
 * managed layout policy. This is the batteries-included path:
 * durable by default, with explicit `@ronde/mem` opt-in for callers
 * who want ephemeral runtimes instead.
 */
export async function createRuntime(
  opts: ManagedRuntimeOptions = {},
): Promise<FsRuntime> {
  return createManagedRuntime(opts)
}
