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
    const spillA = await a.workspace.spill("alpha")
    const spillB = await b.workspace.spill("beta")

    expect(a.journal).not.toBe(b.journal)
    expect(a.workspace).not.toBe(b.workspace)
    expect(a.journal.id).not.toBe(b.journal.id)
    // Each workspace only reads its own spill.
    expect(a.workspace.read(spillA.uri)).toBe("alpha")
    expect(a.workspace.read(spillB.uri)).toBeUndefined()
    expect(b.workspace.read(spillB.uri)).toBe("beta")
    expect(b.workspace.read(spillA.uri)).toBeUndefined()
  })
})
