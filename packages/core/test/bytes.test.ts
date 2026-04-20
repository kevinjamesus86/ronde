import { describe, expect, it } from "vitest"
import { utf8ByteLength } from "@ronde/core/bytes"

describe("@ronde/core utf8ByteLength", () => {
  it("returns 0 for the empty string", () => {
    expect(utf8ByteLength("")).toBe(0)
  })

  it("matches .length for pure ASCII", () => {
    const s = "hello, world"
    expect(utf8ByteLength(s)).toBe(s.length)
  })

  it("counts multi-byte characters as more than one byte each", () => {
    // '€' is 3 bytes in UTF-8, 1 char in UTF-16.
    expect(utf8ByteLength("€")).toBe(3)
    // '🦀' is 4 bytes, 2 UTF-16 code units.
    expect(utf8ByteLength("🦀")).toBe(4)
    // Mixed: 1 + 3 + 1 + 4 + 1 = 10 bytes for "a€b🦀c".
    expect(utf8ByteLength("a€b🦀c")).toBe(10)
  })

  it("loops through the shared buffer for inputs larger than 16 KiB", () => {
    // 50 KiB of ASCII — forces multiple encodeInto passes over the
    // shared 16 KiB buffer. Verify the total matches what TextEncoder
    // would report in one shot.
    const s = "x".repeat(50_000)
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length)
  })

  it("handles multi-byte content crossing buffer boundaries", () => {
    // 16 KiB of '€' chars = 48 KiB of bytes, spread across many buffer
    // passes. Cross-checks against a single full-encode.
    const s = "€".repeat(16_000)
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length)
  })
})
