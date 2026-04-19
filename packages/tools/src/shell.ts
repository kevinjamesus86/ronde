import fs from "node:fs"
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

const CPU_LIMIT_SEC = 60
const TIMEOUT_MS = 65_000
const INLINE_CAP = 25_000
const PREVIEW_HEAD = 10_000
const PREVIEW_TAIL = 10_000
const HARD_LIMIT = 5 * 1024 * 1024

type ShellArgs = z.infer<typeof parameters>

interface ShellState {
  cwd: string
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
 * Output over {@link INLINE_CAP} bytes is head+tail-previewed inline
 * and spilled in full to the workspace; the model drills into the
 * spill via `read_file`.
 *
 * @param opts.cwd - Starting working directory (default: first root).
 * @param opts.sandbox - `true` (default) restricts writes, `false`
 *   disables sandboxing, {@link SandboxConfig} gives fine-grained
 *   control over reads/writes/network.
 */
export const shell = (pathCtx: PathContext, opts: ShellOptions = {}) => {
  const initialCwd = opts.cwd ?? pathCtx.roots[0]!
  const sandbox = opts.sandbox ?? true

  return fsTool({
    name: "shell",
    description:
      "Executes a zsh command. Working directory persists between calls." +
      " Timeout 60s. Long output is middle-truncated inline and" +
      " spilled in full; read the full output via read_file with offset/limit.",
    parameters,
    state: {
      init: () => ({
        cwd: initialCwd,
      }),
    },
    execute: (args, ctx) => run(pathCtx, sandbox, args, ctx),
    format,
  })
}

async function run(
  pathCtx: PathContext,
  sandbox: boolean | SandboxConfig,
  args: ShellArgs,
  ctx: StatefulToolContext<ShellState, DirectoryWorkspace>,
): Promise<ToolOutput<ShellData>> {
  const raw = await runProcess(pathCtx, sandbox, args, ctx)
  if (!raw.ok) {
    return err(raw.error)
  }

  const { stdout, stderr, exitCode, totalBytes } = raw.data

  let inlineStdout = stdout
  let truncated = false
  let fullStdoutPath: string | undefined

  if (stdout.length > INLINE_CAP) {
    const spillResult = await ctx.spill(stdout, {
      previewHead: PREVIEW_HEAD,
      previewTail: PREVIEW_TAIL,
    })
    inlineStdout = spillResult.preview
    truncated = true
    fullStdoutPath = spillResult.path
  }

  const data: ShellData = {
    exitCode,
    stdout: inlineStdout,
    stderr,
    truncated,
    totalBytes,
    ...(fullStdoutPath ? { fullStdoutPath } : {}),
  }

  if (exitCode !== 0) {
    return err(`Command failed with exit code ${exitCode}`, data)
  }
  return ok(data)
}

interface RawShellResult {
  stdout: string
  stderr: string
  exitCode: number
  totalBytes: number
}

function runProcess(
  pathCtx: PathContext,
  sandbox: boolean | SandboxConfig,
  args: ShellArgs,
  ctx: StatefulToolContext<ShellState>,
): Promise<ToolOutput<RawShellResult>> {
  const enabled = sandbox !== false
  const config = typeof sandbox === "object" ? sandbox : undefined
  const profile = pathCtx.sandboxProfile(config)
  const sentinel = `__CWD_${Date.now()}__`
  const script =
    `ulimit -t ${CPU_LIMIT_SEC}\n` +
    `alias python=python3\n` +
    `exec 2>&1\n` +
    `${args.command}\n` +
    `__exit=$?\n` +
    `echo "${sentinel}$(pwd)"\n` +
    `exit $__exit\n`
  const scriptPath = path.join(ensureTmpDir(), `.cmd_${genHex()}.zsh`)

  return new Promise((resolve) => {
    fs.writeFileSync(scriptPath, script, "utf-8")

    const spawnArgs = enabled
      ? (["sandbox-exec", ["-p", profile, "zsh", scriptPath]] as const)
      : (["zsh", [scriptPath]] as const)

    const child = spawn(spawnArgs[0], [...spawnArgs[1]], {
      cwd: ctx.state.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let totalBytes = 0

    child.stdout!.on("data", (data: Buffer) => {
      totalBytes += data.length
      if (stdout.length < HARD_LIMIT) {
        stdout += data
      }
    })
    child.stderr!.on("data", (data: Buffer) => {
      totalBytes += data.length
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

    function finish(exitCode: number): void {
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      try {
        fs.unlinkSync(scriptPath)
      } catch {}

      const sentinelIdx = stdout.lastIndexOf(sentinel)
      if (sentinelIdx !== -1) {
        const newCwd = stdout.slice(sentinelIdx + sentinel.length).trim()
        const strippedLen = stdout.length - sentinelIdx
        stdout = stdout.slice(0, sentinelIdx)
        // Don't count ronde's sentinel plumbing as user output.
        totalBytes = Math.max(0, totalBytes - strippedLen)
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
          totalBytes,
        }),
      )
    }

    child.on("close", (code) => finish(code || 0))
    child.on("error", (e) => {
      clearTimeout(timer)
      try {
        fs.unlinkSync(scriptPath)
      } catch {}
      resolve(err(e.message))
    })
  })
}

function format(data: ShellData): string {
  let output = data.stdout
  if (data.truncated && data.fullStdoutPath) {
    output +=
      `\n\n[Output truncated (${data.totalBytes} bytes total).` +
      ` Full output at ${data.fullStdoutPath}.` +
      ` Use read_file with offset/limit to see specific ranges.]`
  }
  if (data.exitCode !== 0) {
    if (data.stderr) {
      output += `\n\nSTDERR:\n${data.stderr}`
    }
    output += `\n[exit ${data.exitCode}]`
  }
  return output
}

function ensureTmpDir(): string {
  const dir = path.join(os.tmpdir(), ".ronde")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
