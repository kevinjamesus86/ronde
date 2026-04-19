import { isDirectoryWorkspace, type Workspace } from "@ronde/core/workspace"
import { PathContext, ro } from "./context.js"

/**
 * Add the active directory-backed workspace as a read-only root so
 * tools can read spilled artifacts back without widening write scope.
 * Non-directory workspaces pass through unchanged.
 */
export function pathContextForWorkspace(
  base: PathContext,
  workspace: Workspace,
): PathContext {
  if (isDirectoryWorkspace(workspace)) {
    return base.cloneWithRoot(ro(workspace.dir))
  }
  return base
}
