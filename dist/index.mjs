import { z } from "zod/v4";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import syncFs from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import { glob } from "tinyglobby";
import ignore from "ignore";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tryAcquire } from "@ronde/lock";
import crypto from "node:crypto";
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
//#region packages/core/src/block.ts
/**
* @module
* Content blocks — the universal vocabulary for everything a tool
* returns and a multimodal message carries. One discriminated union
* with three kinds:
*
* - `text`   — UTF-8 prose the model reads as tokens
* - `binary` — bytes with a `mediaType` (image, audio, file). Inline
*              base64 in `data: string`, or remote via `data: URL`.
*              Provider adapters route on `mediaType`.
* - `ref`    — an addressable handle. Used by spill substitution and
*              by callers handing in pre-existing artifacts. Opaque
*              to the framework; whoever produced the URI owns
*              dereferencing.
*
* Adding a fourth variant requires a real provider-supported content
* type, not a speculative niche.
*/
let BlockKind = /* @__PURE__ */ function(BlockKind) {
	BlockKind["Text"] = "text";
	BlockKind["Binary"] = "binary";
	BlockKind["Ref"] = "ref";
	return BlockKind;
}({});
function text(s) {
	return {
		kind: "text",
		text: s
	};
}
function image(data, mediaType) {
	return {
		kind: "binary",
		data,
		mediaType
	};
}
function file(data, opts) {
	return {
		kind: "binary",
		data,
		mediaType: opts.mediaType,
		...opts.filename === void 0 ? {} : { filename: opts.filename }
	};
}
function audio(data, mediaType) {
	return {
		kind: "binary",
		data,
		mediaType
	};
}
function ref(uri, opts = {}) {
	return {
		kind: "ref",
		uri,
		...opts.mediaType === void 0 ? {} : { mediaType: opts.mediaType },
		...opts.bytes === void 0 ? {} : { bytes: opts.bytes },
		...opts.summary === void 0 ? {} : { summary: opts.summary }
	};
}
/**
* Lossy projection of `Block[]` to a single string, used by code that
* still operates on text — token estimation, debug rendering, replay
* display. Text blocks pass through; binary and ref blocks render as
* compact placeholders so size estimates remain meaningful.
*/
function blocksToText(blocks) {
	const parts = [];
	for (const b of blocks) switch (b.kind) {
		case "text":
			parts.push(b.text);
			break;
		case "binary": {
			const label = b.filename ?? b.mediaType;
			parts.push(`[${b.mediaType} ${label}]`);
			break;
		}
		case "ref": {
			const summary = b.summary ?? `${b.bytes ?? "?"} bytes`;
			parts.push(`[${b.mediaType ?? "ref"} ${b.uri} (${summary})]`);
			break;
		}
		default: throw new Error(`unreachable: ${b}`);
	}
	return parts.join("\n");
}
//#endregion
//#region packages/core/src/message.ts
/**
* @module
* Canonical message types, parts, constructors, and utility types.
*
* A Message is a batch of parts that commit together — the atomic
* unit of journal durability. Role is not carried on the Message
* itself because a single durable unit may legitimately contain
* contributions from multiple roles (e.g. a tool_use + tool_result
* pair). Role lives on the parts:
*
* - `ContentPart`     — explicit `role` field (user/assistant/system/developer)
* - `ThinkingPart`    — implicit: always assistant (only the model produces reasoning)
* - `ToolCallPart`    — implicit: always assistant (only the model invokes tools)
* - `ToolResultPart`  — implicit: always user (tool outputs flow back to the model)
*
* Use `partRole(part)` to get a part's effective role.
*
* Content shape follows part semantics, not symmetry:
*
* - `ContentPart` / `ToolResultPart` carry `Block[]` — communicative
*   content. The model produces and consumes mixed media (text,
*   images, files, refs); the world reports back the same way.
*   Multimodal is a first-class peer of text.
* - `ThinkingPart` carries `string` — reasoning is private text. No
*   current provider emits multimodal thinking, and the concept is
*   muddled (the model already saw the image in `ContentPart`).
*   Provider-specific opaque payloads — Anthropic `redacted_thinking`,
*   signatures — ride in `meta`.
* - `ToolCallPart` carries structured `arguments` — the model fills a
*   JSON schema. Arguments are typed input, not content.
*
* Don't widen `ThinkingPart` or `ToolCallPart` to `Block[]` for
* symmetry. Widen only if and when a provider drives a real need.
*/
let Role = /* @__PURE__ */ function(Role) {
	Role["User"] = "user";
	Role["Assistant"] = "assistant";
	Role["System"] = "system";
	Role["Developer"] = "developer";
	return Role;
}({});
let MessageType = /* @__PURE__ */ function(MessageType) {
	MessageType["Content"] = "content";
	MessageType["Think"] = "think";
	MessageType["ToolUse"] = "tool_call";
	MessageType["ToolResult"] = "tool_result";
	return MessageType;
}({});
/**
* The effective role of a part. Text carries role explicitly;
* everything else is fixed by part type.
*/
function partRole(part) {
	switch (part.type) {
		case "content": return part.role;
		case "think": return "assistant";
		case "tool_call": return "assistant";
		case "tool_result": return "user";
	}
}
function userMessage(content, meta) {
	return { parts: [contentPart("user", content, meta)] };
}
function assistantMessage(parts, id) {
	const msg = { parts };
	if (id) msg.id = id;
	return msg;
}
function toolResultMessage(toolCallId, ok, content, meta) {
	return { parts: [toolResultPart({
		toolCallId,
		ok,
		content,
		meta
	})] };
}
/**
* Build a ContentPart. Accepts a string (wrapped to `[text(s)]`) or
* a pre-built `Block[]`. The string form is the 90% case.
*/
function contentPart(role, content, meta) {
	return {
		type: "content",
		role,
		content: typeof content === "string" ? [text(content)] : content,
		...meta === void 0 ? {} : { meta }
	};
}
/**
* Convenience: build a single-text-block ContentPart. Equivalent to
* `contentPart(role, content, meta)` when content is a string.
*/
function textPart(role, content, meta) {
	return contentPart(role, content, meta);
}
function thinkingPart(content, meta) {
	return {
		type: "think",
		content,
		...meta === void 0 ? {} : { meta }
	};
}
function toolCallPart(opts) {
	return {
		type: "tool_call",
		toolCallId: opts.toolCallId,
		name: opts.name,
		arguments: opts.arguments,
		...opts.meta === void 0 ? {} : { meta: opts.meta }
	};
}
function toolResultPart(opts) {
	return {
		type: "tool_result",
		toolCallId: opts.toolCallId,
		ok: opts.ok,
		content: typeof opts.content === "string" ? [text(opts.content)] : opts.content,
		...opts.meta === void 0 ? {} : { meta: opts.meta }
	};
}
//#endregion
//#region packages/core/src/completion.ts
/** Why the model stopped generating. */
let StopReason = /* @__PURE__ */ function(StopReason) {
	StopReason["EndTurn"] = "end_turn";
	StopReason["ToolUse"] = "tool_use";
	StopReason["MaxTokens"] = "max_tokens";
	StopReason["Refusal"] = "refusal";
	StopReason["PauseTurn"] = "pause_turn";
	StopReason["ContextWindow"] = "context_window";
	StopReason["Unknown"] = "unknown";
	return StopReason;
}({});
/** Reasoning effort level. Mapped to provider-specific values. */
let Effort = /* @__PURE__ */ function(Effort) {
	Effort["Low"] = "low";
	Effort["Med"] = "med";
	Effort["High"] = "high";
	Effort["XHigh"] = "xhigh";
	return Effort;
}({});
const EMPTY_USAGE = Object.freeze({
	inputTokens: 0,
	outputTokens: 0,
	cachedReadTokens: 0,
	cachedWriteTokens: 0,
	reasoningTokens: 0
});
function emptyUsage() {
	return EMPTY_USAGE;
}
/** Classified error kinds from completion backends. */
let CompletionErrorKind = /* @__PURE__ */ function(CompletionErrorKind) {
	CompletionErrorKind["RateLimit"] = "rate_limit";
	CompletionErrorKind["ServerError"] = "server_error";
	CompletionErrorKind["NetworkError"] = "network_error";
	CompletionErrorKind["ContextLengthExceeded"] = "context_length_exceeded";
	CompletionErrorKind["ContentFiltered"] = "content_filtered";
	CompletionErrorKind["AuthError"] = "auth_error";
	CompletionErrorKind["InvalidRequest"] = "invalid_request";
	CompletionErrorKind["Aborted"] = "aborted";
	CompletionErrorKind["Unknown"] = "unknown";
	return CompletionErrorKind;
}({});
const TRANSIENT_ERROR_KINDS = new Set([
	"rate_limit",
	"server_error",
	"network_error"
]);
/** Normalized error from any completion backend. */
var CompletionError = class extends Error {
	kind;
	statusCode;
	retryable;
	constructor(kind, message, opts) {
		super(message, { cause: opts?.cause });
		this.name = "CompletionError";
		this.kind = kind;
		this.statusCode = opts?.statusCode;
		this.retryable = TRANSIENT_ERROR_KINDS.has(kind);
	}
};
//#endregion
//#region packages/core/src/journal.ts
const JournalEvent = {
	message(message) {
		return {
			type: "message",
			message
		};
	},
	turnEnd(turn, usage, stopReason) {
		return {
			type: "turn_end",
			turn,
			usage,
			stopReason
		};
	},
	compactionStart(turn, historyLength) {
		return {
			type: "compaction_start",
			turn,
			historyLength
		};
	},
	compactionEnd(turn, usage) {
		return {
			type: "compaction_end",
			turn,
			usage
		};
	},
	cutoff(turn, count) {
		return {
			type: "cutoff",
			turn,
			count
		};
	},
	warning(turn, message) {
		return {
			type: "warning",
			turn,
			message
		};
	},
	error(turn, message) {
		return {
			type: "error",
			turn,
			message
		};
	},
	runEnd(settleReason, totals) {
		return {
			type: "run_end",
			settleReason,
			totals
		};
	}
};
/**
* Ordered durable event history for replay, audit, and resume.
* Implementations may be fs-backed, in-memory, remote, or custom.
*/
var Journal = class {
	/**
	* Mark the current active slice as a durable resume point.
	*
	* Semantically: when this resolves, all events appended before the
	* call are on stable storage; a crash afterward can recover from
	* this point. The engine calls `commit()` at natural checkpoints
	* (turn_end, run_end) so resume lands at a coherent boundary.
	*
	* Implementations may no-op when their `event()` path is already
	* synchronous-on-disk, or when durability isn't a concern (memory
	* journal). Implementations that buffer appends must flush here.
	*/
	async commit() {}
};
//#endregion
//#region packages/core/src/workspace.ts
/**
* Base workspace abstraction. Portable tools should target this
* interface and rely on `spill()` for artifact persistence.
*
* Locality (e.g. exposing a concrete fs `dir`) is an
* implementation-level capability. Tools that need it do a
* structural check at the call site rather than discriminating on
* the contract.
*
* `content` accepts either UTF-8 text (`string`) or raw bytes
* (`Uint8Array`). Implementations encode appropriately —
* fs-backed implementations write text as UTF-8 and bytes as-is;
* extension is chosen from `opts.mediaType` when present.
*/
var Workspace = class {};
/**
* Sanitize a filename base for fs use. Replaces characters reserved
* by Windows or POSIX, plus control characters, with `_`. Trims
* leading/trailing `_`. Caps at `max` chars. Returns empty string
* if the input sanitizes to nothing — callers must handle that.
*/
function sanitizeFilename(s, max = 200) {
	return s.replace(/[\\/:*?"<>| \x00-\x1f]/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
}
//#endregion
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
//#region packages/core/src/toolkit.ts
/**
* @module
* Tool definition, composition, and execution.
*
* @example
* ```ts
* import { tool, merge } from "@ronde/core/toolkit";
*
* const weather = tool({
*   name: "weather",
*   description: "Get weather for a city",
*   parameters: z.object({ city: z.string() }),
*   execute: async (args) => ok({ temp: 22 }),
*   format: (data) => `${data.temp}°C`,
* });
* ```
*/
/** Default inline-output budget (characters) before the framework spills and truncates. */
const DEFAULT_MAX_INLINE = 25e3;
const runtimeFactorySymbol = Symbol("ronde.toolkitRuntimeFactory");
/**
* Bind a toolkit to a fresh runtime instance. Toolkits created by `tool()`
* and `merge()` expose an internal runtime factory so each engine execution
* gets isolated stateful tool cells. Hand-built toolkits fall back to
* themselves and remain responsible for any lifecycle they implement.
*/
function bindToolkitRuntime(toolkit) {
	const bind = toolkit[runtimeFactorySymbol];
	const bound = bind ? bind() : toolkit;
	if (!bound.dispose) return bound;
	const inner = bound.dispose;
	let disposed = false;
	return {
		...bound,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await inner();
		}
	};
}
/** Default formatter: returns error string, passes through strings, JSON.stringify for objects. */
function defaultFormatter(_toolName, result) {
	if (!result.ok) return result.error;
	const { data } = result;
	if (typeof data === "string") return data;
	if (data == null) return "";
	return JSON.stringify(data);
}
/**
* Resolve the formatted blocks for a tool output. When `ctx` is supplied,
* the framework enforces an inline size budget via content-substitution:
* oversized text blocks get sliced to fit; oversized binary blocks are
* spilled to the workspace and replaced with a `ref` block addressing
* the artifact. Ref blocks pass through unchanged. When `ctx` is omitted
* (tests, non-engine callers), no size check or spill happens.
*/
async function formatToolResult(toolkit, toolName, result, ctx) {
	const formatter = toolkit.formatters[toolName];
	const blocks = formatter ? renderWithFormatter(formatter, result) : [text(defaultFormatter(toolName, result))];
	if (!ctx) return blocks;
	return fitBlocksToBudget(blocks, {
		budget: ctx.maxInline ?? 25e3,
		strategy: toolkit.truncate?.[toolName] ?? "head",
		workspace: ctx.workspace,
		toolName,
		toolUseId: ctx.toolUseId
	});
}
function renderWithFormatter(formatter, result) {
	if (result.ok) return toBlocks(formatter(result.data));
	if (result.data === void 0) return [text(result.error)];
	return [text(result.error), ...toBlocks(formatter(result.data))];
}
function toBlocks(rendered) {
	return typeof rendered === "string" ? [text(rendered)] : rendered;
}
/**
* Walk a `Block[]` and bring its inline size within budget in a
* single forward pass. Per-block policy:
*
* - text > remaining budget: slice with the truncation strategy and
*   append a hint ref block with the spilled artifact URI.
* - binary > remaining budget: spill the bytes to the workspace,
*   replace with a ref block carrying the URI + mediaType + summary.
*   URL-form binary collapses to a ref using the URL as the URI —
*   no spill, since it's already external.
* - ref: passes through (already an addressable handle).
*
* `remaining` decreases as fitted blocks are emitted, so blocks that
* arrive after the budget is exhausted hit their over-budget branch
* automatically. No second pass.
*/
async function fitBlocksToBudget(blocks, opts) {
	const out = [];
	let remaining = opts.budget;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		const fitted = await fitOne(b, remaining, i, opts);
		for (const piece of fitted) {
			out.push(piece);
			remaining -= inlineByteSize(piece);
		}
	}
	return out;
}
async function fitOne(block, remaining, index, opts) {
	switch (block.kind) {
		case "text": {
			const size = utf8Size(block.text);
			if (size <= remaining) return [block];
			const strategy = opts.strategy;
			const spill = await opts.workspace.spill(block.text, {
				name: spillName(opts, index),
				mediaType: "text/plain"
			});
			return [text(sliceByStrategy(block.text, Math.max(0, remaining), strategy)), ref(spill.uri, {
				mediaType: "text/plain",
				bytes: spill.bytes,
				summary: truncationSummary(strategy, remaining, size)
			})];
		}
		case "binary": {
			if (inlineByteSize(block) <= remaining) return [block];
			const payload = typeof block.data === "string" ? base64ToBytes(block.data) : block.data;
			if (payload instanceof URL) return [ref(payload.href, {
				mediaType: block.mediaType,
				bytes: void 0,
				summary: block.filename
			})];
			const spill = await opts.workspace.spill(payload, {
				name: spillName(opts, index),
				mediaType: block.mediaType
			});
			return [ref(spill.uri, {
				mediaType: block.mediaType,
				bytes: spill.bytes,
				summary: block.filename
			})];
		}
		case "ref": return [block];
		default: throw new Error(`unreachable: ${block}`);
	}
}
function spillName(opts, index) {
	return `${opts.toolName}-${opts.toolUseId}-${index}`;
}
function truncationSummary(strategy, shown, total) {
	switch (strategy) {
		case "head": return `truncated to first ${shown} of ${total} bytes`;
		case "tail": return `truncated to last ${shown} of ${total} bytes`;
		case "middle": {
			const half = Math.floor(shown / 2);
			return `truncated to first ${half} + last ${half} of ${total} bytes`;
		}
	}
}
function utf8Size(s) {
	let size = 0;
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 128) size += 1;
		else if (code < 2048) size += 2;
		else if (code >= 55296 && code <= 56319) {
			size += 4;
			i++;
		} else size += 3;
	}
	return size;
}
function inlineByteSize(block) {
	switch (block.kind) {
		case "text": return utf8Size(block.text);
		case "binary":
			if (block.data instanceof URL) return 0;
			return block.data.length;
		case "ref": return 0;
		default: throw new Error(`unreachable: ${block}`);
	}
}
function base64ToBytes(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}
/**
* Chars we're willing to spend searching for a newline near the cut,
* either direction. Bounded so a pathological line doesn't swallow
* arbitrary tokens trying to end on a boundary.
*/
const SNAP_WINDOW = 200;
/**
* Walk backward from `maxCut` up to SNAP_WINDOW chars looking for a
* newline; return the position just after it so the slice ends on a
* clean line boundary. Falls through to `maxCut` if no newline sits
* within the window.
*/
function snapHeadCut(content, maxCut) {
	const minCut = Math.max(0, maxCut - SNAP_WINDOW);
	const nl = content.lastIndexOf("\n", maxCut - 1);
	return nl >= minCut ? nl + 1 : maxCut;
}
/**
* Walk forward from `minCut` up to SNAP_WINDOW chars looking for a
* newline; return the position just after it so the following slice
* starts on a clean line. Falls through to `minCut` if no newline
* sits within the window.
*/
function snapTailCut(content, minCut) {
	const maxCut = Math.min(content.length, minCut + SNAP_WINDOW);
	const nl = content.indexOf("\n", minCut);
	return nl >= 0 && nl < maxCut ? nl + 1 : minCut;
}
function sliceByStrategy(content, size, strategy) {
	switch (strategy) {
		case "head": {
			const cut = snapHeadCut(content, size);
			const omitted = content.length - cut;
			return `${content.slice(0, cut)}\n\n[... ${omitted} characters truncated ...]`;
		}
		case "tail": {
			const cut = snapTailCut(content, content.length - size);
			return `[... ${cut} characters truncated ...]\n\n${content.slice(cut)}`;
		}
		case "middle": {
			const half = Math.floor(size / 2);
			let headCut = snapHeadCut(content, half);
			let tailCut = snapTailCut(content, content.length - half);
			if (tailCut <= headCut) {
				headCut = half;
				tailCut = content.length - half;
			}
			const omitted = tailCut - headCut;
			return `${content.slice(0, headCut)}\n\n[... ${omitted} characters truncated ...]\n\n${content.slice(tailCut)}`;
		}
	}
}
function tool(defOrNothing) {
	if (defOrNothing === void 0) return (def) => _tool(def);
	return _tool(defOrNothing);
}
function _tool(def) {
	const jsonSchema = z.toJSONSchema(def.parameters, { unrepresentable: "any" });
	const schema = {
		name: def.name,
		description: def.description,
		inputSchema: jsonSchema,
		strict: def.strict
	};
	const formatters = def.format ? { [def.name]: def.format } : {};
	const truncate = def.truncate ? { [def.name]: def.truncate } : {};
	const createRuntime = () => createSingleToolRuntime(def, schema, formatters, truncate);
	let directRuntime;
	const getDirectRuntime = () => directRuntime ??= createRuntime();
	return {
		schemas: [schema],
		execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
		formatters,
		truncate,
		dispose: async () => {
			if (!directRuntime) return;
			try {
				await directRuntime.dispose?.();
			} finally {
				directRuntime = void 0;
			}
		},
		[runtimeFactorySymbol]: createRuntime
	};
}
function merge(...toolkits) {
	const formatters = {};
	const truncate = {};
	const schemaMap = /* @__PURE__ */ new Map();
	for (const tk of toolkits) {
		for (const schema of tk.schemas) schemaMap.set(schema.name, schema);
		Object.assign(formatters, tk.formatters);
		if (tk.truncate) Object.assign(truncate, tk.truncate);
	}
	const createRuntime = () => {
		const runtimeChildren = toolkits.map((tk) => bindToolkitRuntime(tk));
		const runtimeRouting = /* @__PURE__ */ new Map();
		for (const tk of runtimeChildren) for (const schema of tk.schemas) runtimeRouting.set(schema.name, tk);
		const execute = (name, args, ctx) => {
			const tk = runtimeRouting.get(name);
			if (!tk) return Promise.resolve(err(`Unknown tool '${name}'`));
			return tk.execute(name, args, ctx);
		};
		const disposables = runtimeChildren.filter((tk) => tk.dispose);
		const dispose = disposables.length > 0 ? async () => {
			for (const tk of disposables) try {
				await tk.dispose();
			} catch {}
		} : void 0;
		return {
			schemas: [...schemaMap.values()],
			execute,
			formatters,
			truncate,
			dispose
		};
	};
	let directRuntime;
	const getDirectRuntime = () => directRuntime ??= createRuntime();
	return {
		schemas: [...schemaMap.values()],
		execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
		formatters,
		truncate,
		dispose: async () => {
			if (!directRuntime) return;
			try {
				await directRuntime.dispose?.();
			} finally {
				directRuntime = void 0;
			}
		},
		[runtimeFactorySymbol]: createRuntime
	};
}
function createSingleToolRuntime(def, schema, formatters, truncate) {
	let slot = { status: "cold" };
	async function ensureState() {
		if (!def.state) return;
		while (true) switch (slot.status) {
			case "ready": return slot.state;
			case "initializing": return await slot.promise;
			case "disposed": throw new Error(`Tool "${def.name}" executed after the engine has completed`);
			case "cold": {
				const promise = (async () => {
					const state = await def.state.init();
					slot = {
						status: "ready",
						state
					};
					return state;
				})().catch((error) => {
					if (slot.status === "initializing" && slot.promise === promise) slot = { status: "cold" };
					throw error;
				});
				slot = {
					status: "initializing",
					promise
				};
				return await promise;
			}
		}
	}
	const executeIsGenerator = isAsyncGeneratorFunction(def.execute);
	const execute = (name, rawArgs, baseCtx) => {
		if (name !== def.name) return Promise.resolve(err(`Tool '${name}' not found in this toolkit`));
		const parsed = def.parameters.safeParse(rawArgs);
		if (!parsed.success) return Promise.resolve(err(`Invalid arguments for ${def.name}: ${parsed.error.message}`));
		if (!def.state) return def.execute(parsed.data, baseCtx);
		if (executeIsGenerator) return wrapStatefulGenerator(def.execute, parsed.data, baseCtx, ensureState);
		return wrapStatefulPromise(def.execute, parsed.data, baseCtx, ensureState);
	};
	const dispose = def.state ? async () => {
		if (slot.status === "disposed" || slot.status === "cold") {
			slot = { status: "disposed" };
			return;
		}
		if (slot.status === "initializing") try {
			await slot.promise;
		} catch {
			slot = { status: "disposed" };
			return;
		}
		if (slot.status === "ready") try {
			await def.state.dispose?.(slot.state);
		} catch {}
		slot = { status: "disposed" };
	} : void 0;
	return {
		schemas: [schema],
		execute,
		formatters,
		truncate,
		dispose
	};
}
const AsyncGeneratorFunction = async function* () {}.constructor;
function isAsyncGeneratorFunction(fn) {
	if (typeof fn !== "function") return false;
	return Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]" || fn instanceof AsyncGeneratorFunction;
}
async function* wrapStatefulGenerator(exec, args, baseCtx, ensureState) {
	const state = await ensureState();
	return yield* asGenerator(exec(args, {
		...baseCtx,
		state
	}));
}
async function wrapStatefulPromise(exec, args, baseCtx, ensureState) {
	const state = await ensureState();
	return await exec(args, {
		...baseCtx,
		state
	});
}
//#endregion
//#region packages/core/src/bytes.ts
/**
* @module
* Platform-agnostic UTF-8 byte counting. Uses `TextEncoder` so it runs
* in Node, browsers, Deno, and workers alike. Shared buffer avoids
* per-call allocation — strings larger than the buffer loop through it.
*/
const _encoder = new TextEncoder();
const _buf = new Uint8Array(16384);
/** UTF-8 byte length of `str`. */
function utf8ByteLength(str) {
	if (str.length === 0) return 0;
	let total = 0;
	let offset = 0;
	while (offset < str.length) {
		const { read, written } = _encoder.encodeInto(str.slice(offset), _buf);
		if (read === 0) break;
		total += written;
		offset += read;
	}
	return total;
}
//#endregion
//#region packages/core/src/tokens.ts
function estimateTokens(input) {
	const s = stringifyForTokenEstimate(input);
	const bytes = utf8ByteLength(s);
	const len = s.length;
	if (len < 200) return Math.ceil(bytes / 3);
	const windowSize = 100;
	const windowCount = Math.min(5, Math.ceil(len / windowSize));
	const gap = Math.floor(len / windowCount);
	let sampled = 0;
	let dense = 0;
	let struct = 0;
	let spaces = 0;
	for (let w = 0; w < windowCount; w++) {
		const start = w * gap;
		const end = Math.min(start + windowSize, len);
		for (let i = start; i < end; i++) {
			sampled++;
			const c = s.charCodeAt(i);
			if (c === 32 || c === 10 || c === 13 || c === 9) spaces++;
			else if (c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 95 || c === 45) dense++;
			else struct++;
		}
	}
	const denseFrac = spaces / sampled < .05 ? dense / sampled : 0;
	const structFrac = struct / sampled;
	const proseFrac = Math.max(0, 1 - denseFrac - structFrac);
	const bytesPerToken = denseFrac * 1.5 + structFrac * 3 + proseFrac * 4.5;
	return Math.ceil(bytes / bytesPerToken);
}
function stringifyForTokenEstimate(input) {
	if (typeof input === "string") return input;
	try {
		const json = JSON.stringify(input);
		if (typeof json === "string") return json;
	} catch {}
	return String(input);
}
//#endregion
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
//#region packages/backend/src/errors.ts
/**
* @module
* Provider-facing helpers for classifying raw SDK errors into the
* shared completion failure contract.
*/
function classifyError(statusCode, message) {
	if (statusCode === 401 || statusCode === 403) return "auth_error";
	if (statusCode === 429) return "rate_limit";
	if (statusCode === 400) {
		const lower = message.toLowerCase();
		if (lower.includes("context_length_exceeded") || lower.includes("max_tokens") || lower.includes("too many tokens") || lower.includes("token limit") || lower.includes("exceeds the model")) return "context_length_exceeded";
		return "invalid_request";
	}
	if (statusCode !== void 0 && statusCode >= 500 && statusCode < 600) return "server_error";
	const lower = message.toLowerCase();
	if (lower.includes("econnreset") || lower.includes("etimedout") || lower.includes("other side closed") || lower.includes("connection closed") || lower.includes("connection error") || lower.includes("reset by peer") || lower.includes("broken pipe") || lower.includes("network") || lower.includes("timeout") || lower.includes("unexpected eof") || lower.includes("socket") || lower.includes("terminated") || lower.includes("fetch failed")) return "network_error";
	if (lower.includes("content_filter") || lower.includes("content filter") || lower.includes("safety") || lower.includes("blocked")) return "content_filtered";
	if (lower.includes("context_length_exceeded") || lower.includes("context length")) return "context_length_exceeded";
	return "unknown";
}
/**
* Wrap a raw SDK error into a CompletionError, extracting status from
* common SDK shapes (`status`, `statusCode`, numeric `code`) and
* preferring nested `error.message` over the outer message.
*/
function wrapSdkError(err) {
	if (err instanceof CompletionError) return err;
	const raw = err;
	const message = raw.error?.message || raw.message || String(err);
	const statusCode = (typeof raw.status === "number" ? raw.status : void 0) ?? (typeof raw.statusCode === "number" ? raw.statusCode : void 0) ?? (typeof raw.code === "number" ? raw.code : void 0);
	return new CompletionError(classifyError(statusCode, `${message} ${typeof raw.code === "string" ? raw.code : ""}`.trim()), message, {
		statusCode,
		cause: err
	});
}
//#endregion
//#region packages/backend/src/shared.ts
/**
* Canonicalize message history for a specific provider. After this
* pass, every part's meta is either the provider's own type or absent.
*
* - Own meta → passed through untouched
* - Foreign thinking → dropped (reasoning traces stay private)
* - Foreign text / tool call / tool result → meta stripped; content kept
*/
function canonicalize(messages, isOwn) {
	function liftPart(part) {
		if (part.meta === void 0 || isOwn(part.meta)) return part;
		if (part.type === "think") return;
		const { meta: _meta, ...rest } = part;
		return rest;
	}
	return messages.map((msg) => ({
		...msg,
		parts: msg.parts.map(liftPart).filter((p) => p !== void 0)
	}));
}
/**
* Bucket parts into role-tagged messages for providers that require
* role-at-message-level on the wire (Anthropic, Gemini). Role is
* resolved per-part via `partRole()`.
*
* Tool_use and tool_result parts pool across consecutive messages and
* flush together when a non-tool part arrives or the walk ends —
* pooled tool_uses land in one assistant bucket, pooled tool_results
* in one user bucket. This restores the batched wire shape the model
* originally produced even though canonical history stores each tool
* as its own pair message for atomic durability.
*/
function coalesceByRole(messages, mapRole, serializePart) {
	const output = [];
	const assistantRole = mapRole("assistant");
	const userRole = mapRole("user");
	const pooledUses = [];
	const pooledResults = [];
	const pushBucket = (role, parts) => {
		if (parts.length === 0) return;
		const last = output[output.length - 1];
		if (last && last.role === role) last.parts.push(...parts);
		else output.push({
			role,
			parts: [...parts]
		});
	};
	const flushTools = () => {
		pushBucket(assistantRole, pooledUses);
		pooledUses.length = 0;
		pushBucket(userRole, pooledResults);
		pooledResults.length = 0;
	};
	for (const message of messages) for (const part of message.parts) {
		const serialized = serializePart(part);
		if (serialized === void 0) continue;
		const items = Array.isArray(serialized) ? serialized : [serialized];
		if (items.length === 0) continue;
		if (part.type === "tool_call") pooledUses.push(...items);
		else if (part.type === "tool_result") pooledResults.push(...items);
		else {
			flushTools();
			pushBucket(mapRole(partRole(part)), items);
		}
	}
	flushTools();
	return output;
}
//#endregion
//#region packages/backend/src/retry.ts
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MAX_DELAY_MS = 3e4;
/**
* Retry decorator over `ConfiguredBackend`. Retries errors where
* `retryable` is true with exponential backoff + jitter; other errors
* propagate untouched. Abort signals cancel the in-flight attempt and
* short-circuit any pending backoff.
*
* Streams are drained into a single `CompletionResponse` before returning
* — mid-stream failures are retryable, but the caller sees no partial
* events across attempts.
*/
var RetryingBackend = class {
	specVersion = "v1";
	inner;
	maxRetries;
	maxDelayMs;
	onRetry;
	config;
	constructor(inner, options = {}) {
		this.inner = inner;
		this.config = inner.config;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
		this.onRetry = options.onRetry;
	}
	async complete(request) {
		const { signal } = request;
		for (let attempt = 0;; attempt++) {
			if (signal?.aborted) throw new CompletionError("aborted", "Aborted");
			try {
				return await raceAbort(drain(this.inner.complete(request)), signal);
			} catch (err) {
				const wrapped = err instanceof CompletionError ? err : wrapSdkError(err);
				if (!wrapped.retryable || attempt >= this.maxRetries) throw wrapped;
				const baseDelay = Math.min(1e3 * Math.pow(2, attempt), this.maxDelayMs);
				const jitter = Math.random() * baseDelay * .5;
				const delayMs = Math.round(baseDelay + jitter);
				try {
					this.onRetry?.({
						attempt: attempt + 1,
						maxRetries: this.maxRetries,
						error: wrapped,
						delayMs
					});
				} catch {}
				await abortableSleep(delayMs, signal);
			}
		}
	}
};
function withRetry(backend, options = {}) {
	return new RetryingBackend(backend, options);
}
/** Race a promise against an abort signal. Rejects immediately if aborted. */
function raceAbort(promise, signal) {
	if (!signal) return promise;
	promise.catch(() => {});
	if (signal.aborted) return Promise.reject(new CompletionError("aborted", "Aborted"));
	return Promise.race([promise, new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(new CompletionError("aborted", "Aborted")), { once: true });
	})]);
}
/** Sleep that resolves (not rejects) early when the signal is aborted. */
function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
//#endregion
//#region packages/backend/src/defaults.ts
/**
* @module
* Framework-default budgets applied by adapter layers when the caller
* doesn't specify their own. See `createBackend` and `fromAiSdk`.
*/
/**
* Default `maxContext` ceiling when a caller doesn't supply one.
* Safe floor across major reasoning models as of 2026 — below the
* 1M-context frontier (Claude 4.6+, GPT-5.4 extended, Gemini 2.0),
* above the 272K / 200K smaller-window models (GPT-5.4 standard,
* Gemini 3 Flash).
*/
const DEFAULT_MAX_CONTEXT = 4e5;
/**
* Default `maxOutput` ceiling when a caller doesn't supply one.
* Broadest-compatibility output cap: matches Claude Opus 4.7 standard
* (exactly 32K), clamps under Sonnet 4.6 (64K) and GPT-5.4 (128K),
* stays within Gemini Flash's 8-32K output range.
*/
const DEFAULT_MAX_OUTPUT = 32e3;
//#endregion
//#region packages/engine/src/types.ts
function makeEvent(kind, type, data) {
	return {
		kind,
		type,
		...data
	};
}
function lifecycleEvent(type, data) {
	return makeEvent("lifecycle", type, data);
}
function progressEvent(type, data) {
	return makeEvent("progress", type, data);
}
function diagnosticEvent(type, data) {
	return makeEvent("diagnostic", type, data);
}
//#endregion
//#region packages/engine/src/tool-exec.ts
const MAX_TOOL_CONCURRENCY = 10;
const ABORTED = Symbol("aborted");
/**
* Runs pending tool calls in parallel (up to MAX_TOOL_CONCURRENCY),
* yielding progress events. Each tool produces a `tool_result` event
* carrying both the formatted `content` (what the model sees) and the
* raw `result` (the structured `ok(data) | err(msg)` for trajectory
* export).
*
* Invariant: every tool_use in `input.calls` yields exactly one
* `tool_result`. External abort, consumer tear-down, and formatter
* failures all synthesize `err("Cancelled")` / best-effort fallback
* rather than leaving orphans in the stream.
*
* Pure compute — no journal writes, no out-parameter mutation.
*/
async function* executeToolCalls(input) {
	const { calls, toolkit, turn, abort: abortSignal, history, workspace, approvals, maxInline } = input;
	if (calls.length === 0) return;
	const toolCalls = calls.map((tc) => ({
		toolUseId: tc.toolCallId,
		name: tc.name,
		arguments: tc.arguments || {}
	}));
	for (const call of toolCalls) yield progressEvent("tool_call", {
		turn,
		call
	});
	const siblingController = new AbortController();
	const siblingSignal = siblingController.signal;
	if (abortSignal.aborted) siblingController.abort(abortSignal.reason);
	else abortSignal.addEventListener("abort", () => siblingController.abort(abortSignal.reason), { once: true });
	const settled = Array.from({ length: calls.length });
	const aborted = new Promise((resolve) => {
		if (abortSignal.aborted) resolve(ABORTED);
		else abortSignal.addEventListener("abort", () => resolve(ABORTED), { once: true });
	});
	async function finalize(i, result) {
		const tc = calls[i];
		let content;
		try {
			content = await formatToolResult(toolkit, tc.name, result, {
				workspace,
				toolUseId: tc.toolCallId,
				maxInline
			});
		} catch (e) {
			const msg = `Formatter failed: ${e.message}`;
			content = [text(msg)];
			result = err(msg);
		}
		settled[i] = {
			result,
			content
		};
	}
	async function* driveTool(i, tc) {
		if (siblingSignal.aborted) return err("Cancelled");
		if (approvals?.has(i) && !approvals.get(i)) return err(`Tool call "${tc.name}" was rejected`);
		const toolCtx = {
			turn,
			abort: siblingSignal,
			messages: history,
			workspace,
			call: toolCalls[i]
		};
		const gen = asGenerator(toolkit.execute(tc.name, tc.arguments, toolCtx));
		try {
			while (true) {
				const winner = await Promise.race([gen.next(), aborted]);
				if (winner === ABORTED) {
					gen.return(void 0).catch(() => {});
					return err("Cancelled");
				}
				if (winner.done) return winner.value;
				yield winner.value;
			}
		} catch (e) {
			siblingController.abort("sibling_error");
			return err(e.message);
		}
	}
	async function* runTask(i) {
		const tc = calls[i];
		await finalize(i, yield* driveTool(i, tc));
	}
	const armNext = (i, gen) => gen.next().then((iter) => ({
		i,
		iter
	}));
	const active = /* @__PURE__ */ new Map();
	let nextToLaunch = 0;
	const fillSlots = () => {
		while (nextToLaunch < calls.length && active.size < MAX_TOOL_CONCURRENCY) {
			const i = nextToLaunch++;
			const gen = runTask(i);
			active.set(i, {
				waiter: armNext(i, gen),
				gen
			});
		}
	};
	function emitSettled(i) {
		const s = settled[i];
		return progressEvent("tool_result", {
			turn,
			call: toolCalls[i],
			content: s.content,
			result: s.result
		});
	}
	try {
		fillSlots();
		while (active.size > 0) {
			const waiters = [];
			for (const task of active.values()) waiters.push(task.waiter);
			const { i, iter } = await Promise.race(waiters);
			const task = active.get(i);
			if (iter.done) {
				active.delete(i);
				fillSlots();
				yield emitSettled(i);
			} else {
				task.waiter = armNext(i, task.gen);
				yield progressEvent("tool_delta", {
					call: toolCalls[i],
					chunk: iter.value,
					turn
				});
			}
		}
	} finally {
		for (const { gen } of active.values()) gen.return(void 0).catch(() => {});
		active.clear();
	}
	for (let i = 0; i < calls.length; i++) {
		if (settled[i]) continue;
		await finalize(i, err("Cancelled"));
		yield emitSettled(i);
	}
}
//#endregion
//#region packages/engine/src/replay.ts
function splitResponse(response) {
	const messages = [];
	const pendingCalls = [];
	for (const msg of response) {
		const parts = [];
		for (const part of msg.parts) if (part.type === "tool_call") pendingCalls.push(part);
		else parts.push(part);
		if (parts.length > 0) messages.push({
			...msg,
			parts
		});
	}
	return {
		messages,
		pendingCalls
	};
}
function replayTextMessage(role, content) {
	return role === "assistant" ? assistantMessage([textPart("assistant", content)]) : userMessage(content);
}
/**
* Flatten current-turn content into provider-neutral text for post-compaction
* replay. Reasoning is dropped; tool calls and results are stringified.
*/
function translateBufferedMessages(messages) {
	const translated = [];
	const toolNamesById = /* @__PURE__ */ new Map();
	for (const message of messages) for (const part of message.parts) if (part.type === "tool_call") toolNamesById.set(part.toolCallId, part.name);
	for (const message of messages) for (const part of message.parts) switch (part.type) {
		case "think": break;
		case "content": {
			const content = blocksToText(part.content).trim();
			if (!content) break;
			translated.push(replayTextMessage(part.role, `[${part.role} text]\n${content}`));
			break;
		}
		case "tool_call":
			translated.push(replayTextMessage("assistant", `[assistant tool call] ${part.name}\nid: ${part.toolCallId}\nargs: ${JSON.stringify(part.arguments || {})}`));
			break;
		case "tool_result": {
			const toolName = toolNamesById.get(part.toolCallId);
			translated.push(replayTextMessage("user", `${toolName ? `[user tool result] ${toolName}` : "[user tool result]"}\nid: ${part.toolCallId}\nstatus: ${part.ok ? "success" : "failure"}\ncontent:\n${blocksToText(part.content)}`));
			break;
		}
		default:
	}
	return translated;
}
//#endregion
//#region packages/engine/src/engine.ts
/**
* Breaker threshold for consecutive truncated responses (stopReason
* MaxTokens with no tool calls). On the Nth in a row, the loop settles
* with `cutoff_breaker` — the model is looping on "continue where you
* left off" nudges without making progress.
*/
const MAX_CONSECUTIVE_INCOMPLETE = 3;
function toList(v) {
	return Array.isArray(v) ? v : [v];
}
/**
* The agentic loop, as an async generator.
*
* Runs completions against `backend`, executes tool calls, compacts
* history when the context budget tightens, and records every durable
* event to the configured journal. Consumers drive it with `for await`:
*
*     const gen = engine(backend, config)
*     let next = await gen.next()
*     while (!next.done) {
*       // next.value is an EngineEvent — switch on .type / .kind
*       next = await gen.next()
*     }
*     const result: EngineResult = next.value
*
* `EngineEvent`s flow out as the yield type; `EngineResult` is the
* generator's return (TReturn) value, available on the terminal
* `{ done: true, value }` frame. Higher-level helpers (`drive`,
* `runEngine`) wrap this for promise-style callers.
*
* ## Event taxonomy (see types.ts)
*
*   - lifecycle:  turn_start, turn_end, compaction_start, compaction_end,
*                 cutoff, run_end
*   - progress:   text, text_delta, thinking, thinking_delta, tool_call,
*                 tool_delta, tool_input_delta, tool_result
*   - diagnostic: warning, error
*
* ## Durability
*
* History is reconstructed on entry by replaying the journal's active
* partition (see resume docs). Each turn commits at `turn_end`; the run
* commits again at `run_end`. Consumers that reopen the same journal
* after a crash pick up cleanly at the last turn boundary.
*
* Tool-call/tool-result pairs are journaled atomically as a single
* `{ parts: [tool_use, tool_result] }` message, so the durable record
* never contains an orphaned call without its result.
*
* ## Settle reasons (EngineResult.settleReason)
*
*   - `StopReason.*`       — the backend reported a natural stop
*                            (EndTurn, ContentFilter, etc.)
*   - `"max_turns"`        — `config.maxTurns` cap reached; default 0
*                            means no cap
*   - `"aborted"`          — `config.signal` fired before completion
*   - `"cutoff_breaker"`   — MAX_CONSECUTIVE_INCOMPLETE truncations
*                            in a row
*   - `"compaction_failed"`— compaction was needed but exhausted its
*                            retry budget (3 consecutive failures)
*
* ## Hooks (config.hooks)
*
*   - `preStep`  — may rewrite messages, toolSchemas, model, or effort
*                  for the next completion. Scoped to that turn only —
*                  overrides never carry forward.
*   - `approve`  — may veto a tool call before execution. Returning
*                  false turns the call into an `err()` output without
*                  running the tool.
*   - `postStep` — may return a string to inject as a user message and
*                  force another turn, or void to let the natural
*                  stopReason settle the loop.
*
* ## Resource lifecycle
*
* The toolkit's runtime state is bound on entry and `dispose`'d in a
* `finally` on exit — consumer `break`, backend throws mid-stream, hook
* errors, and normal completion all run through the same teardown.
* `dispose` throws are swallowed so they never mask the original error.
*
* @param backend  A ConfiguredBackend — model, effort, and budget are
*                 read from `backend.config`.
* @param config   EngineConfig; `journal` and `workspace` are required.
*/
async function* engine(backend, config) {
	const { system, prompt, maxTurns = 0, toolkit, signal, hooks, compaction, truncation } = config;
	const { model, effort, maxContext, maxOutput } = backend.config;
	const { journal, workspace } = resolveRuntimeResources(config);
	const compactSafetyMargin = clamp(Math.floor(maxContext * .025), 4e3, 1e4);
	const toolkitRuntime = bindToolkitRuntime(toolkit);
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	if (signal) if (signal.aborted) abortController.abort(signal.reason);
	else signal.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
	const history = [];
	const steps = [];
	let turn = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCachedTokens = 0;
	let consecutiveIncomplete = 0;
	let compactionCount = 0;
	let compactionAttempts = 0;
	let settleReason = "max_turns";
	function applyUsage(usage) {
		totalInputTokens += usage.inputTokens;
		totalOutputTokens += usage.outputTokens;
		totalCachedTokens += usage.cachedReadTokens;
	}
	async function* emitCompactionStart() {
		const entry = JournalEvent.compactionStart(turn, history.length);
		yield await record(lifecycleEvent("compaction_start", {
			historyLength: history.length,
			turn
		}), entry);
	}
	async function* emitCompactionEnd(usage) {
		yield await record(lifecycleEvent("compaction_end", {
			turn,
			usage
		}));
	}
	async function* handleCutoff() {
		consecutiveIncomplete++;
		if (consecutiveIncomplete >= MAX_CONSECUTIVE_INCOMPLETE) {
			yield await record(diagnosticEvent("error", {
				message: `${MAX_CONSECUTIVE_INCOMPLETE} consecutive incomplete responses. Stopping.`,
				turn
			}));
			settleReason = "cutoff_breaker";
			return true;
		}
		yield await record(lifecycleEvent("cutoff", {
			count: consecutiveIncomplete,
			turn
		}));
		await send(userMessage("Your previous response was cut off due to output length limits. Continue where you left off."));
		return false;
	}
	function append(arg) {
		for (const m of toList(arg)) history.push(m);
	}
	async function send(arg) {
		append(arg);
		for (const m of toList(arg)) await journal.event(JournalEvent.message(m));
	}
	async function record(observed, entry) {
		await journal.event(entry ?? observed);
		return observed;
	}
	async function recordTurnEnd(step) {
		const entry = JournalEvent.turnEnd(step.turn, step.usage, step.stopReason);
		const event = await record(lifecycleEvent("turn_end", {
			turn: step.turn,
			step
		}), entry);
		await journal.commit();
		return event;
	}
	async function doCompact() {
		if (!compaction || compactionAttempts >= 3) return {
			kind: "not_compacted",
			usage: emptyUsage()
		};
		compactionCount++;
		compactionAttempts++;
		const result = await compaction.compact({
			backend,
			model,
			effort,
			history,
			maxOutput,
			signal: abortSignal
		});
		if (result.kind === "compacted") history.length = 0;
		applyUsage(result.usage);
		return result;
	}
	function canAttemptCompaction() {
		return Boolean(compaction) && compactionAttempts < 3;
	}
	async function* attemptCompaction(mode) {
		if (!canAttemptCompaction()) {
			yield await record(diagnosticEvent("error", {
				message: "Compaction failed. Stopping.",
				turn
			}));
			return "fatal";
		}
		yield* emitCompactionStart();
		const result = await doCompact();
		if (result.kind === "compacted") {
			yield* emitCompactionEnd(result.usage);
			const deferredReplay = translateBufferedMessages(result.deferred);
			const turnReplay = mode.kind === "preemptive" ? translateBufferedMessages(mode.buffered) : [];
			const nextMessages = [
				result.summary,
				...deferredReplay,
				...turnReplay
			];
			await journal.partition("compaction", nextMessages.map((message) => JournalEvent.message(message)));
			append(nextMessages);
			return "continue";
		}
		if (compactionAttempts >= 3) {
			yield await record(diagnosticEvent("error", {
				message: "Compaction failed. Stopping.",
				turn
			}));
			return "fatal";
		}
		return "continue";
	}
	await journal.scan((ev) => {
		if (ev.type === "message") append(ev.message);
	});
	if (prompt) await send(userMessage(prompt));
	try {
		while (maxTurns === 0 || turn < maxTurns) {
			if (abortSignal.aborted) {
				settleReason = "aborted";
				break;
			}
			turn++;
			yield lifecycleEvent("turn_start", { turn });
			const step = {
				turn,
				reasoning: [],
				toolCalls: [],
				usage: emptyUsage(),
				stopReason: "unknown"
			};
			let stepFinalized = false;
			async function* finalizeStep() {
				if (stepFinalized) return;
				stepFinalized = true;
				steps.push(step);
				yield await recordTurnEnd(step);
			}
			try {
				const turnConfig = await resolvePreStepOverrides(hooks, {
					turn,
					messages: [...history],
					toolSchemas: [...toolkitRuntime.schemas],
					steps,
					usage: {
						totalInputTokens,
						totalOutputTokens,
						totalCachedTokens
					},
					budget: {
						maxContext,
						maxOutput
					},
					compactionCount
				}, {
					messages: history,
					toolSchemas: toolkitRuntime.schemas,
					model,
					effort
				});
				let response;
				try {
					response = yield* forwardCompletion(backend.complete({
						model: turnConfig.model,
						system,
						messages: turnConfig.messages,
						tools: turnConfig.toolSchemas,
						effort: turnConfig.effort,
						maxOutput,
						signal: abortSignal
					}), turn);
				} catch (e) {
					if (e instanceof CompletionError && e.kind === "context_length_exceeded") {
						yield await record(diagnosticEvent("warning", {
							turn,
							message: "Context length exceeded — compacting."
						}));
						yield* finalizeStep();
						if ((yield* attemptCompaction({ kind: "reactive" })) === "fatal") {
							settleReason = "compaction_failed";
							break;
						}
						continue;
					}
					throw e;
				}
				step.usage = response.usage;
				step.stopReason = response.stopReason;
				applyUsage(response.usage);
				compactionAttempts = 0;
				yield* emitResponseProgress(response, turn, step);
				const { messages, pendingCalls } = splitResponse(response.messages);
				if (pendingCalls.length === 0 && response.stopReason === "max_tokens") {
					await send(messages);
					yield* finalizeStep();
					if (yield* handleCutoff()) break;
					continue;
				}
				consecutiveIncomplete = 0;
				await send(messages);
				if (pendingCalls.length === 0) {
					let override = void 0;
					if (hooks?.postStep) override = await hooks.postStep(step);
					yield* finalizeStep();
					if (override) {
						await send(userMessage(override));
						continue;
					}
					settleReason = step.stopReason;
					break;
				}
				const approvals = /* @__PURE__ */ new Map();
				if (hooks?.approve) for (let i = 0; i < pendingCalls.length; i++) {
					const tc = pendingCalls[i];
					const call = {
						toolUseId: tc.toolCallId,
						name: tc.name,
						arguments: tc.arguments
					};
					approvals.set(i, await hooks.approve(call));
				}
				let runningEstimate = (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
				const buffered = [];
				const pendingByCallId = new Map(pendingCalls.map((tc) => [tc.toolCallId, tc]));
				const settledByCallId = /* @__PURE__ */ new Map();
				for await (const event of executeToolCalls({
					calls: pendingCalls,
					toolkit: toolkitRuntime,
					turn,
					abort: abortSignal,
					history,
					workspace,
					approvals,
					maxInline: truncation?.maxInline
				})) {
					if (event.type === "tool_result") {
						const toolUse = pendingByCallId.get(event.call.toolUseId);
						const resultPart = toolResultPart({
							toolCallId: event.call.toolUseId,
							content: event.content,
							ok: event.result.ok
						});
						settledByCallId.set(event.call.toolUseId, {
							content: event.content,
							result: event.result
						});
						runningEstimate += estimateTokens(blocksToText(event.content));
						const pair = { parts: [toolUse, resultPart] };
						if (buffered.length === 0 && runningEstimate + compactSafetyMargin < maxContext) await send(pair);
						else buffered.push(pair);
					}
					yield event;
				}
				for (const tc of pendingCalls) {
					const s = settledByCallId.get(tc.toolCallId);
					step.toolCalls.push({
						id: tc.toolCallId,
						name: tc.name,
						args: tc.arguments,
						content: s.content,
						result: s.result
					});
				}
				if (buffered.length > 0) {
					yield* finalizeStep();
					if ((yield* attemptCompaction({
						kind: "preemptive",
						buffered
					})) === "fatal") {
						settleReason = "compaction_failed";
						break;
					}
					continue;
				}
				yield* finalizeStep();
			} catch (e) {
				step.stopReason = "unknown";
				yield* finalizeStep();
				throw e;
			}
		}
		const result = {
			steps,
			totalInputTokens,
			totalOutputTokens,
			totalCachedTokens,
			compactionCount,
			history,
			settleReason
		};
		const runEndEvent = await record(lifecycleEvent("run_end", { result }), JournalEvent.runEnd(settleReason, {
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cachedTokens: totalCachedTokens,
			compactionCount
		}));
		await journal.commit();
		yield runEndEvent;
		return result;
	} finally {
		try {
			await toolkitRuntime.dispose?.();
		} catch {}
	}
}
function resolveRuntimeResources(cfg) {
	if (!cfg.journal || !cfg.workspace) throw new Error("Pass both \"journal\" and \"workspace\".");
	return {
		journal: cfg.journal,
		workspace: cfg.workspace
	};
}
function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}
async function resolvePreStepOverrides(hooks, input, defaults) {
	if (!hooks?.preStep) return defaults;
	const result = await hooks.preStep(input);
	if (!result) return defaults;
	return {
		messages: result.messages ?? defaults.messages,
		toolSchemas: result.toolSchemas ?? defaults.toolSchemas,
		model: result.model ?? defaults.model,
		effort: result.effort ?? defaults.effort
	};
}
async function* forwardCompletion(ret, turn) {
	const gen = asGenerator(ret);
	let next = await gen.next();
	while (!next.done) {
		const d = next.value;
		switch (d.kind) {
			case "text_delta":
				yield progressEvent("text_delta", {
					turn,
					content: d.content
				});
				break;
			case "thinking_delta":
				yield progressEvent("thinking_delta", {
					turn,
					content: d.content
				});
				break;
			case "tool_input_delta":
				yield progressEvent("tool_input_delta", {
					toolCallId: d.toolCallId,
					chunk: d.chunk,
					turn
				});
				break;
			default:
		}
		next = await gen.next();
	}
	return next.value;
}
async function* emitResponseProgress(response, turn, step) {
	for (const msg of response.messages) for (const part of msg.parts) if (part.type === "think" && part.content.trim()) {
		step.reasoning.push(part.content);
		yield progressEvent("thinking", {
			turn,
			content: part.content
		});
	} else if (part.type === "content" && part.role === "assistant") {
		const txt = blocksToText(part.content);
		if (txt.trim()) {
			step.text = step.text ? step.text + txt : txt;
			yield progressEvent("text", {
				turn,
				content: txt
			});
		}
	}
}
//#endregion
//#region packages/providers/src/openai.ts
function isBrowser$1() {
	return typeof globalThis.self !== "undefined";
}
const openaiDescriptor = {
	name: "openai",
	defaultURL: "https://api.openai.com/v1",
	envVar: "OPENAI_API_KEY",
	create: (config) => new OpenAICompletionBackend(config)
};
function isOpenAIMeta(meta) {
	return meta != null && typeof meta === "object" && meta.provider === "openai";
}
function openAIMeta(itemId, encryptedContent) {
	if (!itemId && !encryptedContent) return;
	return {
		provider: "openai",
		...itemId === void 0 ? {} : { itemId },
		...encryptedContent === void 0 ? {} : { encryptedContent }
	};
}
function serializePart$2(part, options) {
	switch (part.type) {
		case "content": {
			const item = {
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{
					type: "output_text",
					text: blocksToText(part.content)
				}]
			};
			if (part.meta?.itemId) item.id = part.meta.itemId;
			return item;
		}
		case "think": {
			const { replayReasoningItems } = options;
			if (replayReasoningItems && part.meta?.itemId) {
				const reasoning = {
					type: "reasoning",
					id: part.meta.itemId,
					summary: []
				};
				if (part.content.trim()) reasoning.summary = [{
					type: "summary_text",
					text: part.content
				}];
				if (part.meta.encryptedContent) reasoning.encrypted_content = part.meta.encryptedContent;
				return reasoning;
			}
			if (!part.content.trim()) return;
			return {
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{
					type: "output_text",
					text: part.content
				}]
			};
		}
		case "tool_call": {
			const item = {
				type: "function_call",
				call_id: part.toolCallId,
				name: part.name,
				arguments: JSON.stringify(part.arguments || {}),
				status: "completed"
			};
			if (part.meta?.itemId) item.id = part.meta.itemId;
			return item;
		}
		case "tool_result": return {
			type: "function_call_output",
			call_id: part.toolCallId,
			output: blocksToText(part.content)
		};
	}
}
/**
* Map a `Block[]` from a user ContentPart into OpenAI's input content
* vocabulary.
*
* - text   → `{ type: "input_text", text }`
* - binary image/* (base64) → `{ type: "input_image", image_url: "data:...;base64,..." }`
* - binary image/* (URL) → `{ type: "input_image", image_url: url }`
* - binary application/pdf (base64) → `{ type: "input_file", file_data: "data:...;base64,..." }`
* - binary application/pdf (URL) → `{ type: "input_file", file_url: url }`
* - other binary / ref → `{ type: "input_text", text: "<descriptor>" }`
*/
function blocksToOpenAIInputContent(blocks) {
	const out = [];
	for (const b of blocks) switch (b.kind) {
		case "text":
			out.push({
				type: "input_text",
				text: b.text
			});
			break;
		case "binary": {
			const isUrl = b.data instanceof URL;
			if (b.mediaType.startsWith("image/")) out.push({
				type: "input_image",
				image_url: isUrl ? b.data.href : `data:${b.mediaType};base64,${b.data}`
			});
			else if (b.mediaType === "application/pdf") if (isUrl) out.push({
				type: "input_file",
				file_url: b.data.href
			});
			else out.push({
				type: "input_file",
				file_data: `data:${b.mediaType};base64,${b.data}`,
				...b.filename === void 0 ? {} : { filename: b.filename }
			});
			else {
				const label = b.filename ?? b.mediaType;
				out.push({
					type: "input_text",
					text: `[${b.mediaType} ${label}]`
				});
			}
			break;
		}
		case "ref": {
			const summary = b.summary ?? `${b.bytes ?? "?"} bytes`;
			out.push({
				type: "input_text",
				text: `[${b.mediaType ?? "ref"} ${b.uri} (${summary})]`
			});
			break;
		}
		default: throw new Error(`unreachable: ${b}`);
	}
	return out;
}
function serializeMessages$2(messages, options = {}) {
	const { replayReasoningItems = true } = options;
	const normalized = canonicalize(messages, isOpenAIMeta);
	const items = [];
	let pendingText;
	const flushText = () => {
		if (pendingText && pendingText.items.length > 0) items.push({
			role: pendingText.role,
			content: pendingText.items
		});
		pendingText = void 0;
	};
	const pendingCalls = [];
	const pendingCallOutputs = [];
	const flushTools = () => {
		for (const item of pendingCalls) items.push(item);
		pendingCalls.length = 0;
		for (const item of pendingCallOutputs) items.push(item);
		pendingCallOutputs.length = 0;
	};
	for (const message of normalized) for (const part of message.parts) {
		if (part.type === "content" && part.role !== "assistant") {
			flushTools();
			const wireRole = part.role === "system" || part.role === "developer" ? "developer" : "user";
			const next = wireRole === "developer" ? [{
				type: "input_text",
				text: blocksToText(part.content)
			}] : blocksToOpenAIInputContent(part.content);
			if (pendingText && pendingText.role === wireRole) for (const item of next) pendingText.items.push(item);
			else {
				flushText();
				pendingText = {
					role: wireRole,
					items: [...next]
				};
			}
			continue;
		}
		const serialized = serializePart$2(part, { replayReasoningItems });
		if (!serialized) continue;
		if (part.type === "tool_call") {
			flushText();
			pendingCalls.push(serialized);
		} else if (part.type === "tool_result") {
			flushText();
			pendingCallOutputs.push(serialized);
		} else {
			flushText();
			flushTools();
			items.push(serialized);
		}
	}
	flushText();
	flushTools();
	return items;
}
function serializeTools$2(tools) {
	return (tools || []).map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description || "Tool",
		parameters: tool.inputSchema || { type: "object" },
		strict: tool.strict !== false
	}));
}
function parseOutputItems(items, responseId) {
	const parts = [];
	for (const item of items) if (item.type === "message") {
		const msg = item;
		const text = msg.content.filter((c) => c.type === "output_text").map((p) => p.text).join("").trim();
		if (text) parts.push(textPart("assistant", text, msg.status === "completed" ? openAIMeta(msg.id || void 0) : void 0));
	} else if (item.type === "reasoning") {
		const r = item;
		const summaryText = r.summary.filter((s) => s.type === "summary_text").map((s) => s.text).join("\n\n").trim();
		const contentText = (r.content || []).filter((c) => c.type === "reasoning_text").map((c) => c.text).join("\n\n").trim();
		const text = summaryText || contentText;
		const meta = r.id || r.encrypted_content ? openAIMeta(r.id || void 0, r.encrypted_content || void 0) : void 0;
		if (text || meta) parts.push(thinkingPart(text, meta));
	} else if (item.type === "function_call") {
		const fc = item;
		if (fc.status === "completed" && fc.call_id) {
			let args = {};
			try {
				args = JSON.parse(fc.arguments);
			} catch {}
			parts.push(toolCallPart({
				toolCallId: fc.call_id,
				name: fc.name,
				arguments: args,
				meta: openAIMeta(fc.id || void 0)
			}));
		}
	}
	if (parts.length === 0) return [];
	return [assistantMessage(parts, responseId)];
}
function normalizeStopReason$2(response, parts) {
	if (response.status === "completed") return parts.some((p) => p.type === "tool_call") ? "tool_use" : "end_turn";
	if (response.status === "incomplete") switch (response.incomplete_details?.reason) {
		case "max_output_tokens": return "max_tokens";
		case "content_filter": return "refusal";
		default: return "unknown";
	}
	return "unknown";
}
function isNativeOpenAI(resolved) {
	return resolved.nativeOpenAI;
}
function normalizeOpenAIEffort(effort) {
	switch (effort) {
		case "low": return "low";
		case "med": return "medium";
		case "high": return "high";
		case "xhigh": return "xhigh";
		default: return null;
	}
}
function buildUsage$1(usage) {
	if (!usage) return emptyUsage();
	const cachedReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
	const inputTokens = usage.input_tokens - cachedReadTokens;
	return {
		inputTokens: Math.max(0, inputTokens),
		outputTokens: usage.output_tokens,
		cachedReadTokens,
		cachedWriteTokens: 0,
		reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0
	};
}
var OpenAICompletionBackend = class {
	specVersion = "v1";
	resolved;
	client;
	constructor(resolved) {
		this.resolved = resolved;
		this.client = new OpenAI({
			apiKey: resolved.apiKey,
			baseURL: resolved.baseURL,
			...isBrowser$1() && { dangerouslyAllowBrowser: true }
		});
	}
	async complete(request) {
		const payload = {
			model: request.model,
			instructions: request.system,
			input: serializeMessages$2(request.messages || [], this.serializeOptions()),
			tools: serializeTools$2(request.tools),
			max_output_tokens: request.maxOutput
		};
		const effort = normalizeOpenAIEffort(request.effort);
		if (isNativeOpenAI(this.resolved)) {
			payload.reasoning = { summary: "auto" };
			if (effort) payload.reasoning.effort = effort;
			payload.include = ["reasoning.encrypted_content"];
		}
		const response = await this.doRequest(this.client, payload, request.signal);
		if (response.status === "failed") throw new CompletionError("unknown", response.error?.message || "OpenAI completion failed", { statusCode: void 0 });
		const messages = parseOutputItems(response.output, response.id);
		return {
			messages,
			stopReason: normalizeStopReason$2(response, messages.flatMap((m) => m.parts)),
			usage: buildUsage$1(response.usage),
			providerMeta: this.buildProviderMeta(response),
			warnings: []
		};
	}
	async doRequest(client, payload, signal) {
		try {
			return await client.responses.stream(payload, { signal }).finalResponse();
		} catch (err) {
			throw wrapSdkError(err);
		}
	}
	buildProviderMeta(response) {
		return {
			provider: "openai",
			responseId: response.id,
			status: response.status ?? null,
			incompleteReason: response.incomplete_details?.reason ?? null
		};
	}
	serializeOptions() {
		return { replayReasoningItems: true };
	}
};
//#endregion
//#region packages/providers/src/anthropic.ts
function isBrowser() {
	return typeof globalThis.self !== "undefined";
}
const anthropicDescriptor = {
	name: "anthropic",
	defaultURL: "https://api.anthropic.com",
	envVar: "ANTHROPIC_API_KEY",
	create: (config) => new AnthropicCompletionBackend(config)
};
function isAnthropicMeta(meta) {
	return meta != null && typeof meta === "object" && meta.provider === "anthropic";
}
const ANTHROPIC_VERSION = "2023-06-01";
function anthropicMeta(signature) {
	if (signature) return {
		provider: "anthropic",
		signature
	};
}
function anthropicRole(role) {
	return role === "assistant" ? "assistant" : "user";
}
function serializePart$1(part, toolNamesById) {
	switch (part.type) {
		case "content": return blocksToAnthropicContent(part.content);
		case "think":
			if (part.meta) return {
				type: "thinking",
				thinking: part.content,
				signature: part.meta.signature
			};
			if (!part.content.trim()) return;
			return {
				type: "text",
				text: part.content
			};
		case "tool_call":
			toolNamesById.set(part.toolCallId, part.name);
			return {
				type: "tool_use",
				id: part.toolCallId,
				name: part.name,
				input: part.arguments || {}
			};
		case "tool_result": return {
			type: "tool_result",
			tool_use_id: part.toolCallId,
			content: blocksToAnthropicContent(part.content),
			is_error: !part.ok
		};
	}
}
/**
* Map a `Block[]` to Anthropic's per-block content array. Used both
* for ContentPart (user/assistant body) and ToolResultPart content.
*
* - text blocks → `{ type: "text", text }`
* - binary blocks with image/* → `{ type: "image", source: { ... } }`
* - binary blocks with application/pdf → `{ type: "document", source: { ... } }`
* - other binary (audio, video, unknown) → text block describing the artifact
*   (Anthropic doesn't accept those shapes yet)
* - ref blocks → text block summarizing the URI + size
*/
function blocksToAnthropicContent(blocks) {
	const out = [];
	for (const block of blocks) switch (block.kind) {
		case "text":
			if (block.text.length > 0) out.push({
				type: "text",
				text: block.text
			});
			break;
		case "binary": {
			const source = block.data instanceof URL ? {
				type: "url",
				url: block.data.href
			} : {
				type: "base64",
				media_type: block.mediaType,
				data: block.data
			};
			if (block.mediaType.startsWith("image/")) out.push({
				type: "image",
				source
			});
			else if (block.mediaType === "application/pdf") out.push({
				type: "document",
				source: {
					...source,
					media_type: "application/pdf"
				}
			});
			else out.push({
				type: "text",
				text: anthropicArtifactDescriptor(block)
			});
			break;
		}
		case "ref":
			out.push({
				type: "text",
				text: anthropicRefDescriptor(block)
			});
			break;
		default: throw new Error(`unreachable: ${block}`);
	}
	return out;
}
function anthropicArtifactDescriptor(block) {
	const label = block.filename ?? block.mediaType;
	return `[${block.mediaType} ${label}]`;
}
function anthropicRefDescriptor(block) {
	const summary = block.summary ?? `${block.bytes ?? "?"} bytes`;
	return `[${block.mediaType ?? "ref"} ${block.uri} (${summary})]`;
}
function serializeMessages$1(messages) {
	const normalized = canonicalize(messages, isAnthropicMeta);
	const toolNamesById = /* @__PURE__ */ new Map();
	return coalesceByRole(normalized, anthropicRole, (part) => serializePart$1(part, toolNamesById)).map(({ role, parts }) => ({
		role,
		content: parts
	}));
}
function serializeTools$1(tools) {
	return (tools || []).map((tool) => ({
		name: tool.name,
		description: tool.description || "Tool",
		input_schema: tool.inputSchema || { type: "object" }
	}));
}
function parseContentBlocks(blocks, responseId) {
	const parts = [];
	let pendingBlocks = [];
	const flushContent = () => {
		if (pendingBlocks.length > 0) {
			parts.push(contentPart("assistant", pendingBlocks));
			pendingBlocks = [];
		}
	};
	for (const block of blocks) {
		if (block.type === "text") {
			const tb = block;
			if (tb.text?.trim()) pendingBlocks.push(text(tb.text));
			continue;
		}
		if (block.type === "thinking") {
			flushContent();
			const tb = block;
			const content = tb.thinking || "";
			const meta = anthropicMeta(tb.signature || void 0);
			if (!content && !meta) continue;
			parts.push(thinkingPart(content, meta));
			continue;
		}
		if (block.type === "tool_use") {
			flushContent();
			const tb = block;
			if (tb.id && tb.name) parts.push(toolCallPart({
				toolCallId: tb.id,
				name: tb.name,
				arguments: tb.input || {}
			}));
			continue;
		}
		const anyBlock = block;
		if (anyBlock.type === "image" || anyBlock.type === "document") {
			const src = anyBlock.source ?? {};
			const mediaType = src.media_type ?? (anyBlock.type === "image" ? "image/png" : "application/octet-stream");
			if (src.type === "base64" && typeof src.data === "string") pendingBlocks.push(image(src.data, mediaType));
			else if (src.type === "url" && typeof src.url === "string") pendingBlocks.push(image(new URL(src.url), mediaType));
		}
	}
	flushContent();
	if (parts.length === 0) return [];
	return [assistantMessage(parts, responseId)];
}
function normalizeStopReason$1(stopReason) {
	switch (stopReason) {
		case "end_turn": return "end_turn";
		case "tool_use": return "tool_use";
		case "max_tokens": return "max_tokens";
		case "refusal": return "refusal";
		case "pause_turn": return "pause_turn";
		case "model_context_window_exceeded": return "context_window";
		default: return "unknown";
	}
}
function anthropicModelSupportsEffort(model) {
	return model.startsWith("claude-opus-4-6") || model.startsWith("claude-sonnet-4-6") || model.startsWith("claude-opus-4-5");
}
function anthropicModelSupportsAdaptiveThinking(model) {
	return model.startsWith("claude-opus-4-6") || model.startsWith("claude-sonnet-4-6");
}
function normalizeAnthropicEffort(model, effort) {
	switch (effort) {
		case "low": return "low";
		case "med": return "medium";
		case "high": return "high";
		case "xhigh": return model.startsWith("claude-opus-4-6") ? "max" : "high";
		default: return null;
	}
}
function buildPayload(request) {
	const payload = {
		model: request.model,
		max_tokens: request.maxOutput,
		messages: serializeMessages$1(request.messages || [])
	};
	if (request.system?.trim()) payload.system = request.system;
	if (request.tools?.length) payload.tools = serializeTools$1(request.tools);
	const effort = normalizeAnthropicEffort(request.model, request.effort);
	if (effort && anthropicModelSupportsEffort(request.model)) payload.output_config = { effort };
	if (anthropicModelSupportsAdaptiveThinking(request.model)) payload.thinking = { type: "adaptive" };
	return payload;
}
function buildResponse(data) {
	const usage = data.usage;
	return {
		messages: parseContentBlocks(data.content, data.id),
		stopReason: normalizeStopReason$1(data.stop_reason),
		usage: {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cachedReadTokens: usage.cache_read_input_tokens || 0,
			cachedWriteTokens: usage.cache_creation_input_tokens || 0,
			reasoningTokens: 0
		},
		providerMeta: {
			provider: "anthropic",
			responseId: data.id,
			stopReason: data.stop_reason
		},
		warnings: []
	};
}
var AnthropicCompletionBackend = class {
	specVersion = "v1";
	resolved;
	client;
	constructor(resolved) {
		this.resolved = resolved;
		this.client = new Anthropic({
			apiKey: resolved.apiKey,
			baseURL: resolved.baseURL,
			...isBrowser() && {
				dangerouslyAllowBrowser: true,
				defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" }
			}
		});
	}
	async *complete(request) {
		const payload = buildPayload(request);
		let data;
		try {
			const stream = this.client.messages.stream(payload, {
				headers: { "anthropic-version": ANTHROPIC_VERSION },
				signal: request.signal
			});
			const toolCallIdByIndex = /* @__PURE__ */ new Map();
			for await (const ev of stream) {
				if (ev.type === "content_block_start") {
					if (ev.content_block.type === "tool_use") toolCallIdByIndex.set(ev.index, ev.content_block.id);
					continue;
				}
				if (ev.type !== "content_block_delta") continue;
				const d = ev.delta;
				if (d.type === "text_delta") yield {
					kind: "text_delta",
					content: d.text
				};
				else if (d.type === "thinking_delta") yield {
					kind: "thinking_delta",
					content: d.thinking
				};
				else if (d.type === "input_json_delta") {
					const id = toolCallIdByIndex.get(ev.index);
					if (id) yield {
						kind: "tool_input_delta",
						toolCallId: id,
						chunk: d.partial_json
					};
				}
			}
			data = await stream.finalMessage();
		} catch (err) {
			throw wrapSdkError(err);
		}
		return buildResponse(data);
	}
};
//#endregion
//#region packages/providers/src/gemini.ts
const geminiDescriptor = {
	name: "gemini",
	defaultURL: "https://generativelanguage.googleapis.com/v1beta",
	envVar: "GEMINI_API_KEY",
	create: (config) => new GeminiCompletionBackend(config)
};
function isGeminiMeta(meta) {
	return meta != null && typeof meta === "object" && meta.provider === "gemini";
}
function geminiMeta(thoughtSignature) {
	if (!thoughtSignature) return;
	return {
		provider: "gemini",
		thoughtSignature
	};
}
function geminiRole(role) {
	return role === "assistant" ? "model" : "user";
}
function resolveToolName(toolNamesById, toolCallId) {
	return toolNamesById.get(toolCallId) || `tool_${toolCallId}`;
}
function serializePart(part, toolNamesById) {
	switch (part.type) {
		case "content": {
			const parts = blocksToGeminiParts(part.content);
			if (part.meta && parts.length > 0) parts[0] = {
				...parts[0],
				thoughtSignature: part.meta.thoughtSignature
			};
			return parts;
		}
		case "think":
			if (part.meta) return {
				text: part.content,
				thought: true,
				thoughtSignature: part.meta.thoughtSignature
			};
			if (!part.content.trim()) return;
			return { text: part.content };
		case "tool_call":
			toolNamesById.set(part.toolCallId, part.name);
			return {
				functionCall: {
					id: part.toolCallId,
					name: part.name,
					args: part.arguments || {}
				},
				...part.meta ? { thoughtSignature: part.meta.thoughtSignature } : {}
			};
		case "tool_result": {
			const text = blocksToText(part.content);
			return { functionResponse: {
				id: part.toolCallId,
				name: resolveToolName(toolNamesById, part.toolCallId),
				response: !part.ok ? {
					toolCallId: part.toolCallId,
					error: text
				} : {
					toolCallId: part.toolCallId,
					content: text
				}
			} };
		}
	}
}
function serializeMessages(messages) {
	const normalized = canonicalize(messages, isGeminiMeta);
	const toolNamesById = /* @__PURE__ */ new Map();
	return coalesceByRole(normalized, geminiRole, (part) => serializePart(part, toolNamesById));
}
/**
* Map a `Block[]` from a ContentPart into Gemini's per-Part vocabulary.
*
* - text   → `{ text }`
* - binary inline (base64 string) → `{ inlineData: { mimeType, data } }`
* - binary URL → `{ fileData: { mimeType, fileUri } }`
* - ref    → `{ fileData: { mimeType?, fileUri: uri } }`
*/
function blocksToGeminiParts(blocks) {
	const out = [];
	for (const b of blocks) switch (b.kind) {
		case "text":
			out.push({ text: b.text });
			break;
		case "binary":
			if (b.data instanceof URL) out.push({ fileData: {
				mimeType: b.mediaType,
				fileUri: b.data.href
			} });
			else out.push({ inlineData: {
				mimeType: b.mediaType,
				data: b.data
			} });
			break;
		case "ref":
			out.push({ fileData: {
				mimeType: b.mediaType ?? "application/octet-stream",
				fileUri: b.uri
			} });
			break;
		default: throw new Error(`unreachable: ${b}`);
	}
	return out;
}
function sanitizeGeminiSchema(schema) {
	if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
	if (!schema || typeof schema !== "object") return schema;
	const output = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "additionalProperties") continue;
		if (key === "type" && Array.isArray(value)) {
			output.type = value.find((entry) => entry !== "null") || value[0];
			continue;
		}
		output[key] = sanitizeGeminiSchema(value);
	}
	return output;
}
function serializeTools(tools) {
	if (!tools?.length) return;
	return [{ functionDeclarations: tools.map((tool) => ({
		name: tool.name,
		description: tool.description || "Tool",
		parametersJsonSchema: sanitizeGeminiSchema(tool.inputSchema || { type: "object" })
	})) }];
}
function parseParts(geminiParts, responseId) {
	const parts = [];
	let toolCallIndex = 0;
	let lastThoughtSignature;
	let pendingBlocks = [];
	let pendingMeta;
	const flushContent = () => {
		if (pendingBlocks.length > 0) {
			parts.push(contentPart("assistant", pendingBlocks, pendingMeta));
			pendingBlocks = [];
			pendingMeta = void 0;
		}
	};
	for (const gp of geminiParts || []) {
		if (gp.thoughtSignature) lastThoughtSignature = gp.thoughtSignature;
		if (gp.functionCall?.name) {
			flushContent();
			toolCallIndex += 1;
			parts.push(toolCallPart({
				toolCallId: gp.functionCall.id || `gemini-call-${toolCallIndex}`,
				name: gp.functionCall.name,
				arguments: gp.functionCall.args || {},
				meta: lastThoughtSignature ? geminiMeta(lastThoughtSignature) : void 0
			}));
			continue;
		}
		if (gp.text?.trim()) {
			if (gp.thought === true) {
				flushContent();
				const content = gp.text;
				const meta = geminiMeta(gp.thoughtSignature || void 0);
				parts.push(thinkingPart(content, meta));
			} else {
				if (lastThoughtSignature && !pendingMeta) pendingMeta = geminiMeta(lastThoughtSignature);
				pendingBlocks.push(text(gp.text));
			}
			continue;
		}
		if (gp.inlineData?.mimeType && typeof gp.inlineData.data === "string") {
			pendingBlocks.push(image(gp.inlineData.data, gp.inlineData.mimeType));
			continue;
		}
		if (gp.fileData?.fileUri) {
			pendingBlocks.push(image(new URL(gp.fileData.fileUri), gp.fileData.mimeType ?? "application/octet-stream"));
			continue;
		}
	}
	flushContent();
	if (parts.length === 0) return [];
	return [assistantMessage(parts, responseId)];
}
function normalizeStopReason(finishReason, parts, promptBlocked) {
	if (promptBlocked) return "refusal";
	if (parts.some((p) => p.type === "tool_call")) return "tool_use";
	switch (finishReason) {
		case "STOP": return "end_turn";
		case "MAX_TOKENS": return "max_tokens";
		case "SAFETY":
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII": return "refusal";
		default: return "unknown";
	}
}
function isGemini3Model(model) {
	return /^gemini-3(?:\.|-)/.test(model);
}
function isGemini25Model(model) {
	return model.startsWith("gemini-2.5-");
}
function normalizeGemini3Effort(_model, effort) {
	switch (effort) {
		case "low": return "low";
		case "med": return "medium";
		case "high":
		case "xhigh": return "high";
		default: return "high";
	}
}
function normalizeGemini25Effort(effort) {
	switch (effort) {
		case "low": return 1024;
		case "med": return 8192;
		case "high": return -1;
		case "xhigh": return 24576;
		default: return -1;
	}
}
function buildUsage(meta, fallbackOutputText = "") {
	if (!meta) return emptyUsage();
	const input = meta.promptTokenCount || 0;
	const reasoning = meta.thoughtsTokenCount || 0;
	const total = meta.totalTokenCount || 0;
	let output = meta.candidatesTokenCount || Math.max(0, total - input - reasoning);
	if (output === 0 && fallbackOutputText) output = estimateTokens(fallbackOutputText);
	return {
		inputTokens: input,
		outputTokens: output,
		cachedReadTokens: meta.cachedContentTokenCount || 0,
		cachedWriteTokens: 0,
		reasoningTokens: reasoning
	};
}
var GeminiCompletionBackend = class {
	specVersion = "v1";
	resolved;
	client;
	constructor(resolved) {
		this.resolved = resolved;
		this.client = new GoogleGenAI({
			apiKey: resolved.apiKey,
			httpOptions: resolved.baseURL ? {
				baseUrl: resolved.baseURL,
				apiVersion: ""
			} : void 0
		});
	}
	async *complete(request) {
		const config = { maxOutputTokens: request.maxOutput };
		if (request.system?.trim()) config.systemInstruction = request.system;
		if (isGemini3Model(request.model)) config.thinkingConfig = {
			thinkingLevel: normalizeGemini3Effort(request.model, request.effort),
			includeThoughts: true
		};
		else if (isGemini25Model(request.model)) config.thinkingConfig = {
			thinkingBudget: normalizeGemini25Effort(request.effort),
			includeThoughts: true
		};
		const tools = serializeTools(request.tools);
		if (tools) config.tools = tools;
		const payload = {
			model: request.model,
			contents: serializeMessages(request.messages || []),
			config
		};
		const accumulatedParts = [];
		let lastChunk;
		try {
			const stream = await this.client.models.generateContentStream(payload);
			for await (const chunk of stream) {
				lastChunk = chunk;
				const parts = chunk.candidates?.[0]?.content?.parts ?? [];
				for (const part of parts) {
					accumulatedParts.push(part);
					if (part.text) if (part.thought) yield {
						kind: "thinking_delta",
						content: part.text
					};
					else yield {
						kind: "text_delta",
						content: part.text
					};
					else if (part.functionCall) yield {
						kind: "tool_input_delta",
						toolCallId: part.functionCall.id ?? "",
						chunk: JSON.stringify(part.functionCall.args ?? {})
					};
				}
			}
		} catch (err) {
			throw wrapSdkError(err);
		}
		const candidate = lastChunk?.candidates?.[0] ?? null;
		const messages = parseParts(accumulatedParts, lastChunk?.responseId ?? void 0);
		const allParts = messages.flatMap((m) => m.parts);
		const promptFeedback = lastChunk?.promptFeedback;
		const promptBlocked = Boolean(promptFeedback?.blockReason);
		const outputText = accumulatedParts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
		return {
			messages,
			stopReason: normalizeStopReason(candidate?.finishReason, allParts, promptBlocked),
			usage: buildUsage(lastChunk?.usageMetadata, outputText),
			providerMeta: {
				provider: "gemini",
				finishReason: candidate?.finishReason ?? null,
				promptBlockReason: promptFeedback?.blockReason ?? null
			},
			warnings: []
		};
	}
};
//#endregion
//#region packages/providers/src/llamacpp.ts
const llamacppDescriptor = {
	name: "llamacpp",
	defaultURL: "http://127.0.0.1:8000/v1",
	envVar: null,
	create: (config) => new LlamaCppCompletionBackend(config)
};
/**
* OpenAI-compatible Responses API without streaming — llama-server's SSE
* format is not fully compatible with the OpenAI SDK's stream accumulator.
*/
var LlamaCppCompletionBackend = class extends OpenAICompletionBackend {
	buildProviderMeta(response) {
		return {
			provider: "llamacpp",
			responseId: response.id,
			status: response.status ?? null,
			incompleteReason: response.incomplete_details?.reason ?? null
		};
	}
	serializeOptions() {
		return { replayReasoningItems: false };
	}
	async doRequest(client, payload) {
		try {
			return await client.responses.create(payload);
		} catch (err) {
			throw wrapSdkError(err);
		}
	}
};
//#endregion
//#region packages/providers/src/registry.ts
const registry = /* @__PURE__ */ new Map();
function registerProvider(desc) {
	registry.set(desc.name, desc);
}
function getProvider(name) {
	return registry.get(name);
}
function allProviders() {
	return registry.values();
}
registerProvider(openaiDescriptor);
registerProvider(anthropicDescriptor);
registerProvider(geminiDescriptor);
registerProvider(llamacppDescriptor);
//#endregion
//#region packages/providers/src/factory.ts
function createBackend(config) {
	const desc = getProvider(config.provider);
	if (!desc) throw new Error(`Unknown provider "${config.provider}". Register it with registerProvider().`);
	const effort = config.effort;
	const maxContext = config.maxContext ?? 4e5;
	const maxOutput = config.maxOutput ?? 32e3;
	const internal = {
		nativeOpenAI: config.provider === "openai",
		apiKey: resolveApiKey(config, desc.envVar),
		baseURL: config.baseURL ?? desc.defaultURL
	};
	const inner = desc.create(internal);
	return {
		specVersion: "v1",
		complete: (req) => inner.complete(req),
		config: {
			model: config.model,
			effort,
			maxContext,
			maxOutput
		}
	};
}
function resolveApiKey(config, envVar) {
	if (config.apiKey) return config.apiKey;
	if (envVar === null) return "";
	const fromEnv = typeof process !== "undefined" ? process.env?.[envVar] : void 0;
	if (fromEnv) return fromEnv;
	throw new Error(`Missing ${envVar} environment variable for provider "${config.provider}". Pass { apiKey } or set ${envVar}.`);
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
* Add the active workspace's local directory as a read-only root
* when present, so tools can read spilled artifacts back without
* widening write scope. Workspaces without a local `dir` pass
* through unchanged.
*/
function pathContextForWorkspace(base, workspace) {
	if ("dir" in workspace && typeof workspace.dir === "string") return base.cloneWithRoot(ro(workspace.dir));
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
	description: `Read a file's contents. Returns up to \`limit\` lines (default 2000) starting at \`offset\` (default 1, 1-indexed). Individual lines over ${MAX_LINE_CHARS} chars are truncated with a \`[line truncated]\` marker.`,
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
		endLine: offset - 1
	});
	const startLine = offset;
	const endLine = Math.min(offset + limit - 1, totalLines);
	const slice = allLines.slice(startLine - 1, endLine).map((line) => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "… [line truncated]" : line);
	return ok({
		path: check.path,
		content: slice.join("\n"),
		totalLines,
		startLine,
		endLine
	});
}
function format$4(data) {
	if (data.totalLines === 0) return "(empty file)";
	if (data.content === "") return `(no lines in range — file has ${data.totalLines} lines. Use a smaller offset to read.)`;
	return data.content;
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
const HARD_LIMIT$3 = 1e4;
const parameters$3 = z.object({
	pattern: z.string().describe("Glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.ts\")"),
	path: z.string().describe("Absolute path to the directory to search")
});
/**
* Find files by glob pattern. Respects `.gitignore` by default.
*/
const globFiles = (pathCtx, opts = {}) => fsTool({
	name: "glob_files",
	description: "Find files by glob pattern. Respects .gitignore by default.",
	parameters: parameters$3,
	execute: (args, ctx) => run$2(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
	format: format$3
});
async function run$2(pathCtx, opts, args) {
	const check = pathCtx.safeDirectoryPath(args.path, "path");
	if (!check.ok) return err(check.error);
	const matches = await walk({
		cwd: check.path,
		pattern: args.pattern,
		gitignore: opts.gitignore
	});
	return ok({
		matches: matches.slice(0, HARD_LIMIT$3),
		totalMatches: matches.length
	});
}
function format$3(data) {
	if (data.matches.length === 0) return "No matches.";
	return groupByDir(data.matches);
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
const HARD_LIMIT$2 = 1e4;
const MAX_FILE_SIZE = 1024 * 1024;
const parameters$2 = z.object({
	pattern: z.string().describe("ECMAScript (JS) regex pattern to search for"),
	path: z.string().describe("Absolute path to the directory to search"),
	include: z.string().default("**/*").describe("Glob filter for files (e.g. \"*.ts\", \"**/*.md\")")
});
/**
* Search file contents with a JS regex. Skips binary files and files
* larger than {@link MAX_FILE_SIZE}. Matches are collected up to
* {@link HARD_LIMIT} and returned grouped by file. Respects
* `.gitignore` by default.
*/
const grepFiles = (pathCtx, opts = {}) => fsTool({
	name: "grep_files",
	description: "Search file contents using a regex. Returns matching lines grouped by file.",
	parameters: parameters$2,
	execute: (args, ctx) => grep(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
	format: format$2
});
async function grep(pathCtx, opts, args) {
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
				if (allMatches.length >= HARD_LIMIT$2) break outer;
			}
		} catch {}
	}
	return ok({
		matches: allMatches,
		fileCount: matchedFiles.size,
		totalMatches: allMatches.length
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
	return sections.join("\n\n");
}
//#endregion
//#region packages/tools/src/list-directory.ts
const HARD_LIMIT$1 = 1e4;
const parameters$1 = z.object({
	path: z.string().describe("Absolute path to the directory to list"),
	depth: z.number().min(1).max(5).default(1).describe("How deep to traverse. 1 = flat, 2+ = tree.")
});
/**
* List a directory as a tree. `depth: 1` is a flat listing; up to
* `depth: 5` for project overviews. Respects `.gitignore` by default.
*/
const listDirectory = (pathCtx, opts = {}) => fsTool({
	name: "list_directory",
	description: "List files and directories as a tree. Depth 1 = flat listing, up to 5 for project structure. Respects .gitignore.",
	parameters: parameters$1,
	execute: (args, ctx) => list(pathContextForWorkspace(pathCtx, ctx.workspace), opts, args),
	format: format$1
});
async function list(pathCtx, opts, args) {
	const check = pathCtx.safeDirectoryPath(args.path, "path");
	if (!check.ok) return err(check.error);
	const base = check.path;
	const capped = (await walk({
		cwd: base,
		pattern: "**/*",
		deep: args.depth ?? 1,
		onlyFiles: false,
		gitignore: opts.gitignore
	})).slice(0, HARD_LIMIT$1);
	return ok({
		path: base,
		entries: await Promise.all(capped.map(async (rel) => {
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
		}))
	});
}
function format$1(data) {
	if (data.entries.length === 0) return "Empty directory.";
	return data.entries.map((e) => {
		const depth = e.name.split("/").length - 1;
		const indent = "  ".repeat(depth);
		const base = e.name.split("/").pop();
		if (e.type === "directory") return `${indent}${base}/`;
		return `${indent}${base}${e.sizeBytes != null ? ` (${formatSize(e.sizeBytes)})` : ""}`;
	}).join("\n");
}
function formatSize(bytes) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
//#endregion
//#region packages/tools/src/shell-snapshot.ts
/**
* @module
* Shell-state snapshotting for zsh and bash.
*
* A snapshot is a captured image of a login shell's state — env vars,
* aliases, functions, and shell options — serialized to a `.sh` script
* that downstream invocations can `source` to inherit that state
* without re-initializing from rc files every time.
*
* Three primitives:
*   - `capture(kind)`  spawns a login shell, sources rc files, and
*                      introspects the resulting state.
*   - `parse(output, kind)`  converts extraction stdout into a Snapshot
*                      (exposed separately so callers can drive the
*                      subprocess themselves — e.g. under a sandbox).
*   - `toScript(snapshot)`  serializes a Snapshot back to a `.sh`
*                      reconstruction script.
*/
const ENV_KEEP = new Set([
	"PATH",
	"HOME",
	"USER",
	"SHELL"
]);
/** Throws if the shell subprocess exits nonzero. */
async function capture(kind) {
	return parse(await runShell(kind, buildExtractionScript(kind)), kind);
}
function parse(output, kind) {
	const snapshot = {
		kind,
		envVars: {},
		aliases: {},
		functions: {},
		shellOptions: []
	};
	const envSection = extractSection(output, "ENV_VARS");
	if (envSection) for (const pair of splitNull(envSection)) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const key = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		if (ENV_KEEP.has(key)) snapshot.envVars[key] = value;
	}
	const aliasSection = extractSection(output, "ALIASES");
	if (aliasSection) for (const pair of splitNull(aliasSection)) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		snapshot.aliases[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	const funcSection = extractSection(output, "FUNCTIONS");
	if (funcSection) for (const pair of splitNull(funcSection)) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const name = pair.slice(0, eq);
		const body = pair.slice(eq + 1);
		if (!name.startsWith("_") && body.length > 0) snapshot.functions[name] = body;
	}
	const optsSection = extractSection(output, "SHELL_OPTIONS");
	if (optsSection) for (const opt of splitNull(optsSection)) snapshot.shellOptions.push(opt);
	return snapshot;
}
/** Ordering is load-bearing: unalias → functions → options → aliases → env. */
function toScript(snapshot) {
	const lines = [];
	lines.push("# Shell snapshot — auto-generated");
	lines.push("unalias -a 2>/dev/null || true");
	lines.push("");
	lines.push("# Functions");
	for (const name of Object.keys(snapshot.functions).sort()) lines.push(snapshot.functions[name]);
	lines.push("");
	lines.push("# Shell options");
	if (snapshot.kind === "zsh") for (const opt of snapshot.shellOptions) lines.push(`setopt ${opt}`);
	else {
		lines.push("shopt -s expand_aliases");
		for (const opt of snapshot.shellOptions) lines.push(`shopt -s ${opt}`);
	}
	lines.push("");
	lines.push("# Aliases");
	for (const name of Object.keys(snapshot.aliases).sort()) lines.push(`alias -- ${name}=${snapshot.aliases[name]}`);
	lines.push("");
	lines.push("# Environment");
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"SHELL"
	]) {
		const value = snapshot.envVars[name];
		if (value !== void 0) lines.push(`export ${name}=${shellEscape(value)}`);
	}
	return lines.join("\n") + "\n";
}
function buildExtractionScript(kind) {
	return [
		kind === "zsh" ? "[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null" : "[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null",
		`
echo "==ENV_VARS_START=="
env -0
echo ""
echo "==ENV_VARS_END=="
`.trim(),
		`
echo "==ALIASES_START=="
alias | while IFS='=' read -r key value; do
  key="\${key#alias }"
  printf "%s=%s\\0" "$key" "$value"
done
echo ""
echo "==ALIASES_END=="
`.trim(),
		kind === "zsh" ? `
echo "==FUNCTIONS_START=="
print -l \${(ok)functions} | while read func; do
  body=$(typeset -f "$func")
  if [ -n "$body" ]; then
    printf "%s=%s\\0" "$func" "$body"
  fi
done
echo ""
echo "==FUNCTIONS_END=="
`.trim() : `
echo "==FUNCTIONS_START=="
declare -F | while read -r _ _ func; do
  body=$(declare -f "$func")
  if [ -n "$body" ]; then
    printf "%s=%s\\0" "$func" "$body"
  fi
done
echo ""
echo "==FUNCTIONS_END=="
`.trim(),
		kind === "zsh" ? `
echo "==SHELL_OPTIONS_START=="
setopt | while read opt; do
  printf "%s\\0" "$opt"
done
echo ""
echo "==SHELL_OPTIONS_END=="
`.trim() : `
echo "==SHELL_OPTIONS_START=="
shopt | while read opt status; do
  if [ "$status" = "on" ]; then
    printf "%s\\0" "$opt"
  fi
done
echo ""
echo "==SHELL_OPTIONS_END=="
`.trim()
	].join("\n\n");
}
function runShell(kind, script) {
	return new Promise((resolve, reject) => {
		const child = spawn(kind, ["-l"], { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(/* @__PURE__ */ new Error(`${kind} snapshot extraction failed (exit ${code}): ${stderr.trim()}`));
		});
		child.stdin.write(script);
		child.stdin.end();
	});
}
function extractSection(output, section) {
	const start = `==${section}_START==`;
	const end = `==${section}_END==`;
	const i = output.indexOf(start);
	const j = output.indexOf(end);
	if (i < 0 || j < 0 || i >= j) return;
	return output.slice(i + start.length, j).trim();
}
function splitNull(section) {
	return section.split("\0").filter((s) => s.length > 0);
}
function shellEscape(value) {
	if (!value.includes("'")) return `'${value}'`;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}
//#endregion
//#region packages/tools/src/shell.ts
const CPU_LIMIT_SEC = 60;
const TIMEOUT_MS = 65e3;
const HARD_LIMIT = 5 * 1024 * 1024;
const UNSUPPORTED_SANDBOX_PREFIX = "ronde shell sandboxing is only enforced on macOS via sandbox-exec; running this shell command unsandboxed";
const parameters = z.object({ command: z.string().describe("Shell command to execute. Must be non-interactive.") });
/**
* Run shell commands with a cwd that persists across calls — a `cd` in
* one call affects the next. Prefers zsh, then bash, then /bin/sh.
* Runs under `sandbox-exec` by default on macOS (writes restricted
* to rw roots; reads unrestricted). On other platforms, sandboxed
* mode falls back to unsandboxed shell execution with a one-time
* process warning.
*
* @param opts.cwd - Starting working directory (default: first root).
* @param opts.sandbox - `true` (default) restricts writes, `false`
*   disables sandboxing, {@link SandboxConfig} gives fine-grained
*   control over reads/writes/network.
* @param opts.snapshot - `true` (default) captures the user's shell rc
*   state (aliases, functions, options, PATH) once on first
*   invocation and sources it into every subsequent command. `false`
*   runs commands with a bare env. Pass a {@link Snapshot} to supply
*   a pre-built one.
*/
const shell = (pathCtx, opts = {}) => {
	const initialCwd = opts.cwd ?? pathCtx.roots[0];
	const sandbox = opts.sandbox ?? true;
	const snapshot = opts.snapshot ?? true;
	const runtimeShell = resolveRuntimeShell();
	return fsTool({
		name: "shell",
		description: `Executes a ${runtimeShell.kind} command and returns its output. The working directory persists between calls — a \`cd\` in one call affects the next. Commands must be non-interactive. Timeout: 60s.`,
		parameters,
		state: {
			init: () => ({
				cwd: initialCwd,
				shell: runtimeShell,
				snapshotPath: void 0,
				snapshotWarningEmitted: false
			}),
			dispose: async (state) => {
				if (state.snapshotPath) await fs.unlink(state.snapshotPath).catch(() => {});
			}
		},
		execute: (args, ctx) => run$1(pathCtx, sandbox, snapshot, args, ctx),
		format,
		truncate: "middle"
	});
};
async function run$1(pathCtx, sandbox, snapshot, args, ctx) {
	await ensureSnapshot(snapshot, ctx.state);
	const raw = await runProcess(pathCtx, sandbox, args, ctx);
	if (!raw.ok) return err(raw.error);
	const data = raw.data;
	if (data.exitCode !== 0) return err(`Command failed with exit code ${data.exitCode}`, data);
	return ok(data);
}
async function runProcess(pathCtx, sandbox, args, ctx) {
	const enabled = sandbox !== false;
	const config = typeof sandbox === "object" ? sandbox : void 0;
	const profile = pathCtx.sandboxProfile(config);
	const sentinel = `__CWD_${Date.now()}__`;
	const script = shellSnapshotLine(ctx.state.snapshotPath, ctx.state.shell) + `ulimit -t ${CPU_LIMIT_SEC}\nexec 2>&1\n${args.command}\n__exit=$?\necho "${sentinel}$(pwd)"\nexit $__exit\n`;
	const scriptPath = path.join(await ensureTmpDir(), `.cmd_${genHex()}.${ctx.state.shell.kind}`);
	await fs.writeFile(scriptPath, script, "utf-8");
	return new Promise((resolve) => {
		const launch = resolveShellLaunch(enabled ? sandbox : false, profile, scriptPath, ctx.state.shell);
		if (launch.warning) emitUnsupportedSandboxWarning(launch.warning);
		const child = spawn(launch.command, launch.args, {
			cwd: ctx.state.cwd,
			env: spawnEnv(ctx.state),
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			if (stdout.length < HARD_LIMIT) stdout += data;
		});
		child.stderr.on("data", (data) => {
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
		async function finish(exitCode) {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			await fs.unlink(scriptPath).catch(() => {});
			const sentinelIdx = stdout.lastIndexOf(sentinel);
			if (sentinelIdx !== -1) {
				const newCwd = stdout.slice(sentinelIdx + sentinel.length).trim();
				stdout = stdout.slice(0, sentinelIdx);
				if (newCwd && path.isAbsolute(newCwd)) {
					const cwdCheck = pathCtx.safePath(newCwd, "cwd");
					if (cwdCheck.ok) ctx.state.cwd = cwdCheck.path;
				}
			}
			resolve(ok({
				stdout: stdout.trimEnd(),
				stderr: stderr.trimEnd(),
				exitCode
			}));
		}
		child.on("close", (code) => void finish(code || 0));
		child.on("error", async (e) => {
			clearTimeout(timer);
			await fs.unlink(scriptPath).catch(() => {});
			resolve(err(e.message));
		});
	});
}
function resolveShellLaunch(sandbox, profile, scriptPath, shell = resolveRuntimeShell(), platform = process.platform) {
	if (sandbox === false) return {
		command: shell.command,
		args: [scriptPath]
	};
	if (platform !== "darwin") return {
		command: shell.command,
		args: [scriptPath],
		warning: `${UNSUPPORTED_SANDBOX_PREFIX} with ${shell.command}. Pass sandbox: false to silence this warning.`
	};
	return {
		command: "sandbox-exec",
		args: [
			"-p",
			profile,
			shell.command,
			scriptPath
		]
	};
}
function resolveRuntimeShell(envPath = process.env.PATH ?? "", canExecute = isExecutable) {
	const zsh = findOnPath("zsh", envPath, canExecute);
	if (zsh) return {
		kind: "zsh",
		command: zsh
	};
	const bash = findOnPath("bash", envPath, canExecute);
	if (bash) return {
		kind: "bash",
		command: bash
	};
	return {
		kind: "sh",
		command: "/bin/sh"
	};
}
function findOnPath(bin, envPath, canExecute) {
	for (const dir of envPath.split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, bin);
		if (canExecute(candidate)) return candidate;
	}
}
function isExecutable(file) {
	try {
		syncFs.accessSync(file, syncFs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
let warnedUnsupportedSandbox = false;
function emitUnsupportedSandboxWarning(message) {
	if (warnedUnsupportedSandbox) return;
	warnedUnsupportedSandbox = true;
	process.emitWarning(message, { code: "RONDE_SHELL_SANDBOX_UNAVAILABLE" });
}
function format(data) {
	let output = data.stdout;
	if (data.exitCode !== 0) {
		if (data.stderr) output += `\n\nSTDERR:\n${data.stderr}`;
		output += `\n[exit ${data.exitCode}]`;
	}
	return output;
}
async function ensureTmpDir() {
	const dir = path.join(os.tmpdir(), ".ronde");
	await fs.mkdir(dir, { recursive: true });
	return dir;
}
async function ensureSnapshot(snapshot, state) {
	if (snapshot === false || state.snapshotPath !== void 0 || state.shell.kind === "sh") return;
	const resolved = await resolveSnapshot(snapshot, state);
	if (!resolved) return;
	const script = toScript(resolved);
	const snapshotPath = path.join(await ensureTmpDir(), `snapshot-${genHex()}.sh`);
	await fs.writeFile(snapshotPath, script, "utf-8");
	state.snapshotPath = snapshotPath;
}
async function resolveSnapshot(snapshot, state) {
	if (state.shell.kind === "sh") return;
	if (typeof snapshot === "object") {
		if (snapshot.kind === state.shell.kind) return snapshot;
		emitSnapshotMismatchWarning(snapshot.kind, state);
		return;
	}
	try {
		return await capture(state.shell.kind);
	} catch {
		return;
	}
}
function shellSnapshotLine(snapshotPath, shell) {
	if (!snapshotPath || shell.kind === "sh") return "";
	return `source ${shQuote(snapshotPath)} 2>/dev/null || true\n`;
}
function emitSnapshotMismatchWarning(snapshotKind, state) {
	if (state.snapshotWarningEmitted) return;
	state.snapshotWarningEmitted = true;
	process.emitWarning(`ronde shell snapshot kind "${snapshotKind}" does not match selected shell "${state.shell.kind}"; running without the snapshot.`, { code: "RONDE_SHELL_SNAPSHOT_MISMATCH" });
}
function shQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
const SPAWN_ENV = {
	TERM: "dumb",
	NO_COLOR: "1",
	PAGER: "cat",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	NONINTERACTIVE: "1",
	DEBIAN_FRONTEND: "noninteractive",
	GIT_TERMINAL_PROMPT: "0"
};
function spawnEnv(state) {
	if (state.snapshotPath) return SPAWN_ENV;
	return {
		...SPAWN_ENV,
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: process.env.HOME ?? "/tmp",
		USER: process.env.USER ?? "unknown",
		SHELL: state.shell.command
	};
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
		sandbox: shellOpts.sandbox ?? true,
		snapshot: shellOpts.snapshot ?? true
	}));
}
//#endregion
//#region packages/fs/src/internal.ts
/**
* @module
* Module-private capability token for the fs runtime backend.
*
* `rebase` keys the repoint-to-new-path method on FsJournal and
* FsWorkspace. Symbol-keyed so the method has no string name — it does
* not surface in autocomplete or property lookup for callers that have
* not imported the symbol.
*
* Exported only from this file and never re-exported through a public
* subpath. Relative imports from outside `packages/fs/` are visible in
* code review and obviously wrong.
*/
const rebase = Symbol("ronde.fs.rebase");
//#endregion
//#region packages/fs/src/journal.ts
const SEGMENTS_DIR = "segments";
const META_FILE = "meta.jsonl";
const SCAN_CHUNK_BYTES = 256 * 1024;
const NEWLINE_BYTE = 10;
const SPACE_BYTE = 32;
const TAB_BYTE = 9;
const CARRIAGE_RETURN_BYTE = 13;
const Uint8IndexOf = Uint8Array.prototype.indexOf;
/**
* Each active-history generation lives in its own append-only JSONL
* segment; current state is reduced from an append-only metadata ledger.
*/
var FsJournal = class extends Journal {
	kind = "fs";
	writes = Promise.resolve();
	writableGeneration;
	activeDirty = false;
	#dir;
	get dir() {
		return this.#dir;
	}
	constructor(id, dir, state) {
		super();
		this.id = id;
		this.state = state;
		this.#dir = dir;
	}
	[rebase](dir) {
		this.#dir = dir;
	}
	async event(event) {
		await this.runExclusiveOnActive(async () => {
			await appendJsonLine(this.activeSegmentPath(), event);
			this.activeDirty = true;
		});
	}
	/**
	* Fsyncs the active segment iff something was appended since the last
	* commit. Callers pick the boundary — the journal makes no assumption
	* about which events warrant a flush.
	*/
	async commit() {
		await this.runExclusiveOnActive(async () => {
			if (this.activeDirty) {
				await fsync(this.activeSegmentPath());
				this.activeDirty = false;
			}
		});
	}
	async partition(reason, nextEvents = []) {
		await this.runExclusiveOnActive(async () => {
			const nextGeneration = this.state.activeGeneration + 1;
			const tempPath = path.join(this.dir, SEGMENTS_DIR, `${segmentFileName(nextGeneration)}.tmp-${genHex()}`);
			const finalPath = segmentPath(this.dir, nextGeneration);
			const at = (/* @__PURE__ */ new Date()).toISOString();
			await writeEventsFile(tempPath, nextEvents);
			await fs.rename(tempPath, finalPath);
			await fsync(path.join(this.dir, SEGMENTS_DIR));
			await appendMetaRecord(this.dir, {
				type: "generation_published",
				generation: nextGeneration,
				reason,
				at
			});
			this.state = {
				...this.state,
				activeGeneration: nextGeneration
			};
			this.writableGeneration = nextGeneration;
			this.activeDirty = false;
		});
	}
	async scan(onEvent) {
		const repairTail = this.writableGeneration !== this.state.activeGeneration;
		const completed = await scanJsonlFile(this.activeSegmentPath(), {
			tailMode: repairTail ? "repair" : "strict",
			parse: parseJournalEvent,
			invalidContext: `Invalid active segment in ${this.dir}`,
			onValue: onEvent
		});
		if (repairTail && completed) this.writableGeneration = this.state.activeGeneration;
	}
	activeSegmentPath() {
		return segmentPath(this.dir, this.state.activeGeneration);
	}
	async ensureActiveGenerationWritable() {
		if (this.writableGeneration !== this.state.activeGeneration) {
			await ensureJsonlTailWritable(this.activeSegmentPath());
			this.writableGeneration = this.state.activeGeneration;
		}
	}
	/**
	* Serialize a mutation against the active generation and repair only
	* its writable tail before mutating. Interior corruption is a
	* scan-time concern.
	*/
	runExclusiveOnActive(op) {
		return this.runExclusive(async () => {
			await this.ensureActiveGenerationWritable();
			return op();
		});
	}
	runExclusive(op) {
		const run = this.writes.then(op, op);
		this.writes = run.then(() => void 0, () => void 0);
		return run;
	}
};
async function readJournalState(dir, tailMode = "strict") {
	let state;
	await scanJsonlFile(path.join(dir, META_FILE), {
		tailMode,
		parse: parseMetaRecord,
		invalidContext: `Invalid journal metadata in ${dir}`,
		onValue: (record) => {
			state = reduceMetaRecord(state, record, dir);
		}
	});
	if (!state) throw new Error(`Invalid journal metadata in ${dir}.`);
	if (state.activeGeneration < 1) throw new Error(`Invalid journal metadata in ${dir}: no active generation has been published`);
	return state;
}
async function initializeJournalState(dir, state) {
	const body = [JSON.stringify({
		type: "runtime_created",
		v: 1,
		id: state.id,
		createdAt: state.createdAt
	}), JSON.stringify({
		type: "generation_published",
		generation: state.activeGeneration,
		reason: "create",
		at: state.createdAt
	})].join("\n") + "\n";
	await writeFileDurable$1(path.join(dir, META_FILE), body);
}
function reduceMetaRecord(state, record, dir) {
	switch (record.type) {
		case "runtime_created":
			if (state) throw new Error(`Invalid journal metadata in ${dir}: duplicate runtime_created record`);
			return {
				v: 1,
				id: record.id,
				createdAt: record.createdAt,
				activeGeneration: 0
			};
		case "generation_published": {
			if (!state) throw new Error(`Invalid journal metadata in ${dir}: generation published before runtime_created`);
			const expected = state.activeGeneration + 1;
			if (record.generation !== expected) throw new Error(`Invalid journal metadata in ${dir}: expected generation ${expected} but saw ${record.generation}`);
			return {
				...state,
				activeGeneration: record.generation
			};
		}
	}
}
function isMetaRecord(x) {
	if (typeof x !== "object" || x === null || !("type" in x)) return false;
	switch (x.type) {
		case "runtime_created": return "v" in x && x.v === 1 && "id" in x && typeof x.id === "string" && "createdAt" in x && typeof x.createdAt === "string";
		case "generation_published": return "generation" in x && typeof x.generation === "number" && Number.isInteger(x.generation) && x.generation > 0 && "reason" in x && typeof x.reason === "string" && "at" in x && typeof x.at === "string";
		default: return false;
	}
}
function parseMetaRecord(line) {
	const parsed = JSON.parse(line);
	if (!isMetaRecord(parsed)) throw new Error("invalid metadata record shape");
	return parsed;
}
function parseJournalEvent(line) {
	return JSON.parse(line);
}
function segmentFileName(generation) {
	return `${generation.toString().padStart(8, "0")}.jsonl`;
}
function segmentPath(dir, generation) {
	return path.join(dir, SEGMENTS_DIR, segmentFileName(generation));
}
async function appendMetaRecord(dir, record) {
	await appendJsonLine(path.join(dir, META_FILE), record, true);
}
async function appendJsonLine(filePath, value, flush = false) {
	const fh = await fs.open(filePath, "a");
	try {
		await fh.writeFile(JSON.stringify(value) + "\n", "utf8");
		if (flush) await fh.sync();
	} finally {
		await fh.close();
	}
}
async function writeEventsFile(filePath, events) {
	await writeFileDurable$1(filePath, events.length === 0 ? "" : events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}
async function writeFileDurable$1(filePath, body) {
	const fh = await fs.open(filePath, "w");
	try {
		await fh.writeFile(body, "utf8");
		await fh.sync();
	} finally {
		await fh.close();
	}
}
async function fsync(pathToSync) {
	const fh = await fs.open(pathToSync, "r");
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}
async function scanJsonlFile(filePath, options) {
	const { tailMode, parse, invalidContext, onValue } = options;
	const fh = await fs.open(filePath, tailMode === "repair" ? "r+" : "r");
	const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
	const tail = emptyTail();
	let fileOffset = 0;
	try {
		for (;;) {
			const chunkStartOffset = fileOffset;
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, fileOffset);
			if (bytesRead === 0) break;
			fileOffset += bytesRead;
			const incoming = chunk.subarray(0, bytesRead);
			let lineStart = 0;
			if (tail.bytes > 0) {
				const tailNewline = byteIndexOf(incoming, NEWLINE_BYTE, 0);
				if (tailNewline === -1) {
					appendTailChunk(tail, incoming);
					continue;
				}
				if (tailHasNonWhitespaceBytes(tail, incoming, 0, tailNewline)) {
					if (await invokeSink(onValue, parseJsonLine(decodeTailLine(tail, incoming, 0, tailNewline), parse, invalidContext))) return false;
				}
				lineStart = tailNewline + 1;
				resetTail(tail);
			}
			for (;;) {
				const newline = byteIndexOf(incoming, NEWLINE_BYTE, lineStart);
				if (newline === -1) break;
				if (hasNonWhitespaceBytes(incoming, lineStart, newline)) {
					if (await invokeSink(onValue, parseJsonLine(incoming.toString("utf8", lineStart, newline), parse, invalidContext))) return false;
				}
				lineStart = newline + 1;
			}
			if (lineStart === incoming.length) resetTail(tail);
			else setTail(tail, Buffer.from(incoming.subarray(lineStart)), chunkStartOffset + lineStart);
		}
		if (tail.bytes === 0) return true;
		if (!tailHasNonWhitespaceBytes(tail)) {
			if (tailMode === "repair") await normalizeOpenFileTail(fh, {
				kind: "truncate",
				at: tail.startOffset
			});
			return true;
		}
		const tailText = decodeTailLine(tail);
		try {
			if (await invokeSink(onValue, parse(tailText))) return false;
			if (tailMode === "repair") await normalizeOpenFileTail(fh, {
				kind: "appendNewline",
				at: fileOffset
			});
			return true;
		} catch (error) {
			if (tailMode === "repair") {
				await normalizeOpenFileTail(fh, {
					kind: "truncate",
					at: tail.startOffset
				});
				return true;
			}
			if (tailMode === "tolerate") return true;
			throw new Error(`${invalidContext}: ${error.message}`);
		}
	} finally {
		await fh.close();
	}
}
async function ensureJsonlTailWritable(filePath) {
	const fh = await fs.open(filePath, "r+");
	try {
		const { size } = await fh.stat();
		if (size === 0) return;
		let start = Math.max(0, size - SCAN_CHUNK_BYTES);
		for (;;) {
			const length = size - start;
			const chunk = Buffer.alloc(length);
			const { bytesRead } = await fh.read(chunk, 0, length, start);
			const data = chunk.subarray(0, bytesRead);
			if (data.length === 0) return;
			if (data[data.length - 1] === NEWLINE_BYTE) return;
			const lineStart = byteLastIndexOf(data, NEWLINE_BYTE);
			if (lineStart === -1 && start > 0) {
				start = Math.max(0, start - SCAN_CHUNK_BYTES);
				continue;
			}
			const tail = data.subarray(lineStart === -1 ? 0 : lineStart + 1);
			const tailStart = lineStart === -1 ? 0 : start + lineStart + 1;
			const tailText = tail.toString("utf8");
			if (!hasNonWhitespaceBytes(tail, 0, tail.length)) {
				await normalizeOpenFileTail(fh, {
					kind: "truncate",
					at: tailStart
				});
				return;
			}
			try {
				JSON.parse(tailText);
				await normalizeOpenFileTail(fh, {
					kind: "appendNewline",
					at: size
				});
			} catch {
				await normalizeOpenFileTail(fh, {
					kind: "truncate",
					at: tailStart
				});
			}
			return;
		}
	} finally {
		await fh.close();
	}
}
function parseJsonLine(line, parse, invalidContext) {
	try {
		return parse(line);
	} catch (error) {
		throw new Error(`${invalidContext}: ${error.message}`);
	}
}
async function normalizeOpenFileTail(fh, op) {
	if (op.kind === "truncate") await fh.truncate(op.at);
	else await fh.write("\n", op.at, "utf8");
	await fh.sync();
}
function byteIndexOf(buf, value, start) {
	return Uint8IndexOf.call(buf, value, start);
}
function byteLastIndexOf(buf, value) {
	for (let i = buf.length - 1; i >= 0; i--) if (buf[i] === value) return i;
	return -1;
}
function hasNonWhitespaceBytes(buf, start, end) {
	for (let i = start; i < end; i++) {
		const byte = buf[i];
		if (byte !== SPACE_BYTE && byte !== TAB_BYTE && byte !== CARRIAGE_RETURN_BYTE) return true;
	}
	return false;
}
function emptyTail() {
	return {
		chunks: [],
		bytes: 0,
		startOffset: 0
	};
}
function resetTail(tail) {
	tail.chunks = [];
	tail.bytes = 0;
	tail.startOffset = 0;
}
function setTail(tail, chunk, startOffset) {
	if (chunk.length === 0) {
		resetTail(tail);
		return;
	}
	tail.chunks = [chunk];
	tail.bytes = chunk.length;
	tail.startOffset = startOffset;
}
function appendTailChunk(tail, chunk) {
	if (chunk.length === 0) return;
	tail.chunks.push(Buffer.from(chunk));
	tail.bytes += chunk.length;
}
function tailHasNonWhitespaceBytes(tail, suffix, start = 0, end = suffix?.length ?? 0) {
	for (const chunk of tail.chunks) if (hasNonWhitespaceBytes(chunk, 0, chunk.length)) return true;
	if (!suffix) return false;
	return hasNonWhitespaceBytes(suffix, start, end);
}
function decodeTailLine(tail, suffix, start = 0, end = suffix?.length ?? 0) {
	let text = "";
	for (const chunk of tail.chunks) text += chunk.toString("utf8");
	if (suffix && end > start) text += suffix.toString("utf8", start, end);
	return text;
}
async function invokeSink(onValue, value) {
	if (!onValue) return false;
	const result = onValue(value);
	if (result === true) return true;
	if (result && typeof result === "object" && "then" in result) return await result === true;
	return false;
}
//#endregion
//#region packages/fs/src/workspace.ts
const TOOL_RESULTS_DIR = "tool-results";
var FsWorkspace = class extends Workspace {
	kind = "fs";
	#dir;
	get dir() {
		return this.#dir;
	}
	constructor(id, dir) {
		super();
		this.id = id;
		this.#dir = dir;
	}
	/** Repoint at the same inode reached via a new path. */
	[rebase](dir) {
		this.#dir = dir;
	}
	async spill(content, o = {}) {
		const isText = typeof content === "string";
		const name = `${sanitizeFilename(o.name ?? "") || `spill-${genHex()}`}${extensionFor(o.mediaType, isText)}`;
		const full = path.join(this.dir, TOOL_RESULTS_DIR, name);
		await fs.mkdir(path.dirname(full), { recursive: true });
		if (isText) {
			await fs.writeFile(full, content, "utf-8");
			return {
				uri: pathToFileURL(full).href,
				bytes: Buffer.byteLength(content, "utf-8")
			};
		}
		await fs.writeFile(full, content);
		return {
			uri: pathToFileURL(full).href,
			bytes: content.byteLength
		};
	}
};
/**
* Pick a file extension from a mediaType. Falls back to `.txt` for
* text content without a mediaType, `.bin` for binary content
* without one. Common types get readable extensions; everything
* else uses the subtype after `/`.
*/
function extensionFor(mediaType, isText) {
	if (!mediaType) return isText ? ".txt" : ".bin";
	const known = {
		"text/plain": ".txt",
		"text/markdown": ".md",
		"text/html": ".html",
		"application/json": ".json",
		"application/pdf": ".pdf",
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
		"audio/wav": ".wav",
		"audio/mpeg": ".mp3",
		"audio/ogg": ".ogg",
		"video/mp4": ".mp4"
	};
	if (known[mediaType]) return known[mediaType];
	const slash = mediaType.indexOf("/");
	if (slash > 0 && slash < mediaType.length - 1) {
		const sub = mediaType.slice(slash + 1).split(";")[0].trim();
		if (/^[a-z0-9.-]+$/i.test(sub)) return `.${sub}`;
	}
	return isText ? ".txt" : ".bin";
}
//#endregion
//#region packages/fs/src/runtime.ts
const WRITER_LOCK_FILE = "writer.lock";
function activeSegmentPath(dir, generation) {
	return path.join(dir, SEGMENTS_DIR, `${String(generation).padStart(8, "0")}.jsonl`);
}
function expandTilde$1(p) {
	if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
	return p;
}
const ownedRuntimes = /* @__PURE__ */ new Map();
const openInFlight = /* @__PURE__ */ new Map();
/**
* Create a new fs-backed runtime at an exact directory. Fails if the
* target already exists. Creation is staged in a sibling temp dir then
* renamed into place — the final path never appears partially
* initialized.
*/
async function createFsRuntime(dir) {
	const runtimeDir = resolveFsRuntimeDir(dir);
	const parentDir = path.dirname(runtimeDir);
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const state = {
		v: 1,
		id: genId("rt"),
		createdAt: now,
		activeGeneration: 1
	};
	await fs.mkdir(parentDir, { recursive: true });
	await assertTargetAbsent(runtimeDir);
	const tempDir = path.join(parentDir, `.ronde-tmp-${state.id}-${genHex()}`);
	try {
		await fs.mkdir(tempDir);
		await fs.mkdir(path.join(tempDir, SEGMENTS_DIR));
		await fs.mkdir(path.join(tempDir, TOOL_RESULTS_DIR));
		await writeFileDurable(path.join(tempDir, SEGMENTS_DIR, "00000001.jsonl"), "");
		await initializeJournalState(tempDir, state);
		await fs.rename(tempDir, runtimeDir);
		await syncDir(parentDir);
	} catch (error) {
		await fs.rm(tempDir, {
			recursive: true,
			force: true
		}).catch(() => {});
		throw error;
	}
	return openFsRuntime(runtimeDir);
}
/**
* Open an existing fs-backed runtime at an exact directory. Validates
* required files; never creates missing paths.
*
* Reentrant: a second same-process open returns the cached
* journal+workspace pair, so every caller sees one reduced metadata
* state and a partition on one handle is visible on every other.
*/
async function openFsRuntime(dir) {
	const runtimeDir = resolveFsRuntimeDir(dir);
	const stat = await fs.stat(runtimeDir);
	const key = `${stat.dev}:${stat.ino}`;
	const inflight = openInFlight.get(key);
	if (inflight) await inflight;
	const cached = ownedRuntimes.get(key);
	if (cached) {
		const journal = cached.runtime.journal;
		if (journal.dir !== runtimeDir) {
			journal[rebase](runtimeDir);
			cached.runtime.workspace[rebase](runtimeDir);
		}
		return cached.runtime;
	}
	const promise = acquireFsRuntime(runtimeDir, key);
	openInFlight.set(key, promise);
	try {
		return await promise;
	} finally {
		openInFlight.delete(key);
	}
}
async function statFsRuntime(dir) {
	const runtimeDir = resolveFsRuntimeDir(dir);
	const state = await readJournalState(runtimeDir, "tolerate");
	const stat = await fs.stat(activeSegmentPath(runtimeDir, state.activeGeneration));
	return {
		id: state.id,
		mtime: stat.mtimeMs,
		createdAt: state.createdAt
	};
}
async function acquireFsRuntime(runtimeDir, key) {
	const lock = await acquireWriterLock(runtimeDir);
	try {
		const state = await readJournalState(runtimeDir, "repair");
		await fs.access(activeSegmentPath(runtimeDir, state.activeGeneration));
		const runtime = {
			journal: new FsJournal(state.id, runtimeDir, state),
			workspace: new FsWorkspace(state.id, runtimeDir)
		};
		ownedRuntimes.set(key, {
			lock,
			runtime
		});
		return runtime;
	} catch (error) {
		lock.release();
		throw error;
	}
}
function resolveFsRuntimeDir(dir) {
	return path.resolve(expandTilde$1(dir));
}
async function assertTargetAbsent(dir) {
	try {
		await fs.access(dir);
	} catch {
		return;
	}
	const error = /* @__PURE__ */ new Error(`Runtime directory already exists: ${dir}`);
	error.code = "EEXIST";
	throw error;
}
async function writeFileDurable(filePath, body) {
	const fh = await fs.open(filePath, "w");
	try {
		await fh.writeFile(body, "utf8");
		await fh.sync();
	} finally {
		await fh.close();
	}
}
async function syncDir(dir) {
	const fh = await fs.open(dir, "r");
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}
/**
* Claim exclusive write access via a kernel advisory lock (flock on
* Unix, LockFileEx on Windows, both wrapped by `@ronde/lock`). The
* kernel releases the lock when this process's fd closes — including
* SIGKILL/OOM/panic — so there is no PID tracking or userspace cleanup.
*
* Unconditionally hits the kernel. Reentrancy lives in `ownedRuntimes`;
* callers must check the cache first.
*/
async function acquireWriterLock(runtimeDir) {
	const lockPath = path.join(runtimeDir, WRITER_LOCK_FILE);
	try {
		return tryAcquire(lockPath);
	} catch (error) {
		if (error.message?.startsWith("LOCKED")) throw new Error(`Runtime already has an active writer lease: ${runtimeDir}`);
		throw error;
	}
}
//#endregion
//#region packages/ronde/src/compaction.ts
const DEFAULT_SYSTEM_PROMPT = `
You produce continuation context for an agent that will resume this work.
Your output will replace the conversation history, so completeness matters
more than brevity. Extract and preserve all specific values, paths,
identifiers, and decisions — verbatim, in full, exactly as they appear.
Absolute paths stay absolute. Never abbreviate, truncate, or elide
references with \`...\`. Never fabricate details that aren't in the
conversation.

Do not answer any questions in the conversation — produce only the
continuation context.

Use this structure:

## Goal
What is the task? What constraints or requirements apply?

## Progress
What has been accomplished? What is still in progress? What remains?

## Key decisions
Important choices made and their reasoning.

## Discoveries
Notable findings, errors encountered, values learned during the work.

## Relevant files
Files read, created, or modified that pertain to the task.

## Next steps
What should the next agent do first?
`.trim();
/**
* Default compaction: asks the model to produce a structured
* continuation context ("## Goal", "## Progress", etc.). Drops
* oldest history items one at a time if the compaction call hits
* the provider's context limit.
*/
var DefaultCompactionStrategy = class {
	compactionSystem;
	resumeMessage;
	constructor(options = {}) {
		this.compactionSystem = options.compactionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		this.resumeMessage = options.resumeMessage ?? "Resume the workflow from where you left off.";
	}
	async compact(ctx) {
		const { backend, model, effort, history } = ctx;
		const working = stripThinking(history);
		const deferred = [];
		while (working.length > 0) {
			const compactInput = [...working, userMessage("Produce the continuation context now.")];
			let compactResponse;
			try {
				compactResponse = await drain(backend.complete({
					model,
					system: this.compactionSystem,
					messages: compactInput,
					tools: [],
					effort,
					maxOutput: ctx.maxOutput,
					signal: ctx.signal
				}));
			} catch (err) {
				if (err instanceof CompletionError && err.kind === "context_length_exceeded") {
					if (working.length <= 1) break;
					deferred.unshift(working.pop());
					continue;
				}
				throw err;
			}
			let summary = "";
			for (const message of compactResponse.messages) for (const part of message.parts) if (part.type === "content" && part.role === "assistant") summary += blocksToText(part.content);
			if (!summary.trim()) return {
				kind: "not_compacted",
				usage: compactResponse.usage
			};
			return {
				kind: "compacted",
				summary: userMessage("## Continuation context (compacted from prior conversation)\n\n" + summary + "\n\n---\n\n" + this.resumeMessage),
				deferred,
				usage: compactResponse.usage
			};
		}
		return {
			kind: "not_compacted",
			usage: emptyUsage()
		};
	}
};
function stripThinking(messages) {
	return messages.map((m) => ({
		...m,
		parts: m.parts.filter((p) => p.type !== "think")
	})).filter((m) => m.parts.length > 0);
}
//#endregion
//#region packages/ronde/src/observer.ts
function dispatch(event, observers) {
	switch (event.type) {
		case "turn_start":
			notify(observers, (o) => o.onTurnStart?.(event.turn));
			break;
		case "thinking_delta":
			notify(observers, (o) => o.onThinkingDelta?.(event.turn, event.content));
			break;
		case "thinking":
			notify(observers, (o) => o.onThinking?.(event.turn, event.content));
			break;
		case "text_delta":
			notify(observers, (o) => o.onTextDelta?.(event.turn, event.content));
			break;
		case "text":
			notify(observers, (o) => o.onText?.(event.turn, event.content));
			break;
		case "tool_input_delta":
			notify(observers, (o) => o.onToolInputDelta?.(event.turn, event.toolCallId, event.chunk));
			break;
		case "tool_call":
			notify(observers, (o) => o.onToolCall?.(event.turn, event.call));
			break;
		case "tool_delta":
			notify(observers, (o) => o.onToolDelta?.(event.turn, event.call, event.chunk));
			break;
		case "tool_result":
			notify(observers, (o) => o.onToolResult?.(event.turn, event.call, event.content, event.result));
			break;
		case "turn_end":
			notify(observers, (o) => o.onTurnEnd?.(event.turn, event.step));
			break;
		case "cutoff":
			notify(observers, (o) => o.onCutoff?.(event.turn, event.count));
			break;
		case "compaction_start":
			notify(observers, (o) => o.onCompactionStart?.(event.turn, event.historyLength));
			break;
		case "compaction_end":
			notify(observers, (o) => o.onCompactionEnd?.(event.turn, event.usage));
			break;
		case "warning":
			notify(observers, (o) => o.onWarning?.(event.turn, event.message));
			break;
		case "error":
			notify(observers, (o) => o.onError?.(event.turn, event.message));
			break;
		case "run_end":
			notify(observers, (o) => o.onRunEnd?.(event.result));
			break;
		default:
	}
}
function notify(observers, fn) {
	for (const observer of observers) try {
		fn(observer);
	} catch {}
}
//#endregion
//#region packages/ronde/src/engine.ts
/**
* Observer-dispatching consumer over `stream`. Streaming is the
* primitive; this is sugar for callers that want per-event callbacks
* instead of iterating a generator.
*/
async function run(backend, config, observe = []) {
	const observers = Array.isArray(observe) ? observe : [observe];
	const gen = stream(backend, config);
	try {
		let next = await gen.next();
		while (!next.done) {
			dispatch(next.value, observers);
			next = await gen.next();
		}
		return next.value;
	} finally {
		try {
			await gen.return(void 0);
		} catch {}
	}
}
/**
* Low-level primitive: drive the engine generator to completion,
* yielding events and returning the final `EngineResult`. Owns the
* try/finally that returns the engine generator even if the consumer
* aborts mid-iteration
*/
async function* stream(backend, config) {
	const gen = engine(backend, config);
	try {
		let next = await gen.next();
		while (!next.done) {
			yield next.value;
			next = await gen.next();
		}
		return next.value;
	} finally {
		try {
			await gen.return(void 0);
		} catch {}
	}
}
//#endregion
//#region packages/ronde/src/managed.ts
/**
* Create a fresh runtime pair.
*
* Default (no options): returns a managed fs runtime under ronde's
* managed layout policy. This is the batteries-included path —
* durable by default.
*/
async function createRuntime(opts = {}) {
	return createManagedRuntime(opts);
}
async function createManagedRuntime(opts = {}) {
	const projectDir = resolveManagedProjectDir(opts);
	if (opts.name !== void 0) {
		const entryName = toManagedEntryName(opts.name);
		return createFsRuntime(path.join(projectDir, entryName));
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const entryName = newRuntimeId();
		try {
			return await createFsRuntime(path.join(projectDir, entryName));
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
		}
	}
	throw new Error("Failed to allocate a fresh managed runtime directory.");
}
async function openRuntime(nameOrOpts = {}, maybeOpts = {}) {
	const opts = typeof nameOrOpts === "string" ? {
		...maybeOpts,
		name: nameOrOpts
	} : nameOrOpts;
	const projectDir = resolveManagedProjectDir(opts);
	return openFsRuntime(opts.name !== void 0 ? path.join(projectDir, toManagedEntryName(opts.name)) : await latestManagedRuntimeDir(projectDir));
}
function expandTilde(p) {
	if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
	return p;
}
function rondeHome(root) {
	if (root) return expandTilde(root);
	const env = process.env["RONDE_HOME"];
	if (env) return expandTilde(env);
	const home = os.homedir();
	try {
		syncFs.accessSync(home, syncFs.constants.W_OK);
		return path.join(home, ".ronde");
	} catch {
		return path.join(os.tmpdir(), ".ronde");
	}
}
function slugifyProjectKey(project) {
	return project.replace(/[\\/:*?"<>| \x00-\x1f]/g, "-");
}
function managedProjectDir(root, project) {
	return path.join(rondeHome(root), "projects", slugifyProjectKey(project));
}
function newRuntimeId() {
	return `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}
function sanitizeManagedName(name, max = 200) {
	let safe = "";
	for (const char of name) {
		const code = char.charCodeAt(0);
		if (char === "\\" || char === "/" || char === ":" || char === "*" || char === "?" || char === "\"" || char === "<" || char === ">" || char === "|" || char === " " || code >= 0 && code <= 31) {
			safe += "_";
			continue;
		}
		safe += char;
	}
	safe = safe.replace(/^_+|_+$/g, "");
	return safe.slice(0, max);
}
async function readManagedState(dir) {
	return {
		dir,
		stat: await statFsRuntime(dir)
	};
}
async function latestManagedRuntimeDir(projectDir) {
	let entries;
	try {
		entries = await fs.readdir(projectDir, { withFileTypes: true });
	} catch {
		throw new Error(`No runtimes found in ${projectDir}.`);
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(projectDir, entry.name);
		try {
			candidates.push(await readManagedState(dir));
		} catch {}
	}
	candidates.sort(compareManagedRuntimeMetaDesc);
	if (candidates.length === 0) throw new Error(`No runtimes found in ${projectDir}.`);
	return candidates[0].dir;
}
function compareManagedRuntimeMetaDesc(a, b) {
	const byMtime = b.stat.mtime - a.stat.mtime;
	if (byMtime !== 0) return byMtime;
	const byCreated = compareIsoDesc(a.stat.createdAt, b.stat.createdAt);
	if (byCreated !== 0) return byCreated;
	return b.stat.id.localeCompare(a.stat.id);
}
function compareIsoDesc(a, b) {
	return b.localeCompare(a);
}
function resolveManagedProjectDir(opts) {
	const project = opts.project ?? process.cwd();
	if (!project) throw new Error("Managed runtime \"project\" must not be empty.");
	return managedProjectDir(opts.root, project);
}
function toManagedEntryName(name) {
	const entry = sanitizeManagedName(name, 240);
	if (!entry || entry === "." || entry === "..") throw new Error(`Invalid managed runtime name: "${name}"`);
	return entry;
}
function isAlreadyExistsError(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
//#endregion
//#region packages/ronde/src/runtime.ts
async function prepare(config) {
	if (config.resume && config.messages) throw new Error("Pass either \"resume\" or \"messages\", not both. Use replay() to inspect durable history separately.");
	if (config.resume && (config.journal || config.workspace)) throw new Error("Pass either \"resume\" or explicit \"journal\" + \"workspace\", not both.");
	if (config.messages && (config.journal || config.workspace)) throw new Error("Pass either caller-owned \"messages\" or explicit \"journal\" + \"workspace\", not both. Use hydrate() to seed a provided runtime pair.");
	if (config.resume) {
		const resumed = await openRuntime(config.resume);
		return {
			journal: resumed.journal,
			workspace: resumed.workspace
		};
	}
	const { journal, workspace } = await ensure({
		journal: config.journal,
		workspace: config.workspace
	});
	if (config.messages && config.messages.length > 0) await seed(journal, config.messages);
	return {
		journal,
		workspace
	};
}
async function ensure(opts) {
	if (isRuntime(opts)) return {
		journal: opts.journal,
		workspace: opts.workspace
	};
	const journal = "journal" in opts ? opts.journal : void 0;
	const workspace = "workspace" in opts ? opts.workspace : void 0;
	if (journal && workspace) return {
		journal,
		workspace
	};
	if (journal || workspace) throw new Error("Pass both \"journal\" and \"workspace\", or neither and let ronde create the default pair.");
	return createRuntime(isManagedRuntimeOptions(opts) ? opts : {});
}
async function seed(journal, messages) {
	for (const message of messages) await journal.event(JournalEvent.message(message));
	if (messages.length > 0) await journal.commit();
}
function isRuntime(value) {
	return typeof value === "object" && value !== null && "journal" in value && "workspace" in value && value.journal !== void 0 && value.workspace !== void 0;
}
function isManagedRuntimeOptions(value) {
	return !("journal" in value) && !("workspace" in value);
}
//#endregion
//#region packages/ronde/src/api.ts
/**
* @module
* High-level public API: `agentic()` and `generate()`.
*
* @example
* ```ts
* import { generate, agentic, coreTools } from "ronde"
*
* const { output } = await generate({
*   model: "anthropic/claude-haiku-4-5",
*   prompt: "Explain monads in one sentence.",
* })
*
* const { output, steps } = await agentic({
*   model: "anthropic/claude-sonnet-4-6",
*   prompt: "Fix the failing tests.",
*   tools: coreTools({ roots: [process.cwd()] }),
* })
* ```
*/
async function generate(backendOrConfig, maybeConfig) {
	if (maybeConfig !== void 0) return agentic(backendOrConfig, maybeConfig);
	return agentic(backendOrConfig);
}
async function agentic(backendOrConfig, maybeConfig) {
	let backend;
	let config;
	if (maybeConfig !== void 0) {
		backend = backendOrConfig;
		config = maybeConfig;
	} else {
		config = backendOrConfig;
		if (!config.model) throw new Error("Either pass a backend as the first argument, or provide \"model\" in config.");
		backend = buildBackend(config.model);
	}
	let system = config.system;
	if (config.output) {
		const instruction = buildSchemaInstruction(config.output);
		system = system ? system + instruction : instruction;
	}
	const prepared = await prepare(config);
	const result = await run(backend, {
		system,
		prompt: config.prompt,
		toolkit: config.tools ?? emptyToolkit,
		maxTurns: config.maxTurns ?? 0,
		signal: config.signal,
		hooks: config.hooks,
		compaction: resolveCompaction(config.compaction),
		truncation: config.truncation,
		journal: prepared.journal,
		workspace: prepared.workspace
	}, config.observers);
	const lastText = result.steps.at(-1)?.text;
	if (config.output) {
		const first = tryParseSchema(lastText, config.output);
		if (first.ok) return buildResult(first.data, result);
		const retryResult = await run(backend, {
			system,
			prompt: repairPrompt(first.error),
			toolkit: config.tools ?? emptyToolkit,
			maxTurns: 1,
			signal: config.signal,
			hooks: config.hooks,
			compaction: resolveCompaction(config.compaction),
			truncation: config.truncation,
			journal: prepared.journal,
			workspace: prepared.workspace
		}, config.observers);
		const merged = mergeRuns(result, retryResult);
		const retryText = retryResult.steps.at(-1)?.text;
		const second = tryParseSchema(retryText, config.output);
		return buildResult(second.ok ? second.data : void 0, merged);
	}
	return buildResult(lastText, result);
}
async function* agenticStream(backendOrConfig, maybeConfig) {
	let backend;
	let config;
	if (maybeConfig !== void 0) {
		backend = backendOrConfig;
		config = maybeConfig;
	} else {
		config = backendOrConfig;
		if (!config.model) throw new Error("Either pass a backend as the first argument, or provide \"model\" in config.");
		backend = buildBackend(config.model);
	}
	if ("observers" in config && config.observers !== void 0) throw new Error("agenticStream() does not accept \"observers\". Consume emitted EngineEvent values directly.");
	let system = config.system;
	if (config.output) {
		const instruction = buildSchemaInstruction(config.output);
		system = system ? system + instruction : instruction;
	}
	const prepared = await prepare(config);
	const toolkit = config.tools ?? emptyToolkit;
	const result = yield* stream(backend, {
		system,
		prompt: config.prompt,
		toolkit,
		maxTurns: config.maxTurns ?? 0,
		signal: config.signal,
		hooks: config.hooks,
		compaction: resolveCompaction(config.compaction),
		truncation: config.truncation,
		journal: prepared.journal,
		workspace: prepared.workspace
	});
	const lastText = result.steps.at(-1)?.text;
	if (config.output) {
		const first = tryParseSchema(lastText, config.output);
		if (first.ok) return buildResult(first.data, result);
		const retryResult = yield* stream(backend, {
			system,
			prompt: repairPrompt(first.error),
			toolkit,
			maxTurns: 1,
			signal: config.signal,
			hooks: config.hooks,
			compaction: resolveCompaction(config.compaction),
			truncation: config.truncation,
			journal: prepared.journal,
			workspace: prepared.workspace
		});
		const merged = mergeRuns(result, retryResult);
		const retryText = retryResult.steps.at(-1)?.text;
		const second = tryParseSchema(retryText, config.output);
		return buildResult(second.ok ? second.data : void 0, merged);
	}
	return buildResult(lastText, result);
}
async function resume(nameOrOpts = {}, maybeOpts = {}) {
	return typeof nameOrOpts === "string" ? openRuntime(nameOrOpts, maybeOpts) : openRuntime(nameOrOpts);
}
async function replay(journalOrNameOrOpts = {}, maybeOpts = {}) {
	const runtimeJournal = journalOrNameOrOpts instanceof Journal ? journalOrNameOrOpts : typeof journalOrNameOrOpts === "string" ? (await openRuntime(journalOrNameOrOpts, maybeOpts)).journal : (await openRuntime(journalOrNameOrOpts)).journal;
	const messages = [];
	await runtimeJournal.scan((ev) => {
		if (ev.type === "message") messages.push(ev.message);
	});
	return messages;
}
/**
* Create a fresh runtime pair pre-populated with the given messages.
* The messages are written to the journal as `message` events, so
* subsequent `replay()` calls reconstruct them. Returns the same
* `{ journal, workspace }` shape as `resume()`.
*
* Use when starting a new conversation from a hand-crafted history
* (e.g. from another store) and you want the journal to reflect it.
*
* ```ts
* const { journal, workspace } = await hydrate(priorMessages)
* await agentic({ model, journal, workspace, prompt: "continue" })
* ```
*/
async function hydrate(messages, opts = {}) {
	const { journal, workspace } = await ensure(opts);
	await seed(journal, messages);
	return {
		journal,
		workspace
	};
}
function parseModelString(model) {
	const slash = model.indexOf("/");
	if (slash === -1) throw new Error(`Invalid model format: "${model}". Expected "provider/model" (e.g. "anthropic/claude-haiku-4-5").`);
	const prefix = model.slice(0, slash);
	const modelName = model.slice(slash + 1);
	for (const desc of allProviders()) if ((desc.modelPrefix ?? desc.name) === prefix) return {
		provider: desc.name,
		model: modelName
	};
	const known = [...allProviders()].map((d) => d.modelPrefix ?? d.name);
	throw new Error(`Unknown provider "${prefix}". Known providers: ${known.join(", ")}.`);
}
function buildBackend(modelStr) {
	const { provider, model } = parseModelString(modelStr);
	return withRetry(createBackend({
		provider,
		model
	}));
}
function buildSchemaInstruction(schema) {
	const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" });
	return "\n\n# Final output schema\n\nOnly your final response is parsed as structured output; intermediate turns are free-form. When the work is complete, your final response must be valid JSON matching the schema below — no prose, no markdown, no code fences, just the raw JSON.\n\n" + JSON.stringify(jsonSchema, null, 2);
}
function repairPrompt(error) {
	return `Your previous response did not match the required JSON schema. Error: ${error}\n\nPlease respond with valid JSON matching the schema.`;
}
function tryParseSchema(text, schema) {
	if (!text) return err("No text output to parse");
	let json = text.trim();
	if (json.startsWith("```")) json = json.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
	try {
		const parsed = JSON.parse(json);
		const result = schema.safeParse(parsed);
		if (result.success) return ok(result.data);
		return err(result.error.message);
	} catch (e) {
		return err(`Invalid JSON: ${e.message}`);
	}
}
function buildResult(output, raw) {
	return {
		output,
		steps: raw.steps,
		history: raw.history,
		settleReason: raw.settleReason,
		usage: {
			input: raw.totalInputTokens,
			output: raw.totalOutputTokens,
			cached: raw.totalCachedTokens
		}
	};
}
function mergeRuns(first, retry) {
	return {
		...first,
		steps: [...first.steps, ...retry.steps],
		history: retry.history,
		settleReason: retry.settleReason,
		totalInputTokens: first.totalInputTokens + retry.totalInputTokens,
		totalOutputTokens: first.totalOutputTokens + retry.totalOutputTokens,
		totalCachedTokens: first.totalCachedTokens + retry.totalCachedTokens
	};
}
const emptyToolkit = {
	execute: async (name) => err(`Tool "${name}" not found`),
	schemas: [],
	formatters: {}
};
function resolveCompaction(value) {
	if (value !== false) return value ?? new DefaultCompactionStrategy();
}
//#endregion
export { BlockKind, CompletionError, CompletionErrorKind, DEFAULT_MAX_CONTEXT, DEFAULT_MAX_INLINE, DEFAULT_MAX_OUTPUT, DefaultCompactionStrategy, EMPTY_USAGE, Effort, FsJournal, FsWorkspace, Journal, JournalEvent, MessageType, PathContext, RetryingBackend, Role, StopReason, Workspace, agentic, agenticStream, allProviders, asGenerator, assistantMessage, audio, bindToolkitRuntime, blocksToText, canonicalize, classifyError, coalesceByRole, contentPart, coreTools, createBackend, createFsRuntime, createManagedRuntime, createRuntime, defaultFormatter, diagnosticEvent, drain, editFile, emptyUsage, engine, err, estimateTokens, file, formatToolResult, genHex, genId, generate, getProvider, globFiles, grepFiles, hydrate, image, isAsyncGenerator, isOk, lifecycleEvent, listDirectory, merge, ok, openFsRuntime, openRuntime, partRole, progressEvent, readFile, ref, registerProvider, replay, resolveRuntimeResources, resume, ro, rw, sanitizeFilename, shell, statFsRuntime, text, textPart, thinkingPart, tool, toolCallPart, toolResultMessage, toolResultPart, userMessage, utf8ByteLength, withRetry, wrapSdkError, writeFile };

//# sourceMappingURL=index.mjs.map