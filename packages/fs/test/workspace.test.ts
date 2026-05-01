import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FsWorkspace } from "@ronde/fs"
import { rebase } from "../src/internal.js"
import { useTmp } from "./support.js"

const tmp = useTmp()
afterEach(() => tmp.cleanup())

describe("@ronde/fs workspace spill", () => {
  it("writes spills under tool-results in the runtime directory", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello", { name: "log" })

    const spillPath = fileURLToPath(result.uri)
    expect(spillPath).toBe(path.join(dir, "tool-results", "log.txt"))
    await expect(fs.readFile(spillPath, "utf8")).resolves.toBe("hello")
  })

  it("sanitizes provided spill names before writing files", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello", { name: "../bad:name" })

    expect(path.basename(fileURLToPath(result.uri))).toBe(".._bad_name.txt")
  })

  it("falls back to a generated spill name when none is provided", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello")

    expect(path.basename(fileURLToPath(result.uri))).toMatch(
      /^spill-[0-9a-f]+\.txt$/,
    )
  })

  it("returns absolute file:// URIs", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello", { name: "log" })

    const spillPath = fileURLToPath(result.uri)
    expect(path.isAbsolute(spillPath)).toBe(true)
    expect(result.uri.startsWith("file://")).toBe(true)
  })

  it("reports byte counts from spill content", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)
    const content = "a".repeat(12)

    const result = await workspace.spill(content)

    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"))
  })
})

describe("@ronde/fs workspace capability boundary", () => {
  it("repoints through the internal rebase capability", () => {
    const dir = tmp.dir()
    const nextDir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    workspace[rebase](nextDir)

    expect(workspace.dir).toBe(nextDir)
  })
})
