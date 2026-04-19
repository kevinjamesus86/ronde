import fs from "node:fs"
import path from "node:path"

function resolveReal(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

type PathResult = { ok: true; path: string } | { ok: false; error: string }

export interface PathSpec {
  path: string
  access: "r" | "rw"
}

export function ro(p: string): PathSpec {
  return { path: p, access: "r" }
}

export function rw(p: string): PathSpec {
  return { path: p, access: "rw" }
}

/** Bare strings default to rw. Use {@link ro}/{@link rw} to be explicit. */
export type RootSpec = string | PathSpec

function normalizeRoot(root: RootSpec): {
  resolved: string
  access: "r" | "rw"
} {
  if (typeof root === "string") {
    return { resolved: resolveReal(root), access: "rw" }
  }
  return { resolved: resolveReal(root.path), access: root.access }
}

/**
 * Jails paths to a set of root directories. Resolves symlinks through
 * realpath before enforcing boundaries, so a symlink inside a root that
 * escapes to an outside target is rejected.
 */
export class PathContext {
  private _roots: Map<string, "r" | "rw">

  constructor(roots: RootSpec[]) {
    this._roots = new Map(
      roots.map((r) => {
        const n = normalizeRoot(r)
        return [n.resolved, n.access]
      }),
    )
  }

  get roots(): string[] {
    return [...this._roots.keys()]
  }

  get writableRoots(): string[] {
    return [...this._roots.entries()]
      .filter(([, access]) => access === "rw")
      .map(([dir]) => dir)
  }

  addRoot(root: RootSpec): void {
    const n = normalizeRoot(root)
    this._roots.set(n.resolved, n.access)
  }

  removeRoot(root: RootSpec): void {
    const n = normalizeRoot(root)
    this._roots.delete(n.resolved)
  }

  cloneWithRoot(root: RootSpec): PathContext {
    const clone = new PathContext([])
    clone._roots = new Map(this._roots)
    clone.addRoot(root)
    return clone
  }

  /** Path is inside any declared root. */
  safePath(filePath: string, argName = "file_path"): PathResult {
    return this._resolve(filePath, argName)
  }

  /** Any declared root permits reads, so this is equivalent to {@link safePath}. */
  safeRead(filePath: string, argName = "file_path"): PathResult {
    return this._resolve(filePath, argName)
  }

  /** Path is inside an `rw` root. Read-only roots are rejected. */
  safeWrite(filePath: string, argName = "file_path"): PathResult {
    const check = this._resolve(filePath, argName)
    if (!check.ok) {
      return check
    }
    const access = this._accessFor(check.path)
    if (access !== "rw") {
      return {
        ok: false,
        error: `${argName} is in a read-only path: ${filePath}`,
      }
    }
    return check
  }

  canRead(filePath: string): boolean {
    return this.safeRead(filePath).ok
  }

  canWrite(filePath: string): boolean {
    return this.safeWrite(filePath).ok
  }

  safeDirectoryPath(dirPath: string, argName = "path"): PathResult {
    const check = this.safePath(dirPath, argName)
    if (!check.ok) {
      return check
    }
    if (!fs.existsSync(check.path)) {
      return {
        ok: false,
        error: `Directory not found: ${dirPath}`,
      }
    }
    const stat = fs.statSync(check.path)
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `Not a directory: ${dirPath}`,
      }
    }
    return check
  }

  /**
   * Generate a macOS sandbox-exec profile.
   *
   * - `reads`: default `"*"` (unrestricted). `"roots"` restricts
   *   to declared roots + system paths.
   * - `writes`: default `"roots"` (restricted to rw roots).
   *   `"*"` unrestricts.
   * - `network`: default `true` (allowed). `false` denies.
   */
  sandboxProfile(options?: {
    reads?: "roots" | "*"
    writes?: "roots" | "*"
    network?: boolean
  }): string {
    // Carve-outs required for real shell tooling: `/` literal for dyld,
    // system libraries, standard utilities, device files, and temp dirs.
    const sysRead = [
      '(literal "/")',
      '(subpath "/bin")',
      '(subpath "/dev")',
      '(subpath "/etc")',
      '(subpath "/Library")',
      '(subpath "/opt")',
      '(subpath "/private")',
      '(subpath "/sbin")',
      '(subpath "/System")',
      '(subpath "/usr")',
      '(subpath "/var")',
    ].join(" ")
    const sysWrite = [
      '(subpath "/dev")',
      '(subpath "/private/tmp")',
      '(subpath "/private/var/folders")',
    ].join(" ")
    const rules = ["(version 1)", "(allow default)"]

    if (options?.reads === "roots") {
      const subpaths = this.roots.map((dir) => `(subpath "${dir}")`).join(" ")
      rules.push("(deny file-read*)")
      rules.push("(allow file-read-metadata)")
      rules.push(`(allow file-read* ${subpaths} ${sysRead})`)
    }

    if (options?.writes !== "*") {
      const subpaths = this.writableRoots
        .map((dir) => `(subpath "${dir}")`)
        .join(" ")
      rules.push("(deny file-write*)")
      rules.push(`(allow file-write* ${subpaths} ${sysWrite})`)
    }

    if (options?.network === false) {
      rules.push("(deny network*)")
    }

    return rules.join("\n")
  }

  private _resolve(filePath: string, argName: string): PathResult {
    if (!path.isAbsolute(filePath)) {
      return {
        ok: false,
        error: `${argName} must be absolute, got relative path: ${filePath}`,
      }
    }
    const resolved = path.resolve(filePath)
    let real: string
    try {
      real = fs.realpathSync(resolved)
    } catch {
      let ancestor = path.dirname(resolved)
      let tail = path.basename(resolved)
      while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
        tail = path.join(path.basename(ancestor), tail)
        ancestor = path.dirname(ancestor)
      }
      try {
        real = path.join(fs.realpathSync(ancestor), tail)
      } catch {
        real = resolved
      }
    }

    const allowed = [...this._roots.keys()].some(
      (dir) => real === dir || real.startsWith(dir + path.sep),
    )
    if (!allowed) {
      return {
        ok: false,
        error: `${argName} escapes allowed directories: ${filePath}`,
      }
    }
    return { ok: true, path: real }
  }

  private _accessFor(resolvedPath: string): "r" | "rw" | null {
    for (const [dir, access] of this._roots) {
      if (resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)) {
        return access
      }
    }
    return null
  }
}
