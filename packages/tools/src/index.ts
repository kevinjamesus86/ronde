/**
 * @module
 * Core filesystem and shell tools with path sandboxing.
 *
 * @example
 * ```ts
 * import { coreTools } from "@ronde/tools";
 *
 * const toolkit = coreTools({ roots: [process.cwd()] });
 * ```
 */
import { merge, type Toolkit } from "@ronde/core/toolkit"
import { PathContext, ro } from "./context.js"
import { readFile } from "./read-file.js"
import { writeFile } from "./write-file.js"
import { editFile } from "./edit-file.js"
import { globFiles } from "./glob-files.js"
import { grepFiles } from "./grep-files.js"
import { listDirectory } from "./list-directory.js"
import { shell, type SandboxConfig } from "./shell.js"
import type { Snapshot } from "./shell-snapshot.js"
import type { Workspace } from "@ronde/core/workspace"

export type { SandboxConfig } from "./shell.js"
export type { Snapshot, ShellKind } from "./shell-snapshot.js"

export interface CoreToolsOptions {
  roots: (string | import("./context.js").PathSpec)[]
  /** Respect .gitignore in traversal tools (glob, grep, list). Default: true. */
  gitignore?: boolean
  shell?: {
    cwd?: string
    sandbox?: boolean | SandboxConfig
    snapshot?: boolean | Snapshot
  }
}

/**
 * Assemble the 7 core tools over one shared `PathContext`. The same
 * `roots` config drives file access and the seatbelt profile.
 *
 * For finer control, compose the individual tool factories directly
 * with `merge()`.
 */
export function coreTools(opts: CoreToolsOptions): Toolkit<Workspace> {
  if (opts.roots.length === 0) {
    throw new Error("coreTools requires at least one root.")
  }

  const pathCtx = new PathContext(opts.roots)
  const shellOpts = opts.shell ?? {}

  if (shellOpts.cwd) {
    if (!pathCtx.canRead(shellOpts.cwd)) {
      throw new Error(
        `shell.cwd "${shellOpts.cwd}" is not within any declared root.`,
      )
    }
    const cwdCheck = pathCtx.safeDirectoryPath(shellOpts.cwd, "shell.cwd")
    if (!cwdCheck.ok) {
      throw new Error(cwdCheck.error)
    }
  }

  const gitignore = opts.gitignore ?? true

  return merge(
    readFile(pathCtx),
    writeFile(pathCtx),
    editFile(pathCtx),
    globFiles(pathCtx, { gitignore }),
    grepFiles(pathCtx, { gitignore }),
    listDirectory(pathCtx, { gitignore }),
    shell(pathCtx, {
      cwd: shellOpts.cwd,
      sandbox: shellOpts.sandbox ?? true,
      snapshot: shellOpts.snapshot ?? true,
    }),
  )
}

export {
  readFile,
  writeFile,
  editFile,
  globFiles,
  grepFiles,
  listDirectory,
  shell,
}

export { PathContext, ro, rw, type PathSpec, type RootSpec } from "./context.js"

export type {
  ReadFileData,
  WriteFileData,
  EditFileData,
  GlobData,
  GrepData,
  GrepMatch,
  ListDirectoryData,
  ListDirectoryEntry,
  ShellData,
} from "./types.js"
