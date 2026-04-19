import fs from "node:fs/promises"
import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { ReadFileData } from "./types.js"
import { fsTool } from "./fs-tool.js"

const DEFAULT_LIMIT = 2000
const MAX_LINE_CHARS = 2000

type ReadArgs = z.infer<typeof parameters>

const parameters = z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  offset: z
    .number()
    .min(1)
    .default(1)
    .describe("First line to read (1-indexed). Default: 1."),
  limit: z
    .number()
    .min(1)
    .default(DEFAULT_LIMIT)
    .describe(
      `Max lines to read. Default: ${DEFAULT_LIMIT}. Individual lines` +
        ` longer than ${MAX_LINE_CHARS} chars are truncated.`,
    ),
})

/**
 * Read a file with 1-indexed line pagination. Defaults to the first
 * {@link DEFAULT_LIMIT} lines; page larger files with `offset`/`limit`.
 * Individual lines over {@link MAX_LINE_CHARS} chars are truncated.
 */
export const readFile = (pathCtx: PathContext) =>
  fsTool({
    name: "read_file",
    description:
      "Read a file's contents. Returns up to `limit` lines (default 2000)" +
      " starting at `offset` (default 1, 1-indexed). Output is formatted" +
      " with line numbers.",
    parameters,
    execute: (args, ctx) =>
      read(pathContextForWorkspace(pathCtx, ctx.workspace), args),
    format,
  })

async function read(pathCtx: PathContext, args: ReadArgs) {
  const check = pathCtx.safeRead(args.file_path)
  if (!check.ok) {
    return err(check.error)
  }
  let raw: string
  try {
    raw = await fs.readFile(check.path, "utf-8")
  } catch (e) {
    return err(
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? `File not found: ${args.file_path}`
        : (e as Error).message,
    )
  }

  const allLines = raw.split("\n")
  // Drop the trailing empty element `split` produces for "…\n" so
  // totalLines matches user intuition ('a\nb\n' has 2 lines, not 3).
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop()
  }
  const totalLines = allLines.length
  const offset = args.offset
  const limit = args.limit

  if (offset > totalLines) {
    return ok<ReadFileData>({
      path: check.path,
      content: "",
      totalLines,
      startLine: offset,
      endLine: offset - 1,
      truncated: true,
    })
  }

  const startLine = offset
  const endLine = Math.min(offset + limit - 1, totalLines)
  const slice = allLines
    .slice(startLine - 1, endLine)
    .map((line) =>
      line.length > MAX_LINE_CHARS
        ? line.slice(0, MAX_LINE_CHARS) + "… [line truncated]"
        : line,
    )
  const truncated = endLine < totalLines || offset > 1

  return ok<ReadFileData>({
    path: check.path,
    content: slice.join("\n"),
    totalLines,
    startLine,
    endLine,
    truncated,
  })
}

function format(data: ReadFileData): string {
  if (data.totalLines === 0) {
    return "(empty file)"
  }
  if (data.content === "") {
    return (
      `(no lines in range — file has ${data.totalLines} lines.` +
      ` Use a smaller offset to read.)`
    )
  }
  const width = String(data.endLine).length
  const lines = data.content.split("\n").map((line, i) => {
    const n = String(data.startLine + i).padStart(width, " ")
    return `${n}→${line}`
  })
  let out = lines.join("\n")
  if (data.truncated) {
    out +=
      `\n\n[Showing lines ${data.startLine}-${data.endLine} of ${data.totalLines}.` +
      ` Use offset/limit to read other ranges.]`
  }
  return out
}
