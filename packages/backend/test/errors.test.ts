import { describe, expect, it } from "vitest"
import { CompletionError, CompletionErrorKind } from "@ronde/core/completion"
import { classifyError, wrapSdkError } from "../src/errors.js"

describe("@ronde/backend classifyError", () => {
  it("maps auth status codes to AuthError", () => {
    expect(classifyError(401, "denied")).toBe(CompletionErrorKind.AuthError)
    expect(classifyError(403, "forbidden")).toBe(CompletionErrorKind.AuthError)
  })

  it("maps 429 responses to RateLimit", () => {
    expect(classifyError(429, "too many requests")).toBe(
      CompletionErrorKind.RateLimit,
    )
  })

  it("maps token-limit 400 responses to ContextLengthExceeded", () => {
    expect(classifyError(400, "too many tokens")).toBe(
      CompletionErrorKind.ContextLengthExceeded,
    )
    expect(classifyError(400, "request exceeds the model limit")).toBe(
      CompletionErrorKind.ContextLengthExceeded,
    )
  })

  it("maps other 400 responses to InvalidRequest", () => {
    expect(classifyError(400, "schema mismatch")).toBe(
      CompletionErrorKind.InvalidRequest,
    )
  })

  it("maps 5xx responses to ServerError", () => {
    expect(classifyError(500, "server panic")).toBe(
      CompletionErrorKind.ServerError,
    )
    expect(classifyError(503, "unavailable")).toBe(
      CompletionErrorKind.ServerError,
    )
  })

  it("maps network-flavored messages to NetworkError", () => {
    expect(classifyError(null, "fetch failed")).toBe(
      CompletionErrorKind.NetworkError,
    )
    expect(classifyError(null, "socket reset by peer")).toBe(
      CompletionErrorKind.NetworkError,
    )
  })

  it("maps safety and content-filter messages to ContentFiltered", () => {
    expect(classifyError(null, "content filter triggered")).toBe(
      CompletionErrorKind.ContentFiltered,
    )
    expect(classifyError(null, "response blocked by safety system")).toBe(
      CompletionErrorKind.ContentFiltered,
    )
  })

  it("falls back to Unknown when no signal matches", () => {
    expect(classifyError(null, "mystery failure")).toBe(
      CompletionErrorKind.Unknown,
    )
  })
})

describe("@ronde/backend wrapSdkError", () => {
  it("passes CompletionError instances through unchanged", () => {
    const error = new CompletionError(CompletionErrorKind.AuthError, "denied")

    expect(wrapSdkError(error)).toBe(error)
  })

  it("extracts status from sdk-like error.status fields", () => {
    const wrapped = wrapSdkError({
      message: "denied",
      status: 401,
    })

    expect(wrapped.kind).toBe(CompletionErrorKind.AuthError)
    expect(wrapped.statusCode).toBe(401)
  })

  it("extracts status from sdk-like error.statusCode fields", () => {
    const wrapped = wrapSdkError({
      message: "too many requests",
      statusCode: 429,
    })

    expect(wrapped.kind).toBe(CompletionErrorKind.RateLimit)
    expect(wrapped.statusCode).toBe(429)
  })

  it("extracts status from numeric error.code fields", () => {
    const wrapped = wrapSdkError({
      message: "service unavailable",
      code: 503,
    })

    expect(wrapped.kind).toBe(CompletionErrorKind.ServerError)
    expect(wrapped.statusCode).toBe(503)
  })

  it("includes string error.code values in message classification", () => {
    const wrapped = wrapSdkError({
      message: "upstream failure",
      code: "ECONNRESET",
    })

    expect(wrapped.kind).toBe(CompletionErrorKind.NetworkError)
    expect(wrapped.statusCode).toBeNull()
  })

  it("uses nested sdk error.message values when present", () => {
    const wrapped = wrapSdkError({
      message: "outer message",
      error: { message: "content filter tripped" },
    })

    expect(wrapped.message).toBe("content filter tripped")
    expect(wrapped.kind).toBe(CompletionErrorKind.ContentFiltered)
  })

  it("preserves the original thrown value as cause", () => {
    const cause = { status: 500, message: "bad gateway" }

    const wrapped = wrapSdkError(cause)

    expect(wrapped.cause).toBe(cause)
  })
})
