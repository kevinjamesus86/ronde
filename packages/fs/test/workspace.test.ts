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

describe("@ronde/fs workspace binary spill", () => {
  it("writes Uint8Array content as raw bytes with a mediaType-derived extension", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

    const result = await workspace.spill(png, {
      name: "screenshot",
      mediaType: "image/png",
    })

    const spillPath = fileURLToPath(result.uri)
    expect(spillPath).toBe(path.join(dir, "tool-results", "screenshot.png"))
    expect(result.bytes).toBe(4)
    const onDisk = await fs.readFile(spillPath)
    expect(onDisk.equals(Buffer.from(png))).toBe(true)
  })

  it("falls back to .bin for binary content without a mediaType", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)
    const bytes = new Uint8Array([1, 2, 3])

    const result = await workspace.spill(bytes, { name: "raw" })

    expect(path.basename(fileURLToPath(result.uri))).toBe("raw.bin")
  })

  it("derives extensions from mediaType subtypes when not in the known list", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill(new Uint8Array([0]), {
      name: "data",
      mediaType: "application/x-custom",
    })

    expect(path.basename(fileURLToPath(result.uri))).toBe("data.x-custom")
  })

  it("threads mediaType through for text spills (text/markdown → .md)", async () => {
    const dir = tmp.dir()
    const workspace = new FsWorkspace("rt-1", dir)

    const result = await workspace.spill("# title", {
      name: "doc",
      mediaType: "text/markdown",
    })

    expect(path.basename(fileURLToPath(result.uri))).toBe("doc.md")
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
