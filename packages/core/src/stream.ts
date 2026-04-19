/**
 * @module
 * Async stream primitives — Promise-or-AsyncGenerator detection and
 * normalization for tool `execute` and backend `complete`.
 */

export function isAsyncGenerator<Y = unknown, R = unknown, N = unknown>(
  x: unknown,
): x is AsyncGenerator<Y, R, N> {
  return (
    x != null &&
    typeof x === "object" &&
    Symbol.asyncIterator in x &&
    typeof (x as { next?: unknown }).next === "function"
  )
}

/** Normalize a Promise-or-AsyncGenerator into a generator. A Promise becomes a zero-yield generator; a generator passes through. */
export async function* asGenerator<Y, R>(
  ret: Promise<R> | AsyncGenerator<Y, R, void>,
): AsyncGenerator<Y, R, void> {
  if (isAsyncGenerator<Y, R>(ret)) {
    let next = await ret.next()
    while (!next.done) {
      yield next.value
      next = await ret.next()
    }
    return next.value
  }
  return await ret
}

/** Drain a Promise-or-AsyncGenerator, discarding yields, returning the final value. */
export async function drain<Y, R>(
  ret: Promise<R> | AsyncGenerator<Y, R, void>,
): Promise<R> {
  if (isAsyncGenerator<Y, R>(ret)) {
    let next = await ret.next()
    while (!next.done) {
      next = await ret.next()
    }
    return next.value
  }
  return await ret
}
