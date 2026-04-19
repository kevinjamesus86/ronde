import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import { shell } from "../src/shell.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools shell", () => {
  it("runs commands with the configured working directory", async () => {
    const root = tmp.dir()
    const subdir = path.join(root, "subdir")
    fs.mkdirSync(subdir)
    const toolkit = shell(new PathContext([root]), {
      cwd: subdir,
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: "pwd" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.stdout).toBe(fs.realpathSync(subdir))
    }
  })

  it("persists cwd across sequential calls on the same toolkit instance", async () => {
    const root = tmp.dir()
    const subdir = path.join(root, "subdir")
    fs.mkdirSync(subdir)
    const toolkit = shell(new PathContext([root]), {
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const first = await execTool(
      toolkit,
      "shell",
      { command: `cd ${JSON.stringify(subdir)}` },
      workspace,
    )
    const second = await execTool(
      toolkit,
      "shell",
      { command: "pwd" },
      workspace,
    )

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.stdout).toBe(fs.realpathSync(subdir))
    }
  })

  it("applies the macOS sandbox profile when sandboxing is enabled", async () => {
    if (process.platform !== "darwin") {
      return
    }

    const root = tmp.dir()
    // $HOME sits outside the sysWrite carve-out (/private/tmp and
    // /private/var/folders), so the sandbox must reject this touch.
    const file = path.join(
      os.homedir(),
      `.ronde-sandbox-test-${process.pid}.txt`,
    )
    const toolkit = shell(new PathContext([root]), {
      sandbox: true,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    try {
      const result = await execTool(
        toolkit,
        "shell",
        { command: `touch ${JSON.stringify(file)}` },
        workspace,
      )

      expect(result.ok).toBe(false)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it("supports disabled sandboxing for trusted local runs", async () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const file = path.join(outside, "outside.txt")
    const toolkit = shell(new PathContext([root]), {
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: `touch ${JSON.stringify(file)}` },
      workspace,
    )

    expect(result.ok).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it("captures command output and exit status", async () => {
    const root = tmp.dir()
    const toolkit = shell(new PathContext([root]), {
      sandbox: false,
      snapshot: false,
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: "echo boom >&2; exit 7" },
      workspace,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("Command failed with exit code 7")
      expect(result.data).toMatchObject({
        exitCode: 7,
        stdout: "boom",
      })
    }
  })

  it("does not leak parent-process env vars into the subprocess", async () => {
    process.env.RONDE_SECRET_LEAK_TEST = "ShouldNotAppear"
    try {
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
        { command: "env | sort" },
        workspace,
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.stdout).not.toContain("RONDE_SECRET_LEAK_TEST")
        expect(result.data.stdout).not.toContain("ShouldNotAppear")
        expect(result.data.stdout).toContain("TERM=dumb")
        expect(result.data.stdout).toContain("PATH=")
      }
    } finally {
      delete process.env.RONDE_SECRET_LEAK_TEST
    }
  })

  it("applies a supplied snapshot so its functions are available", async () => {
    const root = tmp.dir()
    const toolkit = shell(new PathContext([root]), {
      cwd: root,
      sandbox: false,
      snapshot: {
        kind: "zsh",
        envVars: {},
        aliases: {},
        functions: {
          ronde_greet: "ronde_greet () {\n  echo ronde_hi\n}",
        },
        shellOptions: [],
      },
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool(
      toolkit,
      "shell",
      { command: "ronde_greet" },
      workspace,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.stdout).toBe("ronde_hi")
    }
  })
})
