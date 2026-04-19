//#region packages/core/src/workspace.d.ts
/**
 * @module
 * Workspace primitive. A Workspace owns artifact spill URIs and
 * run-associated resources.
 */
interface SpillOpts {
  /** Filename stem or resource label. Default: `"spill"`. */
  name?: string;
  /** Chars from the start to include in the inline preview. Default: 2000. */
  previewHead?: number;
  /** Chars from the end to include in the inline preview. Default: 1000. */
  previewTail?: number;
}
interface SpillResult {
  /** Opaque URI for the full content. */
  uri: string;
  /** Inline preview (head + marker + tail, or full content if small enough). */
  preview: string;
  /** True if the content was larger than the preview window. */
  truncated: boolean;
  bytes: number;
}
/** Spill result for workspaces that persist content to a local path. */
interface PathSpillResult extends SpillResult {
  path: string;
}
/**
 * Base workspace abstraction. Portable tools should target this
 * interface and rely on `spill()` rather than filesystem details.
 */
declare abstract class Workspace<R extends SpillResult = SpillResult> {
  /** Stable unique ID shared with the paired journal when applicable. */
  abstract readonly id: string;
  abstract readonly kind: string;
  /** Persist large content and return a URI plus preview. */
  abstract spill(content: string, opts?: SpillOpts): Promise<R>;
}
/**
 * Workspace capability for backends that expose a concrete directory
 * and pathful spill results.
 */
declare abstract class DirectoryWorkspace extends Workspace<PathSpillResult> {
  abstract readonly dir: string;
}
declare function isDirectoryWorkspace(workspace: Workspace): workspace is DirectoryWorkspace;
/**
 * Sanitize a filename base for fs use. Replaces characters reserved
 * by Windows or POSIX, plus control characters, with `_`. Trims
 * leading/trailing `_`. Caps at `max` chars. Returns empty string
 * if the input sanitizes to nothing — callers must handle that.
 */
declare function sanitizeFilename(s: string, max?: number): string;
/**
 * Build an inline preview: `<head>\n\n[...N truncated...]\n\n<tail>`.
 * Returns the content unchanged if it fits within `head + tail`.
 */
declare function makePreview(content: string, head: number, tail: number): string;
//#endregion
export { DirectoryWorkspace, PathSpillResult, SpillOpts, SpillResult, Workspace, isDirectoryWorkspace, makePreview, sanitizeFilename };
//# sourceMappingURL=workspace.d.mts.map