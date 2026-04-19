/**
 * @module
 * Workspace primitive. A Workspace owns artifact spill URIs and
 * run-associated resources.
 */

export interface SpillOpts {
  /** Filename stem or resource label. Default: `"spill"`. */
  name?: string
  /** Chars from the start to include in the inline preview. Default: 2000. */
  previewHead?: number
  /** Chars from the end to include in the inline preview. Default: 1000. */
  previewTail?: number
}

export interface SpillResult {
  /** Opaque URI for the full content. */
  uri: string
  /** Inline preview (head + marker + tail, or full content if small enough). */
  preview: string
  /** True if the content was larger than the preview window. */
  truncated: boolean
  bytes: number
}

/** Spill result for workspaces that persist content to a local path. */
export interface PathSpillResult extends SpillResult {
  path: string
}

/**
 * Base workspace abstraction. Portable tools should target this
 * interface and rely on `spill()` rather than filesystem details.
 */
export abstract class Workspace<R extends SpillResult = SpillResult> {
  /** Stable unique ID shared with the paired journal when applicable. */
  abstract readonly id: string
  abstract readonly kind: string
  /** Persist large content and return a URI plus preview. */
  abstract spill(content: string, opts?: SpillOpts): Promise<R>
}

/**
 * Workspace capability for backends that expose a concrete directory
 * and pathful spill results.
 */
export abstract class DirectoryWorkspace extends Workspace<PathSpillResult> {
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

/**
 * Build an inline preview: `<head>\n\n[...N truncated...]\n\n<tail>`.
 * Returns the content unchanged if it fits within `head + tail`.
 */
export function makePreview(
  content: string,
  head: number,
  tail: number,
): string {
  if (content.length <= head + tail) {
    return content
  }
  const h = content.slice(0, head)
  const t = content.slice(-tail)
  const omitted = content.length - head - tail
  return `${h}\n\n[... ${omitted} characters truncated ...]\n\n${t}`
}
