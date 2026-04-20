import { describe, expect, it } from "vitest"
import {
  CompletionError,
  CompletionErrorKind,
  CompletionMode,
  EMPTY_USAGE,
  Effort,
  StopReason,
  type ConfiguredBackend,
} from "@ronde/core/completion"

describe("@ronde/core completion contracts", () => {
  it("treats rate limit, server, and network errors as retryable", () => {
    expect(
      new CompletionError(CompletionErrorKind.RateLimit, "retry").retryable,
    ).toBe(true)
    expect(
      new CompletionError(CompletionErrorKind.ServerError, "retry").retryable,
    ).toBe(true)
    expect(
      new CompletionError(CompletionErrorKind.NetworkError, "retry").retryable,
    ).toBe(true)
  })

  it("treats auth, invalid request, and content filter errors as non-retryable", () => {
    expect(
      new CompletionError(CompletionErrorKind.AuthError, "no").retryable,
    ).toBe(false)
    expect(
      new CompletionError(CompletionErrorKind.InvalidRequest, "no").retryable,
    ).toBe(false)
    expect(
      new CompletionError(CompletionErrorKind.ContentFiltered, "no").retryable,
    ).toBe(false)
  })

  it("stores the provided status code on CompletionError", () => {
    expect(
      new CompletionError(CompletionErrorKind.ServerError, "boom", {
        statusCode: 503,
      }).statusCode,
    ).toBe(503)
  })

  it("defaults CompletionError.statusCode to null when omitted", () => {
    expect(
      new CompletionError(CompletionErrorKind.Unknown, "boom").statusCode,
    ).toBeNull()
  })

  it("preserves the original cause on CompletionError", () => {
    const cause = new Error("root cause")
    const error = new CompletionError(
      CompletionErrorKind.ServerError,
      "wrapped",
      { cause },
    )

    expect(error.cause).toBe(cause)
  })

  it("exposes a frozen zero-usage object", () => {
    expect(EMPTY_USAGE).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      reasoningTokens: 0,
    })
    expect(Object.isFrozen(EMPTY_USAGE)).toBe(true)
  })
})

describe("@ronde/core configured backend contract", () => {
  it("requires resolved model and budget configuration alongside complete()", async () => {
    const backend: ConfiguredBackend = {
      specVersion: "v1",
      config: {
        model: "test-model",
        effort: Effort.Low,
        maxContext: 4096,
        maxOutput: 512,
      },
      async complete() {
        return {
          messages: [],
          stopReason: StopReason.EndTurn,
          usage: EMPTY_USAGE,
          providerMeta: null,
          warnings: [],
        }
      },
    }

    const response = await backend.complete({
      model: "test-model",
      messages: [],
      tools: [],
      mode: CompletionMode.Agentic,
      effort: Effort.Low,
      maxOutput: 512,
    })

    expect(backend.specVersion).toBe("v1")
    expect(response.stopReason).toBe(StopReason.EndTurn)
  })

  it("lets consumers read context and output token budgets from config", () => {
    const backend: ConfiguredBackend = {
      specVersion: "v1",
      config: {
        model: "test-model",
        effort: "high",
        maxContext: 8192,
        maxOutput: 1024,
      },
      async complete() {
        throw new Error("not used")
      },
    }

    expect(backend.config).toEqual({
      model: "test-model",
      effort: "high",
      maxContext: 8192,
      maxOutput: 1024,
    })
  })
})
