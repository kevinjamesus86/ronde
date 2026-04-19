import { err, isOk, ok } from "./result.mjs";
import { a as CompletionMode, c as Effort, i as CompletionErrorKind, l as StopReason, n as wrapSdkError, o as DEFAULT_CONTEXT_WINDOW_TOKENS, r as CompletionError, s as DEFAULT_MAX_OUTPUT_TOKENS, t as classifyError, u as emptyUsage } from "./errors-bGHpI9DD.mjs";
import { asGenerator, drain, isAsyncGenerator } from "./stream.mjs";
import { Journal, JournalEvent } from "./journal.mjs";
import { bindToolkitRuntime, defaultFormatter, formatToolOutput, merge, tool } from "./toolkit.mjs";
import { a as globFiles, c as readFile, d as rw, f as genHex, i as grepFiles, l as PathContext, n as shell, o as editFile, p as genId, r as listDirectory, s as writeFile, t as coreTools, u as ro } from "./src-BLS9mEzy.mjs";
import { DirectoryWorkspace, Workspace, makePreview, sanitizeFilename } from "./workspace.mjs";
import { z } from "zod/v4";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tryAcquire } from "@ronde/lock";
//#region packages/backend/src/mode.ts
function normalizeCompletionMode(mode) {
	switch (mode) {
		case "agentic":
		case "structured":
		case "compaction": return mode;
		default: return "agentic";
	}
}
function modeWantsThoughtText(mode) {
	return mode === "agentic";
}
function modeWantsThoughtReplay(mode) {
	return mode !== "compaction";
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
* - `TextPart`        — explicit `role` field (user/assistant/system/developer)
* - `ThinkingPart`    — implicit: always assistant (only the model produces reasoning)
* - `ToolCallPart`    — implicit: always assistant (only the model invokes tools)
* - `ToolResultPart`  — implicit: always user (tool outputs flow back to the model)
*
* Use `partRole(part)` to get a part's effective role.
*/
let Role = /* @__PURE__ */ function(Role) {
	Role["User"] = "user";
	Role["Assistant"] = "assistant";
	Role["System"] = "system";
	Role["Developer"] = "developer";
	return Role;
}({});
let MessageType = /* @__PURE__ */ function(MessageType) {
	MessageType["Text"] = "text";
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
		case "text": return part.role;
		case "think": return "assistant";
		case "tool_call": return "assistant";
		case "tool_result": return "user";
	}
}
function userMessage(content, meta) {
	return { parts: [textPart("user", content, meta)] };
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
function textPart(role, content, meta) {
	return {
		type: "text",
		role,
		content,
		...meta === void 0 ? {} : { meta }
	};
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
		content: opts.content,
		...opts.meta === void 0 ? {} : { meta: opts.meta }
	};
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
		if (part.type === "tool_call") pooledUses.push(serialized);
		else if (part.type === "tool_result") pooledResults.push(serialized);
		else {
			flushTools();
			pushBucket(mapRole(partRole(part)), [serialized]);
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
//#region packages/core/src/tokens.ts
const _encoder = new TextEncoder();
const _buf = new Uint8Array(16384);
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
//#region packages/engine/src/tool-exec.ts
const MAX_TOOL_CONCURRENCY = 10;
/**
* Yields all tool_call events up front, then interleaves tool_delta and
* tool_result events in settle order. Returned parts are in call order.
*/
async function* executeToolCalls(pendingToolCalls, toolkit, step, turn, abortSignal, history, approvals, workspace, journal) {
	if (pendingToolCalls.length === 0) return {
		resultParts: [],
		estimatedTokens: 0
	};
	const toolCalls = pendingToolCalls.map((tc) => ({
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
	const outcomes = Array.from({ length: pendingToolCalls.length });
	async function* runTask(i) {
		const tc = pendingToolCalls[i];
		let output;
		if (siblingSignal.aborted) output = err("Aborted");
		else if (approvals.has(i) && !approvals.get(i)) output = err(`Tool call "${tc.name}" was rejected`);
		else {
			const call = toolCalls[i];
			const toolCtx = {
				turn,
				abort: siblingSignal,
				messages: history,
				workspace,
				call,
				spill: (content, opts) => workspace.spill(content, {
					...opts,
					name: `${call.name}-${call.toolUseId}`
				})
			};
			try {
				const gen = asGenerator(toolkit.execute(tc.name, tc.arguments, toolCtx));
				let next = await gen.next();
				while (!next.done) {
					yield next.value;
					next = await gen.next();
				}
				output = next.value;
			} catch (e) {
				siblingController.abort("sibling_error");
				output = err(e.message);
			}
		}
		const formatted = formatToolOutput(toolkit, tc.name, output);
		const resultPart = toolResultPart({
			toolCallId: tc.toolCallId,
			content: formatted,
			ok: output.ok
		});
		outcomes[i] = {
			output,
			formatted,
			resultPart
		};
		await journal.event(JournalEvent.message({ parts: [tc, resultPart] }));
		return {
			output,
			formatted,
			resultPart
		};
	}
	const armNext = (i, gen) => gen.next().then((iter) => ({
		i,
		iter
	}));
	const active = /* @__PURE__ */ new Map();
	let nextToLaunch = 0;
	const fillSlots = () => {
		while (nextToLaunch < pendingToolCalls.length && active.size < MAX_TOOL_CONCURRENCY) {
			const i = nextToLaunch++;
			const gen = runTask(i);
			active.set(i, {
				waiter: armNext(i, gen),
				gen
			});
		}
	};
	fillSlots();
	while (active.size > 0) {
		const waiters = [];
		for (const task of active.values()) waiters.push(task.waiter);
		const { i, iter } = await Promise.race(waiters);
		const task = active.get(i);
		if (iter.done) {
			active.delete(i);
			fillSlots();
			yield progressEvent("tool_result", {
				turn,
				call: toolCalls[i],
				result: {
					ok: iter.value.output.ok,
					content: iter.value.formatted
				}
			});
		} else {
			task.waiter = armNext(i, task.gen);
			yield progressEvent("tool_delta", {
				call: toolCalls[i],
				chunk: iter.value,
				turn
			});
		}
	}
	const resultParts = [];
	let estimatedTokens = 0;
	for (let i = 0; i < pendingToolCalls.length; i++) {
		const tc = pendingToolCalls[i];
		const outcome = outcomes[i];
		step.toolCalls.push({
			name: tc.name,
			args: tc.arguments,
			output: outcome.output
		});
		estimatedTokens += estimateTokens(tc.arguments) + estimateTokens(outcome.formatted);
		resultParts.push(outcome.resultPart);
	}
	return {
		resultParts,
		estimatedTokens
	};
}
//#endregion
//#region packages/engine/src/replay.ts
function extractToolCalls(messages) {
	const calls = [];
	for (const msg of messages) for (const part of msg.parts) if (part.type === "tool_call") calls.push(part);
	return calls;
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
		case "text": {
			const content = part.content.trim();
			if (!content) break;
			translated.push(replayTextMessage(part.role, `[${part.role} text]\n${content}`));
			break;
		}
		case "tool_call":
			translated.push(replayTextMessage("assistant", `[assistant tool call] ${part.name}\nid: ${part.toolCallId}\nargs: ${JSON.stringify(part.arguments || {})}`));
			break;
		case "tool_result": {
			const toolName = toolNamesById.get(part.toolCallId);
			translated.push(replayTextMessage("user", `${toolName ? `[user tool result] ${toolName}` : "[user tool result]"}\nid: ${part.toolCallId}\nstatus: ${part.ok ? "success" : "failure"}\ncontent:\n${part.content}`));
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
* Tool-call/tool-result pairs are journaled atomically from inside
* `executeToolCalls` — assistant messages here strip `ToolUse` parts
* before writing, so the durable record never contains an orphaned
* call without its result.
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
	const { system, prompt, maxTurns = 0, toolkit, signal, hooks, compaction } = config;
	const { model, effort, contextWindowTokens, maxOutputTokens } = backend.config;
	const { journal, workspace } = resolveRuntimeResources(config);
	const runtime = deriveRuntimeBudgets(contextWindowTokens, maxOutputTokens);
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
	let compactionFailures = 0;
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
	function append(message) {
		history.push(message);
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
		if (!compaction || compactionFailures >= 3) return {
			kind: "not_compacted",
			usage: emptyUsage()
		};
		compactionCount++;
		const result = await compaction.compact({
			backend,
			model,
			effort,
			system,
			history,
			maxOutputTokens: runtime.compactMaxOutputTokens,
			signal: abortSignal
		});
		if (result.kind === "compacted") {
			compactionFailures = 0;
			history.length = 0;
		} else compactionFailures++;
		applyUsage(result.usage);
		return result;
	}
	function canAttemptCompaction() {
		return Boolean(compaction) && compactionFailures < 3;
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
			if (mode.kind === "reactive") {
				await journal.partition("compaction", [JournalEvent.message(result.summary)]);
				await send(result.summary, false);
			} else {
				const replay = translateBufferedMessages(mode.buffered);
				const nextMessages = [result.summary, ...replay];
				await journal.partition("compaction", nextMessages.map((message) => JournalEvent.message(message)));
				await send(result.summary, false);
				await sendAll(replay, false);
			}
			return "continue";
		}
		if (compactionFailures >= 3) {
			yield await record(diagnosticEvent("error", {
				message: "Compaction failed. Stopping.",
				turn
			}));
			return "fatal";
		}
		return "continue";
	}
	async function send(msg, durable = true) {
		append(msg);
		if (durable) await journal.event(JournalEvent.message(msg));
	}
	async function sendAll(messages, durable = true) {
		for (const message of messages) await send(message, durable);
	}
	async function sendAssistantResponse(message) {
		append(message);
		const durableParts = message.parts.filter((p) => p.type !== "tool_call");
		if (durableParts.length > 0) await journal.event(JournalEvent.message({
			...message,
			parts: durableParts
		}));
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
						contextWindowTokens,
						maxOutputTokens
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
						mode: "agentic",
						effort: turnConfig.effort,
						maxOutputTokens: runtime.maxOutputTokens,
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
				yield* emitResponseProgress(response, turn, step);
				const pendingToolCalls = extractToolCalls(response.messages);
				if (pendingToolCalls.length === 0 && response.stopReason === "max_tokens") {
					await sendAll(response.messages);
					yield* finalizeStep();
					if (yield* handleCutoff()) break;
					continue;
				}
				consecutiveIncomplete = 0;
				for (const msg of response.messages) await sendAssistantResponse(msg);
				if (pendingToolCalls.length === 0) {
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
				if (hooks?.approve) for (let i = 0; i < pendingToolCalls.length; i++) {
					const tc = pendingToolCalls[i];
					const call = {
						toolUseId: tc.toolCallId,
						name: tc.name,
						arguments: tc.arguments
					};
					approvals.set(i, await hooks.approve(call));
				}
				const { resultParts, estimatedTokens } = yield* executeToolCalls(pendingToolCalls, toolkitRuntime, step, turn, abortSignal, history, approvals, workspace, journal);
				const toolResultMsg = { parts: resultParts };
				await send(toolResultMsg, false);
				let lastRawInputTokens = 0;
				for (const msg of turnConfig.messages) lastRawInputTokens += JSON.stringify(msg).length / 4;
				if (lastRawInputTokens + (response.usage?.outputTokens ?? 0) + estimatedTokens + runtime.compactSafetyMarginTokens >= runtime.contextWindowTokens) {
					yield* finalizeStep();
					if ((yield* attemptCompaction({
						kind: "preemptive",
						buffered: [toolResultMsg]
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
function deriveRuntimeBudgets(contextWindowTokens, maxOutputTokens) {
	return {
		contextWindowTokens,
		maxOutputTokens,
		compactMaxOutputTokens: clamp(Math.floor(maxOutputTokens / 4), 4e3, 16e3),
		compactSafetyMarginTokens: clamp(Math.floor(contextWindowTokens * .025), 4e3, 1e4)
	};
}
async function resolvePreStepOverrides(hooks, input, defaults) {
	if (!hooks?.preStep) return defaults;
	const result = await hooks.preStep(input);
	if (!result) return defaults;
	return {
		messages: result.messages ?? defaults.messages,
		toolSchemas: result.toolSchemas ?? defaults.toolSchemas,
		model: result.model ?? defaults.model,
		effort: result.effort !== void 0 ? result.effort : defaults.effort
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
	} else if (part.type === "text" && part.role === "assistant" && part.content.trim()) {
		step.text = step.text ? step.text + part.content : part.content;
		yield progressEvent("text", {
			turn,
			content: part.content
		});
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
		case "text": {
			const item = {
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{
					type: "output_text",
					text: part.content
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
			output: part.content
		};
	}
}
function serializeMessages$2(messages, options = {}) {
	const { replayReasoningItems = true } = options;
	const normalized = canonicalize(messages, isOpenAIMeta);
	const items = [];
	let pendingText;
	const flushText = () => {
		if (pendingText && pendingText.texts.length > 0) items.push({
			role: pendingText.role,
			content: pendingText.texts.map((text) => ({
				type: "input_text",
				text
			}))
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
		if (part.type === "text" && part.role !== "assistant") {
			flushTools();
			const wireRole = part.role === "system" || part.role === "developer" ? "developer" : "user";
			if (pendingText && pendingText.role === wireRole) pendingText.texts.push(part.content);
			else {
				flushText();
				pendingText = {
					role: wireRole,
					texts: [part.content]
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
		const mode = normalizeCompletionMode(request.mode);
		const payload = {
			model: request.model,
			instructions: request.system,
			input: serializeMessages$2(request.messages || [], this.serializeOptions()),
			tools: serializeTools$2(request.tools),
			max_output_tokens: request.maxOutputTokens
		};
		const effort = normalizeOpenAIEffort(request.effort);
		if (isNativeOpenAI(this.resolved)) {
			if (effort || modeWantsThoughtText(mode)) payload.reasoning = {};
			if (effort) payload.reasoning.effort = effort;
			if (modeWantsThoughtText(mode)) payload.reasoning.summary = "auto";
		}
		if (isNativeOpenAI(this.resolved) && modeWantsThoughtReplay(mode)) payload.include = ["reasoning.encrypted_content"];
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
	if (!signature) return;
	return {
		provider: "anthropic",
		signature
	};
}
function anthropicRole(role) {
	return role === "assistant" ? "assistant" : "user";
}
function serializePart$1(part, toolNamesById) {
	switch (part.type) {
		case "text": return {
			type: "text",
			text: part.content
		};
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
			content: part.content,
			is_error: !part.ok
		};
	}
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
function parseContentBlocks(blocks, mode, responseId) {
	const parts = [];
	for (const block of blocks) {
		if (block.type === "text") {
			const tb = block;
			if (tb.text?.trim()) parts.push(textPart("assistant", tb.text));
			continue;
		}
		if (block.type === "thinking") {
			if (!modeWantsThoughtReplay(mode) && !modeWantsThoughtText(mode)) continue;
			const tb = block;
			const content = modeWantsThoughtText(mode) ? tb.thinking || "" : "";
			const meta = anthropicMeta(tb.signature || void 0);
			if (!content && !meta) continue;
			parts.push(thinkingPart(content, meta));
			continue;
		}
		if (block.type === "tool_use") {
			const tb = block;
			if (tb.id && tb.name) parts.push(toolCallPart({
				toolCallId: tb.id,
				name: tb.name,
				arguments: tb.input || {}
			}));
		}
	}
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
function buildPayload(request, mode) {
	const payload = {
		model: request.model,
		max_tokens: request.maxOutputTokens,
		messages: serializeMessages$1(request.messages || [])
	};
	if (request.system?.trim()) payload.system = request.system;
	if (request.tools?.length) payload.tools = serializeTools$1(request.tools);
	const effort = normalizeAnthropicEffort(request.model, request.effort);
	if (effort && anthropicModelSupportsEffort(request.model)) payload.output_config = { effort };
	if (modeWantsThoughtReplay(mode) && anthropicModelSupportsAdaptiveThinking(request.model)) payload.thinking = { type: "adaptive" };
	return payload;
}
function buildResponse(data, mode) {
	const usage = data.usage;
	return {
		messages: parseContentBlocks(data.content, mode, data.id),
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
		const mode = normalizeCompletionMode(request.mode);
		const payload = buildPayload(request, mode);
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
		return buildResponse(data, mode);
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
		case "text": return part.meta ? {
			text: part.content,
			thoughtSignature: part.meta.thoughtSignature
		} : { text: part.content };
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
		case "tool_result": return { functionResponse: {
			id: part.toolCallId,
			name: resolveToolName(toolNamesById, part.toolCallId),
			response: !part.ok ? {
				toolCallId: part.toolCallId,
				error: part.content
			} : {
				toolCallId: part.toolCallId,
				content: part.content
			}
		} };
	}
}
function serializeMessages(messages) {
	const normalized = canonicalize(messages, isGeminiMeta);
	const toolNamesById = /* @__PURE__ */ new Map();
	return coalesceByRole(normalized, geminiRole, (part) => serializePart(part, toolNamesById));
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
function parseParts(geminiParts, mode, responseId) {
	const parts = [];
	let toolCallIndex = 0;
	let lastThoughtSignature;
	for (const gp of geminiParts || []) {
		if (gp.thoughtSignature) lastThoughtSignature = gp.thoughtSignature;
		if (gp.functionCall?.name) {
			toolCallIndex += 1;
			parts.push(toolCallPart({
				toolCallId: gp.functionCall.id || `gemini-call-${toolCallIndex}`,
				name: gp.functionCall.name,
				arguments: gp.functionCall.args || {},
				meta: modeWantsThoughtReplay(mode) && lastThoughtSignature ? geminiMeta(lastThoughtSignature) : void 0
			}));
			continue;
		}
		if (gp.text?.trim()) if (gp.thought === true) {
			if (!modeWantsThoughtReplay(mode) && !modeWantsThoughtText(mode)) continue;
			const content = modeWantsThoughtText(mode) ? gp.text : "";
			const meta = geminiMeta(gp.thoughtSignature || void 0);
			if (!content && !meta) continue;
			parts.push(thinkingPart(content, meta));
		} else parts.push(textPart("assistant", gp.text, modeWantsThoughtReplay(mode) && lastThoughtSignature ? geminiMeta(lastThoughtSignature) : void 0));
	}
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
		const mode = normalizeCompletionMode(request.mode);
		const config = { maxOutputTokens: request.maxOutputTokens };
		if (request.system?.trim()) config.systemInstruction = request.system;
		if (isGemini3Model(request.model)) config.thinkingConfig = {
			thinkingLevel: normalizeGemini3Effort(request.model, request.effort),
			...modeWantsThoughtReplay(mode) ? { includeThoughts: true } : {}
		};
		else if (isGemini25Model(request.model)) config.thinkingConfig = {
			thinkingBudget: normalizeGemini25Effort(request.effort),
			...modeWantsThoughtReplay(mode) ? { includeThoughts: true } : {}
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
		const messages = parseParts(accumulatedParts, mode, lastChunk?.responseId ?? void 0);
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
	const effort = config.effort ?? null;
	const contextWindowTokens = config.contextWindowTokens ?? 2e5;
	const maxOutputTokens = config.maxOutputTokens ?? 64e3;
	const internal = {
		nativeOpenAI: config.provider === "openai",
		apiKey: config.apiKey,
		baseURL: config.baseURL ?? desc.defaultURL
	};
	const inner = desc.create(internal);
	return {
		specVersion: "v1",
		complete: (req) => inner.complete(req),
		config: {
			model: config.model,
			effort,
			contextWindowTokens,
			maxOutputTokens
		}
	};
}
//#endregion
//#region packages/ronde/src/compaction.ts
const DEFAULT_SYSTEM_PROMPT = "You produce continuation context for an agent that will resume this work. Your output will replace the conversation history, so completeness matters more than brevity. Extract and preserve all specific values, paths, identifiers, and decisions. Never fabricate details that aren't in the conversation.";
const DEFAULT_USER_MESSAGE = "Construct a continuation context so another agent can pick up this work. Use this structure:\n\n## Goal\nWhat is the task? What constraints or requirements apply?\n\n## Progress\nWhat has been accomplished? What is still in progress? What remains?\n\n## Key decisions\nImportant choices made and their reasoning.\n\n## Discoveries\nNotable findings, errors encountered, values learned during the work.\n\n## Relevant files\nFiles read, created, or modified that pertain to the task.\n\n## Next steps\nWhat should the next agent do first?";
/**
* Default compaction: asks the model to produce a structured
* continuation context ("## Goal", "## Progress", etc.). Drops
* oldest history items one at a time if the compaction call hits
* the provider's context limit.
*/
var DefaultCompactionStrategy = class {
	compactionSystem;
	userMessage;
	resumeMessage;
	constructor(options = {}) {
		this.compactionSystem = options.compactionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		this.userMessage = options.compactionUserMessage ?? DEFAULT_USER_MESSAGE;
		this.resumeMessage = options.resumeMessage ?? "Resume the workflow from where you left off.";
	}
	async compact(ctx) {
		const { backend, model, effort, system, history } = ctx;
		const working = [...history];
		while (working.length > 0) {
			const compactInput = [
				userMessage("## Original system prompt (for context — preserve relevant state)\n\n" + system),
				...working,
				userMessage(this.userMessage)
			];
			let compactResponse;
			try {
				compactResponse = await drain(backend.complete({
					model,
					system: this.compactionSystem,
					messages: compactInput,
					tools: [],
					mode: "compaction",
					effort,
					maxOutputTokens: ctx.maxOutputTokens,
					signal: ctx.signal
				}));
			} catch (err) {
				if (err instanceof CompletionError && err.kind === "context_length_exceeded") {
					if (working.length <= 1) break;
					popHistoryItem(working);
					continue;
				}
				throw err;
			}
			let summary = "";
			for (const message of compactResponse.messages) for (const part of message.parts) if (part.type === "text" && part.role === "assistant" && part.content) summary += part.content;
			if (!summary.trim()) return {
				kind: "not_compacted",
				usage: compactResponse.usage
			};
			return {
				kind: "compacted",
				summary: userMessage("## Continuation context (compacted from prior conversation)\n\n" + summary + "\n\n---\n\n" + this.resumeMessage),
				usage: compactResponse.usage
			};
		}
		return {
			kind: "not_compacted",
			usage: emptyUsage()
		};
	}
};
function popHistoryItem(hist) {
	if (hist.length === 0) return 0;
	if (hist[hist.length - 1].parts.some((p) => p.type === "tool_result") && hist.length > 1) {
		hist.pop();
		hist.pop();
		return 2;
	}
	hist.pop();
	return 1;
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
var FsWorkspace = class extends DirectoryWorkspace {
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
		const name = `${sanitizeFilename(o.name ?? "") || `spill-${genHex()}`}.txt`;
		const full = path.join(this.dir, TOOL_RESULTS_DIR, name);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content, "utf-8");
		const head = o.previewHead ?? 2e3;
		const tail = o.previewTail ?? 1e3;
		return {
			path: full,
			uri: pathToFileURL(full).href,
			preview: makePreview(content, head, tail),
			truncated: content.length > head + tail,
			bytes: Buffer.byteLength(content, "utf-8")
		};
	}
};
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
//#region packages/ronde/src/managed-runtime.ts
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
//#region packages/ronde/src/default-runtime.ts
/**
* Create a fresh runtime pair.
*
* Default (no options): returns a managed fs runtime under ronde's
* managed layout policy. This is the batteries-included path:
* durable by default, with explicit `@ronde/mem` opt-in for callers
* who want ephemeral runtimes instead.
*/
async function createRuntime(opts = {}) {
	return createManagedRuntime(opts);
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
function resolveApiKey(provider) {
	const desc = getProvider(provider);
	if (!desc?.envVar) return "local";
	const key = process.env[desc.envVar];
	if (!key) throw new Error(`Missing ${desc.envVar} environment variable for provider "${provider}".`);
	return key;
}
function buildBackend(modelStr) {
	const { provider, model } = parseModelString(modelStr);
	return withRetry(createBackend({
		provider,
		model,
		apiKey: resolveApiKey(provider)
	}));
}
const emptyToolkit = {
	schemas: [],
	execute: async (name) => err(`Tool "${name}" not found`),
	formatters: {}
};
function resolveCompaction(value) {
	if (value === false) return;
	return value ?? new DefaultCompactionStrategy();
}
function buildSchemaInstruction(schema) {
	const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" });
	return "\n\nRespond with valid JSON matching this schema (no markdown, no code fences, just raw JSON):\n" + JSON.stringify(jsonSchema, null, 2);
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
/** Return the generator so its finally block runs even if the consumer aborts mid-iteration. */
async function finalizeEngine(gen) {
	await gen.return(void 0);
}
function notify(observers, fn) {
	for (const observer of observers) try {
		fn(observer);
	} catch {}
}
function dispatchEngineEvent(event, observers) {
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
			notify(observers, (o) => o.onToolResult?.(event.turn, event.call, event.result));
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
/**
* Drive the engine, projecting `EngineEvent` onto observer callbacks.
* Hooks live on the engine config — this wrapper only observes.
*/
async function run(backend, config, observerInput = []) {
	const observers = Array.isArray(observerInput) ? observerInput : [observerInput];
	const gen = engine(backend, config);
	try {
		let next = await gen.next();
		while (!next.done) {
			dispatchEngineEvent(next.value, observers);
			next = await gen.next();
		}
		return next.value;
	} finally {
		try {
			await finalizeEngine(gen);
		} catch {}
	}
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
	if (config.schema) {
		const instruction = buildSchemaInstruction(config.schema);
		system = system ? system + instruction : instruction;
	}
	const prepared = await prepareRunConfig(config);
	const result = await run(backend, {
		system,
		prompt: config.prompt,
		toolkit: config.tools ?? emptyToolkit,
		maxTurns: config.maxTurns ?? 0,
		signal: config.signal,
		hooks: config.hooks,
		compaction: resolveCompaction(config.compaction),
		journal: prepared.journal,
		workspace: prepared.workspace
	}, config.observers);
	const lastText = result.steps.at(-1)?.text;
	if (config.schema) {
		const first = tryParseSchema(lastText, config.schema);
		if (first.ok) return buildResult(first.data, result);
		const retryResult = await run(backend, {
			system,
			prompt: `Your previous response did not match the required JSON schema. Error: ${first.error}\n\nPlease respond again with valid JSON matching the schema.`,
			toolkit: config.tools ?? emptyToolkit,
			maxTurns: 1,
			signal: config.signal,
			hooks: config.hooks,
			compaction: resolveCompaction(config.compaction),
			journal: prepared.journal,
			workspace: prepared.workspace
		}, config.observers);
		const retryText = retryResult.steps.at(-1)?.text;
		const second = tryParseSchema(retryText, config.schema);
		if (second.ok) return buildResult(second.data, {
			...result,
			steps: [...result.steps, ...retryResult.steps],
			history: retryResult.history,
			settleReason: retryResult.settleReason,
			totalInputTokens: result.totalInputTokens + retryResult.totalInputTokens,
			totalOutputTokens: result.totalOutputTokens + retryResult.totalOutputTokens,
			totalCachedTokens: result.totalCachedTokens + retryResult.totalCachedTokens
		});
		return buildResult(void 0, result);
	}
	return buildResult(lastText, result);
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
async function generate(backendOrConfig, maybeConfig) {
	if (maybeConfig !== void 0) return agentic(backendOrConfig, {
		...maybeConfig,
		maxTurns: maybeConfig.maxTurns ?? 1,
		compaction: maybeConfig.compaction ?? false
	});
	const config = backendOrConfig;
	return agentic({
		...config,
		maxTurns: config.maxTurns ?? 1,
		compaction: config.compaction ?? false
	});
}
/**
* Streaming agentic loop. Yields observation events as they happen.
* Hooks handle decisions internally. Use `for await` to consume.
* `observers` are not accepted here — stream consumers already
* receive the raw `EngineEvent` values directly.
*
* ```
* for await (const event of agenticStream(backend, config)) {
*   if (event.type === "text") process.stdout.write(event.content)
*   if (event.type === "tool_call") console.log(event.call.name)
* }
* ```
*/
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
	if (config.schema) {
		const instruction = buildSchemaInstruction(config.schema);
		system = system ? system + instruction : instruction;
	}
	const prepared = await prepareRunConfig(config);
	const toolkit = config.tools ?? emptyToolkit;
	const gen = engine(backend, {
		system,
		prompt: config.prompt,
		toolkit,
		maxTurns: config.maxTurns ?? 0,
		signal: config.signal,
		hooks: config.hooks,
		compaction: resolveCompaction(config.compaction),
		journal: prepared.journal,
		workspace: prepared.workspace
	});
	try {
		let next = await gen.next();
		while (!next.done) {
			yield next.value;
			next = await gen.next();
		}
		const result = next.value;
		return {
			output: result.steps.at(-1)?.text,
			steps: result.steps,
			history: result.history,
			settleReason: result.settleReason,
			usage: {
				input: result.totalInputTokens,
				output: result.totalOutputTokens,
				cached: result.totalCachedTokens
			}
		};
	} finally {
		try {
			await finalizeEngine(gen);
		} catch {}
	}
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
	const { journal, workspace } = await ensureRuntime(opts);
	await seedJournal(journal, messages);
	return {
		journal,
		workspace
	};
}
async function prepareRunConfig(config) {
	if (config.resume && config.messages) throw new Error("Pass either \"resume\" or \"messages\", not both. Use replay() to inspect durable history separately.");
	if (config.resume && (config.journal || config.workspace)) throw new Error("Pass either \"resume\" or explicit \"journal\" + \"workspace\", not both.");
	if (config.messages && (config.journal || config.workspace)) throw new Error("Pass either caller-owned \"messages\" or explicit \"journal\" + \"workspace\", not both. Use hydrate() to seed a provided runtime pair.");
	if (config.resume) {
		const resumed = await resume(config.resume);
		return {
			journal: resumed.journal,
			workspace: resumed.workspace
		};
	}
	const { journal, workspace } = await ensureRuntime({
		journal: config.journal,
		workspace: config.workspace
	});
	if (config.messages && config.messages.length > 0) await seedJournal(journal, config.messages);
	return {
		journal,
		workspace
	};
}
async function ensureRuntime(opts) {
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
function isRuntime(value) {
	return typeof value === "object" && value !== null && "journal" in value && "workspace" in value && value.journal !== void 0 && value.workspace !== void 0;
}
function isManagedRuntimeOptions(value) {
	return !("journal" in value) && !("workspace" in value);
}
async function seedJournal(journal, messages) {
	for (const message of messages) await journal.event(JournalEvent.message(message));
	if (messages.length > 0) await journal.commit();
}
//#endregion
//#region packages/mem/src/journal.ts
var MemoryJournal = class extends Journal {
	kind = "memory";
	generations = [{
		reason: null,
		events: []
	}];
	activeGeneration = 0;
	constructor(id = genId("rt")) {
		super();
		this.id = id;
	}
	async event(event) {
		this.generations[this.activeGeneration].events.push(event);
	}
	async partition(reason, nextEvents = []) {
		this.generations.push({
			reason,
			events: [...nextEvents]
		});
		this.activeGeneration = this.generations.length - 1;
	}
	async scan(onEvent) {
		for (const event of this.generations[this.activeGeneration].events) if (await onEvent(event)) return;
	}
};
//#endregion
//#region packages/mem/src/workspace.ts
var MemoryWorkspace = class extends Workspace {
	kind = "memory";
	resources = /* @__PURE__ */ new Map();
	constructor(id = genId("rt")) {
		super();
		this.id = id;
	}
	async spill(content, o = {}) {
		const base = sanitizeFilename(o.name ?? "") || `spill-${genHex()}`;
		const uri = `memory://workspace/${this.id}/${base}.txt`;
		this.resources.set(uri, content);
		const head = o.previewHead ?? 2e3;
		const tail = o.previewTail ?? 1e3;
		return {
			uri,
			preview: makePreview(content, head, tail),
			truncated: content.length > head + tail,
			bytes: new TextEncoder().encode(content).length
		};
	}
	read(uri) {
		return this.resources.get(uri);
	}
};
//#endregion
//#region packages/mem/src/runtime.ts
function createMemRuntime() {
	const id = genId("rt");
	return {
		journal: new MemoryJournal(id),
		workspace: new MemoryWorkspace(id)
	};
}
//#endregion
export { CompletionError, CompletionErrorKind, CompletionMode, DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, DefaultCompactionStrategy, Effort, FsWorkspace, Journal, JournalEvent, MemoryJournal, MemoryWorkspace, MessageType, PathContext, RetryingBackend, Role, StopReason, Workspace, agentic, agenticStream, allProviders, asGenerator, assistantMessage, bindToolkitRuntime, classifyError, coreTools, createBackend, createFsRuntime, createMemRuntime, createRuntime, defaultFormatter, diagnosticEvent, drain, editFile, engine, err, formatToolOutput, generate, getProvider, globFiles, grepFiles, hydrate, isAsyncGenerator, isOk, lifecycleEvent, listDirectory, merge, ok, openFsRuntime, openRuntime, progressEvent, readFile, registerProvider, replay, resume, ro, rw, shell, textPart, thinkingPart, tool, toolCallPart, toolResultMessage, toolResultPart, userMessage, withRetry, wrapSdkError, writeFile };

//# sourceMappingURL=index.mjs.map