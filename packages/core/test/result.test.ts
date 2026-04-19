import { describe, expect, it } from "vitest"
import { err, isOk, ok } from "@ronde/core/result"

describe("@ronde/core ok", () => {
  it("wraps success data in an ok result", () => {
    expect(ok({ x: 1 })).toEqual({ ok: true, data: { x: 1 } })
  })

  it("preserves null, undefined, and structured payloads", () => {
    expect(ok(null)).toEqual({ ok: true, data: null })
    expect(ok(undefined)).toEqual({ ok: true, data: undefined })

    const data = { nested: [1, { answer: 42 }] }
    const result = ok(data)
    expect(result.data).toBe(data)
  })
})

describe("@ronde/core err", () => {
  it("wraps a string message in a failed result", () => {
    expect(err("bad")).toEqual({ ok: false, error: "bad" })
  })

  it("extracts the message from an Error instance", () => {
    expect(err(new Error("oops"))).toEqual({ ok: false, error: "oops" })
  })

  it("includes optional failure data when provided", () => {
    expect(err("partial", { stderr: "boom" })).toEqual({
      ok: false,
      error: "partial",
      data: { stderr: "boom" },
    })
  })

  it("omits the data field when no failure data is provided", () => {
    expect(err("fail")).not.toHaveProperty("data")
  })
})

describe("@ronde/core isOk", () => {
  it("narrows success results", () => {
    const result = ok(42)

    expect(isOk(result)).toBe(true)
    if (isOk(result)) {
      expect(result.data).toBe(42)
    }
  })

  it("rejects failed results", () => {
    expect(isOk(err("nope"))).toBe(false)
  })
})
