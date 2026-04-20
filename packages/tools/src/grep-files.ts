import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import { walk } from "./walk.js"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { GrepData, GrepMatch } from "./types.js"
import { fsTool } from "./fs-tool.js"

const HARD_LIMIT = 10_000
const MAX_FILE_SIZE = 1024 * 1024

type GrepArgs = z.infer<typeof parameters>

export interface GrepOptions {
  gitignore?: boolean
}

const parameters = z.object({
  pattern: z.string().describe("ECMAScript (JS) regex pattern to search for"),
  path: z.string().describe("Absolute path to the directory to search"),
  include: z
    .string()
    .default("**/*")
    .describe('Glob filter for files (e.g. "*.ts", "**/*.md")'),
})

/**
 * Search file contents with a JS regex. Skips binary files and files
 * larger than {@link MAX_FILE_SIZE}. Matches are collected up to
 * {@link HARD_LIMIT} and returned grouped by file. Respects
 * `.gitignore` by default.
 */
export const grepFiles = (pathCtx: PathContext, opts: GrepOptions = {}) =>
  fsTool({
    name: "grep_files",
    description:
      "Search file contents using a regex. Returns matching lines" +
      " grouped by file.",
    parameters,
    execute: (args, ctx) =>
      grep(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
    format,
  })

async function grep(pathCtx: PathContext, opts: GrepOptions, args: GrepArgs) {
  const check = pathCtx.safeDirectoryPath(args.path, "path")
  if (!check.ok) {
    return err(check.error)
  }
  const base = check.path

  let regex: RegExp
  try {
    regex = new RegExp(args.pattern)
  } catch (e) {
    return err(`Invalid regex: ${(e as Error).message}`)
  }
  if (regex.test("")) {
    return err("Pattern matches empty string — too broad.")
  }

  const files = await walk({
    cwd: base,
    pattern: args.include,
    gitignore: opts.gitignore,
  })

  const allMatches: GrepMatch[] = []
  const matchedFiles = new Set<string>()

  outer: for (const rel of files) {
    const full = path.join(base, rel)
    try {
      const stat = await fs.stat(full)
      if (stat.size > MAX_FILE_SIZE) {
        continue
      }
      const buf = await fs.readFile(full)
      if (buf.includes(0)) {
        continue
      }
      const lines = buf.toString("utf-8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          allMatches.push({ file: rel, line: i + 1, text: lines[i]! })
          matchedFiles.add(rel)
          if (allMatches.length >= HARD_LIMIT) {
            break outer
          }
        }
      }
    } catch {}
  }

  return ok<GrepData>({
    matches: allMatches,
    fileCount: matchedFiles.size,
    totalMatches: allMatches.length,
  })
}

function format(data: GrepData): string {
  if (data.matches.length === 0) {
    return "No matches."
  }
  const byFile = new Map<string, string[]>()
  for (const m of data.matches) {
    let arr = byFile.get(m.file)
    if (!arr) {
      arr = []
      byFile.set(m.file, arr)
    }
    arr.push(`${m.line}: ${m.text}`)
  }
  const sections: string[] = []
  for (const [file, lines] of byFile) {
    sections.push(`## ${file}\n${lines.join("\n")}`)
  }
  return sections.join("\n\n")
}
