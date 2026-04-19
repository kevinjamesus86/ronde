import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import { walk } from "./walk.js"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { GlobData } from "./types.js"
import { fsTool } from "./fs-tool.js"

const MAX_RESULTS = 500

type GlobArgs = z.infer<typeof parameters>

export interface GlobOptions {
  gitignore?: boolean
}

const parameters = z.object({
  pattern: z
    .string()
    .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")'),
  path: z.string().describe("Absolute path to the directory to search"),
})

/**
 * Find files by glob pattern. Capped at {@link MAX_RESULTS} matches;
 * `.gitignore` is respected by default.
 */
export const globFiles = (pathCtx: PathContext, opts: GlobOptions = {}) =>
  fsTool({
    name: "glob_files",
    description:
      "Find files by glob pattern. Respects .gitignore by default." +
      ` Returns up to ${MAX_RESULTS} matches.`,
    parameters,
    execute: (args, ctx) =>
      run(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
    format,
  })

async function run(pathCtx: PathContext, opts: GlobOptions, args: GlobArgs) {
  const check = pathCtx.safeDirectoryPath(args.path, "path")
  if (!check.ok) {
    return err(check.error)
  }

  const matches = await walk({
    cwd: check.path,
    pattern: args.pattern,
    gitignore: opts.gitignore,
  })

  const truncated = matches.length > MAX_RESULTS
  const results = truncated ? matches.slice(0, MAX_RESULTS) : matches

  return ok<GlobData>({
    matches: results,
    totalMatches: matches.length,
    truncated,
  })
}

function format(data: GlobData): string {
  if (data.matches.length === 0) {
    return "No matches."
  }
  let out = groupByDir(data.matches)
  if (data.truncated) {
    out += `\n\n(${data.totalMatches} total — showing first ${MAX_RESULTS})`
  }
  return out
}

function groupByDir(paths: string[]): string {
  const groups = new Map<string, string[]>()
  for (const p of paths) {
    const slash = p.lastIndexOf("/")
    const dir = slash === -1 ? "" : p.slice(0, slash + 1)
    const file = slash === -1 ? p : p.slice(slash + 1)
    let arr = groups.get(dir)
    if (!arr) {
      arr = []
      groups.set(dir, arr)
    }
    arr.push(file)
  }
  const sections: string[] = []
  for (const [dir, files] of groups) {
    if (dir === "") {
      sections.push(files.join("\n"))
    } else {
      sections.push(`${dir}\n  ${files.join("\n  ")}`)
    }
  }
  return sections.join("\n\n")
}
