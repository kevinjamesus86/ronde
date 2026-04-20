import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { shell } from "../src/shell.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools shell output shaping", () => {
  it("returns stdout verbatim", async () => {
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
      // Tool returns raw stdout; framework cuts at formatToolOutput layer.
      expect(result.data.stdout.length).toBeGreaterThanOrEqual(40000)
    }
  })

  it("captures short stdout", async () => {
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
      expect(result.data.stdout).toBe("short")
    }
  })

  it("declares the middle truncate strategy", () => {
    const toolkit = shell(new PathContext([tmp.dir()]), {
      sandbox: false,
      snapshot: false,
    })

    expect(toolkit.truncate).toEqual({ shell: "middle" })
  })

  it("formats successful output as stdout", () => {
    const toolkit = shell(new PathContext([tmp.dir()]), {
      sandbox: false,
      snapshot: false,
    })

    expect(
      toolkit.formatters.shell?.({
        exitCode: 0,
        stdout: "hello",
        stderr: "",
      }),
    ).toBe("hello")
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
    })

    expect(formatted).toContain("STDERR:")
    expect(formatted).toContain("warning!")
    expect(formatted).toContain("[exit 2]")
  })
})
