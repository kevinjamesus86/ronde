import { describe, expect, it } from "vitest"
import {
  DirectoryWorkspace,
  Workspace,
  isDirectoryWorkspace,
  sanitizeFilename,
  type SpillOpts,
  type SpillResult,
  type PathSpillResult,
} from "@ronde/core/workspace"
import { utf8ByteLength } from "@ronde/core/bytes"

describe("@ronde/core workspace contract", () => {
  it("treats spill() as the portable artifact persistence boundary", async () => {
    const workspace: Workspace = new TestWorkspace()

    await expect(workspace.spill("hello")).resolves.toEqual({
      uri: "memory://workspace/test",
      bytes: 5,
    })
  })

  it("exposes DirectoryWorkspace as a pathful capability, not the base contract", async () => {
    const workspace = new TestDirectoryWorkspace()
    const result = await workspace.spill("hello")

    expect(workspace.dir).toBe("/tmp/ronde")
    expect(result.path).toBe("/tmp/ronde/spill.txt")
  })

  it("identifies directory-backed workspaces structurally via isDirectoryWorkspace", () => {
    expect(isDirectoryWorkspace(new TestWorkspace())).toBe(false)
    expect(isDirectoryWorkspace(new TestDirectoryWorkspace())).toBe(true)
  })
})

describe("@ronde/core sanitizeFilename", () => {
  it("replaces reserved and control characters with underscores", () => {
    expect(sanitizeFilename('a/b:c*?"<>|\u0000z')).toBe("a_b_c_______z")
  })

  it("trims leading and trailing underscores", () => {
    expect(sanitizeFilename("  hello world  ")).toBe("hello_world")
  })

  it("caps output to the configured max length", () => {
    expect(sanitizeFilename("abcdef", 4)).toBe("abcd")
  })

  it("returns an empty string when nothing survives sanitization", () => {
    expect(sanitizeFilename(' /:*?"<>| ')).toBe("")
  })
})

class TestWorkspace extends Workspace {
  readonly id = "workspace-1"
  readonly kind = "test"

  async spill(content: string, _opts?: SpillOpts): Promise<SpillResult> {
    return {
      uri: "memory://workspace/test",
      bytes: utf8ByteLength(content),
    }
  }
}

class TestDirectoryWorkspace extends DirectoryWorkspace {
  readonly id = "workspace-2"
  readonly kind = "dir"
  readonly dir = "/tmp/ronde"

  async spill(content: string, _opts?: SpillOpts): Promise<PathSpillResult> {
    return {
      uri: "file:///tmp/ronde/spill.txt",
      path: "/tmp/ronde/spill.txt",
      bytes: utf8ByteLength(content),
    }
  }
}
