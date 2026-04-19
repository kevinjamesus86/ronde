import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { WriteFileData } from "./types.js"
import { fsTool } from "./fs-tool.js"

type WriteArgs = z.infer<typeof parameters>

const parameters = z.object({
  file_path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("The content to write to the file"),
})

/**
 * Write a file. Overwrites existing content, creates parent
 * directories, and rejects targets outside any `rw` root.
 */
export const writeFile = (pathCtx: PathContext) =>
  fsTool({
    name: "write_file",
    description:
      "Write a file to disk. Overwrites if it exists. Creates parent directories as needed.",
    parameters,
    execute: (args, ctx) =>
      write(pathContextForWorkspace(pathCtx, ctx.workspace), args),
    format: (data) => `OK — ${data.bytesWritten} bytes written`,
  })

async function write(pathCtx: PathContext, args: WriteArgs) {
  const check = pathCtx.safeWrite(args.file_path)
  if (!check.ok) {
    return err(check.error)
  }
  await fs.mkdir(path.dirname(check.path), { recursive: true })
  await fs.writeFile(check.path, args.content, "utf-8")
  return ok<WriteFileData>({
    path: check.path,
    bytesWritten: args.content.length,
  })
}
