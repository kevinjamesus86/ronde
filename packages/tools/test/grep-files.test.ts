import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { grepFiles } from "../src/grep-files.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools grep_files", () => {
  it("searches files with ECMAScript regular expressions", async () => {
    const root = tmp.dir()
    tmp.write(root, { "a.txt": "hello\nronde\n" })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: root, pattern: "ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.totalMatches).toBe(1)
    }
  })

  it("returns matching lines with path and line number metadata", async () => {
    const root = tmp.dir()
    tmp.write(root, { "a.txt": "hello\nronde\n" })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: root, pattern: "ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: {
        matches: [{ file: "a.txt", line: 2, text: "ronde" }],
        fileCount: 1,
        totalMatches: 1,
        truncated: false,
      },
    })
  })

  it("respects gitignore filtering by default", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "ronde\n",
      "ignored.txt": "ronde\n",
    })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: root, pattern: "ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fileCount).toBe(1)
    }
  })

  it("can disable gitignore filtering", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "ronde\n",
      "ignored.txt": "ronde\n",
    })
    const toolkit = grepFiles(new PathContext([root]), { gitignore: false })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: root, pattern: "ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fileCount).toBe(2)
    }
  })

  it("rejects invalid ECMAScript regex patterns", async () => {
    const root = tmp.dir()
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: root, pattern: "(?i)ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(false)
  })

  it("rejects search roots outside the allowed sandbox", async () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "grep_files",
      { path: outside, pattern: "ronde", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(false)
  })
})
