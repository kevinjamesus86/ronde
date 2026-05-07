import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  sanitizeFilename,
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"
import type { Toolkit, ToolResult } from "@ronde/core/toolkit"
import type { ToolCall } from "@ronde/core/tool"
import { drain } from "@ronde/core/stream"

export type FileTree = { [key: string]: string | FileTree }

export interface TmpHandle {
  dir(prefix?: string): string
  write(dir: string, tree: FileTree): void
  cleanup(): void
}

export function useTmp(): TmpHandle {
  const created: string[] = []

  return {
    dir(prefix = "ronde-tools-") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
      created.push(dir)
      return dir
    },
    write(dir: string, tree: FileTree) {
      for (const [key, value] of Object.entries(tree)) {
        const target = path.join(dir, key)
        if (typeof value === "string") {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, value)
        } else {
          fs.mkdirSync(target, { recursive: true })
          this.write(target, value)
        }
      }
    },
    cleanup() {
      while (created.length > 0) {
        fs.rmSync(created.pop()!, { recursive: true, force: true })
      }
    },
  }
}

export class TestDirectoryWorkspace extends Workspace {
  readonly kind = "test-dir" as const
  readonly spills = new Map<string, string>()

  constructor(
    readonly id: string,
    readonly dir: string,
  ) {
    super()
  }

  async spill(
    content: string | Uint8Array,
    opts: SpillOpts = {},
  ): Promise<SpillResult> {
    const base = sanitizeFilename(opts.name ?? "") || "spill"
    const full = path.join(this.dir, `${base}.txt`)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    if (typeof content === "string") {
      fs.writeFileSync(full, content, "utf8")
      this.spills.set(full, content)
      return {
        uri: `file://${full}`,
        bytes: Buffer.byteLength(content, "utf8"),
      }
    }
    fs.writeFileSync(full, content)
    this.spills.set(full, "")
    return { uri: `file://${full}`, bytes: content.byteLength }
  }
}

export async function execTool<D = unknown>(
  toolkit: Toolkit<any>,
  name: string,
  args: Record<string, unknown>,
  workspace: Workspace,
): Promise<ToolResult<D>> {
  const abort = new AbortController()
  const call: ToolCall = {
    toolUseId: "toolu_1",
    name,
    arguments: args,
  }

  return drain(
    toolkit.execute(name, args, {
      turn: 1,
      abort: abort.signal,
      messages: [],
      workspace,
      call,
    }),
  ) as Promise<ToolResult<D>>
}
