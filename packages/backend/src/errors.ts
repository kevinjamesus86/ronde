/**
 * @module
 * Provider-facing helpers for classifying raw SDK errors into the
 * shared completion failure contract.
 */
import { CompletionError, CompletionErrorKind } from "@ronde/core/completion"

export { CompletionError, CompletionErrorKind }

export function classifyError(
  statusCode: number | undefined,
  message: string,
): CompletionErrorKind {
  if (statusCode === 401 || statusCode === 403) {
    return CompletionErrorKind.AuthError
  }
  if (statusCode === 429) {
    return CompletionErrorKind.RateLimit
  }
  if (statusCode === 400) {
    const lower = message.toLowerCase()
    if (
      lower.includes("context_length_exceeded") ||
      lower.includes("max_tokens") ||
      lower.includes("too many tokens") ||
      lower.includes("token limit") ||
      lower.includes("exceeds the model")
    ) {
      return CompletionErrorKind.ContextLengthExceeded
    }
    return CompletionErrorKind.InvalidRequest
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return CompletionErrorKind.ServerError
  }

  const lower = message.toLowerCase()

  if (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("other side closed") ||
    lower.includes("connection closed") ||
    lower.includes("connection error") ||
    lower.includes("reset by peer") ||
    lower.includes("broken pipe") ||
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("unexpected eof") ||
    lower.includes("socket") ||
    lower.includes("terminated") ||
    lower.includes("fetch failed")
  ) {
    return CompletionErrorKind.NetworkError
  }

  if (
    lower.includes("content_filter") ||
    lower.includes("content filter") ||
    lower.includes("safety") ||
    lower.includes("blocked")
  ) {
    return CompletionErrorKind.ContentFiltered
  }

  if (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length")
  ) {
    return CompletionErrorKind.ContextLengthExceeded
  }

  return CompletionErrorKind.Unknown
}

/**
 * Wrap a raw SDK error into a CompletionError, extracting status from
 * common SDK shapes (`status`, `statusCode`, numeric `code`) and
 * preferring nested `error.message` over the outer message.
 */
export function wrapSdkError(err: unknown): CompletionError {
  if (err instanceof CompletionError) {
    return err
  }

  const raw = err as Error & {
    status?: number
    statusCode?: number
    code?: string | number
    error?: { type?: string; message?: string }
  }

  const message = raw.error?.message || raw.message || String(err)
  const statusCode =
    (typeof raw.status === "number" ? raw.status : undefined) ??
    (typeof raw.statusCode === "number" ? raw.statusCode : undefined) ??
    (typeof raw.code === "number" ? raw.code : undefined)

  const codeStr = typeof raw.code === "string" ? raw.code : ""
  const fullMessage = `${message} ${codeStr}`.trim()
  const kind = classifyError(statusCode, fullMessage)

  return new CompletionError(kind, message, {
    statusCode,
    cause: err,
  })
}
