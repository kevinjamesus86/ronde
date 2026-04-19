import { describe, expect, it } from "vitest"
import { makePreview } from "@ronde/core/workspace"
import { MemoryWorkspace, memoryWorkspace } from "../src/workspace.js"

describe("@ronde/mem workspace spill", () => {
  it("stores spilled content under memory:// URIs", async () => {
    const workspace = new MemoryWorkspace("runtime-1")
    const result = await workspace.spill("hello", { name: "note" })

    expect(result.uri).toBe("memory://workspace/runtime-1/note.txt")
    expect(workspace.resources.get(result.uri)).toBe("hello")
  })

  it("sanitizes provided spill names", async () => {
    const workspace = new MemoryWorkspace("runtime-1")
    const result = await workspace.spill("hello", { name: " bad:/name?* " })

    expect(result.uri).toBe("memory://workspace/runtime-1/bad__name.txt")
  })

  it("falls back to a generated spill name when none is provided", async () => {
    const workspace = new MemoryWorkspace("runtime-1")
    const result = await workspace.spill("hello")

    expect(result.uri).toMatch(
      /^memory:\/\/workspace\/runtime-1\/spill-[0-9a-f]+\.txt$/,
    )
  })

  it("builds previews, truncation metadata, and byte counts", async () => {
    const workspace = new MemoryWorkspace("runtime-1")
    const content = "abcdefghij"
    const result = await workspace.spill(content, {
      name: "preview",
      previewHead: 3,
      previewTail: 2,
    })

    expect(result.preview).toBe(makePreview(content, 3, 2))
    expect(result.truncated).toBe(true)
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf-8"))
  })
})

describe("@ronde/mem workspace reads", () => {
  it("returns stored content for known memory URIs", async () => {
    const workspace = new MemoryWorkspace("runtime-1")
    const result = await workspace.spill("hello", { name: "note" })

    expect(workspace.read(result.uri)).toBe("hello")
  })

  it("returns undefined for unknown memory URIs", () => {
    const workspace = new MemoryWorkspace("runtime-1")

    expect(
      workspace.read("memory://workspace/runtime-1/missing.txt"),
    ).toBeUndefined()
  })

  it("preserves an explicit workspace id when provided", () => {
    const workspace = memoryWorkspace("runtime-1")

    expect(workspace.id).toBe("runtime-1")
  })
})
