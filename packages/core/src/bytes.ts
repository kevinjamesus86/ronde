/**
 * @module
 * Platform-agnostic UTF-8 byte counting. Uses `TextEncoder` so it runs
 * in Node, browsers, Deno, and workers alike. Shared buffer avoids
 * per-call allocation — strings larger than the buffer loop through it.
 */

// Reused across calls to avoid per-call allocation. 16 KiB fits most
// inputs in one pass; longer strings loop without reallocating.
const _encoder = new TextEncoder()
const _buf = new Uint8Array(16_384)

/** UTF-8 byte length of `str`. */
export function utf8ByteLength(str: string): number {
  if (str.length === 0) {
    return 0
  }

  let total = 0
  let offset = 0

  while (offset < str.length) {
    const { read, written } = _encoder.encodeInto(str.slice(offset), _buf)

    // Spec guarantees read > 0 for a non-empty source with a >= 4-byte
    // buffer; guard anyway so a broken implementation can't loop forever.
    if (read === 0) {
      break
    }

    total += written
    offset += read
  }

  return total
}
