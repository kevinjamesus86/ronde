/** Random hex string. `bytes` random bytes → 2×bytes hex chars. */
export function genHex(bytes = 4): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let out = ""
  for (const b of buf) {
    out += b.toString(16).padStart(2, "0")
  }
  return out
}

/** Sortable id: `<prefix>-<base36 time>_<hex>`. */
export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}_${genHex()}`
}
