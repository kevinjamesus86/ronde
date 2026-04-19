import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { ok } from "@ronde/core/result"
import { fsTool } from "../src/fs-tool.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

describe("@ronde/tools fs tool scaffolding", () => {
  it("binds directory-backed workspace capability into tool contexts", async () => {
    const tmp = useTmp()
    const dir = tmp.dir()
    const workspace = new TestDirectoryWorkspace("ws", dir)
    const toolkit = fsTool({
      name: "workspace_dir",
      description: "Return the workspace dir",
      parameters: z.object({}),
      execute: async (_args, ctx) => ok({ dir: ctx.workspace.dir }),
      format: (data) => JSON.stringify(data),
    })

    const result = await execTool(toolkit, "workspace_dir", {}, workspace)

    expect(result).toEqual(ok({ dir }))
    tmp.cleanup()
  })

  it("produces directory-pinned schemas through the shared tool factory", () => {
    const toolkit = fsTool({
      name: "echo_dir",
      description: "Echo",
      parameters: z.object({ path: z.string() }),
      execute: async () => ok("ok"),
    })

    expect(toolkit.schemas[0]?.name).toBe("echo_dir")
  })
})
