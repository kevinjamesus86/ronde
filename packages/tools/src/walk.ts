/**
 * @module
 * Shared file traversal backed by tinyglobby + ignore.
 *
 * Nested `.gitignore` handling: walks up from `cwd` to the repo root
 * (nearest `.git`), then loads every `.gitignore` from the root down
 * with each rule scoped to its containing directory.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { glob } from "tinyglobby"
import ignore, { type Ignore } from "ignore"

export interface WalkOptions {
  cwd: string
  pattern?: string
  deep?: number
  onlyFiles?: boolean
  gitignore?: boolean
}

/** Walk up from `cwd` to the nearest `.git`. Returns `cwd` if none found. */
async function findRepoRoot(cwd: string): Promise<string> {
  let dir = cwd
  while (true) {
    try {
      const stat = await fs.stat(path.join(dir, ".git"))
      if (stat.isDirectory() || stat.isFile()) {
        return dir
      }
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) {
      return cwd
    }
    dir = parent
  }
}

/** Prefix every pattern in a `.gitignore` with its directory scope. */
function scopePatterns(content: string, scope: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) {
        return ""
      }
      if (scope === "") {
        return trimmed
      }
      const negate = trimmed.startsWith("!")
      const pat = negate ? trimmed.slice(1) : trimmed
      const clean = pat.startsWith("/") ? pat.slice(1) : pat
      return `${negate ? "!" : ""}${scope}/${clean}`
    })
    .filter(Boolean)
    .join("\n")
}

/** Collect every `.gitignore` under `repoRoot`, each scoped to its directory. */
async function loadNestedGitignores(
  repoRoot: string,
  searchCwd: string,
): Promise<Ignore> {
  const ig = ignore()
  ig.add([".git", "node_modules"])

  const files = await glob("**/.gitignore", {
    cwd: repoRoot,
    dot: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  })

  // Parents before children so deeper negations override.
  for (const rel of files.sort()) {
    const dir = path.dirname(rel)
    try {
      const content = await fs.readFile(path.join(repoRoot, rel), "utf-8")
      // Scope relative to searchCwd (the walk base), not repoRoot —
      // the filter runs against paths emitted by the walk.
      const scope = path.relative(
        searchCwd,
        path.join(repoRoot, dir === "." ? "" : dir),
      )
      if (scope.startsWith("..")) {
        continue
      }
      ig.add(scopePatterns(content, scope))
    } catch {}
  }

  return ig
}

export async function walk(opts: WalkOptions): Promise<string[]> {
  const { cwd, pattern = "**/*", deep, onlyFiles = true } = opts

  const results = await glob(pattern, {
    cwd,
    deep,
    dot: false,
    onlyFiles,
    onlyDirectories: false,
    followSymbolicLinks: false,
    expandDirectories: false,
  })

  if (opts.gitignore === false) {
    return results.sort()
  }

  const repoRoot = await findRepoRoot(cwd)
  const ig = await loadNestedGitignores(repoRoot, cwd)
  return ig.filter(results).sort()
}
