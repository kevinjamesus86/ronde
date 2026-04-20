import { describe, expect, it } from "vitest"
import { Effort } from "@ronde/core/completion"
import type { Awaitable, Lax } from "@ronde/core"
import type { ToolCall, ToolResult } from "@ronde/core/tool"

describe("@ronde/core tool value contracts", () => {
  it("models ToolCall as provider toolUseId plus parsed arguments", () => {
    const call: ToolCall = {
      toolUseId: "call-1",
      name: "search",
      arguments: { q: "ronde" },
    }

    expect(call.toolUseId).toBe("call-1")
    expect(call.arguments).toEqual({ q: "ronde" })
  })

  it("models ToolResult as the model-facing formatted outcome", () => {
    const result: ToolResult = {
      ok: false,
      content: "permission denied",
    }

    expect(result).toEqual({
      ok: false,
      content: "permission denied",
    })
  })
})

describe("@ronde/core tool type aliases", () => {
  it("covers Lax accepting enum values and underlying string literals in type tests", () => {
    const enumValue: Lax<Effort> = Effort.High
    const stringValue: Lax<Effort> = "low"

    expect(enumValue).toBe(Effort.High)
    expect(stringValue).toBe("low")
  })

  it("covers Awaitable accepting plain values and PromiseLike values in type tests", async () => {
    const direct: Awaitable<number> = 7
    const promised: Awaitable<number> = Promise.resolve(9)

    expect(await direct).toBe(7)
    expect(await promised).toBe(9)
  })
})
