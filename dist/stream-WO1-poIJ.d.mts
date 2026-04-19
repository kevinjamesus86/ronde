//#region packages/core/src/stream.d.ts
/**
 * @module
 * Async stream primitives — Promise-or-AsyncGenerator detection and
 * normalization for tool `execute` and backend `complete`.
 */
declare function isAsyncGenerator<Y = unknown, R = unknown, N = unknown>(x: unknown): x is AsyncGenerator<Y, R, N>;
/** Normalize a Promise-or-AsyncGenerator into a generator. A Promise becomes a zero-yield generator; a generator passes through. */
declare function asGenerator<Y, R>(ret: Promise<R> | AsyncGenerator<Y, R, void>): AsyncGenerator<Y, R, void>;
/** Drain a Promise-or-AsyncGenerator, discarding yields, returning the final value. */
declare function drain<Y, R>(ret: Promise<R> | AsyncGenerator<Y, R, void>): Promise<R>;
//#endregion
export { drain as n, isAsyncGenerator as r, asGenerator as t };
//# sourceMappingURL=stream-WO1-poIJ.d.mts.map