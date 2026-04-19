import { describe, expect, it } from "vitest"
import {
  capture,
  detectShellKind,
  parse,
  toScript,
  type Snapshot,
} from "../src/shell-snapshot.js"

describe("@ronde/tools shell-snapshot detectShellKind", () => {
  it("returns zsh for a zsh path", () => {
    expect(detectShellKind("/bin/zsh")).toBe("zsh")
    expect(detectShellKind("/opt/homebrew/bin/zsh")).toBe("zsh")
  })

  it("returns bash for a bash path", () => {
    expect(detectShellKind("/bin/bash")).toBe("bash")
    expect(detectShellKind("/usr/local/bin/bash")).toBe("bash")
  })

  it("returns undefined for unknown shells or empty input", () => {
    expect(detectShellKind("")).toBeUndefined()
    expect(detectShellKind("/usr/bin/fish")).toBeUndefined()
  })
})

describe("@ronde/tools shell-snapshot parse", () => {
  it("extracts env vars, filtering to the keep-list", () => {
    const output = [
      "==ENV_VARS_START==",
      "PATH=/usr/bin:/bin\0HOME=/home/test\0RANDOM_VAR=ignored\0USER=tester\0",
      "==ENV_VARS_END==",
    ].join("\n")

    const snap = parse(output, "bash")
    expect(snap.envVars).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      USER: "tester",
    })
    expect(snap.envVars.RANDOM_VAR).toBeUndefined()
  })

  it("extracts aliases", () => {
    const output = [
      "==ALIASES_START==",
      "ll='ls -la'\0gs='git status'\0",
      "==ALIASES_END==",
    ].join("\n")

    const snap = parse(output, "zsh")
    expect(snap.aliases).toEqual({
      ll: "'ls -la'",
      gs: "'git status'",
    })
  })

  it("extracts function bodies, skipping internal _-prefixed names", () => {
    const output = [
      "==FUNCTIONS_START==",
      "hello=hello () {\n  echo hi\n}\0_internal=_internal () { :; }\0",
      "==FUNCTIONS_END==",
    ].join("\n")

    const snap = parse(output, "bash")
    expect(Object.keys(snap.functions)).toEqual(["hello"])
    expect(snap.functions.hello).toContain("echo hi")
  })

  it("extracts shell options as a list", () => {
    const output = [
      "==SHELL_OPTIONS_START==",
      "interactivecomments\0nomatch\0",
      "==SHELL_OPTIONS_END==",
    ].join("\n")

    const snap = parse(output, "zsh")
    expect(snap.shellOptions).toEqual(["interactivecomments", "nomatch"])
  })

  it("returns empty sections when markers are missing", () => {
    const snap = parse("no markers here", "bash")
    expect(snap.envVars).toEqual({})
    expect(snap.aliases).toEqual({})
    expect(snap.functions).toEqual({})
    expect(snap.shellOptions).toEqual([])
  })
})

describe("@ronde/tools shell-snapshot toScript", () => {
  const base: Snapshot = {
    kind: "bash",
    envVars: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/test",
      USER: "tester",
      SHELL: "/bin/bash",
    },
    aliases: { ll: "'ls -la'", gs: "'git status'" },
    functions: { hello: "hello () {\n  echo hi\n}" },
    shellOptions: ["expand_aliases", "nocaseglob"],
  }

  it("unaliases first so user aliases don't leak in", () => {
    const script = toScript(base)
    expect(script.indexOf("unalias -a")).toBeLessThan(
      script.indexOf("alias -- "),
    )
  })

  it("orders functions → options → aliases → env", () => {
    const script = toScript(base)
    const iFunc = script.indexOf("hello () {")
    const iOpts = script.indexOf("shopt -s")
    const iAlias = script.indexOf("alias -- ")
    const iEnv = script.indexOf("export PATH=")
    expect(iFunc).toBeLessThan(iOpts)
    expect(iOpts).toBeLessThan(iAlias)
    expect(iAlias).toBeLessThan(iEnv)
  })

  it("uses bash-specific shopt for options and forces expand_aliases", () => {
    const script = toScript(base)
    expect(script).toContain("shopt -s expand_aliases")
    expect(script).toContain("shopt -s nocaseglob")
  })

  it("uses zsh-specific setopt when kind is zsh", () => {
    const script = toScript({
      ...base,
      kind: "zsh",
      shellOptions: ["interactivecomments"],
    })
    expect(script).toContain("setopt interactivecomments")
    expect(script).not.toContain("shopt -s")
  })

  it("only exports whitelisted env vars", () => {
    const script = toScript({
      ...base,
      envVars: { ...base.envVars, SECRET: "leaked" },
    })
    expect(script).toContain("export PATH=")
    expect(script).toContain("export HOME=")
    expect(script).toContain("export USER=")
    expect(script).toContain("export SHELL=")
    expect(script).not.toContain("SECRET")
    expect(script).not.toContain("leaked")
  })

  it("single-quotes values without embedded single quotes", () => {
    const script = toScript({
      ...base,
      envVars: { PATH: "/usr/bin:/bin" },
    })
    expect(script).toContain("export PATH='/usr/bin:/bin'")
  })

  it("double-quotes and escapes values that contain single quotes", () => {
    const script = toScript({
      ...base,
      envVars: { HOME: "/home/o'brien" },
    })
    // Single-quote in value forces double-quote form with backslash
    // escapes for $, `, ", \.
    expect(script).toMatch(/export HOME="\/home\/o'brien"/)
  })
})

describe("@ronde/tools shell-snapshot capture", () => {
  it.skipIf(process.platform === "win32")(
    "captures env + aliases from a real bash subprocess",
    async () => {
      const snap = await capture("bash")
      expect(snap.kind).toBe("bash")
      // PATH is always set in any reasonable shell environment.
      expect(snap.envVars.PATH).toBeDefined()
      // Sanity: capture produced a live subprocess and parsed its
      // stdout — shellOptions should be a non-empty list.
      expect(snap.shellOptions.length).toBeGreaterThan(0)
    },
  )
})
