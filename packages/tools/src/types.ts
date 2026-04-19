export interface ReadFileData {
  path: string
  /** Content for the requested window; individual lines may be truncated. */
  content: string
  totalLines: number
  /** 1-indexed, inclusive. */
  startLine: number
  /** 1-indexed, inclusive. */
  endLine: number
  /** True when the returned window doesn't cover the whole file. */
  truncated: boolean
}

export interface WriteFileData {
  path: string
  bytesWritten: number
}

export interface EditFileData {
  path: string
}

export interface GlobData {
  matches: string[]
  totalMatches: number
  truncated: boolean
}

export interface GrepMatch {
  file: string
  line: number
  text: string
}

export interface GrepData {
  /** Inline preview — first N matches. */
  matches: GrepMatch[]
  fileCount: number
  /** Total matches found, capped at a hard search limit. */
  totalMatches: number
  /** True when more matches exist than the inline preview contains. */
  truncated: boolean
  /** Full match list (`file:line: text` lines) spilled to the workspace. */
  fullMatchesPath?: string
}

export interface ListDirectoryEntry {
  name: string
  type: "file" | "directory"
  sizeBytes?: number
}

export interface ListDirectoryData {
  path: string
  entries: ListDirectoryEntry[]
  truncated: boolean
}

export interface ShellData {
  exitCode: number
  /** Middle-truncated (head+tail) when the full output exceeds the inline cap. */
  stdout: string
  stderr: string
  /** True when `stdout` is a preview and full output was spilled. */
  truncated: boolean
  /** Full output spilled to the workspace when `truncated` is true. */
  fullStdoutPath?: string
  /** Total bytes produced by the command, including any spilled output. */
  totalBytes: number
}
