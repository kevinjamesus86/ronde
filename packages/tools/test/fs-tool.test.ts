import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { ok } from "@ronde/core/result"
import { fsTool } from "../src/fs-tool.js"
import { execTool, TestDirectoryWorkspace, useTmp } from "./support.js"

describe("@ronde/tools fs tool scaffolding", () => {
  it("passes the workspace through to tool contexts", async () => {
    const tmp = useTmp()
    const dir = tmp.dir()
    const workspace = new TestDirectoryWorkspace("ws", dir)
    const toolkit = fsTool({
      name: "workspace_id",
      description: "Return the workspace id",
      parameters: z.object({}),
      execute: async (_args, ctx) => ok({ id: ctx.workspace.id }),
      format: (data) => JSON.stringify(data),
    })

    const result = await execTool(toolkit, "workspace_id", {}, workspace)

    expect(result).toEqual(ok({ id: "ws" }))
    tmp.cleanup()
  })

  it("produces schemas through the shared tool factory", () => {
    const toolkit = fsTool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ path: z.string() }),
      execute: async () => ok("ok"),
    })

    expect(toolkit.schemas[0]?.name).toBe("echo")
  })
})
