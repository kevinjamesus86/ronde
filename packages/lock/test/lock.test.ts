import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { tryAcquire } from "@ronde/lock"

function useTmp() {
  const created: string[] = []

  return {
    file(prefix = "ronde-lock-") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      created.push(dir)
      return path.join(dir, "lockfile")
    },
    cleanup() {
      while (created.length > 0) {
        fs.rmSync(created.pop()!, { recursive: true, force: true })
      }
    },
  }
}

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/lock tryAcquire", () => {
  it("acquires an exclusive lock and releases it explicitly", () => {
    const lockPath = tmp.file()
    const lock = tryAcquire(lockPath)

    expect(lock).toBeDefined()

    lock.release()
    expect(() => tryAcquire(lockPath)).not.toThrow()
  })

  it("rejects a second acquire while the first handle is live", () => {
    const lockPath = tmp.file()
    const lock = tryAcquire(lockPath)

    try {
      expect(() => tryAcquire(lockPath)).toThrow(/LOCKED/)
    } finally {
      lock.release()
    }
  })
})
