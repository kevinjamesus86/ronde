import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { genHex } from "@ronde/core/id"
import {
  sanitizeFilename,
  type SpillOpts,
  type SpillResult,
  Workspace,
} from "@ronde/core/workspace"
import { rebase } from "./internal.js"

export const TOOL_RESULTS_DIR = "tool-results"

export class FsWorkspace extends Workspace {
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

  async spill(
    content: string | Uint8Array,
    o: SpillOpts = {},
  ): Promise<SpillResult> {
    const isText = typeof content === "string"
    const base = sanitizeFilename(o.name ?? "") || `spill-${genHex()}`
    const ext = extensionFor(o.mediaType, isText)
    const name = `${base}${ext}`
    const full = path.join(this.dir, TOOL_RESULTS_DIR, name)
    await fs.mkdir(path.dirname(full), { recursive: true })
    if (isText) {
      await fs.writeFile(full, content, "utf-8")
      return {
        uri: pathToFileURL(full).href,
        bytes: Buffer.byteLength(content, "utf-8"),
      }
    }
    await fs.writeFile(full, content)
    return {
      uri: pathToFileURL(full).href,
      bytes: content.byteLength,
    }
  }
}

/**
 * Pick a file extension from a mediaType. Falls back to `.txt` for
 * text content without a mediaType, `.bin` for binary content
 * without one. Common types get readable extensions; everything
 * else uses the subtype after `/`.
 */
function extensionFor(mediaType: string | undefined, isText: boolean): string {
  if (!mediaType) {
    return isText ? ".txt" : ".bin"
  }
  const known: Record<string, string> = {
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
  }
  if (known[mediaType]) {
    return known[mediaType]
  }
  const slash = mediaType.indexOf("/")
  if (slash > 0 && slash < mediaType.length - 1) {
    const sub = mediaType
      .slice(slash + 1)
      .split(";")[0]!
      .trim()
    if (/^[a-z0-9.-]+$/i.test(sub)) {
      return `.${sub}`
    }
  }
  return isText ? ".txt" : ".bin"
}
