import { describe, expect, it } from "vitest"
import {
  audio,
  Block,
  BlockKind,
  file,
  image,
  ref,
  text,
} from "@ronde/core/block"

describe("@ronde/core block constructors", () => {
  it("text wraps a string in a TextBlock", () => {
    const b = text("hi")
    expect(b).toEqual({ kind: BlockKind.Text, text: "hi" })
  })

  it("image produces a BinaryBlock keyed on mediaType", () => {
    const b = image("aGVsbG8=", "image/png")
    expect(b).toEqual({
      kind: BlockKind.Binary,
      data: "aGVsbG8=",
      mediaType: "image/png",
    })
  })

  it("audio produces a BinaryBlock with audio mediaType", () => {
    const b = audio("aGVsbG8=", "audio/wav")
    expect(b.kind).toBe(BlockKind.Binary)
    expect(b.mediaType).toBe("audio/wav")
  })

  it("file carries optional filename", () => {
    const withName = file("aGVsbG8=", {
      mediaType: "application/pdf",
      filename: "report.pdf",
    })
    expect(withName).toEqual({
      kind: BlockKind.Binary,
      data: "aGVsbG8=",
      mediaType: "application/pdf",
      filename: "report.pdf",
    })

    const without = file("aGVsbG8=", { mediaType: "application/pdf" })
    expect(without).toEqual({
      kind: BlockKind.Binary,
      data: "aGVsbG8=",
      mediaType: "application/pdf",
    })
    expect("filename" in without).toBe(false)
  })

  it("ref produces a RefBlock with optional metadata omitted when unset", () => {
    const minimal = ref("file:///tmp/x.log")
    expect(minimal).toEqual({ kind: BlockKind.Ref, uri: "file:///tmp/x.log" })

    const rich = ref("file:///tmp/x.log", {
      mediaType: "text/plain",
      bytes: 1024,
      summary: "20 lines",
    })
    expect(rich).toEqual({
      kind: BlockKind.Ref,
      uri: "file:///tmp/x.log",
      mediaType: "text/plain",
      bytes: 1024,
      summary: "20 lines",
    })
  })

  it("binary blocks accept URL form alongside inline data", () => {
    const url = new URL("https://example.com/image.png")
    const b = image(url, "image/png")
    expect(b.data).toBe(url)
  })

  it("Block union is exhaustively discriminated by kind", () => {
    const blocks: Block[] = [
      text("a"),
      image("aGk=", "image/png"),
      ref("file:///x"),
    ]
    for (const b of blocks) {
      switch (b.kind) {
        case BlockKind.Text:
          expect(typeof b.text).toBe("string")
          break
        case BlockKind.Binary:
          expect(typeof b.mediaType).toBe("string")
          break
        case BlockKind.Ref:
          expect(typeof b.uri).toBe("string")
          break
        default: {
          const _: never = b
          throw new Error(`unreachable: ${_}`)
        }
      }
    }
  })
})
