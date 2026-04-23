# Changelog

## v0.7.0

[Compare v0.6.0…v0.7.0](https://github.com/kevinjamesus86/ronde/compare/v0.6.0...v0.7.0)

Pure tool-exec + per-pair budget. Eager journaling of tool pairs was unsound under preemptive compaction — pairs got durably committed to the pre-partition generation before the engine could decide whether they belonged there. Execution is now pure compute; the engine owns persistence and sizes each pair against the context budget, committing what fits and buffering the rest for compaction replay.

### Breaking changes

- **`ToolOutput<D>` → `ToolResult<D>`** and **`formatToolOutput` → `formatToolResult`** in `@ronde/core/toolkit`. Reads as `tool.execute() → ToolResult`. ([`f9d2e3c`](f9d2e3c))
- **Old `ToolResult { ok, content }` in `@ronde/core/tool` removed.** The `tool_result` event and `onToolResult` observer callback now carry `content: string` and `result: ToolResult` side by side instead of via a dedicated wrapper type. ([`f9d2e3c`](f9d2e3c))
- **`AgentStepToolCall`** replaces `output: ToolOutput` with `content: string` + `result: ToolResult`. Trajectory export now has both what the model saw and the raw exec return. ([`f9d2e3c`](f9d2e3c))
- **`onToolResult(turn, call, content, result)`** — observer callback adds a `content` parameter. ([`f9d2e3c`](f9d2e3c))

### Fixes

- **Tool-call args no longer double-counted** in the preemptive-compaction trigger. Args were already in `response.outputTokens`; the engine was adding them a second time via `estimateTokens(args)`. Pair-level estimate now counts only the result content.
- **Every `tool_use` yields exactly one `tool_result`** under external abort, formatter failure, and unlaunched-tool cancellation. Pinned by a new invariant test that also asserts the raw `ToolResult` structure never reaches the journal.

## v0.6.0

[Compare v0.5.0…v0.6.0](https://github.com/kevinjamesus86/ronde/compare/v0.5.0...v0.6.0)

Two threads: structured-output parity across `generate` / `agentic` / `agenticStream`, and a tightening pass on public surfaces (mem private state, fs meta-ledger internalized, providers browser-safe, generate simplified to a naming alias).

### Breaking changes

- **`config.schema` renamed to `config.output`.** Reads cleanly into `result.output` — one vocabulary across the config and the result. Typed overloads on `generate` / `agentic` / `agenticStream` now key on `{ output: S }` to infer `z.infer<S>`. ([`25a3767`](25a3767))

- **`generate()` is a naming alias over `agentic()`.** No capped turn count, no forced compaction default. Passing tools + output now iterates normally and returns the parsed value. Callers relying on implicit `maxTurns: 1` must pass it explicitly. ([`3c80e24`](3c80e24))

- **`MemoryJournal.generations` and `MemoryWorkspace.resources` are private.** External reads must go through `scan()` and `read()`. `MemoryJournal` no longer uses `null` for the initial generation's reason — the field is `string | undefined`. ([`c809b17`](c809b17))

- **`CompletionError.statusCode` is `number | undefined`** (was `number | null`). `classifyError(statusCode, message)` param type updated to match; `wrapSdkError` no longer coerces `null → undefined` at the construction boundary. ([`848e018`](848e018))

- **`FsJournalMetaRecord` removed from `@ronde/fs` public exports.** Meta-ledger record shape is implementation detail; reach fs journal state through `statFsRuntime(...)`. ([`d3fad96`](d3fad96))

- **`ronde/*` dropped from shared tsconfig paths.** The published `ronde` package exports only `.`; the path mapping used to let `import "ronde/api"` typecheck and then fail at install. ([`da23e11`](da23e11))

### Structured output across the public API

`agenticStream()` used to accept `schema` in its config but only inject the instruction into the system prompt — the generator returned raw text with no parse and no repair. All three entry points now honor `output` the same way:

- `generate({ output })` / `agentic({ output })` — single pass with parse + one repair attempt on failure, result is the parsed value or `undefined`.
- `agenticStream({ output })` — same flow, events flow through the same stream (two `run_end` events when a retry happens), generator's return carries the parsed value.
- A typed overload on each API infers `AgenticResult<z.infer<S>>` when the caller passes `output: S`.

Related correctness fix: `agentic()`'s failed-repair path dropped the retry turn's steps, history, and usage from the returned result. Merged result now reflects reality even when both parses fail. ([`e1ca97c`](e1ca97c), [`6214e3d`](6214e3d))

System prompt for structured runs updated: the agent is told to do the work (think, call tools, iterate) and only commit the final response as raw JSON. Tools + `output` iterate coherently as a result.

### Tighter public surfaces

- **`@ronde/mem`** — `#generations` and `#resources` are genuinely private (hash-private fields, matching `@ronde/fs`). Callers can't bypass `event()` / `partition()` / `scan()` on the journal or `spill()` / `read()` on the workspace. Tests rewritten to assert behavior through the public API instead of implementation state. ([`c809b17`](c809b17))
- **`@ronde/fs`** — `FsJournalMetaRecord` is no longer exported; `meta.jsonl`'s record shape is internal. ([`d3fad96`](d3fad96))
- **`@ronde/providers`** — factory's env-var fallback guards `typeof process !== "undefined"`, so runtimes without a Node-style `process` global get the normal "Missing X env var" error instead of a `TypeError`. CLAUDE.md platform matrix clarifies non-Node runtimes must pass `apiKey` explicitly. ([`227987f`](227987f))
- **`ronde`** — shared tsconfig no longer advertises `ronde/*` subpaths that the runtime export map doesn't back. ([`da23e11`](da23e11))

### Internal

- `packages/ronde/src/` split: engine drivers (`stream`, `run`) to `engine.ts`, runtime lifecycle (`prepare`, `ensure`, `seed`) to `runtime.ts`, observer dispatch (`dispatch` + `notify`) to `observer.ts` alongside `RunObserver`, managed-fs policy collapsed into `managed.ts`. `api.ts` now holds types, public API, and immediate validation only (898 → 608 lines).
- Concise naming via file context: `streamEngine` → `stream`, `dispatchEngineEvent` → `dispatch`, `prepareRunConfig` → `runtime.prepare` via namespace import.
- `generate()` is a pure forwarder over `agentic()` — no config massaging. Overload surface preserved for typed-output inference. ([`3c80e24`](3c80e24))
- `openRuntime()` gains a union-accepting overload so `string | ManagedRuntimeOptions` dispatches without a ternary at the call site.

### Housekeeping

- CLAUDE.md gains four principles distilled from the work: _primitives are the most general form_ (strengthens _one engine, many consumers_), _types are a testable surface_, _file context carries the prefix_, and _prove before you fix_.
- `@ronde/providers` factory test suite covers the browser-like path (simulated `process === undefined`) for both explicit-apiKey and env-fallback branches.
- Type-level assertions (`void (x satisfies T)`) pin overload inference across the three public APIs so the typed-output contract fails at typecheck on regression.

## v0.5.0

[Compare v0.4.0…v0.5.0](https://github.com/kevinjamesus86/ronde/compare/v0.4.0...v0.5.0)

Big release. Three headline threads: a rewrite of how tool output is sized and spilled, a ground-up pass on compaction correctness, and a provider registry that makes adding a new provider a single-file change.

### Breaking changes

- **`ProviderKind` enum removed.** Providers self-register via a `ProviderDescriptor` (`name`, `defaultURL`, `envVar`, `modelPrefix`, `create`). Core treats providers as opaque strings; adding a provider is one file, zero core changes. New exports: `registerProvider`, `getProvider`, `ProviderDescriptor`. `ProviderMeta` becomes `unknown` on `CompletionResponse`. ([`00b2831`](00b2831))

- **`CompletionMode` removed.** Providers derive their conditionals directly. `InternalBackendConfig.providerKind` replaced with `nativeOpenAI: boolean`. ([`00b2831`](00b2831))

- **Per-tool `truncated` flags removed** from `ReadFileData`, `GlobData`, `ListDirectoryData`. The framework owns truncation now via `formatToolOutput`; tools emit domain data and a `TruncateStrategy` declaration. `read_file` no longer prefixes lines with `${n}→` — the LLM knows what it asked for. ([`f4fd966`](f4fd966))

- **`CompactionResult.deferred: Message[]` now required.** Strategies that shrink their working set during a retry must return the popped messages so the engine can replay them verbatim. ([`eae1899`](eae1899))

- **`extractToolCalls` replaced by `splitResponse`.** Partitions a completion into `{ messages, pendingCalls }` — text/think commit immediately; `tool_use` parts wait for their results and then commit as a single atomic `{ parts: [tool_use, tool_result] }` message per call. ([`eae1899`](eae1899))

- **`BackendConfig.provider: string`** (was the `ProviderKind` enum). `apiKey` optional with env-var fallback. ([`0d0f11e`](0d0f11e))

- **Default context window 200K → 400K, default output 64K → 32K.** ([`1b36ffe`](1b36ffe))

### Framework-owned tool output truncation

Tools no longer decide how to truncate their own output. The framework governs sizing via `formatToolOutput(toolkit, name, output, ctx)` with a tool-agnostic neutral hint appended on truncation, spill to the workspace for oversized results, and a `TruncateStrategy = "head" | "tail" | "middle"` per-tool slice declaration. `AgenticConfig.truncation?: { maxInline?: number }` exposes the knob to callers. `SpillResult = { uri, bytes }` is pure persistence; the hint reads `[Full output at <uri> (N bytes).]` so the agent can inspect the full content with whatever tool fits. ([`d59c7c4`](d59c7c4), [`f4fd966`](f4fd966))

### Compaction correctness

A coordinated pass on three interacting bugs in the compaction path ([`eae1899`](eae1899)):

- **Canonical pair-messages.** Tool calls and their results commit as a single `{ parts: [tool_use, tool_result] }` message — the same atomic shape the journal already used. Post-compaction replay emits both `[assistant tool call]` and `[user tool result]` with tool names preserved; orphaned results are gone.
- **Deferred buffering.** When the compaction call itself overflowed, the strategy used to drop messages from its working copy and retry — those messages were then lost when the engine wiped history on compaction. The strategy now returns `CompactionResult.deferred`; the engine flattens it through `translateBufferedMessages` and splices it into post-compaction history as `[summary, ...deferred, ...turn-replay]`.
- **Attempt breaker.** `compactionFailures` becomes `compactionAttempts` — ticks on every compaction call, resets when a completion returns. Catches both pathological single-message overflows and compacted-but-still-overflowing spirals (both manifest as completions that keep throwing). Doesn't false-positive on legitimate "compacts every turn" work.

Other compaction improvements:

- Threshold check uses measured tokens (`inputTokens + outputTokens + estimatedTokens + safetyMargin`), not char/4 estimates. ([`3b90d75`](3b90d75))
- Compaction prompt produces structured "continuation context" (never "summary" — it biases the model). Fidelity clause preserves absolute paths and identifiers verbatim. User trigger merged into system prompt. `CompactionContext.system` dropped. ([`88a2147`](88a2147), [`ae7dd3c`](ae7dd3c))

### Internal

- `send` / `append` replace the `send(msg, durable=true|false)` pattern. Both accept a single message or an array. `sendAssistantResponse` goes away — it only existed to compensate for the old pre-pair-message shape. ([`eae1899`](eae1899))
- `@ronde/core/bytes` primitive with `utf8ByteLength`. ([`28907d7`](28907d7))
- Backend-config flattening: `ResolvedBackendConfig` drops the `provider` field (agent loop never read it). ([`90ef0ad`](90ef0ad))
- `zip()` helper with load-bearing length-mismatch throw, used by the engine to pair tool calls with their results.
- `stripThinking` operates on the history array instead of per-message.
- Typecheck gap closed: `test/` directories now included in per-package tsconfig `include`, catching drift across 29 test files. ([`b753953`](b753953))

### Housekeeping

- Root `ronde` barrel re-exports every `@ronde/*` workspace; a single `import { ... } from "ronde"` covers the whole consumer-facing surface.
- `@ronde/ai-sdk` standalone; consumers install separately.
- Release script runs `check` + `test` + `build` before tagging; two-step `git push && git push origin vX.Y.Z` is intentional so branch protection gates the tag push. ([`b753953`](b753953))
