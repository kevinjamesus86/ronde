import { describe, expect, it } from "vitest"
import type { Awaitable } from "@ronde/core"
import type { Runtime } from "@ronde/core/runtime"
import { Journal, type JournalEvent } from "@ronde/core/journal"
import {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"

describe("@ronde/core runtime contract", () => {
  it("treats Runtime as the coherent journal plus workspace pair", () => {
    const runtime: Runtime<TestWorkspace> = {
      journal: new TestJournal(),
      workspace: new TestWorkspace(),
    }

    expect(runtime.journal.id).toBe("journal-1")
    expect(runtime.workspace.id).toBe("workspace-1")
  })

  it("allows richer managed runtime objects to extend the pair structurally", () => {
    const runtime: Runtime<TestWorkspace> & { path: string } = {
      journal: new TestJournal(),
      workspace: new TestWorkspace(),
      path: "/tmp/ronde",
    }

    expect(runtime.path).toBe("/tmp/ronde")
    expect(runtime.workspace.kind).toBe("test-workspace")
  })

  it("covers Runtime shape compatibility in type tests", () => {
    const runtime: Runtime = {
      journal: new TestJournal(),
      workspace: new TestWorkspace(),
    }

    expect("journal" in runtime).toBe(true)
    expect("workspace" in runtime).toBe(true)
  })
})

class TestJournal extends Journal {
  readonly id = "journal-1"
  readonly kind = "test-journal"

  async event(_event: JournalEvent): Promise<void> {}

  async scan(
    _onEvent: (event: JournalEvent) => Awaitable<boolean | void>,
  ): Promise<void> {}

  async partition(
    _reason: string,
    _nextEvents?: readonly JournalEvent[],
  ): Promise<void> {}
}

class TestWorkspace extends Workspace {
  readonly id = "workspace-1"
  readonly kind = "test-workspace"

  async spill(_content: string, _opts?: SpillOpts): Promise<SpillResult> {
    return {
      uri: "memory://workspace/test",
      bytes: 0,
    }
  }
}
