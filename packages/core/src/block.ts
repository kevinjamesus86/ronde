/**
 * @module
 * Content blocks — the universal vocabulary for everything a tool
 * returns and a multimodal message carries. One discriminated union
 * with three kinds:
 *
 * - `text`   — UTF-8 prose the model reads as tokens
 * - `binary` — bytes with a `mediaType` (image, audio, file). Inline
 *              base64 in `data: string`, or remote via `data: URL`.
 *              Provider adapters route on `mediaType`.
 * - `ref`    — an addressable handle. Used by spill substitution and
 *              by callers handing in pre-existing artifacts. Opaque
 *              to the framework; whoever produced the URI owns
 *              dereferencing.
 *
 * Adding a fourth variant requires a real provider-supported content
 * type, not a speculative niche.
 */

export const enum BlockKind {
  Text = "text",
  Binary = "binary",
  Ref = "ref",
}

export interface TextBlock {
  kind: BlockKind.Text
  text: string
}

export interface BinaryBlock {
  kind: BlockKind.Binary
  data: string | URL
  mediaType: string
  filename?: string
}

export interface RefBlock {
  kind: BlockKind.Ref
  uri: string
  mediaType?: string
  bytes?: number
  summary?: string
}

export type Block = TextBlock | BinaryBlock | RefBlock

export function text(s: string): TextBlock {
  return { kind: BlockKind.Text, text: s }
}

export function image(data: string | URL, mediaType: string): BinaryBlock {
  return { kind: BlockKind.Binary, data, mediaType }
}

export function file(
  data: string | URL,
  opts: { mediaType: string; filename?: string },
): BinaryBlock {
  return {
    kind: BlockKind.Binary,
    data,
    mediaType: opts.mediaType,
    ...(opts.filename === undefined ? {} : { filename: opts.filename }),
  }
}

export function audio(data: string | URL, mediaType: string): BinaryBlock {
  return { kind: BlockKind.Binary, data, mediaType }
}

export function ref(
  uri: string,
  opts: { mediaType?: string; bytes?: number; summary?: string } = {},
): RefBlock {
  return {
    kind: BlockKind.Ref,
    uri,
    ...(opts.mediaType === undefined ? {} : { mediaType: opts.mediaType }),
    ...(opts.bytes === undefined ? {} : { bytes: opts.bytes }),
    ...(opts.summary === undefined ? {} : { summary: opts.summary }),
  }
}
