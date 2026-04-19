import fs from "node:fs/promises"
import { z } from "zod/v4"
import { ok, err } from "@ronde/core/result"
import type { PathContext } from "./context.js"
import { pathContextForWorkspace } from "./workspace-path.js"
import type { EditFileData } from "./types.js"
import { fsTool } from "./fs-tool.js"

type EditArgs = z.infer<typeof parameters>

const parameters = z.object({
  file_path: z.string().describe("Absolute path to the file to modify"),
  old_string: z.string().describe("The text to replace"),
  new_string: z.string().describe("The replacement text"),
})

/**
 * Exact string replacement. `old_string` must occur exactly once; zero
 * or multiple matches return an error rather than guessing.
 */
export const editFile = (pathCtx: PathContext) =>
  fsTool({
    name: "edit_file",
    description:
      "Exact string replacement in a file. old_string must appear exactly once.",
    parameters,
    execute: (args, ctx) =>
      edit(pathContextForWorkspace(pathCtx, ctx.workspace), args),
    format: () => "OK",
  })

async function edit(pathCtx: PathContext, args: EditArgs) {
  const check = pathCtx.safeWrite(args.file_path)
  if (!check.ok) {
    return err(check.error)
  }
  let content: string
  try {
    content = await fs.readFile(check.path, "utf-8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return err(`File not found: ${args.file_path}`)
    }
    return err((e as Error).message)
  }
  const idx = content.indexOf(args.old_string)
  if (idx === -1) {
    return err(
      `old_string not found in ${args.file_path}\nHint: Ensure the old_string matches exactly (including whitespace).`,
    )
  }
  const secondIdx = content.indexOf(args.old_string, idx + 1)
  if (secondIdx !== -1) {
    return err(
      `old_string is not unique in ${args.file_path} (found at positions ${idx} and ${secondIdx})`,
    )
  }
  const updated =
    content.slice(0, idx) +
    args.new_string +
    content.slice(idx + args.old_string.length)
  await fs.writeFile(check.path, updated, "utf-8")
  return ok<EditFileData>({ path: check.path })
}
