import { describe, expect, it } from "vitest"
import { StopReason, emptyUsage } from "@ronde/core/completion"
import {
  diagnosticEvent,
  lifecycleEvent,
  progressEvent,
  type EngineResult,
  type EngineConfig,
  type EngineHooks,
} from "@ronde/engine"
import {
  emptyToolkit,
  type TestJournal,
  type TestWorkspace,
} from "./support.js"

describe("@ronde/engine event taxonomy", () => {
  it("classifies turn lifecycle events under EngineLifecycleEvent", () => {
    expect(lifecycleEvent("turn_start", { turn: 1 })).toEqual({
      kind: "lifecycle",
      type: "turn_start",
      turn: 1,
    })
    expect(
      lifecycleEvent("turn_end", {
        turn: 1,
        step: {
          turn: 1,
          reasoning: [],
          toolCalls: [],
          text: "done",
          usage: emptyUsage(),
          stopReason: StopReason.EndTurn,
        },
      }).kind,
    ).toBe("lifecycle")
  })

  it("classifies thinking/text/tool activity under EngineProgressEvent", () => {
    expect(progressEvent("thinking", { turn: 1, content: "plan" }).kind).toBe(
      "progress",
    )
    expect(
      progressEvent("tool_call", {
        turn: 1,
        call: { toolUseId: "call-1", name: "echo", arguments: {} },
      }).type,
    ).toBe("tool_call")
  })

  it("classifies warning/error output under EngineDiagnosticEvent", () => {
    expect(diagnosticEvent("warning", { turn: 1, message: "careful" })).toEqual(
      {
        kind: "diagnostic",
        type: "warning",
        turn: 1,
        message: "careful",
      },
    )
    expect(diagnosticEvent("error", { turn: 1, message: "boom" }).kind).toBe(
      "diagnostic",
    )
  })

  it("ensures event constructors stamp both kind and type correctly", () => {
    const event = progressEvent("text", { turn: 2, content: "hello" })
    expect(event.kind).toBe("progress")
    expect(event.type).toBe("text")
  })
})

describe("@ronde/engine hook contracts", () => {
  it("defines preStep as an optional per-turn override hook", async () => {
    const hooks: EngineHooks = {
      preStep: async (input) => ({
        model: "override",
        messages: input.messages,
      }),
    }

    await expect(
      hooks.preStep?.({
        turn: 1,
        messages: [],
        toolSchemas: [],
        steps: [],
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedTokens: 0,
        },
        budget: {
          contextWindowTokens: 4096,
          maxOutputTokens: 512,
        },
        compactionCount: 0,
      }),
    ).resolves.toMatchObject({ model: "override", messages: [] })
  })

  it("defines approve as an optional per-tool decision hook", async () => {
    const hooks: EngineHooks = {
      approve: async (call) => call.name === "echo",
    }

    await expect(
      hooks.approve?.({
        toolUseId: "call-1",
        name: "echo",
        arguments: {},
      }),
    ).resolves.toBe(true)
  })

  it("defines postStep as an optional feedback hook", async () => {
    const hooks: EngineHooks = {
      postStep: async () => "continue",
    }

    await expect(
      hooks.postStep?.({
        turn: 1,
        reasoning: [],
        toolCalls: [],
        usage: emptyUsage(),
        stopReason: StopReason.EndTurn,
      }),
    ).resolves.toBe("continue")
  })

  it("documents EngineHooks as inbound control points, not emitted events", () => {
    const hooks: EngineHooks = {}
    expect(
      "approve" in hooks || "preStep" in hooks || "postStep" in hooks,
    ).toBe(false)
  })
})

describe("@ronde/engine config contracts", () => {
  it("requires journal and workspace in EngineConfig", () => {
    const config: EngineConfig<TestWorkspace> = {
      journal: {} as TestJournal,
      workspace: {} as TestWorkspace,
      toolkit: emptyToolkit(),
    }

    expect(config.journal).toBeDefined()
    expect(config.workspace).toBeDefined()
  })

  it("threads toolkit, prompt, signal, hooks, and compaction as optional loop inputs", () => {
    const controller = new AbortController()
    const config: EngineConfig<TestWorkspace> = {
      journal: {} as TestJournal,
      workspace: {} as TestWorkspace,
      toolkit: emptyToolkit(),
      prompt: "go",
      signal: controller.signal,
      hooks: {},
      compaction: {
        async compact() {
          return { kind: "not_compacted", usage: emptyUsage() }
        },
      },
    }

    expect(config.prompt).toBe("go")
    expect(config.signal).toBe(controller.signal)
    expect(config.hooks).toEqual({})
    expect(config.compaction).toBeDefined()
  })

  it("covers the public EngineConfig and EngineResult shapes in type tests", () => {
    const result: EngineResult = {
      steps: [],
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCachedTokens: 3,
      compactionCount: 0,
      history: [],
      settleReason: "max_turns",
    }

    expect(result.settleReason).toBe("max_turns")
    expect(result.totalCachedTokens).toBe(3)
  })
})
