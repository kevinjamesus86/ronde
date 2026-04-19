import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createFsRuntime, openFsRuntime } from "../src/index.js"
import {
  initializeJournalState,
  META_FILE,
  SEGMENTS_DIR,
} from "../src/journal.js"
import { useTmp } from "./support.js"

const tmp = useTmp()
const homeCreated: string[] = []
afterEach(() => tmp.cleanup())
afterEach(async () => {
  while (homeCreated.length > 0) {
    await fs.rm(homeCreated.pop()!, { recursive: true, force: true })
  }
})

async function seedFsRuntimeDir(
  dir: string,
  id = "runtime-seed",
): Promise<void> {
  const now = new Date().toISOString()
  await fs.mkdir(path.join(dir, "segments"), { recursive: true })
  await fs.mkdir(path.join(dir, "tool-results"), { recursive: true })
  await fs.writeFile(path.join(dir, "segments", "00000001.jsonl"), "", "utf8")
  await initializeJournalState(dir, {
    v: 1,
    id,
    createdAt: now,
    activeGeneration: 1,
  })
}

async function spawnLeaseHolder(runtimeDir: string) {
  const lockUrl = pathToFileURL(
    path.resolve(process.cwd(), "packages/lock/index.js"),
  ).href
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { tryAcquire } from ${JSON.stringify(lockUrl)}
        import path from "node:path"
        try {
          const lock = tryAcquire(path.join(${JSON.stringify(runtimeDir)}, "writer.lock"))
          process.stdout.write("ACQUIRED\\n")
          setInterval(() => void lock, 1000)
        } catch (error) {
          process.stderr.write(String(error))
          process.exit(1)
        }
      `,
    ],
    { cwd: process.cwd() },
  )
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d.toString()))
  await new Promise<void>((resolve, reject) => {
    let stdout = ""
    child.stdout.on("data", (d) => {
      stdout += d.toString()
      if (stdout.includes("ACQUIRED")) {
        resolve()
      }
    })
    child.on("error", reject)
    child.on("exit", (code) =>
      reject(
        new Error(
          `lease holder exited prematurely (${code}). stderr: ${stderr}`,
        ),
      ),
    )
  })
  return child
}

async function tryAcquireInChild(runtimeDir: string): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const lockUrl = pathToFileURL(
    path.resolve(process.cwd(), "packages/lock/index.js"),
  ).href
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { tryAcquire } from ${JSON.stringify(lockUrl)}
          import path from "node:path"
          try {
            const lock = tryAcquire(path.join(${JSON.stringify(runtimeDir)}, "writer.lock"))
            process.stdout.write("ACQUIRED\\n")
            lock.release()
          } catch (error) {
            process.stderr.write(String(error))
            process.exit(1)
          }
        `,
      ],
      { cwd: process.cwd() },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

describe("@ronde/fs createFsRuntime", () => {
  it("creates the initial metadata ledger, segment, and tool-results directory", async () => {
    const dir = path.join(tmp.dir(), "runtime")

    const runtime = await createFsRuntime(dir)

    expect(runtime.journal.id).toBe(runtime.workspace.id)
    await expect(fs.access(path.join(dir, META_FILE))).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(dir, SEGMENTS_DIR, "00000001.jsonl")),
    ).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(dir, "tool-results")),
    ).resolves.toBeUndefined()
  })

  it("fails when the target runtime directory already exists", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await fs.mkdir(dir, { recursive: true })

    await expect(createFsRuntime(dir)).rejects.toThrow(/already exists/i)
  })

  it("stages creation in a temp directory before renaming into place", async () => {
    const parent = tmp.dir()
    const dir = path.join(parent, "runtime")

    await createFsRuntime(dir)

    const entries = await fs.readdir(parent)
    expect(entries).toEqual(["runtime"])
  })
})

describe("@ronde/fs openFsRuntime", () => {
  it("opens an existing runtime without creating missing paths", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const created = await createFsRuntime(dir)

    const opened = await openFsRuntime(dir)

    expect(opened.journal.id).toBe(created.journal.id)
  })

  it("validates the active segment named by the metadata ledger", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    await fs.rm(path.join(dir, SEGMENTS_DIR, "00000001.jsonl"))

    await expect(openFsRuntime(dir)).rejects.toThrow()
  })

  it("expands ~ prefixes before resolving the runtime directory", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-home-runtime-"))
    homeCreated.push(dir)
    await seedFsRuntimeDir(dir)

    const tildePath = path.join("~", path.relative(os.homedir(), dir))
    const opened = await openFsRuntime(tildePath)

    expect(opened.journal.dir).toBe(dir)
    expect(opened.workspace.dir).toBe(dir)
  })
})

describe("@ronde/fs writer lease and reentrancy", () => {
  it("takes an exclusive writer lock per runtime directory", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await createFsRuntime(dir)

    const result = await tryAcquireInChild(dir)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("LOCKED")
  })

  it("fails when another process already holds the writer lock", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await seedFsRuntimeDir(dir)
    const holder = await spawnLeaseHolder(dir)

    try {
      await expect(openFsRuntime(dir)).rejects.toThrow(/active writer lease/i)
    } finally {
      holder.kill("SIGKILL")
      await new Promise((resolve) => holder.on("exit", resolve))
    }
  })

  it("returns the same journal and workspace instances for same-process reopens", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    const first = await createFsRuntime(dir)
    const second = await openFsRuntime(dir)

    expect(second.journal).toBe(first.journal)
    expect(second.workspace).toBe(first.workspace)
  })

  it("repoints cached handles when the same inode is reopened via a new path", async () => {
    const parent = tmp.dir()
    const dir = path.join(parent, "runtime")
    const moved = path.join(parent, "moved")
    const runtime = await createFsRuntime(dir)
    await fs.rename(dir, moved)

    const reopened = await openFsRuntime(moved)

    expect(reopened.journal).toBe(runtime.journal)
    expect(reopened.workspace).toBe(runtime.workspace)
    expect(reopened.journal.dir).toBe(moved)
    expect(reopened.workspace.dir).toBe(moved)
  })

  it("serializes concurrent first-opens through the in-flight cache", async () => {
    const dir = path.join(tmp.dir(), "runtime")
    await createFsRuntime(dir)

    const [a, b] = await Promise.all([openFsRuntime(dir), openFsRuntime(dir)])

    expect(a.journal).toBe(b.journal)
    expect(a.workspace).toBe(b.workspace)
  })
})
