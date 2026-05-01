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
 */
export abstract class Workspace {
  /** Stable unique ID shared with the paired journal when applicable. */
  abstract readonly id: string
  abstract readonly kind: string
  /** Persist content and return a URI. */
  abstract spill(content: string, opts?: SpillOpts): Promise<SpillResult>
}

/**
 * Workspace capability for backends that expose a concrete local
 * directory. Tools that need to splice the workspace's spill
 * landing site into a path jail check for this.
 */
export abstract class DirectoryWorkspace extends Workspace {
  abstract readonly dir: string
}

export function isDirectoryWorkspace(
  workspace: Workspace,
): workspace is DirectoryWorkspace {
  return "dir" in workspace && typeof workspace.dir === "string"
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
