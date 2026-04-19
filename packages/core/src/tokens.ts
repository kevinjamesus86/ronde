// Reused across calls to avoid per-call allocation. 16 KiB fits most
// token-estimator inputs in one pass; longer strings loop without
// reallocating.
const _encoder = new TextEncoder()
const _buf = new Uint8Array(16_384)

function utf8ByteLength(str: string): number {
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

export function estimateTokens(input: string | unknown): number {
  const s = stringifyForTokenEstimate(input)
  const bytes = utf8ByteLength(s)
  const len = s.length

  if (len < 200) {
    return Math.ceil(bytes / 3)
  }

  const windowSize = 100
  const windowCount = Math.min(5, Math.ceil(len / windowSize))
  const gap = Math.floor(len / windowCount)
  let sampled = 0
  let dense = 0
  let struct = 0
  let spaces = 0
  for (let w = 0; w < windowCount; w++) {
    const start = w * gap
    const end = Math.min(start + windowSize, len)
    for (let i = start; i < end; i++) {
      sampled++
      const c = s.charCodeAt(i)
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        spaces++
      } else if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 95 ||
        c === 45
      ) {
        dense++
      } else {
        struct++
      }
    }
  }

  const spaceFrac = spaces / sampled
  const denseFrac = spaceFrac < 0.05 ? dense / sampled : 0
  const structFrac = struct / sampled
  const proseFrac = Math.max(0, 1 - denseFrac - structFrac)
  const bytesPerToken = denseFrac * 1.5 + structFrac * 3 + proseFrac * 4.5

  return Math.ceil(bytes / bytesPerToken)
}

function stringifyForTokenEstimate(input: string | unknown): string {
  if (typeof input === "string") {
    return input
  }

  try {
    const json = JSON.stringify(input)
    if (typeof json === "string") {
      return json
    }
  } catch {
    // Fall through to a conservative string representation.
  }

  return String(input)
}
