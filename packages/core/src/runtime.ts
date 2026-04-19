/**
 * @module
 * Runtime interface — coherent journal + workspace pair.
 */

import type { Journal } from "./journal.js"
import type { Workspace } from "./workspace.js"

/**
 * Coherent durable runtime pair. The engine only consumes these two
 * primitives; managed wrappers may extend the shape structurally.
 */
export interface Runtime<W extends Workspace = Workspace> {
  journal: Journal
  workspace: W
}
