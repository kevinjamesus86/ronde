import { describe, expect, it } from "vitest"
import { createMemRuntime } from "../src/runtime.js"
import { MemoryJournal } from "../src/journal.js"
import { MemoryWorkspace } from "../src/workspace.js"

describe("@ronde/mem createMemRuntime", () => {
  it("returns a fresh memory journal and memory workspace pair", () => {
    const runtime = createMemRuntime()

    expect(runtime.journal).toBeInstanceOf(MemoryJournal)
    expect(runtime.workspace).toBeInstanceOf(MemoryWorkspace)
  })

  it("allocates matching runtime identities for the pair", () => {
    const runtime = createMemRuntime()

    expect(runtime.journal.id).toBe(runtime.workspace.id)
  })

  it("returns isolated state across repeated calls", async () => {
    const a = createMemRuntime()
    const b = createMemRuntime()

    await a.journal.event({ type: "warning", turn: 1, message: "a" })
    await a.workspace.spill("alpha")
    await b.workspace.spill("beta")

    expect(a.journal).not.toBe(b.journal)
    expect(a.workspace).not.toBe(b.workspace)
    expect(a.journal.id).not.toBe(b.journal.id)
    expect(a.workspace.resources.size).toBe(1)
    expect(b.workspace.resources.size).toBe(1)
    expect(a.workspace.resources).not.toBe(b.workspace.resources)
  })
})
