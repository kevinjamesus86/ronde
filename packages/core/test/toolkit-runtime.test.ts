import { describe, expect, it, vi } from "vitest"
import { z } from "zod/v4"
import { ok } from "@ronde/core/result"
import { drain } from "@ronde/core/stream"
import { bindToolkitRuntime, merge, tool } from "@ronde/core/toolkit"
import type { ToolContext } from "@ronde/core/toolkit"
import {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"

describe("@ronde/core toolkit runtime lifecycle", () => {
  it("shares one init attempt across concurrent first calls", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const init = vi.fn(async () => {
      await gate
      return { count: 0 }
    })
    const toolkit = tool({
      name: "counter",
      description: "Count",
      parameters: z.object({}),
      state: { init },
      execute: async (_args, ctx) => ok(ctx.state.count),
    })

    const p1 = drain(toolkit.execute("counter", {}, stubCtx()))
    const p2 = drain(toolkit.execute("counter", {}, stubCtx()))
    const p3 = drain(toolkit.execute("counter", {}, stubCtx()))

    release()
    const results = await Promise.all([p1, p2, p3])

    expect(init).toHaveBeenCalledOnce()
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it("retries init on the next call after a failed shared init attempt", async () => {
    let attempt = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const toolkit = tool({
      name: "counter",
      description: "Count",
      parameters: z.object({}),
      state: {
        init: async () => {
          attempt++
          if (attempt === 1) {
            await gate
            throw new Error("boom")
          }
          return { attempt }
        },
      },
      execute: async (_args, ctx) => ok(ctx.state.attempt),
    })

    const p1 = toolkit.execute("counter", {}, stubCtx())
    const p2 = toolkit.execute("counter", {}, stubCtx())
    release()

    const failed = await Promise.allSettled([p1, p2])
    expect(failed.every((result) => result.status === "rejected")).toBe(true)

    const retried = await toolkit.execute("counter", {}, stubCtx())
    expect(attempt).toBe(2)
    expect(retried).toEqual(ok(2))
  })

  it("resets lifecycle after dispose and re-inits on the next execute", async () => {
    let initCount = 0
    const toolkit = tool({
      name: "counter",
      description: "Count",
      parameters: z.object({}),
      state: {
        init: () => ({ run: ++initCount }),
      },
      execute: async (_args, ctx) => ok(ctx.state.run),
    })

    expect(await toolkit.execute("counter", {}, stubCtx())).toEqual(ok(1))
    await toolkit.dispose?.()
    expect(await toolkit.execute("counter", {}, stubCtx())).toEqual(ok(2))
  })

  it("throws when a bound runtime is executed after dispose", async () => {
    const toolkit = tool({
      name: "inner",
      description: "Inner",
      parameters: z.object({}),
      state: {
        init: () => ({ x: 1 }),
      },
      execute: async (_args, ctx) => ok(ctx.state.x),
    })

    const runtime = bindToolkitRuntime(toolkit)
    await runtime.execute("inner", {}, stubCtx())
    await runtime.dispose?.()

    await expect(runtime.execute("inner", {}, stubCtx())).rejects.toThrow(
      /executed after the engine has completed/,
    )
  })

  it("merged runtimes continue disposing even when one child throws", async () => {
    const disposed: string[] = []
    const bad = tool({
      name: "bad",
      description: "Bad",
      parameters: z.object({}),
      state: {
        init: () => ({ x: 1 }),
        dispose: async () => {
          throw new Error("boom")
        },
      },
      execute: async () => ok(null),
    })
    const good = tool({
      name: "good",
      description: "Good",
      parameters: z.object({}),
      state: {
        init: () => ({ y: 2 }),
        dispose: async () => {
          disposed.push("good")
        },
      },
      execute: async () => ok(null),
    })

    const merged = merge(bad, good)
    await merged.execute("bad", {}, stubCtx())
    await merged.execute("good", {}, stubCtx())
    await merged.dispose?.()

    expect(disposed).toEqual(["good"])
  })
})

function stubCtx(
  overrides: Partial<ToolContext<RecordingWorkspace>> = {},
): ToolContext<RecordingWorkspace> {
  const workspace = overrides.workspace ?? new RecordingWorkspace()
  const call = {
    toolUseId: "test-call",
    name: "test-tool",
    arguments: {},
    ...overrides.call,
  }

  return {
    turn: 1,
    abort: new AbortController().signal,
    messages: [],
    workspace,
    call,
    ...overrides,
  }
}

class RecordingWorkspace extends Workspace {
  readonly id = "recording"
  readonly kind = "recording" as const

  async spill(_content: string, _opts?: SpillOpts): Promise<SpillResult> {
    return {
      uri: "memory://spill/1",
      bytes: 0,
    }
  }
}
