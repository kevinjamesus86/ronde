import { afterEach, describe, expect, it } from "vitest"
import { coreTools } from "../src/index.js"
import type { GlobData, ShellData } from "../src/types.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools coreTools", () => {
  it("requires at least one root", () => {
    expect(() => coreTools({ roots: [] })).toThrow(/at least one root/i)
  })

  it("assembles the default file and shell tools over one shared path context", () => {
    const root = tmp.dir()
    const toolkit = coreTools({ roots: [root] })

    expect(toolkit.schemas.map((s) => s.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "glob_files",
      "grep_files",
      "list_directory",
      "shell",
    ])
  })

  it("enforces shell cwd inside the declared roots", () => {
    const root = tmp.dir()
    const outside = tmp.dir()

    expect(() => coreTools({ roots: [root], shell: { cwd: outside } })).toThrow(
      /not within any declared root/i,
    )
  })

  it("forwards gitignore and sandbox options to child tool factories", async () => {
    const root = tmp.dir()
    tmp.write(root, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "hello",
      "ignored.txt": "world",
    })
    const toolkit = coreTools({
      roots: [root],
      gitignore: false,
      shell: { sandbox: false, snapshot: false },
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const glob = await execTool<GlobData>(
      toolkit,
      "glob_files",
      { path: root, pattern: "**/*.txt" },
      workspace,
    )

    expect(glob.ok).toBe(true)
    if (glob.ok) {
      expect(glob.data.matches).toEqual(["ignored.txt", "kept.txt"])
    }

    const shell = await execTool<ShellData>(
      toolkit,
      "shell",
      { command: "pwd" },
      workspace,
    )

    expect(shell.ok).toBe(true)
  })
})
