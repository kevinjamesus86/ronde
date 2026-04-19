/**
 * @module
 * Discriminated result type with `ok()` and `err()` constructors.
 *
 * @example
 * ```ts
 * import { ok, err } from "@ronde/core/result"
 *
 * fetchWeather(city).then(ok).catch(err)
 * ```
 */

export type Result<D = unknown> =
  | { ok: true; data: D }
  | { ok: false; error: string; data?: D }

export function ok<D>(data: D): Result<D> & { ok: true } {
  return { ok: true, data }
}

/** Construct a failure result. Accepts a string or Error. */
export function err(error: string | Error): Result<never> & { ok: false }
export function err<D>(
  error: string | Error,
  data: D,
): Result<D> & { ok: false }
export function err(error: string | Error, data?: unknown): Result<any> {
  const message = error instanceof Error ? error.message : String(error)
  if (data !== undefined) {
    return { ok: false, error: message, data }
  }
  return { ok: false, error: message }
}

export function isOk<D>(r: Result<D>): r is Result<D> & { ok: true } {
  return r.ok === true
}
