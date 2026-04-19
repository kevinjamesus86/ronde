//#region packages/core/src/completion.ts
/** Completion mode — controls thinking behavior. */
let CompletionMode = /* @__PURE__ */ function(CompletionMode) {
	CompletionMode["Agentic"] = "agentic";
	CompletionMode["Structured"] = "structured";
	/** Compaction mode — no thinking replay. */
	CompletionMode["Compaction"] = "compaction";
	return CompletionMode;
}({});
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
const DEFAULT_CONTEXT_WINDOW_TOKENS = 2e5;
const DEFAULT_MAX_OUTPUT_TOKENS = 64e3;
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
		this.statusCode = opts?.statusCode ?? null;
		this.retryable = TRANSIENT_ERROR_KINDS.has(kind);
	}
};
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
	if (statusCode !== null && statusCode >= 500 && statusCode < 600) return "server_error";
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
	const statusCode = (typeof raw.status === "number" ? raw.status : null) ?? (typeof raw.statusCode === "number" ? raw.statusCode : null) ?? (typeof raw.code === "number" ? raw.code : null);
	return new CompletionError(classifyError(statusCode, `${message} ${typeof raw.code === "string" ? raw.code : ""}`.trim()), message, {
		statusCode: statusCode ?? void 0,
		cause: err
	});
}
//#endregion
export { CompletionMode as a, Effort as c, CompletionErrorKind as i, StopReason as l, wrapSdkError as n, DEFAULT_CONTEXT_WINDOW_TOKENS as o, CompletionError as r, DEFAULT_MAX_OUTPUT_TOKENS as s, classifyError as t, emptyUsage as u };

//# sourceMappingURL=errors-bGHpI9DD.mjs.map