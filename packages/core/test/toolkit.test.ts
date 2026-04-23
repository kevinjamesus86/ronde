import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { err } from "@ronde/core/result"
import {
  bindToolkitRuntime,
  defaultFormatter,
  formatToolResult,
  merge,
  tool,
  type ToolContext,
  type Toolkit,
} from "@ronde/core/toolkit"
import { drain, isAsyncGenerator } from "@ronde/core/stream"
import { utf8ByteLength } from "@ronde/core/bytes"
import {
  Workspace,
  type SpillOpts,
  type SpillResult,
} from "@ronde/core/workspace"
import { ok } from "@ronde/core/result"

describe("@ronde/core formatToolResult", () => {
  it("preserves err data when a formatter is registered", async () => {
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        throw new Error("not used in this test")
      },
      formatters: {
        shell: (data) => `stderr: ${(data as { stderr: string }).stderr}`,
      },
    }

    const output = await formatToolResult(
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

  it("uses the registered formatter for successful tool output", async () => {
    const toolkit = tool({
      name: "greet",
      description: "Greet",
      parameters: z.object({}),
      execute: async () => ok({ name: "world" }),
      format: (data) => `Hello, ${(data as { name: string }).name}!`,
    })

    expect(
      await formatToolResult(toolkit, "greet", ok({ name: "world" })),
    ).toBe("Hello, world!")
  })

  it("falls back to defaultFormatter when no formatter is registered", async () => {
    const toolkit: Toolkit = {
      schemas: [],
      async execute() {
        throw new Error("not used in this test")
      },
      formatters: {},
    }

    expect(await formatToolResult(toolkit, "echo", ok({ answer: 42 }))).toBe(
      '{"answer":42}',
    )
  })

  it("returns the plain error string when err output carries no data", async () => {
    const toolkit = tool({
      name: "noop",
      description: "No-op",
      parameters: z.object({}),
      execute: async () => err("boom"),
      format: () => "not used",
    })

    expect(await formatToolResult(toolkit, "noop", err("boom"))).toBe("boom")
  })
})

describe("@ronde/core formatToolResult framework truncation", () => {
  class RecordingWorkspace extends Workspace {
    readonly id = "recording"
    readonly kind = "recording"
    spills: { content: string; opts: SpillOpts | undefined }[] = []
    async spill(content: string, opts?: SpillOpts): Promise<SpillResult> {
      this.spills.push({ content, opts })
      return {
        uri: `memory://spill/${this.spills.length}`,
        bytes: content.length,
      }
    }
  }

  function makeToolkit(
    name: string,
    truncate?: "head" | "tail" | "middle",
  ): Toolkit {
    return {
      schemas: [],
      async execute() {
        return ok(null)
      },
      formatters: {
        [name]: (data) => (data as { text: string }).text,
      },
      ...(truncate ? { truncate: { [name]: truncate } } : {}),
    }
  }

  it("no-ops when output fits the inline budget", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo")
    const out = await formatToolResult(
      toolkit,
      "echo",
      ok({ text: "small payload" }),
      { workspace, toolUseId: "call-1", maxInline: 100 },
    )

    expect(out).toBe("small payload")
    expect(workspace.spills).toHaveLength(0)
  })

  it("spills and keeps the head slice on default (head) strategy", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo")
    const big = "x".repeat(50) + "y".repeat(50)
    const out = await formatToolResult(toolkit, "echo", ok({ text: big }), {
      workspace,
      toolUseId: "call-1",
      maxInline: 30,
    })

    expect(workspace.spills).toHaveLength(1)
    expect(workspace.spills[0]!.content).toBe(big)
    expect(workspace.spills[0]!.opts).toEqual({ name: "echo-call-1" })
    // Head slice: first 30 chars, marker, hint — no tail of original.
    expect(out.startsWith("x".repeat(30))).toBe(true)
    expect(out).toContain("70 characters truncated")
    expect(out).toContain("[Full output at memory://spill/1 (100 bytes).]")
    expect(out).not.toContain("y".repeat(10))
  })

  it("keeps the tail slice on tail strategy", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("shell", "tail")
    const big = "x".repeat(50) + "y".repeat(50)
    const out = await formatToolResult(toolkit, "shell", ok({ text: big }), {
      workspace,
      toolUseId: "call-2",
      maxInline: 30,
    })

    expect(out).toContain("y".repeat(30))
    expect(out).not.toContain("x".repeat(40))
    expect(out).toContain("[Full output at memory://spill/1 (100 bytes).]")
  })

  it("keeps both ends on middle strategy", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("grep", "middle")
    const big = "h".repeat(50) + "m".repeat(50) + "t".repeat(50)
    const out = await formatToolResult(toolkit, "grep", ok({ text: big }), {
      workspace,
      toolUseId: "call-3",
      maxInline: 40,
    })

    // half = 20 chars from each end
    expect(out.startsWith("h".repeat(20))).toBe(true)
    expect(out).toContain("t".repeat(20))
    expect(out).not.toContain("m".repeat(30))
    expect(out).toContain("[Full output at memory://spill/1 (150 bytes).]")
  })

  it("omits tool-name references from the spill hint", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("shell")
    const out = await formatToolResult(
      toolkit,
      "shell",
      ok({ text: "x".repeat(100) }),
      { workspace, toolUseId: "call-4", maxInline: 20 },
    )

    // The framework hint does not suggest any particular tool.
    expect(out).not.toContain("read_file")
    expect(out).not.toContain("Use ")
  })

  it("snaps the head cut back to the nearest newline within the window", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo")
    // Newline at index 10. Exact cut at size=15 lands inside 'm' block;
    // snap walks back to the \n, yielding an 11-char head ending on \n.
    const content = "h".repeat(10) + "\n" + "m".repeat(90)
    const out = await formatToolResult(toolkit, "echo", ok({ text: content }), {
      workspace,
      toolUseId: "call-snap-head",
      maxInline: 15,
    })

    // Slice = "h"*10 + "\n". Then "\n\n[" begins the marker.
    expect(out.startsWith("h".repeat(10) + "\n\n\n[")).toBe(true)
    expect(out).toContain("90 characters truncated")
  })

  it("snaps the tail cut forward to the nearest newline within the window", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo", "tail")
    // Exact tail start at index 86 lands mid-'m'. Snap forward to the
    // \n at index 90, giving a 10-char 't' slice after the cut.
    const content = "m".repeat(90) + "\n" + "t".repeat(10)
    const out = await formatToolResult(toolkit, "echo", ok({ text: content }), {
      workspace,
      toolUseId: "call-snap-tail",
      maxInline: 15,
    })

    expect(
      out.endsWith(
        "\n\n" +
          "t".repeat(10) +
          "\n\n[Full output at memory://spill/1 (101 bytes).]",
      ),
    ).toBe(true)
    expect(out).toContain("91 characters truncated")
  })

  it("snaps both cuts in the middle strategy when newlines sit within range", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("shell", "middle")
    // half = 15. Head snap at \n index 10 → cut 11. Tail minCut = 77,
    // next \n at 81 → cut 82. Slice: "h"*10 + "\n", marker, "t"*10.
    const content =
      "h".repeat(10) + "\n" + "m".repeat(70) + "\n" + "t".repeat(10)
    const out = await formatToolResult(
      toolkit,
      "shell",
      ok({ text: content }),
      { workspace, toolUseId: "call-snap-middle", maxInline: 30 },
    )

    expect(out.startsWith("h".repeat(10) + "\n\n\n[")).toBe(true)
    expect(
      out.endsWith(
        "\n\n" +
          "t".repeat(10) +
          "\n\n[Full output at memory://spill/1 (92 bytes).]",
      ),
    ).toBe(true)
    expect(out).toContain("71 characters truncated")
  })

  it("falls through to exact cut when no newline sits within the snap window", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo")
    // Single long line, no newlines anywhere.
    const content = "x".repeat(1000)
    const out = await formatToolResult(toolkit, "echo", ok({ text: content }), {
      workspace,
      toolUseId: "call-no-snap",
      maxInline: 100,
    })

    expect(out.startsWith("x".repeat(100))).toBe(true)
    expect(out).toContain("900 characters truncated")
  })

  it("bounds the snap — a newline outside SNAP_WINDOW does not pull the cut", async () => {
    const workspace = new RecordingWorkspace()
    const toolkit = makeToolkit("echo")
    // 500 'x', a newline, then 500 more 'x'. SNAP_WINDOW is 200.
    // With maxInline=100, the exact cut is at index 100. The newline
    // at index 500 is far outside [100-200, 100], so no snap applies.
    const content = "x".repeat(500) + "\n" + "x".repeat(500)
    const out = await formatToolResult(toolkit, "echo", ok({ text: content }), {
      workspace,
      toolUseId: "call-bounded",
      maxInline: 100,
    })

    expect(out.startsWith("x".repeat(100))).toBe(true)
    expect(out).toContain("901 characters truncated")
  })
})

describe("@ronde/core tool() truncate metadata", () => {
  it("lands the declared truncate strategy on the toolkit", () => {
    const toolkit = tool({
      name: "shell",
      description: "Run a shell command.",
      parameters: z.object({ cmd: z.string() }),
      execute: async () => ok("output"),
      truncate: "middle",
    })

    expect(toolkit.truncate).toEqual({ shell: "middle" })
  })

  it("omits the tool from the truncate map when not declared", () => {
    const toolkit = tool({
      name: "echo",
      description: "Echo.",
      parameters: z.object({ text: z.string() }),
      execute: async (args) => ok(args.text),
    })

    expect(toolkit.truncate).toEqual({})
  })

  it("merges truncate maps across toolkits; later wins on collision", () => {
    const first = tool({
      name: "a",
      description: "A.",
      parameters: z.object({}),
      execute: async () => ok(null),
      truncate: "head",
    })
    const second = tool({
      name: "b",
      description: "B.",
      parameters: z.object({}),
      execute: async () => ok(null),
      truncate: "tail",
    })
    const third = tool({
      name: "a",
      description: "A'.",
      parameters: z.object({}),
      execute: async () => ok(null),
      truncate: "middle",
    })

    const merged = merge(first, second, third)
    expect(merged.truncate).toEqual({ a: "middle", b: "tail" })
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

  it("returns err output on schema validation failure", async () => {
    const toolkit = tool({
      name: "calc",
      description: "Calculator",
      parameters: z.object({ x: z.number() }),
      execute: async (args) => ok(args.x),
    })

    const result = await drain(
      toolkit.execute("calc", { x: "nope" }, stubCtx()),
    )
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
    const output = await drain(ret)
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
      bytes: utf8ByteLength(content),
    }
  }
}
