import { describe, expect, it } from "vitest"
import {
  DirectoryWorkspace,
  Workspace,
  isDirectoryWorkspace,
  makePreview,
  sanitizeFilename,
  type SpillOpts,
  type SpillResult,
  type PathSpillResult,
} from "@ronde/core/workspace"

describe("@ronde/core workspace contract", () => {
  it("treats spill() as the portable artifact persistence boundary", async () => {
    const workspace: Workspace = new TestWorkspace()

    await expect(workspace.spill("hello")).resolves.toEqual({
      uri: "memory://workspace/test",
      preview: "hello",
      truncated: false,
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

describe("@ronde/core makePreview", () => {
  it("returns the content unchanged when it fits within head plus tail", () => {
    expect(makePreview("hello", 4, 4)).toBe("hello")
  })

  it("builds a head / marker / tail preview when content exceeds the window", () => {
    expect(makePreview("abcdefghij", 3, 2)).toBe(
      "abc\n\n[... 5 characters truncated ...]\n\nij",
    )
  })

  it("reports the omitted character count in the truncation marker", () => {
    expect(makePreview("abcdefghij", 3, 2)).toContain("5 characters truncated")
  })
})

class TestWorkspace extends Workspace {
  readonly id = "workspace-1"
  readonly kind = "test"

  async spill(content: string, _opts?: SpillOpts): Promise<SpillResult> {
    return {
      uri: "memory://workspace/test",
      preview: content,
      truncated: false,
      bytes: Buffer.byteLength(content, "utf8"),
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
      preview: content,
      truncated: false,
      bytes: Buffer.byteLength(content, "utf8"),
    }
  }
}
