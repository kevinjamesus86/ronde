import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readFile } from "../src/read-file.js"
import { PathContext } from "../src/context.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools read_file", () => {
  it("reads UTF-8 file content within the allowed roots", async () => {
    const root = tmp.dir()
    tmp.write(root, { "file.txt": "hello\nworld" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: path.join(root, "file.txt") },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toBe("hello\nworld")
      expect(result.data.totalLines).toBe(2)
    }
  })

  it("supports optional line slicing", async () => {
    const root = tmp.dir()
    tmp.write(root, { "file.txt": "a\nb\nc\nd" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      {
        file_path: path.join(root, "file.txt"),
        offset: 2,
        limit: 2,
      },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toBe("b\nc")
      expect(result.data.startLine).toBe(2)
      expect(result.data.endLine).toBe(3)
      expect(result.data.truncated).toBe(true)
    }
  })

  it("rejects paths outside the allowed roots", async () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    tmp.write(outside, { "file.txt": "hello" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: path.join(outside, "file.txt") },
      workspace,
    )

    expect(result.ok).toBe(false)
  })

  it("returns a useful error for missing files", async () => {
    const root = tmp.dir()
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())
    const file = path.join(root, "missing.txt")

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: file },
      workspace,
    )

    expect(result).toEqual({
      ok: false,
      error: `File not found: ${file}`,
    })
  })

  it("truncates lines longer than the per-line cap", async () => {
    const root = tmp.dir()
    const file = path.join(root, "long.txt")
    tmp.write(root, { "long.txt": "x".repeat(5000) })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: file },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content.length).toBeLessThan(5000)
      expect(result.data.content).toContain("[line truncated]")
    }
  })

  it("treats a trailing newline as end-of-file, not a phantom line", async () => {
    const root = tmp.dir()
    const file = path.join(root, "trail.txt")
    tmp.write(root, { "trail.txt": "a\nb\n" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: file },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.totalLines).toBe(2)
      expect(result.data.content).toBe("a\nb")
    }
  })

  it("handles empty files cleanly", async () => {
    const root = tmp.dir()
    const file = path.join(root, "empty.txt")
    tmp.write(root, { "empty.txt": "" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: file },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.totalLines).toBe(0)
      expect(toolkit.formatters.read_file?.(result.data)).toBe("(empty file)")
    }
  })

  it("returns an empty range when offset is past end of file", async () => {
    const root = tmp.dir()
    const file = path.join(root, "small.txt")
    tmp.write(root, { "small.txt": "a\nb\nc" })
    const toolkit = readFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "read_file",
      { file_path: file, offset: 100 },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content).toBe("")
      expect(toolkit.formatters.read_file?.(result.data)).toContain(
        "no lines in range",
      )
    }
  })
})
