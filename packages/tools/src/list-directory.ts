import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import { walk } from "./walk.js"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { ListDirectoryData, ListDirectoryEntry } from "./types.js"
import { fsTool } from "./fs-tool.js"

const MAX_ENTRIES = 500

type ListArgs = z.infer<typeof parameters>

export interface ListOptions {
  gitignore?: boolean
}

const parameters = z.object({
  path: z.string().describe("Absolute path to the directory to list"),
  depth: z
    .number()
    .min(1)
    .max(5)
    .default(1)
    .describe("How deep to traverse. 1 = flat, 2+ = tree."),
})

/**
 * List a directory as a tree. `depth: 1` is a flat listing; up to
 * `depth: 5` for project overviews. Capped at {@link MAX_ENTRIES}.
 * Respects `.gitignore` by default.
 */
export const listDirectory = (pathCtx: PathContext, opts: ListOptions = {}) =>
  fsTool({
    name: "list_directory",
    description:
      "List files and directories as a tree." +
      " Depth 1 = flat listing, up to 5 for project structure." +
      ` Respects .gitignore. Max ${MAX_ENTRIES} entries.`,
    parameters,
    execute: (args, ctx) =>
      list(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
    format,
  })

async function list(pathCtx: PathContext, opts: ListOptions, args: ListArgs) {
  const check = pathCtx.safeDirectoryPath(args.path, "path")
  if (!check.ok) {
    return err(check.error)
  }
  const base = check.path
  const depth = args.depth ?? 1

  const paths = await walk({
    cwd: base,
    pattern: "**/*",
    deep: depth,
    onlyFiles: false,
    gitignore: opts.gitignore,
  })

  const truncated = paths.length > MAX_ENTRIES
  const visible = truncated ? paths.slice(0, MAX_ENTRIES) : paths

  const entries: ListDirectoryEntry[] = await Promise.all(
    visible.map(async (rel) => {
      const isDir = rel.endsWith("/")
      const name = isDir ? rel.slice(0, -1) : rel
      if (isDir) {
        return { name, type: "directory" as const }
      }
      try {
        const stat = await fs.stat(path.join(base, rel))
        return { name, type: "file" as const, sizeBytes: stat.size }
      } catch {
        return { name, type: "file" as const }
      }
    }),
  )

  return ok<ListDirectoryData>({
    path: base,
    entries,
    truncated,
  })
}

function format(data: ListDirectoryData): string {
  if (data.entries.length === 0) {
    return "Empty directory."
  }
  const lines = data.entries.map((e) => {
    const depth = e.name.split("/").length - 1
    const indent = "  ".repeat(depth)
    const base = e.name.split("/").pop()!
    if (e.type === "directory") {
      return `${indent}${base}/`
    }
    const size = e.sizeBytes != null ? ` (${formatSize(e.sizeBytes)})` : ""
    return `${indent}${base}${size}`
  })
  let out = lines.join("\n")
  if (data.truncated) {
    out += `\n\n(truncated — ${MAX_ENTRIES} entries shown)`
  }
  return out
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
