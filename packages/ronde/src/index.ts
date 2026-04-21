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

// Workspace packages — each one curates its own public surface in its
// index.ts; we forward the lot transparently.
export * from "@ronde/core"
export * from "@ronde/backend"
export * from "@ronde/engine"
export * from "@ronde/providers"
export * from "@ronde/tools"
export * from "@ronde/fs"
export * from "@ronde/mem"

// Product layer — things that only exist in the convenience package.
export * from "./api.js"
export * from "./compaction.js"
export * from "./managed.js"
export type { RunObserver } from "./observer.js"
