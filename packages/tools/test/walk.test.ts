import { afterEach, describe, expect, it } from "vitest"
import { walk } from "../src/walk.js"
import { useTmp } from "./support.js"

const tmp = useTmp()

afterEach(() => tmp.cleanup())

describe("@ronde/tools walk helpers", () => {
  it("walks directory trees in stable order", async () => {
    const dir = tmp.dir()
    tmp.write(dir, {
      "b.txt": "b",
      "a.txt": "a",
      nested: { "c.txt": "c" },
    })

    await expect(walk({ cwd: dir })).resolves.toEqual([
      "a.txt",
      "b.txt",
      "nested/c.txt",
    ])
  })

  it("respects gitignore filtering when enabled", async () => {
    const dir = tmp.dir()
    tmp.write(dir, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "a",
      "ignored.txt": "b",
    })

    await expect(walk({ cwd: dir, gitignore: true })).resolves.toEqual([
      "kept.txt",
    ])
  })

  it("includes ignored paths when gitignore filtering is disabled", async () => {
    const dir = tmp.dir()
    tmp.write(dir, {
      ".gitignore": "ignored.txt\n",
      "kept.txt": "a",
      "ignored.txt": "b",
    })

    await expect(walk({ cwd: dir, gitignore: false })).resolves.toEqual([
      "ignored.txt",
      "kept.txt",
    ])
  })

  it("includes descendants within the requested traversal depth", async () => {
    const dir = tmp.dir()
    tmp.write(dir, {
      nested: {
        "one.txt": "a",
        deeper: { "two.txt": "b" },
      },
    })

    const results = await walk({ cwd: dir, deep: 2, onlyFiles: false })

    expect(results).toContain("nested/")
    expect(results).toContain("nested/one.txt")
    expect(results).toContain("nested/deeper/two.txt")
  })
})
