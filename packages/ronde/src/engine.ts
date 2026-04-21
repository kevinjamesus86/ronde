import { engine } from "@ronde/engine"
import type { EngineConfig, EngineEvent, EngineResult } from "@ronde/engine"
import type { ConfiguredBackend } from "@ronde/core/completion"
import type { Workspace } from "@ronde/core/workspace"
import { dispatch, type RunObserver } from "./observer.js"

/**
 * Observer-dispatching consumer over `stream`. Streaming is the
 * primitive; this is sugar for callers that want per-event callbacks
 * instead of iterating a generator.
 */
export async function run<W extends Workspace = Workspace>(
  backend: ConfiguredBackend,
  config: EngineConfig<W>,
  observe: RunObserver | RunObserver[] = [],
): Promise<EngineResult> {
  const observers = Array.isArray(observe) ? observe : [observe]
  const gen = stream(backend, config)
  try {
    let next = await gen.next()
    while (!next.done) {
      dispatch(next.value, observers)
      next = await gen.next()
    }
    return next.value
  } finally {
    try {
      await gen.return(undefined as never)
    } catch {}
  }
}

/**
 * Low-level primitive: drive the engine generator to completion,
 * yielding events and returning the final `EngineResult`. Owns the
 * try/finally that returns the engine generator even if the consumer
 * aborts mid-iteration
 */
export async function* stream<W extends Workspace>(
  backend: ConfiguredBackend,
  config: EngineConfig<W>,
): AsyncGenerator<EngineEvent, EngineResult, unknown> {
  const gen = engine(backend, config)
  try {
    let next = await gen.next()
    while (!next.done) {
      yield next.value
      next = await gen.next()
    }
    return next.value
  } finally {
    try {
      await gen.return(undefined as never)
    } catch {}
  }
}
