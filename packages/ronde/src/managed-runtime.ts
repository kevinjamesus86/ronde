import fs from "node:fs/promises"
import syncFs from "node:fs"
import type { Dirent } from "node:fs"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  createFsRuntime,
  openFsRuntime,
  statFsRuntime,
  type FsRuntime,
  type FsRuntimeStat,
} from "@ronde/fs"
import type { Runtime } from "@ronde/core/runtime"

export type { FsRuntime, Runtime }

export interface ManagedRuntimeOptions {
  root?: string
  project?: string
  name?: string
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

function rondeHome(root?: string): string {
  if (root) {
    return expandTilde(root)
  }
  const env = process.env["RONDE_HOME"]
  if (env) {
    return expandTilde(env)
  }
  const home = os.homedir()
  try {
    syncFs.accessSync(home, syncFs.constants.W_OK)
    return path.join(home, ".ronde")
  } catch {
    return path.join(os.tmpdir(), ".ronde")
  }
}

function slugifyProjectKey(project: string): string {
  // eslint-disable-next-line no-control-regex
  return project.replace(/[\\/:*?"<>| \x00-\x1f]/g, "-")
}

function managedProjectDir(root: string | undefined, project: string): string {
  return path.join(rondeHome(root), "projects", slugifyProjectKey(project))
}

function newRuntimeId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`
}

function sanitizeManagedName(name: string, max = 200): string {
  let safe = ""
  for (const char of name) {
    const code = char.charCodeAt(0)
    if (
      char === "\\" ||
      char === "/" ||
      char === ":" ||
      char === "*" ||
      char === "?" ||
      char === '"' ||
      char === "<" ||
      char === ">" ||
      char === "|" ||
      char === " " ||
      (code >= 0x00 && code <= 0x1f)
    ) {
      safe += "_"
      continue
    }
    safe += char
  }
  safe = safe.replace(/^_+|_+$/g, "")
  return safe.slice(0, max)
}

type ManagedRuntimeMeta = {
  dir: string
  stat: FsRuntimeStat
}

async function readManagedState(dir: string): Promise<ManagedRuntimeMeta> {
  const stat = await statFsRuntime(dir)
  return {
    dir,
    stat,
  }
}

export async function createManagedRuntime(
  opts: ManagedRuntimeOptions = {},
): Promise<FsRuntime> {
  const projectDir = resolveManagedProjectDir(opts)

  if (opts.name !== undefined) {
    const entryName = toManagedEntryName(opts.name)
    return createFsRuntime(path.join(projectDir, entryName))
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const entryName = newRuntimeId()
    try {
      return await createFsRuntime(path.join(projectDir, entryName))
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error
      }
    }
  }

  throw new Error("Failed to allocate a fresh managed runtime directory.")
}

/**
 * Open an existing managed fs-backed runtime.
 *
 * Named mode opens `<root>/projects/<project>/<name>/`. Unnamed mode
 * selects the latest valid runtime under that project bucket using
 * active-segment mtime, then `createdAt`, then `id`.
 */
export async function openRuntime(
  opts?: ManagedRuntimeOptions,
): Promise<FsRuntime>

export async function openRuntime(
  name: string,
  opts?: Omit<ManagedRuntimeOptions, "name">,
): Promise<FsRuntime>

export async function openRuntime(
  nameOrOpts: string | ManagedRuntimeOptions = {},
  maybeOpts: Omit<ManagedRuntimeOptions, "name"> = {},
): Promise<FsRuntime> {
  const opts =
    typeof nameOrOpts === "string"
      ? { ...maybeOpts, name: nameOrOpts }
      : nameOrOpts

  const projectDir = resolveManagedProjectDir(opts)
  const targetDir =
    opts.name !== undefined
      ? path.join(projectDir, toManagedEntryName(opts.name))
      : await latestManagedRuntimeDir(projectDir)

  return openFsRuntime(targetDir)
}

async function latestManagedRuntimeDir(projectDir: string): Promise<string> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true })
  } catch {
    throw new Error(`No runtimes found in ${projectDir}.`)
  }

  const candidates: ManagedRuntimeMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = path.join(projectDir, entry.name)
    try {
      candidates.push(await readManagedState(dir))
    } catch {
      // Ignore non-runtime directories or corrupted candidates.
    }
  }

  candidates.sort(compareManagedRuntimeMetaDesc)
  if (candidates.length === 0) {
    throw new Error(`No runtimes found in ${projectDir}.`)
  }

  return candidates[0]!.dir
}

function compareManagedRuntimeMetaDesc(
  a: ManagedRuntimeMeta,
  b: ManagedRuntimeMeta,
): number {
  const byMtime = b.stat.mtime - a.stat.mtime
  if (byMtime !== 0) {
    return byMtime
  }

  const byCreated = compareIsoDesc(a.stat.createdAt, b.stat.createdAt)
  if (byCreated !== 0) {
    return byCreated
  }

  return b.stat.id.localeCompare(a.stat.id)
}

function compareIsoDesc(a: string, b: string): number {
  return b.localeCompare(a)
}

function resolveManagedProjectDir(opts: ManagedRuntimeOptions): string {
  const project = opts.project ?? process.cwd()
  if (!project) {
    throw new Error('Managed runtime "project" must not be empty.')
  }
  return managedProjectDir(opts.root, project)
}

function toManagedEntryName(name: string): string {
  const entry = sanitizeManagedName(name, 240)
  if (!entry || entry === "." || entry === "..") {
    throw new Error(`Invalid managed runtime name: "${name}"`)
  }
  return entry
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  )
}
