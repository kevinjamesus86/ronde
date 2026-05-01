/**
 * @module
 * Workspace primitive. A Workspace owns artifact spill URIs and
 * run-associated resources.
 */

export interface SpillOpts {
  /** Filename stem or resource label. Default: `"spill"`. */
  name?: string
}

export interface SpillResult {
  /** Opaque URI for the full content. */
  uri: string
  bytes: number
}

/**
 * Base workspace abstraction. Portable tools should target this
 * interface and rely on `spill()` for artifact persistence.
 *
 * Locality (e.g. exposing a concrete fs `dir`) is an
 * implementation-level capability. Tools that need it do a
 * structural check at the call site rather than discriminating on
 * the contract.
 */
export abstract class Workspace {
  /** Stable unique ID shared with the paired journal when applicable. */
  abstract readonly id: string
  abstract readonly kind: string
  /** Persist content and return a URI. */
  abstract spill(content: string, opts?: SpillOpts): Promise<SpillResult>
}

/**
 * Sanitize a filename base for fs use. Replaces characters reserved
 * by Windows or POSIX, plus control characters, with `_`. Trims
 * leading/trailing `_`. Caps at `max` chars. Returns empty string
 * if the input sanitizes to nothing — callers must handle that.
 */
export function sanitizeFilename(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const safe = s.replace(/[\\/:*?"<>| \x00-\x1f]/g, "_").replace(/^_+|_+$/g, "")
  return safe.slice(0, max)
}
