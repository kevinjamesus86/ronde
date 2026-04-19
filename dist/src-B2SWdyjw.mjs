import { err, ok } from "./result.mjs";
import { merge, tool } from "./toolkit.mjs";
import { isDirectoryWorkspace } from "./workspace.mjs";
import { z } from "zod/v4";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import ignore from "ignore";
import { spawn } from "node:child_process";
//#region packages/core/src/id.ts
/** Random hex string. `bytes` random bytes → 2×bytes hex chars. */
function genHex(bytes = 4) {
	const buf = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buf);
	let out = "";
	for (const b of buf) out += b.toString(16).padStart(2, "0");
	return out;
}
/** Sortable id: `<prefix>-<base36 time>_<hex>`. */
function genId(prefix) {
	return `${prefix}-${Date.now().toString(36)}_${genHex()}`;
}
//#endregion
//#region packages/tools/src/context.ts
function resolveReal(p) {
	const abs = path.resolve(p);
	try {
		return syncFs.realpathSync(abs);
	} catch {
		return abs;
	}
}
function ro(p) {
	return {
		path: p,
		access: "r"
	};
}
function rw(p) {
	return {
		path: p,
		access: "rw"
	};
}
function normalizeRoot(root) {
	if (typeof root === "string") return {
		resolved: resolveReal(root),
		access: "rw"
	};
	return {
		resolved: resolveReal(root.path),
		access: root.access
	};
}
/**
* Jails paths to a set of root directories. Resolves symlinks through
* realpath before enforcing boundaries, so a symlink inside a root that
* escapes to an outside target is rejected.
*/
var PathContext = class PathContext {
	_roots;
	constructor(roots) {
		this._roots = new Map(roots.map((r) => {
			const n = normalizeRoot(r);
			return [n.resolved, n.access];
		}));
	}
	get roots() {
		return [...this._roots.keys()];
	}
	get writableRoots() {
		return [...this._roots.entries()].filter(([, access]) => access === "rw").map(([dir]) => dir);
	}
	addRoot(root) {
		const n = normalizeRoot(root);
		this._roots.set(n.resolved, n.access);
	}
	removeRoot(root) {
		const n = normalizeRoot(root);
		this._roots.delete(n.resolved);
	}
	cloneWithRoot(root) {
		const clone = new PathContext([]);
		clone._roots = new Map(this._roots);
		clone.addRoot(root);
		return clone;
	}
	/** Path is inside any declared root. */
	safePath(filePath, argName = "file_path") {
		return this._resolve(filePath, argName);
	}
	/** Any declared root permits reads, so this is equivalent to {@link safePath}. */
	safeRead(filePath, argName = "file_path") {
		return this._resolve(filePath, argName);
	}
	/** Path is inside an `rw` root. Read-only roots are rejected. */
	safeWrite(filePath, argName = "file_path") {
		const check = this._resolve(filePath, argName);
		if (!check.ok) return check;
		if (this._accessFor(check.path) !== "rw") return {
			ok: false,
			error: `${argName} is in a read-only path: ${filePath}`
		};
		return check;
	}
	canRead(filePath) {
		return this.safeRead(filePath).ok;
	}
	canWrite(filePath) {
		return this.safeWrite(filePath).ok;
	}
	safeDirectoryPath(dirPath, argName = "path") {
		const check = this.safePath(dirPath, argName);
		if (!check.ok) return check;
		if (!syncFs.existsSync(check.path)) return {
			ok: false,
			error: `Directory not found: ${dirPath}`
		};
		if (!syncFs.statSync(check.path).isDirectory()) return {
			ok: false,
			error: `Not a directory: ${dirPath}`
		};
		return check;
	}
	/**
	* Generate a macOS sandbox-exec profile.
	*
	* - `reads`: default `"*"` (unrestricted). `"roots"` restricts
	*   to declared roots + system paths.
	* - `writes`: default `"roots"` (restricted to rw roots).
	*   `"*"` unrestricts.
	* - `network`: default `true` (allowed). `false` denies.
	*/
	sandboxProfile(options) {
		const sysRead = [
			"(literal \"/\")",
			"(subpath \"/bin\")",
			"(subpath \"/dev\")",
			"(subpath \"/etc\")",
			"(subpath \"/Library\")",
			"(subpath \"/opt\")",
			"(subpath \"/private\")",
			"(subpath \"/sbin\")",
			"(subpath \"/System\")",
			"(subpath \"/usr\")",
			"(subpath \"/var\")"
		].join(" ");
		const sysWrite = [
			"(subpath \"/dev\")",
			"(subpath \"/private/tmp\")",
			"(subpath \"/private/var/folders\")"
		].join(" ");
		const rules = ["(version 1)", "(allow default)"];
		if (options?.reads === "roots") {
			const subpaths = this.roots.map((dir) => `(subpath "${dir}")`).join(" ");
			rules.push("(deny file-read*)");
			rules.push("(allow file-read-metadata)");
			rules.push(`(allow file-read* ${subpaths} ${sysRead})`);
		}
		if (options?.writes !== "*") {
			const subpaths = this.writableRoots.map((dir) => `(subpath "${dir}")`).join(" ");
			rules.push("(deny file-write*)");
			rules.push(`(allow file-write* ${subpaths} ${sysWrite})`);
		}
		if (options?.network === false) rules.push("(deny network*)");
		return rules.join("\n");
	}
	_resolve(filePath, argName) {
		if (!path.isAbsolute(filePath)) return {
			ok: false,
			error: `${argName} must be absolute, got relative path: ${filePath}`
		};
		const resolved = path.resolve(filePath);
		let real;
		try {
			real = syncFs.realpathSync(resolved);
		} catch {
			let ancestor = path.dirname(resolved);
			let tail = path.basename(resolved);
			while (!syncFs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
				tail = path.join(path.basename(ancestor), tail);
				ancestor = path.dirname(ancestor);
			}
			try {
				real = path.join(syncFs.realpathSync(ancestor), tail);
			} catch {
				real = resolved;
			}
		}
		if (![...this._roots.keys()].some((dir) => real === dir || real.startsWith(dir + path.sep))) return {
			ok: false,
			error: `${argName} escapes allowed directories: ${filePath}`
		};
		return {
			ok: true,
			path: real
		};
	}
	_accessFor(resolvedPath) {
		for (const [dir, access] of this._roots) if (resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)) return access;
		return null;
	}
};
//#endregion
//#region packages/tools/src/workspace-path.ts
/**
* Add the active directory-backed workspace as a read-only root so
* tools can read spilled artifacts back without widening write scope.
* Non-directory workspaces pass through unchanged.
*/
function pathContextForWorkspace(base, workspace) {
	if (isDirectoryWorkspace(workspace)) return base.cloneWithRoot(ro(workspace.dir));
	return base;
}
//#endregion
//#region packages/tools/src/fs-tool.ts
const fsTool = tool();
//#endregion
//#region packages/tools/src/read-file.ts
const DEFAULT_LIMIT = 2e3;
const MAX_LINE_CHARS = 2e3;
const parameters$6 = z.object({
	file_path: z.string().describe("Absolute path to the file to read"),
	offset: z.number().min(1).default(1).describe("First line to read (1-indexed). Default: 1."),
	limit: z.number().min(1).default(DEFAULT_LIMIT).describe(`Max lines to read. Default: ${DEFAULT_LIMIT}. Individual lines longer than ${MAX_LINE_CHARS} chars are truncated.`)
});
/**
* Read a file with 1-indexed line pagination. Defaults to the first
* {@link DEFAULT_LIMIT} lines; page larger files with `offset`/`limit`.
* Individual lines over {@link MAX_LINE_CHARS} chars are truncated.
*/
const readFile = (pathCtx) => fsTool({
	name: "read_file",
	description: "Read a file's contents. Returns up to `limit` lines (default 2000) starting at `offset` (default 1, 1-indexed). Output is formatted with line numbers.",
	parameters: parameters$6,
	execute: (args, ctx) => read(pathContextForWorkspace(pathCtx, ctx.workspace), args),
	format: format$4
});
async function read(pathCtx, args) {
	const check = pathCtx.safeRead(args.file_path);
	if (!check.ok) return err(check.error);
	let raw;
	try {
		raw = await fs.readFile(check.path, "utf-8");
	} catch (e) {
		return err(e.code === "ENOENT" ? `File not found: ${args.file_path}` : e.message);
	}
	const allLines = raw.split("\n");
	if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
	const totalLines = allLines.length;
	const offset = args.offset;
	const limit = args.limit;
	if (offset > totalLines) return ok({
		path: check.path,
		content: "",
		totalLines,
		startLine: offset,
		endLine: offset - 1,
		truncated: true
	});
	const startLine = offset;
	const endLine = Math.min(offset + limit - 1, totalLines);
	const slice = allLines.slice(startLine - 1, endLine).map((line) => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "… [line truncated]" : line);
	const truncated = endLine < totalLines || offset > 1;
	return ok({
		path: check.path,
		content: slice.join("\n"),
		totalLines,
		startLine,
		endLine,
		truncated
	});
}
function format$4(data) {
	if (data.totalLines === 0) return "(empty file)";
	if (data.content === "") return `(no lines in range — file has ${data.totalLines} lines. Use a smaller offset to read.)`;
	const width = String(data.endLine).length;
	let out = data.content.split("\n").map((line, i) => {
		return `${String(data.startLine + i).padStart(width, " ")}→${line}`;
	}).join("\n");
	if (data.truncated) out += `\n\n[Showing lines ${data.startLine}-${data.endLine} of ${data.totalLines}. Use offset/limit to read other ranges.]`;
	return out;
}
//#endregion
//#region packages/tools/src/write-file.ts
const parameters$5 = z.object({
	file_path: z.string().describe("Absolute path to the file to write"),
	content: z.string().describe("The content to write to the file")
});
/**
* Write a file. Overwrites existing content, creates parent
* directories, and rejects targets outside any `rw` root.
*/
const writeFile = (pathCtx) => fsTool({
	name: "write_file",
	description: "Write a file to disk. Overwrites if it exists. Creates parent directories as needed.",
	parameters: parameters$5,
	execute: (args, ctx) => write(pathContextForWorkspace(pathCtx, ctx.workspace), args),
	format: (data) => `OK — ${data.bytesWritten} bytes written`
});
async function write(pathCtx, args) {
	const check = pathCtx.safeWrite(args.file_path);
	if (!check.ok) return err(check.error);
	await fs.mkdir(path.dirname(check.path), { recursive: true });
	await fs.writeFile(check.path, args.content, "utf-8");
	return ok({
		path: check.path,
		bytesWritten: args.content.length
	});
}
//#endregion
//#region packages/tools/src/edit-file.ts
const parameters$4 = z.object({
	file_path: z.string().describe("Absolute path to the file to modify"),
	old_string: z.string().describe("The text to replace"),
	new_string: z.string().describe("The replacement text")
});
/**
* Exact string replacement. `old_string` must occur exactly once; zero
* or multiple matches return an error rather than guessing.
*/
const editFile = (pathCtx) => fsTool({
	name: "edit_file",
	description: "Exact string replacement in a file. old_string must appear exactly once.",
	parameters: parameters$4,
	execute: (args, ctx) => edit(pathContextForWorkspace(pathCtx, ctx.workspace), args),
	format: () => "OK"
});
async function edit(pathCtx, args) {
	const check = pathCtx.safeWrite(args.file_path);
	if (!check.ok) return err(check.error);
	let content;
	try {
		content = await fs.readFile(check.path, "utf-8");
	} catch (e) {
		if (e.code === "ENOENT") return err(`File not found: ${args.file_path}`);
		return err(e.message);
	}
	const idx = content.indexOf(args.old_string);
	if (idx === -1) return err(`old_string not found in ${args.file_path}\nHint: Ensure the old_string matches exactly (including whitespace).`);
	const secondIdx = content.indexOf(args.old_string, idx + 1);
	if (secondIdx !== -1) return err(`old_string is not unique in ${args.file_path} (found at positions ${idx} and ${secondIdx})`);
	const updated = content.slice(0, idx) + args.new_string + content.slice(idx + args.old_string.length);
	await fs.writeFile(check.path, updated, "utf-8");
	return ok({ path: check.path });
}
//#endregion
//#region packages/tools/src/walk.ts
/**
* @module
* Shared file traversal backed by tinyglobby + ignore.
*
* Nested `.gitignore` handling: walks up from `cwd` to the repo root
* (nearest `.git`), then loads every `.gitignore` from the root down
* with each rule scoped to its containing directory.
*/
/** Walk up from `cwd` to the nearest `.git`. Returns `cwd` if none found. */
async function findRepoRoot(cwd) {
	let dir = cwd;
	while (true) {
		try {
			const stat = await fs.stat(path.join(dir, ".git"));
			if (stat.isDirectory() || stat.isFile()) return dir;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}
/** Prefix every pattern in a `.gitignore` with its directory scope. */
function scopePatterns(content, scope) {
	return content.split("\n").map((line) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return "";
		if (scope === "") return trimmed;
		const negate = trimmed.startsWith("!");
		const pat = negate ? trimmed.slice(1) : trimmed;
		const clean = pat.startsWith("/") ? pat.slice(1) : pat;
		return `${negate ? "!" : ""}${scope}/${clean}`;
	}).filter(Boolean).join("\n");
}
/** Collect every `.gitignore` under `repoRoot`, each scoped to its directory. */
async function loadNestedGitignores(repoRoot, searchCwd) {
	const ig = ignore();
	ig.add([".git", "node_modules"]);
	const files = await glob("**/.gitignore", {
		cwd: repoRoot,
		dot: true,
		followSymbolicLinks: false,
		ignore: ["**/node_modules/**", "**/.git/**"]
	});
	for (const rel of files.sort()) {
		const dir = path.dirname(rel);
		try {
			const content = await fs.readFile(path.join(repoRoot, rel), "utf-8");
			const scope = path.relative(searchCwd, path.join(repoRoot, dir === "." ? "" : dir));
			if (scope.startsWith("..")) continue;
			ig.add(scopePatterns(content, scope));
		} catch {}
	}
	return ig;
}
async function walk(opts) {
	const { cwd, pattern = "**/*", deep, onlyFiles = true } = opts;
	const results = await glob(pattern, {
		cwd,
		deep,
		dot: false,
		onlyFiles,
		onlyDirectories: false,
		followSymbolicLinks: false,
		expandDirectories: false
	});
	if (opts.gitignore === false) return results.sort();
	return (await loadNestedGitignores(await findRepoRoot(cwd), cwd)).filter(results).sort();
}
//#endregion
//#region packages/tools/src/glob-files.ts
const MAX_RESULTS = 500;
const parameters$3 = z.object({
	pattern: z.string().describe("Glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.ts\")"),
	path: z.string().describe("Absolute path to the directory to search")
});
/**
* Find files by glob pattern. Capped at {@link MAX_RESULTS} matches;
* `.gitignore` is respected by default.
*/
const globFiles = (pathCtx, opts = {}) => fsTool({
	name: "glob_files",
	description: `Find files by glob pattern. Respects .gitignore by default. Returns up to ${MAX_RESULTS} matches.`,
	parameters: parameters$3,
	execute: (args, ctx) => run$1(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
	format: format$3
});
async function run$1(pathCtx, opts, args) {
	const check = pathCtx.safeDirectoryPath(args.path, "path");
	if (!check.ok) return err(check.error);
	const matches = await walk({
		cwd: check.path,
		pattern: args.pattern,
		gitignore: opts.gitignore
	});
	const truncated = matches.length > MAX_RESULTS;
	return ok({
		matches: truncated ? matches.slice(0, MAX_RESULTS) : matches,
		totalMatches: matches.length,
		truncated
	});
}
function format$3(data) {
	if (data.matches.length === 0) return "No matches.";
	let out = groupByDir(data.matches);
	if (data.truncated) out += `\n\n(${data.totalMatches} total — showing first ${MAX_RESULTS})`;
	return out;
}
function groupByDir(paths) {
	const groups = /* @__PURE__ */ new Map();
	for (const p of paths) {
		const slash = p.lastIndexOf("/");
		const dir = slash === -1 ? "" : p.slice(0, slash + 1);
		const file = slash === -1 ? p : p.slice(slash + 1);
		let arr = groups.get(dir);
		if (!arr) {
			arr = [];
			groups.set(dir, arr);
		}
		arr.push(file);
	}
	const sections = [];
	for (const [dir, files] of groups) if (dir === "") sections.push(files.join("\n"));
	else sections.push(`${dir}\n  ${files.join("\n  ")}`);
	return sections.join("\n\n");
}
//#endregion
//#region packages/tools/src/grep-files.ts
const MAX_INLINE = 200;
const HARD_LIMIT$1 = 1e4;
const MAX_FILE_SIZE = 1024 * 1024;
const parameters$2 = z.object({
	pattern: z.string().describe("ECMAScript (JS) regex pattern to search for"),
	path: z.string().describe("Absolute path to the directory to search"),
	include: z.string().default("**/*").describe("Glob filter for files (e.g. \"*.ts\", \"**/*.md\")")
});
/**
* Search file contents with a JS regex. Skips binary files and files
* larger than {@link MAX_FILE_SIZE}. Up to {@link MAX_INLINE} matches
* return inline; on overflow the full `file:line: text` list spills to
* the workspace and the model drills in via `read_file`. Respects
* `.gitignore` by default.
*/
const grepFiles = (pathCtx, opts = {}) => fsTool({
	name: "grep_files",
	description: `Search file contents using a regex. Returns matching lines grouped by file. First ${MAX_INLINE} matches shown inline; on overflow the full list is spilled — drill in with read_file.`,
	parameters: parameters$2,
	execute: (args, ctx) => grep(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args, ctx),
	format: format$2
});
async function grep(pathCtx, opts, args, ctx) {
	const check = pathCtx.safeDirectoryPath(args.path, "path");
	if (!check.ok) return err(check.error);
	const base = check.path;
	let regex;
	try {
		regex = new RegExp(args.pattern);
	} catch (e) {
		return err(`Invalid regex: ${e.message}`);
	}
	if (regex.test("")) return err("Pattern matches empty string — too broad.");
	const files = await walk({
		cwd: base,
		pattern: args.include,
		gitignore: opts.gitignore
	});
	const allMatches = [];
	const matchedFiles = /* @__PURE__ */ new Set();
	outer: for (const rel of files) {
		const full = path.join(base, rel);
		try {
			if ((await fs.stat(full)).size > MAX_FILE_SIZE) continue;
			const buf = await fs.readFile(full);
			if (buf.includes(0)) continue;
			const lines = buf.toString("utf-8").split("\n");
			for (let i = 0; i < lines.length; i++) if (regex.test(lines[i])) {
				allMatches.push({
					file: rel,
					line: i + 1,
					text: lines[i]
				});
				matchedFiles.add(rel);
				if (allMatches.length >= HARD_LIMIT$1) break outer;
			}
		} catch {}
	}
	const totalMatches = allMatches.length;
	const truncated = totalMatches > MAX_INLINE;
	const inline = truncated ? allMatches.slice(0, MAX_INLINE) : allMatches;
	let fullMatchesPath;
	if (truncated) {
		const body = allMatches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
		fullMatchesPath = (await ctx.spill(body)).path;
	}
	return ok({
		matches: inline,
		fileCount: matchedFiles.size,
		totalMatches,
		truncated,
		...fullMatchesPath ? { fullMatchesPath } : {}
	});
}
function format$2(data) {
	if (data.matches.length === 0) return "No matches.";
	const byFile = /* @__PURE__ */ new Map();
	for (const m of data.matches) {
		let arr = byFile.get(m.file);
		if (!arr) {
			arr = [];
			byFile.set(m.file, arr);
		}
		arr.push(`${m.line}: ${m.text}`);
	}
	const sections = [];
	for (const [file, lines] of byFile) sections.push(`## ${file}\n${lines.join("\n")}`);
	let out = sections.join("\n\n");
	if (data.truncated) out += `\n\n[${data.totalMatches} total matches — showing first ${MAX_INLINE}.` + (data.fullMatchesPath ? ` Full list at ${data.fullMatchesPath}. Use read_file with offset/limit to see more.` : "") + `]`;
	return out;
}
//#endregion
//#region packages/tools/src/list-directory.ts
const MAX_ENTRIES = 500;
const parameters$1 = z.object({
	path: z.string().describe("Absolute path to the directory to list"),
	depth: z.number().min(1).max(5).default(1).describe("How deep to traverse. 1 = flat, 2+ = tree.")
});
/**
* List a directory as a tree. `depth: 1` is a flat listing; up to
* `depth: 5` for project overviews. Capped at {@link MAX_ENTRIES}.
* Respects `.gitignore` by default.
*/
const listDirectory = (pathCtx, opts = {}) => fsTool({
	name: "list_directory",
	description: `List files and directories as a tree. Depth 1 = flat listing, up to 5 for project structure. Respects .gitignore. Max ${MAX_ENTRIES} entries.`,
	parameters: parameters$1,
	execute: (args, ctx) => list(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
	format: format$1
});
async function list(pathCtx, opts, args) {
	const check = pathCtx.safeDirectoryPath(args.path, "path");
	if (!check.ok) return err(check.error);
	const base = check.path;
	const paths = await walk({
		cwd: base,
		pattern: "**/*",
		deep: args.depth ?? 1,
		onlyFiles: false,
		gitignore: opts.gitignore
	});
	const truncated = paths.length > MAX_ENTRIES;
	const visible = truncated ? paths.slice(0, MAX_ENTRIES) : paths;
	return ok({
		path: base,
		entries: await Promise.all(visible.map(async (rel) => {
			const isDir = rel.endsWith("/");
			const name = isDir ? rel.slice(0, -1) : rel;
			if (isDir) return {
				name,
				type: "directory"
			};
			try {
				return {
					name,
					type: "file",
					sizeBytes: (await fs.stat(path.join(base, rel))).size
				};
			} catch {
				return {
					name,
					type: "file"
				};
			}
		})),
		truncated
	});
}
function format$1(data) {
	if (data.entries.length === 0) return "Empty directory.";
	let out = data.entries.map((e) => {
		const depth = e.name.split("/").length - 1;
		const indent = "  ".repeat(depth);
		const base = e.name.split("/").pop();
		if (e.type === "directory") return `${indent}${base}/`;
		return `${indent}${base}${e.sizeBytes != null ? ` (${formatSize(e.sizeBytes)})` : ""}`;
	}).join("\n");
	if (data.truncated) out += `\n\n(truncated — ${MAX_ENTRIES} entries shown)`;
	return out;
}
function formatSize(bytes) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
//#endregion
//#region packages/tools/src/shell.ts
const CPU_LIMIT_SEC = 60;
const TIMEOUT_MS = 65e3;
const INLINE_CAP = 25e3;
const PREVIEW_HEAD = 1e4;
const PREVIEW_TAIL = 1e4;
const HARD_LIMIT = 5 * 1024 * 1024;
const parameters = z.object({ command: z.string().describe("Shell command to execute. Must be non-interactive.") });
/**
* Run zsh commands with a cwd that persists across calls — a `cd` in
* one call affects the next. Runs under `sandbox-exec` by default
* (writes restricted to rw roots; reads unrestricted).
*
* Output over {@link INLINE_CAP} bytes is head+tail-previewed inline
* and spilled in full to the workspace; the model drills into the
* spill via `read_file`.
*
* @param opts.cwd - Starting working directory (default: first root).
* @param opts.sandbox - `true` (default) restricts writes, `false`
*   disables sandboxing, {@link SandboxConfig} gives fine-grained
*   control over reads/writes/network.
*/
const shell = (pathCtx, opts = {}) => {
	const initialCwd = opts.cwd ?? pathCtx.roots[0];
	const sandbox = opts.sandbox ?? true;
	return fsTool({
		name: "shell",
		description: "Executes a zsh command. Working directory persists between calls. Timeout 60s. Long output is middle-truncated inline and spilled in full; read the full output via read_file with offset/limit.",
		parameters,
		state: { init: () => ({ cwd: initialCwd }) },
		execute: (args, ctx) => run(pathCtx, sandbox, args, ctx),
		format
	});
};
async function run(pathCtx, sandbox, args, ctx) {
	const raw = await runProcess(pathCtx, sandbox, args, ctx);
	if (!raw.ok) return err(raw.error);
	const { stdout, stderr, exitCode, totalBytes } = raw.data;
	let inlineStdout = stdout;
	let truncated = false;
	let fullStdoutPath;
	if (stdout.length > INLINE_CAP) {
		const spillResult = await ctx.spill(stdout, {
			previewHead: PREVIEW_HEAD,
			previewTail: PREVIEW_TAIL
		});
		inlineStdout = spillResult.preview;
		truncated = true;
		fullStdoutPath = spillResult.path;
	}
	const data = {
		exitCode,
		stdout: inlineStdout,
		stderr,
		truncated,
		totalBytes,
		...fullStdoutPath ? { fullStdoutPath } : {}
	};
	if (exitCode !== 0) return err(`Command failed with exit code ${exitCode}`, data);
	return ok(data);
}
function runProcess(pathCtx, sandbox, args, ctx) {
	const enabled = sandbox !== false;
	const config = typeof sandbox === "object" ? sandbox : void 0;
	const profile = pathCtx.sandboxProfile(config);
	const sentinel = `__CWD_${Date.now()}__`;
	const script = `ulimit -t ${CPU_LIMIT_SEC}\nalias python=python3\nexec 2>&1\n${args.command}\n__exit=$?\necho "${sentinel}$(pwd)"\nexit $__exit\n`;
	const scriptPath = path.join(ensureTmpDir(), `.cmd_${genHex()}.zsh`);
	return new Promise((resolve) => {
		syncFs.writeFileSync(scriptPath, script, "utf-8");
		const spawnArgs = enabled ? ["sandbox-exec", [
			"-p",
			profile,
			"zsh",
			scriptPath
		]] : ["zsh", [scriptPath]];
		const child = spawn(spawnArgs[0], [...spawnArgs[1]], {
			cwd: ctx.state.cwd,
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let totalBytes = 0;
		child.stdout.on("data", (data) => {
			totalBytes += data.length;
			if (stdout.length < HARD_LIMIT) stdout += data;
		});
		child.stderr.on("data", (data) => {
			totalBytes += data.length;
			if (stderr.length < HARD_LIMIT) stderr += data;
		});
		let killTimer = null;
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}, 2e3);
		}, TIMEOUT_MS);
		function finish(exitCode) {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			try {
				syncFs.unlinkSync(scriptPath);
			} catch {}
			const sentinelIdx = stdout.lastIndexOf(sentinel);
			if (sentinelIdx !== -1) {
				const newCwd = stdout.slice(sentinelIdx + sentinel.length).trim();
				const strippedLen = stdout.length - sentinelIdx;
				stdout = stdout.slice(0, sentinelIdx);
				totalBytes = Math.max(0, totalBytes - strippedLen);
				if (newCwd && path.isAbsolute(newCwd)) {
					const cwdCheck = pathCtx.safePath(newCwd, "cwd");
					if (cwdCheck.ok) ctx.state.cwd = cwdCheck.path;
				}
			}
			resolve(ok({
				stdout: stdout.trimEnd(),
				stderr: stderr.trimEnd(),
				exitCode,
				totalBytes
			}));
		}
		child.on("close", (code) => finish(code || 0));
		child.on("error", (e) => {
			clearTimeout(timer);
			try {
				syncFs.unlinkSync(scriptPath);
			} catch {}
			resolve(err(e.message));
		});
	});
}
function format(data) {
	let output = data.stdout;
	if (data.truncated && data.fullStdoutPath) output += `\n\n[Output truncated (${data.totalBytes} bytes total). Full output at ${data.fullStdoutPath}. Use read_file with offset/limit to see specific ranges.]`;
	if (data.exitCode !== 0) {
		if (data.stderr) output += `\n\nSTDERR:\n${data.stderr}`;
		output += `\n[exit ${data.exitCode}]`;
	}
	return output;
}
function ensureTmpDir() {
	const dir = path.join(os.tmpdir(), ".ronde");
	syncFs.mkdirSync(dir, { recursive: true });
	return dir;
}
//#endregion
//#region packages/tools/src/index.ts
/**
* @module
* Core filesystem and shell tools with path sandboxing.
*
* @example
* ```ts
* import { coreTools } from "@ronde/tools";
*
* const toolkit = coreTools({ roots: [process.cwd()] });
* ```
*/
/**
* Assemble the 7 core tools over one shared `PathContext`. The same
* `roots` config drives file access and the seatbelt profile.
*
* For finer control, compose the individual tool factories directly
* with `merge()`.
*/
function coreTools(opts) {
	if (opts.roots.length === 0) throw new Error("coreTools requires at least one root.");
	const pathCtx = new PathContext(opts.roots);
	const shellOpts = opts.shell ?? {};
	if (shellOpts.cwd) {
		if (!pathCtx.canRead(shellOpts.cwd)) throw new Error(`shell.cwd "${shellOpts.cwd}" is not within any declared root.`);
		const cwdCheck = pathCtx.safeDirectoryPath(shellOpts.cwd, "shell.cwd");
		if (!cwdCheck.ok) throw new Error(cwdCheck.error);
	}
	const gitignore = opts.gitignore ?? true;
	return merge(readFile(pathCtx), writeFile(pathCtx), editFile(pathCtx), globFiles(pathCtx, { gitignore }), grepFiles(pathCtx, { gitignore }), listDirectory(pathCtx, { gitignore }), shell(pathCtx, {
		cwd: shellOpts.cwd,
		sandbox: shellOpts.sandbox ?? true
	}));
}
//#endregion
export { globFiles as a, readFile as c, rw as d, genHex as f, grepFiles as i, PathContext as l, shell as n, editFile as o, genId as p, listDirectory as r, writeFile as s, coreTools as t, ro as u };

//# sourceMappingURL=src-B2SWdyjw.mjs.map