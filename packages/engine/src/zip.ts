export function zip<A, B>(a: readonly A[], b: readonly B[]): Array<[A, B]> {
  if (a.length !== b.length) {
    throw new Error(`zip: length mismatch (${a.length} !== ${b.length})`)
  }
  const out: Array<[A, B]> = []
  for (let i = 0; i < a.length; i++) {
    out.push([a[i]!, b[i]!])
  }
  return out
}
