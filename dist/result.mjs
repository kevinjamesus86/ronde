//#region packages/core/src/result.ts
function ok(data) {
	return {
		ok: true,
		data
	};
}
function err(error, data) {
	const message = error instanceof Error ? error.message : String(error);
	if (data !== void 0) return {
		ok: false,
		error: message,
		data
	};
	return {
		ok: false,
		error: message
	};
}
function isOk(r) {
	return r.ok === true;
}
//#endregion
export { err, isOk, ok };

//# sourceMappingURL=result.mjs.map