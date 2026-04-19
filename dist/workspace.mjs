//#region packages/core/src/workspace.ts
/**
* Base workspace abstraction. Portable tools should target this
* interface and rely on `spill()` rather than filesystem details.
*/
var Workspace = class {};
/**
* Workspace capability for backends that expose a concrete directory
* and pathful spill results.
*/
var DirectoryWorkspace = class extends Workspace {};
function isDirectoryWorkspace(workspace) {
	return "dir" in workspace && typeof workspace.dir === "string";
}
/**
* Sanitize a filename base for fs use. Replaces characters reserved
* by Windows or POSIX, plus control characters, with `_`. Trims
* leading/trailing `_`. Caps at `max` chars. Returns empty string
* if the input sanitizes to nothing — callers must handle that.
*/
function sanitizeFilename(s, max = 200) {
	return s.replace(/[\\/:*?"<>| \x00-\x1f]/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
}
/**
* Build an inline preview: `<head>\n\n[...N truncated...]\n\n<tail>`.
* Returns the content unchanged if it fits within `head + tail`.
*/
function makePreview(content, head, tail) {
	if (content.length <= head + tail) return content;
	const h = content.slice(0, head);
	const t = content.slice(-tail);
	return `${h}\n\n[... ${content.length - head - tail} characters truncated ...]\n\n${t}`;
}
//#endregion
export { DirectoryWorkspace, Workspace, isDirectoryWorkspace, makePreview, sanitizeFilename };

//# sourceMappingURL=workspace.mjs.map