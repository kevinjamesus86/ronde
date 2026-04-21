import { describe, expect, it } from "vitest"
import { zip } from "../src/zip.js"

describe("@ronde/engine zip", () => {
  it("pairs equal-length arrays in order", () => {
    expect(zip([1, 2, 3], ["a", "b", "c"])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ])
  })

  it("returns an empty array when both inputs are empty", () => {
    expect(zip([], [])).toEqual([])
  })

  it("throws on length mismatch", () => {
    expect(() => zip([1, 2], ["a"])).toThrow(/length mismatch/)
  })
})
