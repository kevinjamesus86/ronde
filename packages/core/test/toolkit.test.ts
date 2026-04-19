import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { err } from "@ronde/core/result"
import {
  bindToolkitRuntime,
  defaultFormatter,
  formatToolOutput,
  merge,
  tool,
  type ToolContext,
  type Toolkit,
} from "@ronde/core/toolkit"
import { isAsyncGenerator } from "@ronde/core/stream"
import {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"
import { ok } from "@ronde/core/result"

describe("@ronde/core formatToolOutput", () => {
  it("preserves err data when a formatter is registered", () => {
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        throw new Error("not used in this test")
      },
      formatters: {
        shell: (data) => `stderr: ${(data as { stderr: string }).stderr}`,
      },
    }

    const output = formatToolOutput(
      toolkit,
      "shell",
      err("Command failed with exit code 1", {
        stderr: "permission denied",
      }),
    )

    expect(output).toBe(
      "Command failed with exit code 1\nstderr: permission denied",
    )
  })

  it("uses the registered formatter for successful tool output", () => {
    const toolkit = tool({
      name: "greet",
      description: "Greet",
      parameters: z.object({}),
      execute: async () => ok({ name: "world" }),
      format: (data) => `Hello, ${(data as { name: string }).name}!`,
    })

    expect(formatToolOutput(toolkit, "greet", ok({ name: "world" }))).toBe(
      "Hello, world!",
    )
  })

  it("falls back to defaultFormatter when no formatter is registered", () => {
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        throw new Error("not used in this test")
      },
      formatters: {},
    }

    expect(formatToolOutput(toolkit, "echo", ok({ answer: 42 }))).toBe(
      '{"answer":42}',
    )
  })

  it("returns the plain error string when err output carries no data", () => {
    const toolkit = tool({
      name: "noop",
      description: "No-op",
      parameters: z.object({}),
      execute: async () => err("boom"),
      format: () => "not used",
    })

    expect(formatToolOutput(toolkit, "noop", err("boom"))).toBe("boom")
  })
})

describe("@ronde/core defaultFormatter", () => {
  it("passes through string success payloads unchanged", () => {
    expect(defaultFormatter("echo", ok("hello"))).toBe("hello")
  })

  it("returns an empty string for nullish success payloads", () => {
    expect(defaultFormatter("noop", ok(null))).toBe("")
    expect(defaultFormatter("noop", ok(undefined))).toBe("")
  })

  it("stringifies structured success payloads as JSON", () => {
    expect(defaultFormatter("calc", ok({ x: 1 }))).toBe('{"x":1}')
  })

  it("returns the error string for failed output", () => {
    expect(defaultFormatter("calc", err("bad"))).toBe("bad")
  })
})

describe("@ronde/core bindToolkitRuntime", () => {
  it("returns the original toolkit when no runtime factory is present and no dispose exists", () => {
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        return ok(null)
      },
      formatters: {},
    }

    expect(bindToolkitRuntime(toolkit)).toBe(toolkit)
  })

  it("creates a fresh runtime toolkit from the internal factory", async () => {
    let initCount = 0
    const toolkit = tool({
      name: "stateful",
      description: "Stateful",
      parameters: z.object({}),
      state: {
        init: () => ({ id: ++initCount }),
      },
      execute: async (_args, ctx) => ok(ctx.state.id),
    })

    const a = bindToolkitRuntime(toolkit)
    const b = bindToolkitRuntime(toolkit)

    const resultA = await a.execute("stateful", {}, stubCtx())
    const resultB = await b.execute("stateful", {}, stubCtx())

    expect(resultA).toEqual(ok(1))
    expect(resultB).toEqual(ok(2))
  })

  it("wraps dispose so repeated calls are idempotent", async () => {
    let disposeCount = 0
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        return ok(null)
      },
      formatters: {},
      async dispose() {
        disposeCount += 1
      },
    }

    const bound = bindToolkitRuntime(toolkit)
    await bound.dispose?.()
    await bound.dispose?.()

    expect(disposeCount).toBe(1)
  })
})

describe("@ronde/core tool", () => {
  it("builds a stateless toolkit from a Zod schema and executor", async () => {
    const toolkit = tool({
      name: "add",
      description: "Add two numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async (args) => ok({ sum: args.a + args.b }),
    })

    expect(toolkit.schemas[0]).toMatchObject({
      name: "add",
      description: "Add two numbers",
    })
    expect(await toolkit.execute("add", { a: 1, b: 2 }, stubCtx())).toEqual(
      ok({ sum: 3 }),
    )
  })

  it("builds a stateful toolkit with lazy init and disposal", async () => {
    let initCount = 0
    let disposeCount = 0
    const toolkit = tool({
      name: "counter",
      description: "Counter",
      parameters: z.object({}),
      state: {
        init: () => ({ count: ++initCount }),
        dispose: async () => {
          disposeCount += 1
        },
      },
      execute: async (_args, ctx) => ok(ctx.state.count),
    })

    expect(initCount).toBe(0)
    expect(await toolkit.execute("counter", {}, stubCtx())).toEqual(ok(1))
    expect(await toolkit.execute("counter", {}, stubCtx())).toEqual(ok(1))
    expect(initCount).toBe(1)

    await toolkit.dispose?.()
    expect(disposeCount).toBe(1)
  })

  it("binds spill names to call identity in ToolContext.spill", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = tool<RecordingWorkspace>()({
      name: "shell",
      description: "Shell",
      parameters: z.object({}),
      execute: async (_args, ctx) => {
        await ctx.spill("hello")
        return ok(null)
      },
    })

    await toolkit.execute(
      "shell",
      {},
      stubCtx({
        workspace,
        call: { name: "shell", toolUseId: "call-1", arguments: {} },
      }),
    )

    expect(workspace.spills).toHaveLength(1)
    expect(workspace.spills[0]).toMatchObject({ name: "shell-call-1" })
  })

  it("returns err output on schema validation failure", async () => {
    const toolkit = tool({
      name: "calc",
      description: "Calculator",
      parameters: z.object({ x: z.number() }),
      execute: async (args) => ok(args.x),
    })

    const result = await toolkit.execute("calc", { x: "nope" }, stubCtx())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("Invalid arguments for calc")
    }
  })
})

describe("@ronde/core tool — async-generator execute", () => {
  it("passes an async-generator return through as-is for stateless tools", async () => {
    const streaming = tool({
      name: "stream",
      description: "Streams",
      parameters: z.object({}),
      async *execute() {
        yield "chunk-1"
        yield "chunk-2"
        return ok({ done: true })
      },
    })

    const ret = streaming.execute("stream", {}, stubCtx())
    expect(isAsyncGenerator(ret)).toBe(true)

    const chunks: string[] = []
    const gen = ret as AsyncGenerator<string, ReturnType<typeof ok>, void>
    let next = await gen.next()
    while (!next.done) {
      chunks.push(next.value)
      next = await gen.next()
    }
    expect(chunks).toEqual(["chunk-1", "chunk-2"])
    expect(next.value).toEqual(ok({ done: true }))
  })

  it("passes a plain async return through as a Promise for stateless tools", async () => {
    const plain = tool({
      name: "plain",
      description: "Plain",
      parameters: z.object({}),
      execute: async () => ok("done"),
    })

    const ret = plain.execute("plain", {}, stubCtx())
    expect(isAsyncGenerator(ret)).toBe(false)
    expect(await ret).toEqual(ok("done"))
  })

  it("yields zero chunks when the generator has no yield before return", async () => {
    const silent = tool({
      name: "silent",
      description: "Silent",
      parameters: z.object({}),
      // eslint-disable-next-line require-yield
      async *execute() {
        return ok("no-progress")
      },
    })

    const gen = silent.execute("silent", {}, stubCtx()) as AsyncGenerator<
      string,
      ReturnType<typeof ok>,
      void
    >
    const chunks: string[] = []
    let next = await gen.next()
    while (!next.done) {
      chunks.push(next.value)
      next = await gen.next()
    }
    expect(chunks).toEqual([])
    expect(next.value).toEqual(ok("no-progress"))
  })

  it("validates args before iterating the generator", async () => {
    const streaming = tool({
      name: "stream",
      description: "Streams",
      parameters: z.object({ n: z.number() }),
      async *execute() {
        yield "should-not-appear"
        return ok(null)
      },
    })

    const ret = streaming.execute("stream", { n: "bad" }, stubCtx())
    // Validation short-circuits to Promise<err> before execute runs,
    // so the result shape never reflects the generator underneath.
    expect(isAsyncGenerator(ret)).toBe(false)
    const output = await ret
    expect(output.ok).toBe(false)
    if (!output.ok) {
      expect(output.error).toContain("Invalid arguments for stream")
    }
  })

  it("wraps stateful generator tools so state resolves before yielding", async () => {
    let initCount = 0
    const stateful = tool({
      name: "wrapped",
      description: "Wrapped",
      parameters: z.object({}),
      state: {
        init: () => ({ id: ++initCount }),
      },
      async *execute(_args, ctx) {
        yield `state:${ctx.state.id}`
        yield "tick"
        return ok(ctx.state.id)
      },
    })

    const gen = stateful.execute("wrapped", {}, stubCtx()) as AsyncGenerator<
      string,
      ReturnType<typeof ok>,
      void
    >
    const chunks: string[] = []
    let next = await gen.next()
    while (!next.done) {
      chunks.push(next.value)
      next = await gen.next()
    }
    expect(chunks).toEqual(["state:1", "tick"])
    expect(next.value).toEqual(ok(1))
    expect(initCount).toBe(1)
  })
})

describe("@ronde/core merge", () => {
  it("combines schemas, executors, and formatters from multiple toolkits", async () => {
    const greet = tool({
      name: "greet",
      description: "Greet",
      parameters: z.object({ name: z.string() }),
      execute: async (args) => ok({ greeting: `hello ${args.name}` }),
      format: (data) => (data as { greeting: string }).greeting,
    })
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    const merged = merge(greet, echo)

    expect(merged.schemas.map((schema) => schema.name).sort()).toEqual([
      "echo",
      "greet",
    ])
    expect(await merged.execute("greet", { name: "ronde" }, stubCtx())).toEqual(
      ok({ greeting: "hello ronde" }),
    )
    expect(await merged.execute("echo", { text: "hi" }, stubCtx())).toEqual(
      ok("hi"),
    )
    expect(merged.formatters["greet"]?.({ greeting: "hi" })).toBe("hi")
  })

  it("preserves each tool's return shape when dispatching through merge", async () => {
    const streamer = tool({
      name: "s",
      description: "Streamer",
      parameters: z.object({}),
      async *execute() {
        yield "hi"
        return ok("stream-done")
      },
    })
    const awaiter = tool({
      name: "a",
      description: "Awaiter",
      parameters: z.object({}),
      execute: async () => ok("await-done"),
    })

    const merged = merge(streamer, awaiter)

    const streamRet = merged.execute("s", {}, stubCtx())
    expect(isAsyncGenerator(streamRet)).toBe(true)
    const gen = streamRet as AsyncGenerator<string, ReturnType<typeof ok>, void>
    const chunks: string[] = []
    let next = await gen.next()
    while (!next.done) {
      chunks.push(next.value)
      next = await gen.next()
    }
    expect(chunks).toEqual(["hi"])
    expect(next.value).toEqual(ok("stream-done"))

    const plainRet = merged.execute("a", {}, stubCtx())
    expect(isAsyncGenerator(plainRet)).toBe(false)
    expect(await plainRet).toEqual(ok("await-done"))
  })

  it("lets later toolkits win on name collisions", async () => {
    const first = tool({
      name: "dup",
      description: "First",
      parameters: z.object({}),
      execute: async () => ok("first"),
    })
    const second = tool({
      name: "dup",
      description: "Second",
      parameters: z.object({}),
      execute: async () => ok("second"),
    })

    const merged = merge(first, second)

    expect(merged.schemas).toHaveLength(1)
    expect(merged.schemas[0]?.description).toBe("Second")
    expect(await merged.execute("dup", {}, stubCtx())).toEqual(ok("second"))
  })

  it("disposes child toolkits once when the merged toolkit is disposed", async () => {
    let disposeCount = 0
    const first = tool({
      name: "one",
      description: "One",
      parameters: z.object({}),
      state: {
        init: () => ({}),
        dispose: async () => {
          disposeCount += 1
        },
      },
      execute: async () => ok("one"),
    })
    const second = tool({
      name: "two",
      description: "Two",
      parameters: z.object({}),
      state: {
        init: () => ({}),
        dispose: async () => {
          disposeCount += 1
        },
      },
      execute: async () => ok("two"),
    })

    const merged = merge(first, second)
    await merged.execute("one", {}, stubCtx())
    await merged.execute("two", {}, stubCtx())

    await merged.dispose?.()
    await merged.dispose?.()

    expect(disposeCount).toBe(2)
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
    spill: (content, opts) =>
      workspace.spill(content, {
        ...opts,
        name: `${call.name}-${call.toolUseId}`,
      }),
    ...overrides,
  }
}

class RecordingWorkspace extends Workspace {
  readonly id = "workspace-1"
  readonly kind = "test-workspace"
  readonly spills: SpillOpts[] = []

  async spill(content: string, opts: SpillOpts = {}): Promise<SpillResult> {
    this.spills.push(opts)
    return {
      uri: "memory://spill",
      preview: content,
      truncated: false,
      bytes: Buffer.byteLength(content, "utf8"),
    }
  }
}
