import { describe, expect, it } from "vitest"
import {
  Workspace,
  sanitizeFilename,
  type SpillOpts,
  type SpillResult,
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
