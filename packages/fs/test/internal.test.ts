import { describe, expect, it } from "vitest"
import * as fsPkg from "@ronde/fs"
import { rebase } from "../src/internal.js"

describe("@ronde/fs internal capability token", () => {
  it("exposes a symbol token for rebase", () => {
    expect(typeof rebase).toBe("symbol")
  })

  it("keeps the capability token out of the public package surface", () => {
    expect("rebase" in fsPkg).toBe(false)
  })
})
