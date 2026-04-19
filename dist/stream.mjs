//#region packages/core/src/stream.ts
/**
* @module
* Async stream primitives — Promise-or-AsyncGenerator detection and
* normalization for tool `execute` and backend `complete`.
*/
function isAsyncGenerator(x) {
	return x != null && typeof x === "object" && Symbol.asyncIterator in x && typeof x.next === "function";
}
/** Normalize a Promise-or-AsyncGenerator into a generator. A Promise becomes a zero-yield generator; a generator passes through. */
async function* asGenerator(ret) {
	if (isAsyncGenerator(ret)) {
		let next = await ret.next();
		while (!next.done) {
			yield next.value;
			next = await ret.next();
		}
		return next.value;
	}
	return await ret;
}
/** Drain a Promise-or-AsyncGenerator, discarding yields, returning the final value. */
async function drain(ret) {
	if (isAsyncGenerator(ret)) {
		let next = await ret.next();
		while (!next.done) next = await ret.next();
		return next.value;
	}
	return await ret;
}
//#endregion
export { asGenerator, drain, isAsyncGenerator };

//# sourceMappingURL=stream.mjs.map