import { describe, expect, it } from "vitest"
import {
  audio,
  Block,
  BlockKind,
  blocksToText,
  file,
  image,
  ref,
  text,
} from "ronde"

describe("ronde public surface — Block vocabulary", () => {
  it("exposes Block, BlockKind, and the constructor helpers from the root entry", () => {
    const blocks: Block[] = [
      text("hi"),
      image("aGVsbG8=", "image/png"),
      audio("aGVsbG8=", "audio/wav"),
      file("aGVsbG8=", { mediaType: "application/pdf", filename: "x.pdf" }),
      ref("file:///tmp/x.txt", { mediaType: "text/plain", bytes: 12 }),
    ]

    expect(blocks.map((b) => b.kind)).toEqual([
      BlockKind.Text,
      BlockKind.Binary,
      BlockKind.Binary,
      BlockKind.Binary,
      BlockKind.Ref,
    ])
  })

  it("exposes blocksToText for projecting blocks to a single string", () => {
    expect(
      blocksToText([text("a"), ref("file:///x", { summary: "log" })]),
    ).toContain("a")
  })
})
