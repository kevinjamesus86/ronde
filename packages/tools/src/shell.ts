import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { z } from "zod/v4"
import { genHex } from "@ronde/core/id"
import type { StatefulToolContext, ToolOutput } from "@ronde/core/toolkit"
import { ok, err } from "@ronde/core/result"
import type { DirectoryWorkspace } from "@ronde/core/workspace"
import type { PathContext } from "./context.js"
import type { ShellData } from "./types.js"
import { fsTool } from "./fs-tool.js"
import {
  capture as captureSnapshot,
  detectShellKind,
  toScript as snapshotToScript,
  type Snapshot,
} from "./shell-snapshot.js"

const CPU_LIMIT_SEC = 60
const TIMEOUT_MS = 65_000
const HARD_LIMIT = 5 * 1024 * 1024

type ShellArgs = z.infer<typeof parameters>

interface ShellState {
  cwd: string
  // Populated lazily on first `execute`. Undefined if snapshotting is
  // disabled or capture failed (we fall back to a bare shell).
  snapshotPath: string | undefined
}

/** Sandbox policy for the shell subprocess. */
export interface SandboxConfig {
  /** File read policy. Default: `"*"` (unrestricted). `"roots"` restricts to declared roots + system paths. */
  reads?: "roots" | "*"
  /** File write policy. Default: `"roots"` (restricted to rw roots). `"*"` unrestricts. */
  writes?: "roots" | "*"
  /** Network access. Default: true (allowed). */
  network?: boolean
}

export interface ShellOptions {
  cwd?: string
  sandbox?: boolean | SandboxConfig
  snapshot?: boolean | Snapshot
}

const parameters = z.object({
  command: z
    .string()
    .describe("Shell command to execute. Must be non-interactive."),
})

/**
 * Run zsh commands with a cwd that persists across calls — a `cd` in
 * one call affects the next. Runs under `sandbox-exec` by default
 * (writes restricted to rw roots; reads unrestricted).
 *
 * @param opts.cwd - Starting working directory (default: first root).
 * @param opts.sandbox - `true` (default) restricts writes, `false`
 *   disables sandboxing, {@link SandboxConfig} gives fine-grained
 *   control over reads/writes/network.
 * @param opts.snapshot - `true` (default) captures the user's shell rc
 *   state (aliases, functions, options, PATH) once on first
 *   invocation and sources it into every subsequent command. `false`
 *   runs commands with a bare env. Pass a {@link Snapshot} to supply
 *   a pre-built one.
 */
export const shell = (pathCtx: PathContext, opts: ShellOptions = {}) => {
  const initialCwd = opts.cwd ?? pathCtx.roots[0]!
  const sandbox = opts.sandbox ?? true
  const snapshot = opts.snapshot ?? true

  return fsTool({
    name: "shell",
    description:
      "Executes a zsh command. Working directory persists between calls." +
      " Timeout 60s.",
    parameters,
    state: {
      init: () => ({
        cwd: initialCwd,
        snapshotPath: undefined,
      }),
      dispose: async (state) => {
        if (state.snapshotPath) {
          await fs.unlink(state.snapshotPath).catch(() => {})
        }
      },
    },
    execute: (args, ctx) => run(pathCtx, sandbox, snapshot, args, ctx),
    format,
    truncate: "middle",
  })
}

async function run(
  pathCtx: PathContext,
  sandbox: boolean | SandboxConfig,
  snapshot: boolean | Snapshot,
  args: ShellArgs,
  ctx: StatefulToolContext<ShellState, DirectoryWorkspace>,
): Promise<ToolOutput<ShellData>> {
  await ensureSnapshot(snapshot, ctx.state)
  const raw = await runProcess(pathCtx, sandbox, args, ctx)
  if (!raw.ok) {
    return err(raw.error)
  }

  const data: ShellData = raw.data
  if (data.exitCode !== 0) {
    return err(`Command failed with exit code ${data.exitCode}`, data)
  }
  return ok(data)
}

async function runProcess(
  pathCtx: PathContext,
  sandbox: boolean | SandboxConfig,
  args: ShellArgs,
  ctx: StatefulToolContext<ShellState>,
): Promise<ToolOutput<ShellData>> {
  const enabled = sandbox !== false
  const config = typeof sandbox === "object" ? sandbox : undefined
  const profile = pathCtx.sandboxProfile(config)
  const sentinel = `__CWD_${Date.now()}__`
  // `|| true` keeps the shell alive if the snapshot file vanished
  // mid-session (e.g. tmpdir GC) — user gets a bare shell instead of
  // a hard failure.
  const snapshotLine = ctx.state.snapshotPath
    ? `source ${shQuote(ctx.state.snapshotPath)} 2>/dev/null || true\n`
    : ""
  const script =
    snapshotLine +
    `ulimit -t ${CPU_LIMIT_SEC}\n` +
    `exec 2>&1\n` +
    `${args.command}\n` +
    `__exit=$?\n` +
    `echo "${sentinel}$(pwd)"\n` +
    `exit $__exit\n`

  const scriptPath = path.join(await ensureTmpDir(), `.cmd_${genHex()}.zsh`)
  await fs.writeFile(scriptPath, script, "utf-8")

  return new Promise((resolve) => {
    const spawnArgs = enabled
      ? (["sandbox-exec", ["-p", profile, "zsh", scriptPath]] as const)
      : (["zsh", [scriptPath]] as const)

    const child = spawn(spawnArgs[0], [...spawnArgs[1]], {
      cwd: ctx.state.cwd,
      env: spawnEnv(ctx.state),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout!.on("data", (data: Buffer) => {
      if (stdout.length < HARD_LIMIT) {
        stdout += data
      }
    })
    child.stderr!.on("data", (data: Buffer) => {
      if (stderr.length < HARD_LIMIT) {
        stderr += data
      }
    })

    let killTimer: ReturnType<typeof setTimeout> | null = null
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGTERM")
      } catch {}
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch {}
      }, 2000)
    }, TIMEOUT_MS)

    async function finish(exitCode: number): Promise<void> {
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      await fs.unlink(scriptPath).catch(() => {})

      const sentinelIdx = stdout.lastIndexOf(sentinel)
      if (sentinelIdx !== -1) {
        const newCwd = stdout.slice(sentinelIdx + sentinel.length).trim()
        stdout = stdout.slice(0, sentinelIdx)
        if (newCwd && path.isAbsolute(newCwd)) {
          const cwdCheck = pathCtx.safePath(newCwd, "cwd")
          if (cwdCheck.ok) {
            ctx.state.cwd = cwdCheck.path
          }
        }
      }

      resolve(
        ok({
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode,
        }),
      )
    }

    child.on("close", (code) => void finish(code || 0))
    child.on("error", async (e) => {
      clearTimeout(timer)
      await fs.unlink(scriptPath).catch(() => {})
      resolve(err(e.message))
    })
  })
}

function format(data: ShellData): string {
  let output = data.stdout
  if (data.exitCode !== 0) {
    if (data.stderr) {
      output += `\n\nSTDERR:\n${data.stderr}`
    }
    output += `\n[exit ${data.exitCode}]`
  }
  return output
}

async function ensureTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), ".ronde")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function ensureSnapshot(
  snapshot: boolean | Snapshot,
  state: ShellState,
): Promise<void> {
  if (snapshot === false || state.snapshotPath !== undefined) {
    return
  }

  const resolved = await resolveSnapshot(snapshot)
  if (!resolved) {
    return
  }

  const script = snapshotToScript(resolved)
  const snapshotPath = path.join(
    await ensureTmpDir(),
    `snapshot-${genHex()}.sh`,
  )
  await fs.writeFile(snapshotPath, script, "utf-8")
  state.snapshotPath = snapshotPath
}

async function resolveSnapshot(
  snapshot: true | Snapshot,
): Promise<Snapshot | undefined> {
  if (typeof snapshot === "object") {
    return snapshot
  }
  const kind = detectShellKind()
  if (!kind) {
    return
  }
  try {
    return await captureSnapshot(kind)
  } catch {
    // Capture can fail on unusual rc files; fall back to a bare
    // shell rather than breaking the tool.
    return
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Non-interactive / deterministic hygiene for an LLM-driven shell.
// Restricting env to this set also keeps API tokens and other
// parent-process secrets out of the subprocess — anything not named
// here drops on the floor at spawn time.
const SPAWN_ENV = {
  TERM: "dumb",
  NO_COLOR: "1",
  PAGER: "cat",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NONINTERACTIVE: "1",
  DEBIAN_FRONTEND: "noninteractive",
  GIT_TERMINAL_PROMPT: "0",
}

function spawnEnv(state: ShellState): NodeJS.ProcessEnv {
  if (state.snapshotPath) {
    // Snapshot's `export` lines supply PATH/HOME/USER/SHELL.
    return SPAWN_ENV
  }
  return {
    ...SPAWN_ENV,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/tmp",
    USER: process.env.USER ?? "unknown",
    SHELL: process.env.SHELL ?? "/bin/zsh",
  }
}
