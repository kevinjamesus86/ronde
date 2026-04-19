import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { editFile } from "../src/edit-file.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools edit_file", () => {
  it("applies exact-match replacements to files within writable roots", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    tmp.write(root, { "file.txt": "hello world" })
    const toolkit = editFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "edit_file",
      {
        file_path: file,
        old_string: "world",
        new_string: "ronde",
      },
      workspace,
    )

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toBe("hello ronde")
  })

  it("rejects ambiguous replacements when the target occurs multiple times", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    tmp.write(root, { "file.txt": "x x" })
    const toolkit = editFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "edit_file",
      {
        file_path: file,
        old_string: "x",
        new_string: "y",
      },
      workspace,
    )

    expect(result.ok).toBe(false)
  })

  it("rejects edits when the target text is missing", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    tmp.write(root, { "file.txt": "hello" })
    const toolkit = editFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "edit_file",
      {
        file_path: file,
        old_string: "world",
        new_string: "ronde",
      },
      workspace,
    )

    expect(result.ok).toBe(false)
  })

  it("returns a useful summary of the applied edit", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    tmp.write(root, { "file.txt": "hello world" })
    const toolkit = editFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "edit_file",
      {
        file_path: file,
        old_string: "world",
        new_string: "ronde",
      },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: { path: fs.realpathSync(file) },
    })
  })
})
