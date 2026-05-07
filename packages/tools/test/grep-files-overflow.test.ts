import { afterEach, describe, expect, it } from "vitest"
import { BlockKind } from "@ronde/core/block"
import { ok } from "@ronde/core/result"
import { formatToolResult } from "@ronde/core/toolkit"
import { PathContext } from "../src/context.js"
import { grepFiles } from "../src/grep-files.js"
import type { GrepData } from "../src/types.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools grep_files", () => {
  it("rejects empty-matching patterns", async () => {
    const root = tmp.dir()
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool<GrepData>(
      toolkit,
      "grep_files",
      { path: root, pattern: ".*", include: "**/*" },
      workspace,
    )

    expect(result.ok).toBe(false)
  })

  it("returns every match up to the hard limit", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      "big.txt": Array.from({ length: 250 }, (_, i) => `hello ${i + 1}`).join(
        "\n",
      ),
    })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool<GrepData>(
      toolkit,
      "grep_files",
      { path: root, pattern: "hello", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.totalMatches).toBe(250)
      expect(result.data.matches).toHaveLength(250)
    }
  })

  it("returns each match with file, line number, and text", async () => {
    const root = tmp.dir()
    tmp.write(root, { "small.txt": "hello\nworld\nhello\n" })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool<GrepData>(
      toolkit,
      "grep_files",
      { path: root, pattern: "hello", include: "**/*.txt" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.matches).toHaveLength(2)
      expect(result.data.totalMatches).toBe(2)
    }
  })

  it("formats matches grouped by file", () => {
    const toolkit = grepFiles(new PathContext([tmp.dir()]))

    const formatted = toolkit.formatters.grep_files?.({
      matches: [
        { file: "a.txt", line: 1, text: "target here" },
        { file: "a.txt", line: 3, text: "target again" },
        { file: "b.txt", line: 1, text: "target once" },
      ],
      fileCount: 2,
      totalMatches: 3,
    })

    expect(formatted).toContain("## a.txt")
    expect(formatted).toContain("## b.txt")
    // No tool-level hint; framework appends its neutral hint when it cuts.
    expect(formatted).not.toContain("read_file")
    expect(formatted).not.toContain("Full list at")
  })

  it("framework spill-substitution wraps oversized grep output as [text, ref]", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      "haystack.txt": Array.from(
        { length: 500 },
        (_, i) => `match ${i + 1} ${"x".repeat(100)}`,
      ).join("\n"),
    })
    const toolkit = grepFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const out = await formatToolResult(
      toolkit,
      "grep_files",
      ok({
        matches: Array.from({ length: 500 }, (_, i) => ({
          file: "haystack.txt",
          line: i + 1,
          text: `match ${i + 1} ${"x".repeat(100)}`,
        })),
        fileCount: 1,
        totalMatches: 500,
      }),
      { workspace, toolUseId: "call-1", maxInline: 200 },
    )

    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0]!.kind).toBe(BlockKind.Text)
    const r = out.find((b) => b.kind === BlockKind.Ref)
    expect(r).toBeDefined()
    expect(r!.kind).toBe(BlockKind.Ref)
    if (r!.kind === BlockKind.Ref) {
      expect(r!.uri.startsWith("file://")).toBe(true)
      expect(r!.summary).toMatch(/^truncated to /)
    }
    expect(workspace.spills).toHaveLength(1)
  })
})
