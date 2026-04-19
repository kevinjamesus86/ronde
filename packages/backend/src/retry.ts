import { CompletionError, CompletionErrorKind, wrapSdkError } from "./errors.js"
import { drain } from "@ronde/core/stream"
import type {
  CompletionBackend,
  CompletionRequest,
  CompletionResponse,
  ConfiguredBackend,
  ResolvedBackendConfig,
} from "@ronde/core/completion"

export interface RetryAttempt {
  attempt: number
  maxRetries: number
  error: CompletionError
  delayMs: number
}

export interface RetryOptions {
  /** Default: 5. */
  maxRetries?: number
  /** Default: 30_000. */
  maxDelayMs?: number
  /** Invoked before each backoff sleep. Silent by default. */
  onRetry?: (event: RetryAttempt) => void
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_MAX_DELAY_MS = 30_000

/**
 * Retry decorator over `ConfiguredBackend`. Retries errors where
 * `retryable` is true with exponential backoff + jitter; other errors
 * propagate untouched. Abort signals cancel the in-flight attempt and
 * short-circuit any pending backoff.
 *
 * Streams are drained into a single `CompletionResponse` before returning
 * — mid-stream failures are retryable, but the caller sees no partial
 * events across attempts.
 */
export class RetryingBackend implements ConfiguredBackend {
  readonly specVersion = "v1" as const
  private inner: CompletionBackend
  private maxRetries: number
  private maxDelayMs: number
  private onRetry?: (event: RetryAttempt) => void
  readonly config: ResolvedBackendConfig

  constructor(inner: ConfiguredBackend, options: RetryOptions = {}) {
    this.inner = inner
    this.config = inner.config
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.onRetry = options.onRetry
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { signal } = request

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        throw new CompletionError(CompletionErrorKind.Aborted, "Aborted")
      }

      try {
        return await raceAbort(drain(this.inner.complete(request)), signal)
      } catch (err) {
        const wrapped = err instanceof CompletionError ? err : wrapSdkError(err)

        if (!wrapped.retryable || attempt >= this.maxRetries) {
          throw wrapped
        }

        const baseDelay = Math.min(1000 * Math.pow(2, attempt), this.maxDelayMs)
        const jitter = Math.random() * baseDelay * 0.5
        const delayMs = Math.round(baseDelay + jitter)

        // Observer errors must never derail the retry itself.
        try {
          this.onRetry?.({
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            error: wrapped,
            delayMs,
          })
        } catch {}

        await abortableSleep(delayMs, signal)
      }
    }
  }
}

export function withRetry(
  backend: ConfiguredBackend,
  options: RetryOptions = {},
): ConfiguredBackend {
  return new RetryingBackend(backend, options)
}

/** Race a promise against an abort signal. Rejects immediately if aborted. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise
  }

  // Suppress unhandled rejection when abort wins the race but the
  // original promise later rejects.
  promise.catch(() => {})

  if (signal.aborted) {
    return Promise.reject(
      new CompletionError(CompletionErrorKind.Aborted, "Aborted"),
    )
  }

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(new CompletionError(CompletionErrorKind.Aborted, "Aborted")),
        { once: true },
      )
    }),
  ])
}

/** Sleep that resolves (not rejects) early when the signal is aborted. */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
