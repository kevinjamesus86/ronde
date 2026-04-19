import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PathContext, ro, rw } from "../src/context.js"
import { useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools PathContext roots", () => {
  it("normalizes bare string roots as read-write roots", () => {
    const root = tmp.dir()
    const ctx = new PathContext([root])

    expect(ctx.roots).toEqual([fs.realpathSync(root)])
    expect(ctx.writableRoots).toEqual([fs.realpathSync(root)])
  })

  it("preserves explicit read-only and read-write root access", () => {
    const readRoot = tmp.dir()
    const writeRoot = tmp.dir()
    const ctx = new PathContext([ro(readRoot), rw(writeRoot)])

    expect(ctx.roots).toEqual([
      fs.realpathSync(readRoot),
      fs.realpathSync(writeRoot),
    ])
    expect(ctx.writableRoots).toEqual([fs.realpathSync(writeRoot)])
  })

  it("adds and removes roots after construction", () => {
    const a = tmp.dir()
    const b = tmp.dir()
    const ctx = new PathContext([a])

    ctx.addRoot(ro(b))
    expect(ctx.roots).toContain(fs.realpathSync(b))
    expect(ctx.writableRoots).not.toContain(fs.realpathSync(b))

    ctx.removeRoot(ro(b))
    expect(ctx.roots).not.toContain(fs.realpathSync(b))
  })

  it("clones contexts with an additional root", () => {
    const a = tmp.dir()
    const b = tmp.dir()
    const base = new PathContext([a])
    const clone = base.cloneWithRoot(ro(b))

    expect(base.roots).toEqual([fs.realpathSync(a)])
    expect(clone.roots).toEqual([fs.realpathSync(a), fs.realpathSync(b)])
  })
})

describe("@ronde/tools PathContext path safety", () => {
  it("rejects relative paths", () => {
    const ctx = new PathContext([tmp.dir()])

    expect(ctx.safeRead("relative.txt")).toEqual({
      ok: false,
      error: "file_path must be absolute, got relative path: relative.txt",
    })
  })

  it("accepts paths contained within declared roots", () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    fs.writeFileSync(file, "hello")
    const ctx = new PathContext([root])

    expect(ctx.safeRead(file)).toEqual({
      ok: true,
      path: fs.realpathSync(file),
    })
  })

  it("rejects paths that escape declared roots", () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const file = path.join(outside, "file.txt")
    fs.writeFileSync(file, "hello")
    const ctx = new PathContext([root])

    expect(ctx.safeRead(file)).toEqual({
      ok: false,
      error: `file_path escapes allowed directories: ${file}`,
    })
  })

  it("rejects writes into read-only roots", () => {
    const root = tmp.dir()
    const file = path.join(root, "file.txt")
    fs.writeFileSync(file, "hello")
    const ctx = new PathContext([ro(root)])

    expect(ctx.safeWrite(file)).toEqual({
      ok: false,
      error: `file_path is in a read-only path: ${file}`,
    })
  })

  it("resolves symlinks through realpath when checking boundaries", () => {
    const root = tmp.dir()
    const outside = tmp.dir()
    const secret = path.join(outside, "secret.txt")
    const link = path.join(root, "link.txt")
    fs.writeFileSync(secret, "shh")
    fs.symlinkSync(secret, link)
    const ctx = new PathContext([root])

    expect(ctx.safeRead(link)).toEqual({
      ok: false,
      error: `file_path escapes allowed directories: ${link}`,
    })
  })

  it("validates directory paths for shell cwd and traversal inputs", () => {
    const root = tmp.dir()
    const dir = path.join(root, "subdir")
    const file = path.join(root, "file.txt")
    fs.mkdirSync(dir)
    fs.writeFileSync(file, "hello")
    const ctx = new PathContext([root])

    expect(ctx.safeDirectoryPath(dir)).toEqual({
      ok: true,
      path: fs.realpathSync(dir),
    })
    expect(ctx.safeDirectoryPath(file)).toEqual({
      ok: false,
      error: `Not a directory: ${file}`,
    })
  })
})

describe("@ronde/tools PathContext sandbox profile", () => {
  it("emits a roots-restricted read profile when requested", () => {
    const root = tmp.dir()
    const ctx = new PathContext([root])
    const profile = ctx.sandboxProfile({ reads: "roots" })

    expect(profile).toContain("(deny file-read*)")
    expect(profile).toContain(`(subpath "${fs.realpathSync(root)}")`)
  })

  it("restricts writes to writable roots by default", () => {
    const readRoot = tmp.dir()
    const writeRoot = tmp.dir()
    const ctx = new PathContext([ro(readRoot), rw(writeRoot)])
    const profile = ctx.sandboxProfile()

    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain(`(subpath "${fs.realpathSync(writeRoot)}")`)
    expect(profile).not.toContain(`(subpath "${fs.realpathSync(readRoot)}")`)
  })

  it("can deny network access in the generated sandbox profile", () => {
    const ctx = new PathContext([tmp.dir()])
    const profile = ctx.sandboxProfile({ network: false })

    expect(profile).toContain("(deny network*)")
  })
})
