import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Workspace, type SpillResult } from "@ronde/core/workspace"
import { PathContext } from "../src/context.js"
import { pathContextForWorkspace } from "../src/workspace-path.js"
import { TestDirectoryWorkspace, useTmp } from "./support.js"

class TestWorkspace extends Workspace {
  readonly kind = "test" as const

  constructor(readonly id: string) {
    super()
  }

  async spill(): Promise<SpillResult> {
    throw new Error("unused")
  }
}

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools workspace path helpers", () => {
  it("derives path context from directory-backed workspaces", () => {
    const root = tmp.dir()
    const workspaceDir = tmp.dir()
    const base = new PathContext([root])
    const workspace = new TestDirectoryWorkspace("ws", workspaceDir)
    const derived = pathContextForWorkspace(base, workspace)
    const file = path.join(workspaceDir, "artifact.txt")

    expect(derived.safeRead(file).ok).toBe(true)
  })

  it("leaves non-directory workspaces unchanged", () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const base = new PathContext([root])
    const workspace = new TestWorkspace("ws")
    const derived = pathContextForWorkspace(base, workspace)
    const file = path.join(outside, "artifact.txt")

    expect(derived.safeRead(file).ok).toBe(false)
  })

  it("adds workspace roots with the correct access mode", () => {
    const root = tmp.dir()
    const workspaceDir = tmp.dir()
    const base = new PathContext([root])
    const workspace = new TestDirectoryWorkspace("ws", workspaceDir)
    const derived = pathContextForWorkspace(base, workspace)
    const file = path.join(workspaceDir, "artifact.txt")

    expect(derived.safeRead(file).ok).toBe(true)
    expect(derived.safeWrite(file).ok).toBe(false)
  })
})
