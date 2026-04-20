import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { genHex } from "@ronde/core/id"
import {
  DirectoryWorkspace,
  type PathSpillResult,
  sanitizeFilename,
  type SpillOpts,
} from "@ronde/core/workspace"
import { rebase } from "./internal.js"

export const TOOL_RESULTS_DIR = "tool-results"

export interface FsSpillResult extends PathSpillResult {}

export class FsWorkspace extends DirectoryWorkspace {
  readonly kind = "fs" as const

  // Native-private — unreachable via cast or reflection. Exposed
  // read-only through `dir`.
  #dir: string
  get dir(): string {
    return this.#dir
  }

  constructor(
    readonly id: string,
    dir: string,
  ) {
    super()
    this.#dir = dir
  }

  /** Repoint at the same inode reached via a new path. */
  [rebase](dir: string): void {
    this.#dir = dir
  }

  async spill(content: string, o: SpillOpts = {}): Promise<FsSpillResult> {
    const base = sanitizeFilename(o.name ?? "") || `spill-${genHex()}`
    const name = `${base}.txt`
    const full = path.join(this.dir, TOOL_RESULTS_DIR, name)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
    return {
      path: full,
      uri: pathToFileURL(full).href,
      bytes: Buffer.byteLength(content, "utf-8"),
    }
  }
}
