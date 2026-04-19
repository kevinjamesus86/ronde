import { genId } from "@ronde/core/id"
import { MemoryJournal } from "./journal.js"
import { MemoryWorkspace } from "./workspace.js"
import type { Runtime } from "@ronde/core/runtime"

export function createMemRuntime(): Runtime<MemoryWorkspace> {
  const id = genId("rt")
  return {
    journal: new MemoryJournal(id),
    workspace: new MemoryWorkspace(id),
  }
}
