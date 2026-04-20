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
  matches: GrepMatch[]
  fileCount: number
  /** Total matches found, capped at a hard search limit. */
  totalMatches: number
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
  stdout: string
  stderr: string
}
