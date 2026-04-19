import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tryAcquire, type FileLock } from "@ronde/lock"
import { genHex, genId } from "@ronde/core/id"
import {
  FsJournal,
  SEGMENTS_DIR,
  initializeJournalState,
  readJournalState,
  type FsJournalState,
} from "./journal.js"
import { FsWorkspace, TOOL_RESULTS_DIR } from "./workspace.js"
import { rebase } from "./internal.js"
import type { Runtime } from "@ronde/core/runtime"

const WRITER_LOCK_FILE = "writer.lock"

export type FsRuntime = Runtime<FsWorkspace>

export interface FsRuntimeStat {
  id: string
  mtime: number
  createdAt: string
}

function activeSegmentPath(dir: string, generation: number): string {
  return path.join(
    dir,
    SEGMENTS_DIR,
    `${String(generation).padStart(8, "0")}.jsonl`,
  )
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

// Keyed by inode, not path: a FileLock keeps the fd (and kernel lock)
// alive, so renames/symlinks aliasing the same runtime must resolve to
// the same entry. Path-keyed tracking would miss renames and let a
// second acquire hit the kernel, which flock rejects.
//
// Cached alongside the journal+workspace so reentrant opens share one
// reduced metadata state — two FsJournal instances over the same dir
// would diverge on partition, and the stale one would later commit
// against the wrong generation.
interface OwnedFsRuntime {
  lock: FileLock
  runtime: FsRuntime
}
const ownedRuntimes = new Map<string, OwnedFsRuntime>()

// Serializes concurrent first-opens on the same inode. Without this,
// both callers miss the cache and race on tryAcquire; the loser sees a
// same-process flock conflict surfaced as a misleading "another process
// holds the lease" error.
const openInFlight = new Map<string, Promise<FsRuntime>>()

/**
 * Create a new fs-backed runtime at an exact directory. Fails if the
 * target already exists. Creation is staged in a sibling temp dir then
 * renamed into place — the final path never appears partially
 * initialized.
 */
export async function createFsRuntime(dir: string): Promise<FsRuntime> {
  const runtimeDir = resolveFsRuntimeDir(dir)
  const parentDir = path.dirname(runtimeDir)
  const now = new Date().toISOString()
  const state: FsJournalState = {
    v: 1,
    id: genId("rt"),
    createdAt: now,
    activeGeneration: 1,
  }

  await fs.mkdir(parentDir, { recursive: true })
  await assertTargetAbsent(runtimeDir)

  const tempDir = path.join(parentDir, `.ronde-tmp-${state.id}-${genHex()}`)
  try {
    await fs.mkdir(tempDir)
    await fs.mkdir(path.join(tempDir, SEGMENTS_DIR))
    await fs.mkdir(path.join(tempDir, TOOL_RESULTS_DIR))
    await writeFileDurable(
      path.join(tempDir, SEGMENTS_DIR, "00000001.jsonl"),
      "",
    )
    await initializeJournalState(tempDir, state)
    await fs.rename(tempDir, runtimeDir)
    await syncDir(parentDir)
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return openFsRuntime(runtimeDir)
}

/**
 * Open an existing fs-backed runtime at an exact directory. Validates
 * required files; never creates missing paths.
 *
 * Reentrant: a second same-process open returns the cached
 * journal+workspace pair, so every caller sees one reduced metadata
 * state and a partition on one handle is visible on every other.
 */
export async function openFsRuntime(dir: string): Promise<FsRuntime> {
  const runtimeDir = resolveFsRuntimeDir(dir)
  const stat = await fs.stat(runtimeDir)
  const key = `${stat.dev}:${stat.ino}`

  const inflight = openInFlight.get(key)
  if (inflight) {
    await inflight
  }

  const cached = ownedRuntimes.get(key)
  if (cached) {
    // Same inode reached via a new path (rename/symlink). Cached
    // handles follow the inode; repoint them at the current path.
    const journal = cached.runtime.journal as FsJournal
    if (journal.dir !== runtimeDir) {
      journal[rebase](runtimeDir)
      ;(cached.runtime.workspace as FsWorkspace)[rebase](runtimeDir)
    }
    return cached.runtime
  }

  const promise = acquireFsRuntime(runtimeDir, key)
  openInFlight.set(key, promise)
  try {
    return await promise
  } finally {
    openInFlight.delete(key)
  }
}

export async function statFsRuntime(dir: string): Promise<FsRuntimeStat> {
  const runtimeDir = resolveFsRuntimeDir(dir)
  const state = await readJournalState(runtimeDir, "tolerate")
  const stat = await fs.stat(
    activeSegmentPath(runtimeDir, state.activeGeneration),
  )
  return {
    id: state.id,
    mtime: stat.mtimeMs,
    createdAt: state.createdAt,
  }
}

async function acquireFsRuntime(
  runtimeDir: string,
  key: string,
): Promise<FsRuntime> {
  const lock = await acquireWriterLock(runtimeDir)
  try {
    const state = await readJournalState(runtimeDir, "repair")
    await fs.access(activeSegmentPath(runtimeDir, state.activeGeneration))
    const runtime: FsRuntime = {
      journal: new FsJournal(state.id, runtimeDir, state),
      workspace: new FsWorkspace(state.id, runtimeDir),
    }
    ownedRuntimes.set(key, { lock, runtime })
    return runtime
  } catch (error) {
    lock.release()
    throw error
  }
}

function resolveFsRuntimeDir(dir: string): string {
  return path.resolve(expandTilde(dir))
}

async function assertTargetAbsent(dir: string): Promise<void> {
  try {
    await fs.access(dir)
  } catch {
    return
  }
  const error = new Error(
    `Runtime directory already exists: ${dir}`,
  ) as Error & {
    code?: string
  }
  error.code = "EEXIST"
  throw error
}

async function writeFileDurable(filePath: string, body: string): Promise<void> {
  const fh = await fs.open(filePath, "w")
  try {
    await fh.writeFile(body, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function syncDir(dir: string): Promise<void> {
  const fh = await fs.open(dir, "r")
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/**
 * Claim exclusive write access via a kernel advisory lock (flock on
 * Unix, LockFileEx on Windows, both wrapped by `@ronde/lock`). The
 * kernel releases the lock when this process's fd closes — including
 * SIGKILL/OOM/panic — so there is no PID tracking or userspace cleanup.
 *
 * Unconditionally hits the kernel. Reentrancy lives in `ownedRuntimes`;
 * callers must check the cache first.
 */
async function acquireWriterLock(runtimeDir: string): Promise<FileLock> {
  const lockPath = path.join(runtimeDir, WRITER_LOCK_FILE)
  try {
    return tryAcquire(lockPath)
  } catch (error) {
    if ((error as Error).message?.startsWith("LOCKED")) {
      throw new Error(
        `Runtime already has an active writer lease: ${runtimeDir}`,
      )
    }
    throw error
  }
}
