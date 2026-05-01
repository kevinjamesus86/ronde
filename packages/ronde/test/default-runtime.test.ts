import { afterEach, describe, expect, it } from "vitest"
import path from "node:path"
import { createRuntime } from "../src/managed.js"
import { useTmp, withEnv } from "./support.js"

const tmp = useTmp()

afterEach(() => {
  tmp.cleanup()
})

describe("@ronde createRuntime", () => {
  it("creates a managed fs runtime when no options are supplied", async () => {
    const root = tmp.dir("ronde-default-runtime-")

    await withEnv("RONDE_HOME", root, async () => {
      const runtime = await createRuntime()
      expect(runtime.journal.id).toBe(runtime.workspace.id)
      expect(runtime.workspace.kind).toBe("fs")
      expect(
        runtime.workspace.dir.startsWith(path.join(root, "projects")),
      ).toBe(true)
    })
  })

  it("creates a managed fs runtime when managed options are supplied", async () => {
    const root = tmp.dir("ronde-managed-runtime-")

    const runtime = await createRuntime({
      root,
      project: "acme",
      name: "named-run",
    })

    expect(runtime.workspace.kind).toBe("fs")
    expect(runtime.workspace.dir).toContain(path.join("projects", "acme"))
    expect(runtime.workspace.dir).toContain("named-run")
  })
})
