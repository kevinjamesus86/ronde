import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { shell } from "../src/shell.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools shell output shaping", () => {
  it("spills large stdout and returns the full output path", async () => {
    const root = tmp.dir()
    const toolkit = shell(new PathContext([root]), {
      cwd: root,
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: "yes hello | head -c 40000" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.truncated).toBe(true)
      expect(result.data.fullStdoutPath).toBeDefined()
      expect(result.data.totalBytes).toBeGreaterThanOrEqual(40000)
    }
  })

  it("leaves small stdout untruncated", async () => {
    const root = tmp.dir()
    const toolkit = shell(new PathContext([root]), {
      cwd: root,
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: "echo -n short" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.truncated).toBe(false)
      expect(result.data.fullStdoutPath).toBeUndefined()
      expect(result.data.totalBytes).toBe(5)
    }
  })

  it("formats successful output directly", () => {
    const toolkit = shell(new PathContext([tmp.dir()]), {
      sandbox: false,
      snapshot: false,
    })

    expect(
      toolkit.formatters.shell?.({
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        truncated: false,
        totalBytes: 5,
      }),
    ).toBe("hello")
  })

  it("formats truncated output with a read_file spill hint", () => {
    const toolkit = shell(new PathContext([tmp.dir()]), {
      sandbox: false,
      snapshot: false,
    })

    const formatted = toolkit.formatters.shell?.({
      exitCode: 0,
      stdout: "head...\n\n[... truncated ...]\n\n...tail",
      stderr: "",
      truncated: true,
      totalBytes: 50000,
      fullStdoutPath: "/tmp/spill/shell-x.txt",
    })

    expect(formatted).toContain("Full output at /tmp/spill/shell-x.txt")
    expect(formatted).toContain("read_file")
  })

  it("formats stderr and exit code on failures", () => {
    const toolkit = shell(new PathContext([tmp.dir()]), {
      sandbox: false,
      snapshot: false,
    })

    const formatted = toolkit.formatters.shell?.({
      exitCode: 2,
      stdout: "head",
      stderr: "warning!",
      truncated: false,
      totalBytes: 4,
    })

    expect(formatted).toContain("STDERR:")
    expect(formatted).toContain("warning!")
    expect(formatted).toContain("[exit 2]")
  })
})
