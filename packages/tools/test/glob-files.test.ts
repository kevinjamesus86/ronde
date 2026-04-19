import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { globFiles } from "../src/glob-files.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools glob_files", () => {
  it("returns matches under the declared roots", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      "a.ts": "",
      "b.js": "",
      src: { "c.ts": "" },
    })
    const toolkit = globFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "glob_files",
      { path: root, pattern: "**/*.ts" },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: {
        matches: ["a.ts", "src/c.ts"],
        totalMatches: 2,
        truncated: false,
      },
    })
  })

  it("respects gitignore filtering by default", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.ts\n",
      "kept.ts": "",
      "ignored.ts": "",
    })
    const toolkit = globFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "glob_files",
      { path: root, pattern: "**/*.ts" },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: {
        matches: ["kept.ts"],
        totalMatches: 1,
        truncated: false,
      },
    })
  })

  it("can disable gitignore filtering", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.ts\n",
      "kept.ts": "",
      "ignored.ts": "",
    })
    const toolkit = globFiles(new PathContext([root]), { gitignore: false })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "glob_files",
      { path: root, pattern: "**/*.ts" },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: {
        matches: ["ignored.ts", "kept.ts"],
        totalMatches: 2,
        truncated: false,
      },
    })
  })

  it("rejects roots and patterns outside the allowed sandbox", async () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const toolkit = globFiles(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "glob_files",
      { path: outside, pattern: "**/*.ts" },
      workspace,
    )

    expect(result.ok).toBe(false)
  })
})
