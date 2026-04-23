import { describe, expect, it } from "vitest"
import { Effort } from "@ronde/core/completion"
import type { Awaitable, Lax } from "@ronde/core"
import type { ToolCall } from "@ronde/core/tool"

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
