import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PathContext } from "../src/context.js"
import {
  resolveRuntimeShell,
  resolveShellLaunch,
  shell,
  shellSnapshotLine,
  type RuntimeShell,
} from "../src/shell.js"
import type { ShellData } from "../src/types.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

const zshShell: RuntimeShell = { kind: "zsh", command: "zsh" }
const bashShell: RuntimeShell = { kind: "bash", command: "/bin/bash" }
const shShell: RuntimeShell = { kind: "sh", command: "/bin/sh" }

describe("@ronde/tools shell", () => {
  it("uses sandbox-exec for sandboxed launches on macOS", () => {
    const launch = resolveShellLaunch(
      true,
      "(version 1)",
      "/tmp/script.zsh",
      zshShell,
      "darwin",
    )

    expect(launch).toEqual({
      command: "sandbox-exec",
      args: ["-p", "(version 1)", "zsh", "/tmp/script.zsh"],
    })
  })

  it("falls back to unsandboxed zsh with a warning off macOS", () => {
    const launch = resolveShellLaunch(
      true,
      "(version 1)",
      "/tmp/script.zsh",
      zshShell,
      "linux",
    )

    expect(launch).toEqual({
      command: "zsh",
      args: ["/tmp/script.zsh"],
      warning:
        "ronde shell sandboxing is only enforced on macOS via sandbox-exec; " +
        "running this shell command unsandboxed with zsh. Pass sandbox: " +
        "false to silence this warning.",
    })
  })

  it("runs unsandboxed without warning when sandboxing is disabled", () => {
    const launch = resolveShellLaunch(
      false,
      "(version 1)",
      "/tmp/script.zsh",
      zshShell,
      "linux",
    )

    expect(launch).toEqual({
      command: "zsh",
      args: ["/tmp/script.zsh"],
    })
  })

  it("prefers zsh, then bash, then /bin/sh for runtime shell selection", () => {
    const envPath = ["/zsh-bin", "/bash-bin"].join(path.delimiter)
    const canExecute = (file: string) =>
      file === "/zsh-bin/zsh" || file === "/bash-bin/bash"

    expect(resolveRuntimeShell(envPath, canExecute)).toEqual({
      kind: "zsh",
      command: "/zsh-bin/zsh",
    })
    expect(
      resolveRuntimeShell(envPath, (file) => file === "/bash-bin/bash"),
    ).toEqual({
      kind: "bash",
      command: "/bash-bin/bash",
    })
    expect(resolveRuntimeShell(envPath, () => false)).toEqual(shShell)
  })

  it("uses the resolved shell command for sandbox and unsandboxed launches", () => {
    expect(
      resolveShellLaunch(
        true,
        "(version 1)",
        "/tmp/script.bash",
        bashShell,
        "darwin",
      ),
    ).toEqual({
      command: "sandbox-exec",
      args: ["-p", "(version 1)", "/bin/bash", "/tmp/script.bash"],
    })
    expect(
      resolveShellLaunch(
        false,
        "(version 1)",
        "/tmp/script.sh",
        shShell,
        "linux",
      ),
    ).toEqual({
      command: "/bin/sh",
      args: ["/tmp/script.sh"],
    })
  })

  it("sources snapshots for zsh/bash and skips them for sh", () => {
    expect(shellSnapshotLine("/tmp/snapshot.sh", zshShell)).toBe(
      "source '/tmp/snapshot.sh' 2>/dev/null || true\n",
    )
    expect(shellSnapshotLine("/tmp/snapshot.sh", bashShell)).toBe(
      "source '/tmp/snapshot.sh' 2>/dev/null || true\n",
    )
    expect(shellSnapshotLine("/tmp/snapshot.sh", shShell)).toBe("")
    expect(shellSnapshotLine(undefined, zshShell)).toBe("")
  })

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

    const result = await execTool<ShellData>(
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

    const first = await execTool<ShellData>(
      toolkit,
      "shell",
      { command: `cd ${JSON.stringify(subdir)}` },
      workspace,
    )
    const second = await execTool<ShellData>(
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
      const result = await execTool<ShellData>(
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

    const result = await execTool<ShellData>(
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

    const result = await execTool<ShellData>(
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

      const result = await execTool<ShellData>(
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
    const runtimeShell = resolveRuntimeShell()
    if (runtimeShell.kind === "sh") {
      return
    }

    const root = tmp.dir()
    const toolkit = shell(new PathContext([root]), {
      cwd: root,
      sandbox: false,
      snapshot: {
        kind: runtimeShell.kind,
        envVars: {},
        aliases: {},
        functions: {
          ronde_greet: "ronde_greet () {\n  echo ronde_hi\n}",
        },
        shellOptions: [],
      },
    })
    const workspace = new TestDirectoryWorkspace("ws", tmp.dir())

    const result = await execTool<ShellData>(
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
