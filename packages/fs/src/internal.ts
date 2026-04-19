/**
 * @module
 * Module-private capability token for the fs runtime backend.
 *
 * `rebase` keys the repoint-to-new-path method on FsJournal and
 * FsWorkspace. Symbol-keyed so the method has no string name — it does
 * not surface in autocomplete or property lookup for callers that have
 * not imported the symbol.
 *
 * Exported only from this file and never re-exported through a public
 * subpath. Relative imports from outside `packages/fs/` are visible in
 * code review and obviously wrong.
 */

export const rebase: unique symbol = Symbol("ronde.fs.rebase")
