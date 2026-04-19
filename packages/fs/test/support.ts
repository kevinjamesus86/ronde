import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export interface TmpHandle {
  dir(prefix?: string): string
  cleanup(): void
}

export function useTmp(): TmpHandle {
  const created: string[] = []

  return {
    dir(prefix = "ronde-fs-") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      created.push(dir)
      return dir
    },
    cleanup() {
      while (created.length > 0) {
        fs.rmSync(created.pop()!, { recursive: true, force: true })
      }
    },
  }
}
