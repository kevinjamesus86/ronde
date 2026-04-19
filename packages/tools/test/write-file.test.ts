import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PathContext, ro } from "../src/context.js"
import { writeFile } from "../src/write-file.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools write_file", () => {
  it("writes new file content within writable roots", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    const toolkit = writeFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "write_file",
      { file_path: file, content: "hello" },
      workspace,
    )

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  it("creates parent directories as needed", async () => {
    const root = tmp.dir()
    const file = path.join(root, "nested", "dir", "file.txt")
    const toolkit = writeFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    await execTool(
      toolkit,
      "write_file",
      { file_path: file, content: "hello" },
      workspace,
    )

    expect(fs.readFileSync(file, "utf8")).toBe("hello")
  })

  it("rejects writes into read-only roots", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    const toolkit = writeFile(new PathContext([ro(root)]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "write_file",
      { file_path: file, content: "hello" },
      workspace,
    )

    expect(result.ok).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("returns bytes written metadata", async () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    const toolkit = writeFile(new PathContext([root]))
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "write_file",
      { file_path: file, content: "hello" },
      workspace,
    )

    expect(result).toEqual({
      ok: true,
      data: { path: fs.realpathSync(file), bytesWritten: 5 },
    })
  })
})
