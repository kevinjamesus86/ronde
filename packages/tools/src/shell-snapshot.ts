/**
 * @module
 * Shell-state snapshotting for zsh and bash.
 *
 * A snapshot is a captured image of a login shell's state — env vars,
 * aliases, functions, and shell options — serialized to a `.sh` script
 * that downstream invocations can `source` to inherit that state
 * without re-initializing from rc files every time.
 *
 * Three primitives:
 *   - `capture(kind)`  spawns a login shell, sources rc files, and
 *                      introspects the resulting state.
 *   - `parse(output, kind)`  converts extraction stdout into a Snapshot
 *                      (exposed separately so callers can drive the
 *                      subprocess themselves — e.g. under a sandbox).
 *   - `toScript(snapshot)`  serializes a Snapshot back to a `.sh`
 *                      reconstruction script.
 */

import { spawn } from "node:child_process"

export type ShellKind = "zsh" | "bash"

export interface Snapshot {
  kind: ShellKind
  envVars: Record<string, string>
  aliases: Record<string, string>
  functions: Record<string, string>
  shellOptions: string[]
}

// Snapshots are written to disk as plaintext .sh scripts. Capturing
// the full environment would serialize API tokens, ssh sockets, and
// other secrets. This whitelist is the minimum a restored shell
// needs to be functional — PATH to resolve binaries, HOME for `~`,
// USER and SHELL because many programs read them.
const ENV_KEEP = new Set(["PATH", "HOME", "USER", "SHELL"])

export function detectShellKind(
  shellPath: string | undefined = process.env.SHELL,
): ShellKind | undefined {
  if (!shellPath) {
    return undefined
  }
  if (shellPath.endsWith("/zsh")) {
    return "zsh"
  }
  if (shellPath.endsWith("/bash")) {
    return "bash"
  }
  return undefined
}

/** Throws if the shell subprocess exits nonzero. */
export async function capture(kind: ShellKind): Promise<Snapshot> {
  const script = buildExtractionScript(kind)
  const output = await runShell(kind, script)
  return parse(output, kind)
}

export function parse(output: string, kind: ShellKind): Snapshot {
  const snapshot: Snapshot = {
    kind,
    envVars: {},
    aliases: {},
    functions: {},
    shellOptions: [],
  }

  const envSection = extractSection(output, "ENV_VARS")
  if (envSection) {
    for (const pair of splitNull(envSection)) {
      const eq = pair.indexOf("=")
      if (eq < 0) {
        continue
      }
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (ENV_KEEP.has(key)) {
        snapshot.envVars[key] = value
      }
    }
  }

  const aliasSection = extractSection(output, "ALIASES")
  if (aliasSection) {
    for (const pair of splitNull(aliasSection)) {
      const eq = pair.indexOf("=")
      if (eq < 0) {
        continue
      }
      snapshot.aliases[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
  }

  const funcSection = extractSection(output, "FUNCTIONS")
  if (funcSection) {
    for (const pair of splitNull(funcSection)) {
      const eq = pair.indexOf("=")
      if (eq < 0) {
        continue
      }
      const name = pair.slice(0, eq)
      const body = pair.slice(eq + 1)
      if (!name.startsWith("_") && body.length > 0) {
        snapshot.functions[name] = body
      }
    }
  }

  const optsSection = extractSection(output, "SHELL_OPTIONS")
  if (optsSection) {
    for (const opt of splitNull(optsSection)) {
      snapshot.shellOptions.push(opt)
    }
  }

  return snapshot
}

/** Ordering is load-bearing: unalias → functions → options → aliases → env. */
export function toScript(snapshot: Snapshot): string {
  const lines: string[] = []
  lines.push("# Shell snapshot — auto-generated")
  lines.push("unalias -a 2>/dev/null || true")
  lines.push("")

  lines.push("# Functions")
  for (const name of Object.keys(snapshot.functions).sort()) {
    lines.push(snapshot.functions[name]!)
  }

  lines.push("")
  lines.push("# Shell options")
  if (snapshot.kind === "zsh") {
    for (const opt of snapshot.shellOptions) {
      lines.push(`setopt ${opt}`)
    }
  } else {
    // bash: expand_aliases is required so aliases defined below
    // take effect even when the snapshot is sourced non-interactively.
    lines.push("shopt -s expand_aliases")
    for (const opt of snapshot.shellOptions) {
      lines.push(`shopt -s ${opt}`)
    }
  }

  lines.push("")
  lines.push("# Aliases")
  for (const name of Object.keys(snapshot.aliases).sort()) {
    lines.push(`alias -- ${name}=${snapshot.aliases[name]}`)
  }

  lines.push("")
  lines.push("# Environment")
  for (const name of ["PATH", "HOME", "USER", "SHELL"]) {
    const value = snapshot.envVars[name]
    if (value !== undefined) {
      lines.push(`export ${name}=${shellEscape(value)}`)
    }
  }

  return lines.join("\n") + "\n"
}

function buildExtractionScript(kind: ShellKind): string {
  // Marker-delimited sections, null-separated entries within each
  // section. Null separators let entries contain whitespace, quotes,
  // newlines — the parser splits on \0 and doesn't care about the
  // content in between.
  const rcSource =
    kind === "zsh"
      ? "[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null"
      : "[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null"

  const envBlock = `
echo "==ENV_VARS_START=="
env -0
echo ""
echo "==ENV_VARS_END=="
`.trim()

  const aliasBlock = `
echo "==ALIASES_START=="
alias | while IFS='=' read -r key value; do
  key="\${key#alias }"
  printf "%s=%s\\0" "$key" "$value"
done
echo ""
echo "==ALIASES_END=="
`.trim()

  const funcBlock =
    kind === "zsh"
      ? `
echo "==FUNCTIONS_START=="
print -l \${(ok)functions} | while read func; do
  body=$(typeset -f "$func")
  if [ -n "$body" ]; then
    printf "%s=%s\\0" "$func" "$body"
  fi
done
echo ""
echo "==FUNCTIONS_END=="
`.trim()
      : `
echo "==FUNCTIONS_START=="
declare -F | while read -r _ _ func; do
  body=$(declare -f "$func")
  if [ -n "$body" ]; then
    printf "%s=%s\\0" "$func" "$body"
  fi
done
echo ""
echo "==FUNCTIONS_END=="
`.trim()

  const optsBlock =
    kind === "zsh"
      ? `
echo "==SHELL_OPTIONS_START=="
setopt | while read opt; do
  printf "%s\\0" "$opt"
done
echo ""
echo "==SHELL_OPTIONS_END=="
`.trim()
      : `
echo "==SHELL_OPTIONS_START=="
shopt | while read opt status; do
  if [ "$status" = "on" ]; then
    printf "%s\\0" "$opt"
  fi
done
echo ""
echo "==SHELL_OPTIONS_END=="
`.trim()

  return [rcSource, envBlock, aliasBlock, funcBlock, optsBlock].join("\n\n")
}

function runShell(kind: ShellKind, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -l: login shell, picks up .zprofile/.zshenv / .bash_profile.
    // We source the interactive rc file explicitly inside the script,
    // which avoids -i and its job-control / prompt side effects.
    const child = spawn(kind, ["-l"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8")
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `${kind} snapshot extraction failed (exit ${code}): ${stderr.trim()}`,
          ),
        )
      }
    })

    child.stdin.write(script)
    child.stdin.end()
  })
}

function extractSection(output: string, section: string): string | undefined {
  const start = `==${section}_START==`
  const end = `==${section}_END==`
  const i = output.indexOf(start)
  const j = output.indexOf(end)
  if (i < 0 || j < 0 || i >= j) {
    return undefined
  }
  return output.slice(i + start.length, j).trim()
}

function splitNull(section: string): string[] {
  return section.split("\0").filter((s) => s.length > 0)
}

function shellEscape(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
  return `"${escaped}"`
}
