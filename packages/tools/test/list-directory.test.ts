import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { listDirectory } from "../src/list-directory.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools list_directory", () => {
  it("lists entries under an allowed directory", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      "file.txt": "hello",
      nested: { "child.txt": "world" },
    })
    const toolkit = listDirectory(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "list_directory",
      { path: root, depth: 2 },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries.map((e) => e.name)).toEqual([
        "file.txt",
        "nested",
        "nested/child.txt",
      ])
    }
  })

  it("marks file and directory entry kinds", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      "file.txt": "hello",
      nested: { "child.txt": "world" },
    })
    const toolkit = listDirectory(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "list_directory",
      { path: root, depth: 2 },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries).toEqual([
        { name: "file.txt", type: "file", sizeBytes: 5 },
        { name: "nested", type: "directory" },
        { name: "nested/child.txt", type: "file", sizeBytes: 5 },
      ])
    }
  })

  it("respects gitignore filtering by default", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "hello",
      "ignored.txt": "world",
    })
    const toolkit = listDirectory(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "list_directory",
      { path: root, depth: 1 },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries.map((e) => e.name)).toEqual(["kept.txt"])
    }
  })

  it("can disable gitignore filtering", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "hello",
      "ignored.txt": "world",
    })
    const toolkit = listDirectory(new PathContext([root]), { gitignore: false })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "list_directory",
      { path: root, depth: 1 },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries.map((e) => e.name)).toEqual([
        "ignored.txt",
        "kept.txt",
      ])
    }
  })

  it("rejects directories outside the allowed roots", async () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const toolkit = listDirectory(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "list_directory",
      { path: outside, depth: 1 },
      workspace,
    )

    expect(result.ok).toBe(false)
  })
})
