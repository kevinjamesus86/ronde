import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
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

    expect(result.path).toBe(path.join(dir, "tool-results", "log.txt"))
    await expect(fs.readFile(result.path, "utf8")).resolves.toBe("hello")
  })

  it("sanitizes provided spill names before writing files", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello", { name: "../bad:name" })

    expect(path.basename(result.path)).toBe(".._bad_name.txt")
  })

  it("falls back to a generated spill name when none is provided", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello")

    expect(path.basename(result.path)).toMatch(/^spill-[0-9a-f]+\.txt$/)
  })

  it("returns file:// URIs and absolute spill paths", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("hello", { name: "log" })

    expect(path.isAbsolute(result.path)).toBe(true)
    expect(result.uri).toBe(`file://${result.path}`)
  })

  it("builds previews and truncation metadata from spill content", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)
    const content = "a".repeat(12)

    const result = await workspace.spill(content, {
      previewHead: 4,
      previewTail: 3,
    })

    expect(result.preview).toContain("aaaa")
    expect(result.truncated).toBe(true)
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
