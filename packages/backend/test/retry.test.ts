import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CompletionError,
  CompletionErrorKind,
  CompletionMode,
  StopReason,
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type ConfiguredBackend,
} from "@ronde/core/completion"
import { userMessage } from "@ronde/core/message"
import {
  RetryingBackend,
  abortableSleep,
  raceAbort,
  withRetry,
} from "../src/retry.js"

function request(signal?: AbortSignal): CompletionRequest {
  return {
    model: "test-model",
    messages: [userMessage("hello")],
    tools: [],
    mode: CompletionMode.Agentic,
    effort: undefined,
    maxOutput: 1024,
    signal,
  }
}

function response(text = "ok"): CompletionResponse {
  return {
    messages: [userMessage(text)],
    stopReason: StopReason.EndTurn,
    usage: emptyUsage(),
    providerMeta: null,
    warnings: [],
  }
}

function backendFrom(
  complete: (request: CompletionRequest) => Promise<CompletionResponse>,
): ConfiguredBackend {
  return {
    specVersion: "v1",
    config: {
      model: "test-model",
      effort: undefined,
      maxContext: 32_000,
      maxOutput: 4_000,
    },
    complete,
  }
}

describe("@ronde/backend retry configuration", () => {
  it("preserves the wrapped backend config", async () => {
    const inner = backendFrom(async () => response())

    const decorated = withRetry(inner)

    expect(decorated).toBeInstanceOf(RetryingBackend)
    expect(decorated.config).toBe(inner.config)
    await expect(decorated.complete(request())).resolves.toEqual(response())
  })

  it("defaults maxRetries and maxDelayMs when options are omitted", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        throw new CompletionError(CompletionErrorKind.NetworkError, "offline")
      }),
    )

    const run = backend.complete(request())
    const rejected = expect(run).rejects.toMatchObject({
      kind: CompletionErrorKind.NetworkError,
      retryable: true,
    })
    await vi.runAllTimersAsync()

    await rejected
    expect(attempts).toBe(6)
  })

  it("lets callers override maxRetries and maxDelayMs", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(1)

    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        throw new CompletionError(CompletionErrorKind.ServerError, "boom")
      }),
      { maxRetries: 1, maxDelayMs: 10 },
    )

    const run = backend.complete(request())
    const rejected = expect(run).rejects.toMatchObject({
      kind: CompletionErrorKind.ServerError,
    })
    await Promise.resolve()
    expect(attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(15)
    await rejected
    expect(attempts).toBe(2)
  })
})

describe("@ronde/backend retry loop", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("passes through the first successful response without delay", async () => {
    const inner = vi.fn(async () => response("first pass"))
    const onRetry = vi.fn()
    const backend = withRetry(backendFrom(inner), { onRetry })

    await expect(backend.complete(request())).resolves.toEqual(
      response("first pass"),
    )

    expect(inner).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("retries retryable failures with exponential backoff and jitter", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    const onRetry = vi.fn()
    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        if (attempts < 3) {
          throw new CompletionError(
            CompletionErrorKind.RateLimit,
            `retry ${attempts}`,
          )
        }
        return response("recovered")
      }),
      { onRetry },
    )

    const run = backend.complete(request())
    await Promise.resolve()
    expect(attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempts).toBe(2)

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(run).resolves.toEqual(response("recovered"))
    expect(attempts).toBe(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxRetries: 5,
      error: expect.objectContaining({ kind: CompletionErrorKind.RateLimit }),
      delayMs: 1000,
    })
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      maxRetries: 5,
      error: expect.objectContaining({ kind: CompletionErrorKind.RateLimit }),
      delayMs: 2000,
    })
  })

  it("swallows errors thrown from onRetry so the retry loop continues", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        if (attempts < 2) {
          throw new CompletionError(CompletionErrorKind.RateLimit, "slow down")
        }
        return response("recovered")
      }),
      {
        onRetry: () => {
          throw new Error("observer explodes")
        },
      },
    )

    const run = backend.complete(request())
    await vi.runAllTimersAsync()

    await expect(run).resolves.toEqual(response("recovered"))
    expect(attempts).toBe(2)
  })

  it("stops retrying after maxRetries attempts", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        throw new CompletionError(CompletionErrorKind.NetworkError, "offline")
      }),
      { maxRetries: 2 },
    )

    const run = backend.complete(request())
    const rejected = expect(run).rejects.toMatchObject({
      kind: CompletionErrorKind.NetworkError,
    })
    await vi.runAllTimersAsync()

    await rejected
    expect(attempts).toBe(3)
  })

  it("rethrows non-retryable failures immediately", async () => {
    const inner = vi.fn(async () => {
      throw new CompletionError(CompletionErrorKind.InvalidRequest, "bad input")
    })
    const onRetry = vi.fn()
    const backend = withRetry(backendFrom(inner), { onRetry })

    await expect(backend.complete(request())).rejects.toMatchObject({
      kind: CompletionErrorKind.InvalidRequest,
      retryable: false,
    })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("wraps non-CompletionError failures before retry classification", async () => {
    const backend = withRetry(
      backendFrom(async () => {
        throw new Error("fetch failed")
      }),
      { maxRetries: 0 },
    )

    await expect(backend.complete(request())).rejects.toMatchObject({
      kind: CompletionErrorKind.NetworkError,
      retryable: true,
      cause: expect.any(Error),
    })
  })
})

describe("@ronde/backend abort handling", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("rejects immediately when the request signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const backend = withRetry(
      backendFrom(async () => response()),
      { maxRetries: 3 },
    )

    await expect(
      backend.complete(request(controller.signal)),
    ).rejects.toMatchObject({
      kind: CompletionErrorKind.Aborted,
    })
  })

  it("rejects the in-flight attempt when the signal aborts mid-request", async () => {
    let release!: (value: CompletionResponse) => void
    const backend = withRetry(
      backendFrom(
        () =>
          new Promise<CompletionResponse>((resolve) => {
            release = resolve
          }),
      ),
    )
    const controller = new AbortController()

    const run = backend.complete(request(controller.signal))
    controller.abort()
    release(response("late"))

    await expect(run).rejects.toMatchObject({
      kind: CompletionErrorKind.Aborted,
    })
  })

  it("breaks the retry loop when the signal aborts during backoff", async () => {
    vi.useFakeTimers()

    let attempts = 0
    const backend = withRetry(
      backendFrom(async () => {
        attempts += 1
        throw new CompletionError(CompletionErrorKind.NetworkError, "offline")
      }),
    )
    const controller = new AbortController()

    const run = backend.complete(request(controller.signal))
    const rejected = expect(run).rejects.toMatchObject({
      kind: CompletionErrorKind.Aborted,
    })
    await Promise.resolve()
    expect(attempts).toBe(1)

    controller.abort()
    await vi.runAllTimersAsync()

    await rejected
    expect(attempts).toBe(1)
  })
})

describe("@ronde/backend retry helpers", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("raceAbort resolves the original promise when no signal is provided", async () => {
    await expect(raceAbort(Promise.resolve("ok"))).resolves.toBe("ok")
  })

  it("raceAbort preserves successful completion when the signal stays open", async () => {
    const controller = new AbortController()

    await expect(
      raceAbort(Promise.resolve("ok"), controller.signal),
    ).resolves.toBe("ok")
  })

  it("abortableSleep resolves after the requested delay", async () => {
    vi.useFakeTimers()

    const sleeper = abortableSleep(50)
    await vi.advanceTimersByTimeAsync(49)

    let settled = false
    void sleeper.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(sleeper).resolves.toBeUndefined()
  })

  it("abortableSleep resolves early when the signal aborts", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()

    const sleeper = abortableSleep(5_000, controller.signal)
    controller.abort()

    await expect(sleeper).resolves.toBeUndefined()
  })
})
