import type { Workspace } from "@ronde/core/workspace"
import { PathContext, ro } from "./context.js"

/**
 * Add the active workspace's local directory as a read-only root
 * when present, so tools can read spilled artifacts back without
 * widening write scope. Workspaces without a local `dir` pass
 * through unchanged.
 */
export function pathContextForWorkspace(
  base: PathContext,
  workspace: Workspace,
): PathContext {
  if ("dir" in workspace && typeof workspace.dir === "string") {
    return base.cloneWithRoot(ro(workspace.dir))
  }
  return base
}
