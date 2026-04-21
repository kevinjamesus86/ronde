import { describe, expect, it, vi } from "vitest"
import { z } from "zod/v4"
import { CompletionError, CompletionErrorKind } from "@ronde/core/completion"
import { agentic, ok, tool } from "../src/index.js"
import {
  cutoffResponse,
  mockBackend,
  mockHandler,
  textResponse,
} from "./support.js"

const echo = tool({
  name: "echo",
  description: "Echo",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => ok({ echoed: args.text }),
})

describe("@ronde observer events", () => {
  it("fires compaction start/end callbacks on successful compaction", async () => {
    const events: string[] = []
    const backend = mockHandler(
      (request, call) => {
        if (call === 0) {
          throw new CompletionError(
            CompletionErrorKind.ContextLengthExceeded,
            "too many tokens",
          )
        }
        if (request.system?.includes("continuation context")) {
          return textResponse("summary")
        }
        return textResponse("done")
      },
      { maxContext: 1000, maxOutput: 200 },
    )

    await agentic(backend, {
      prompt: "go",
      tools: echo,
      maxTurns: 5,
      observers: {
        onCompactionStart(turn) {
          events.push(`start:${turn}`)
        },
        onCompactionEnd(turn) {
          events.push(`end:${turn}`)
        },
      },
    })

    expect(events.some((event) => event.startsWith("start:"))).toBe(true)
    expect(events.some((event) => event.startsWith("end:"))).toBe(true)
  })

  it("passes full compaction usage to onCompactionEnd", async () => {
    let usage:
      | {
          inputTokens: number
          outputTokens: number
        }
      | undefined
    const backend = mockHandler(
      (request, call) => {
        if (call === 0) {
          throw new CompletionError(
            CompletionErrorKind.ContextLengthExceeded,
            "too many tokens",
          )
        }
        if (request.system?.includes("continuation context")) {
          return textResponse("summary", { outputTokens: 9 })
        }
        return textResponse("done")
      },
      { maxContext: 1000, maxOutput: 200 },
    )

    await agentic(backend, {
      prompt: "go",
      tools: echo,
      maxTurns: 5,
      observers: {
        onCompactionEnd(_turn, received) {
          usage = received
        },
      },
    })

    expect(usage).toBeDefined()
    expect(usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    })
    expect(usage!.outputTokens).toBeGreaterThan(0)
  })

  it("fires onCutoff with the turn and consecutive count", async () => {
    const cutoffs: Array<[number, number]> = []

    await agentic(
      mockBackend([cutoffResponse("partial"), textResponse("done")]),
      {
        prompt: "go",
        maxTurns: 5,
        observers: {
          onCutoff(turn, count) {
            cutoffs.push([turn, count])
          },
        },
      },
    )

    expect(cutoffs).toEqual([[1, 1]])
  })

  it("does not fire onCutoff for normal end-turn responses", async () => {
    const cutoffs = vi.fn()

    await agentic(mockBackend([textResponse("ok")]), {
      prompt: "go",
      observers: { onCutoff: cutoffs },
    })

    expect(cutoffs).not.toHaveBeenCalled()
  })

  it("fires onWarning when the engine hits a budget overflow path", async () => {
    const warnings: string[] = []
    const backend = mockHandler(
      (request) => {
        if (request.system?.includes("continuation context")) {
          return textResponse("summary")
        }
        throw new CompletionError(
          CompletionErrorKind.ContextLengthExceeded,
          "too many tokens",
        )
      },
      { maxContext: 1000, maxOutput: 200 },
    )

    await agentic(backend, {
      prompt: "go",
      tools: echo,
      maxTurns: 2,
      observers: {
        onWarning(_turn, message) {
          warnings.push(message)
        },
      },
    })

    expect(
      warnings.some((warning) => warning.includes("Context length exceeded")),
    ).toBe(true)
  })

  it("fires onError after the cutoff breaker trips", async () => {
    const errors: string[] = []

    await agentic(
      mockBackend([
        cutoffResponse("p1"),
        cutoffResponse("p2"),
        cutoffResponse("p3"),
      ]),
      {
        prompt: "go",
        maxTurns: 10,
        observers: {
          onError(_turn, message) {
            errors.push(message)
          },
        },
      },
    )

    expect(errors.some((error) => error.includes("consecutive"))).toBe(true)
  })
})
