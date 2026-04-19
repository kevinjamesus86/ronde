import { describe, expect, it } from "vitest"
import { mapEffort, unsupported } from "../src/provider-utils.js"

describe("@ronde/providers mapEffort", () => {
  it("maps known effort levels through the provider table", () => {
    const table = {
      low: "L",
      med: "M",
      high: "H",
    }

    expect(mapEffort("low", table)).toBe("L")
    expect(mapEffort("med", table)).toBe("M")
    expect(mapEffort("high", table)).toBe("H")
  })

  it("returns null for null and undefined effort", () => {
    expect(mapEffort(null, { low: 1 })).toBeNull()
    expect(mapEffort(undefined, { low: 1 })).toBeNull()
  })

  it("returns null for unknown effort values", () => {
    expect(mapEffort("xhigh", { low: 1, high: 2 })).toBeNull()
  })
})

describe("@ronde/providers unsupported", () => {
  it("builds unsupported warnings with a feature name", () => {
    expect(unsupported("thinking")).toEqual({
      type: "unsupported",
      feature: "thinking",
      details: undefined,
    })
  })

  it("includes optional details when provided", () => {
    expect(unsupported("reasoning", "provider dropped summaries")).toEqual({
      type: "unsupported",
      feature: "reasoning",
      details: "provider dropped summaries",
    })
  })
})
