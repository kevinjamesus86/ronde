import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod/v4"
import { CompletionError, CompletionErrorKind } from "@ronde/core/completion"
import { userMessage } from "@ronde/core/message"
import { registerProvider, type ProviderDescriptor } from "@ronde/providers"
import { agentic, agenticStream, hydrate } from "../src/index.js"
import { createManagedRuntime } from "../src/managed-runtime.js"
import type { RunObserver } from "../src/observer.js"
import {
  mockBackend,
  textResponse,
  toolResponse,
  useTmp,
  withEnv,
} from "./support.js"

const tmp = useTmp()

afterEach(() => {
  tmp.cleanup()
})

function registerTestProvider(
  name: string,
  create: ProviderDescriptor["create"],
  envVar = "RONDE_TEST_API_KEY",
): void {
  registerProvider({
    name,
    modelPrefix: name,
    defaultURL: "https://example.test",
    envVar,
    create,
  })
}

describe("@ronde api backend selection", () => {
  it("accepts an explicit configured backend as the first argument", async () => {
    const backend = mockBackend([textResponse("hello")])
    const result = await agentic(backend, { prompt: "hi" })
    expect(result.output).toBe("hello")
    expect(backend.requests).toHaveLength(1)
  })

  it('builds an official backend from "provider/model" strings', async () => {
    const requests: unknown[] = []
    registerTestProvider("testapi", () => ({
      specVersion: "v1",
      complete: async (request) => {
        requests.push(request)
        return textResponse("from provider")
      },
    }))

    const result = await withEnv("RONDE_TEST_API_KEY", "secret", async () =>
      agentic({ model: "testapi/demo", prompt: "hi" }),
    )

    expect(result.output).toBe("from provider")
    expect(requests).toHaveLength(1)
  })

  it("wraps convenience backends with retry policy by default", async () => {
    let calls = 0
    registerTestProvider("retryapi", () => ({
      specVersion: "v1",
      complete: async () => {
        calls++
        if (calls === 1) {
          throw new CompletionError(CompletionErrorKind.RateLimit, "retry me")
        }
        return textResponse("recovered")
      },
    }))

    const result = await withEnv("RONDE_TEST_API_KEY", "secret", async () =>
      agentic({ model: "retryapi/demo", prompt: "hi" }),
    )

    expect(result.output).toBe("recovered")
    expect(calls).toBe(2)
  })

  it("rejects unknown provider prefixes in model strings", async () => {
    await expect(
      agentic({ model: "unknown/model", prompt: "hi" }),
    ).rejects.toThrow(/Unknown provider/i)
  })

  it("requires provider API keys when the official provider declares an env var", async () => {
    registerTestProvider("needskey", () => ({
      specVersion: "v1",
      complete: async () => textResponse("never reached"),
    }))

    await withEnv("RONDE_TEST_API_KEY", undefined, async () => {
      await expect(
        agentic({ model: "needskey/demo", prompt: "hi" }),
      ).rejects.toThrow(/Missing RONDE_TEST_API_KEY/i)
    })
  })
})

describe("@ronde agentic runtime handling", () => {
  it("uses the provided journal and workspace pair when supplied", async () => {
    const runtime = await createManagedRuntime({
      root: tmp.dir("ronde-api-runtime-"),
      project: "acme",
      name: "explicit",
    })
    const backend = mockBackend([textResponse("ok")])

    await agentic(backend, {
      prompt: "hi",
      journal: runtime.journal,
      workspace: runtime.workspace,
    })

    expect(backend.requests).toHaveLength(1)
  })

  it("creates a default managed fs runtime when no runtime is provided", async () => {
    const root = tmp.dir("ronde-default-api-")
    const backend = mockBackend([textResponse("ok")])

    await withEnv("RONDE_HOME", root, async () => {
      await agentic(backend, { prompt: "hi" })
    })

    const projects = await fs.readdir(path.join(root, "projects"))
    expect(projects.length).toBeGreaterThan(0)
  })

  it("hydrates caller-owned message history into a fresh runtime", async () => {
    const backend = mockBackend([textResponse("continued")])
    const history = [userMessage("seeded history")]

    await agentic(backend, { prompt: "continue", messages: history })

    expect(backend.requests[0]!.messages).toContainEqual(history[0]!)
  })

  it("rejects partial runtime inputs when only one side is supplied", async () => {
    const runtime = await createManagedRuntime({
      root: tmp.dir("ronde-partial-runtime-"),
      project: "acme",
      name: "partial",
    })
    const backend = mockBackend([textResponse("ok")])

    await expect(
      agentic(backend, {
        prompt: "hi",
        journal: runtime.journal,
      }),
    ).rejects.toThrow(/Pass both "journal" and "workspace"/i)
  })

  it("replays active journal history on resumed runs", async () => {
    const root = tmp.dir("ronde-resume-")
    const runtime = await createManagedRuntime({
      root,
      project: "acme",
      name: "resume-me",
    })
    await hydrate([userMessage("previous")], runtime)
    const backend = mockBackend([textResponse("continued")])

    await agentic(backend, {
      prompt: "continue",
      resume: {
        root,
        project: "acme",
        name: "resume-me",
      },
    })

    expect(backend.requests[0]!.messages).toContainEqual(
      userMessage("previous"),
    )
  })
})

describe("@ronde agentic result shaping", () => {
  it("collects final output, steps, history, usage, and settleReason", async () => {
    const backend = mockBackend([
      textResponse("hello", { inputTokens: 12, outputTokens: 7 }),
    ])
    const result = await agentic(backend, { prompt: "hi" })

    expect(result.output).toBe("hello")
    expect(result.steps).toHaveLength(1)
    expect(result.history.length).toBeGreaterThan(0)
    expect(result.settleReason).toBe("end_turn")
    expect(result.usage).toEqual({ input: 12, output: 7, cached: 0 })
  })

  it("returns structured output when a schema succeeds", async () => {
    const backend = mockBackend([textResponse('{"name":"Ada"}')])
    const result = await agentic(backend, {
      prompt: "person",
      schema: z.object({ name: z.string() }),
    })

    expect(result.output).toEqual({ name: "Ada" })
  })

  it("runs a schema repair pass when the first parse fails", async () => {
    const backend = mockBackend([
      textResponse("not json"),
      textResponse('{"ok":true}'),
    ])

    const result = await agentic(backend, {
      prompt: "structured",
      schema: z.object({ ok: z.boolean() }),
    })

    expect(result.output).toEqual({ ok: true })
    expect(result.steps).toHaveLength(2)
  })

  it("surfaces schema failure when repair cannot produce valid output", async () => {
    const backend = mockBackend([
      textResponse("bad"),
      textResponse("still bad"),
    ])

    const result = await agentic(backend, {
      prompt: "structured",
      schema: z.object({ ok: z.boolean() }),
    })

    expect(result.output).toBeUndefined()
  })

  // The repair turn ran — it hit the backend, cost tokens, produced a step.
  // The returned AgenticResult must reflect that reality even when the
  // repaired parse also fails. Dropping the retry state hides work that
  // actually happened from callers who inspect usage/steps/history.
  it("merges retry-pass steps, usage, and history when schema repair fails", async () => {
    const backend = mockBackend([
      textResponse("bad", { inputTokens: 10, outputTokens: 5 }),
      textResponse("still bad", { inputTokens: 20, outputTokens: 7 }),
    ])

    const result = await agentic(backend, {
      prompt: "structured",
      schema: z.object({ ok: z.boolean() }),
    })

    expect(result.output).toBeUndefined()
    expect(backend.requests).toHaveLength(2)
    expect(result.steps).toHaveLength(2)
    expect(result.usage).toEqual({ input: 30, output: 12, cached: 0 })
  })
})

describe("@ronde streaming and observer dispatch", () => {
  it("streams EngineEvent values through agenticStream()", async () => {
    const backend = mockBackend([toolResponse("echo", { text: "hi" })])
    const events: string[] = []

    for await (const event of agenticStream(backend, {
      prompt: "hi",
      maxTurns: 1,
    })) {
      events.push(event.type)
    }

    expect(events).toContain("turn_start")
    expect(events).toContain("tool_call")
  })

  it('rejects "observers" in agenticStream config', async () => {
    const backend = mockBackend([textResponse("hello")])

    await expect(async () => {
      for await (const _event of agenticStream(backend, {
        prompt: "hi",
        observers: {
          onText() {},
        },
      } as never)) {
      }
    }).rejects.toThrow(/does not accept "observers"/i)
  })

  it("dispatches engine events onto RunObserver callbacks", async () => {
    const backend = mockBackend([textResponse("hello")])
    const seen: string[] = []
    const observer: RunObserver = {
      onTurnStart(turn) {
        seen.push(`start:${turn}`)
      },
      onText(turn, text) {
        seen.push(`text:${turn}:${text}`)
      },
      onTurnEnd(turn) {
        seen.push(`end:${turn}`)
      },
    }

    await agentic(backend, { prompt: "hi", observers: observer })

    expect(seen).toEqual(["start:1", "text:1:hello", "end:1"])
  })

  it("isolates observer failures from the underlying engine run", async () => {
    const backend = mockBackend([textResponse("hello")])
    const observer: RunObserver = {
      onText() {
        throw new Error("observer boom")
      },
    }

    const result = await agentic(backend, { prompt: "hi", observers: observer })
    expect(result.output).toBe("hello")
  })
})
