# Changelog

## v0.5.0

[compare changes](https://github.com/kevinjamesus86/ronde/compare/v0.4.0...v0.5.0)

Big release. Three headline threads: a rewrite of how tool output is
sized and spilled, a ground-up pass on compaction correctness, and a
provider registry that makes adding a new provider a single-file change.

### Breaking changes

- **`ProviderKind` enum removed.** Providers self-register via a
  `ProviderDescriptor` (`name`, `defaultURL`, `envVar`, `modelPrefix`,
  `create`). Core treats providers as opaque strings. Adding a provider
  is one file, zero core changes. New exports: `registerProvider`,
  `getProvider`, `ProviderDescriptor`. `ProviderMeta` becomes `unknown`
  on `CompletionResponse` (00b2831).

- **`CompletionMode` removed.** Providers derive their conditionals
  directly. `InternalBackendConfig.providerKind` is replaced with
  `nativeOpenAI: boolean` (00b2831).

- **Per-tool `truncated` flags removed** from `ReadFileData`, `GlobData`,
  `ListDirectoryData`. The framework owns truncation now via
  `formatToolOutput`; tools emit domain data and a `TruncateStrategy`
  declaration. `read_file` no longer prefixes lines with `${n}→` —
  the LLM knows what it asked for (f4fd966).

- **`CompactionResult.deferred: Message[]` is now required.** Strategies
  that shrink their working set during a retry must return the popped
  messages so the engine can replay them verbatim (eae1899).

- **`extractToolCalls` replaced by `splitResponse`.** Partitions a
  completion into `{ messages, pendingCalls }` — text/think commit
  immediately, `tool_use` parts wait for their results and then commit
  as a single atomic `{ parts: [tool_use, tool_result] }` message per
  call (eae1899).

- **`BackendConfig.provider: string`** (was the `ProviderKind` enum).
  `apiKey` optional with env-var fallback (0d0f11e).

- **Default context window 200K → 400K, default output 64K → 32K**
  (1b36ffe).

### Framework-owned tool output truncation

Tools no longer decide how to truncate their own output. The framework
governs sizing via `formatToolOutput(toolkit, name, output, ctx)` with a
tool-agnostic neutral hint appended on truncation, spill to disk for
oversized results, and a `TruncateStrategy = "head" | "tail" | "middle"`
per-tool slice declaration. `AgenticConfig.truncation?: { maxInline?: number }`
exposes the knob to callers. `SpillResult = { uri, bytes }` is pure
persistence; the hint reads `[Full output at file://… (N bytes).]` so
the agent can fetch the full content with `read_file`
(d59c7c4,
f4fd966).

### Compaction correctness

A coordinated pass on three interacting bugs in the compaction path:

- **Canonical pair-messages.** Tool calls and their results now commit
  as a single `{ parts: [tool_use, tool_result] }` message — the same
  atomic shape the journal already used. Post-compaction replay emits
  both `[assistant tool call]` and `[user tool result]` with tool names
  preserved; orphaned results are gone.
- **Deferred buffering.** When the compaction call itself overflowed,
  the strategy used to drop messages from its working copy and retry —
  those messages were then lost when the engine wiped history on
  compaction. Now the strategy returns `CompactionResult.deferred`, the
  engine flattens it through `translateBufferedMessages`, and splices it
  into post-compaction history as `[summary, ...deferred, ...turn-replay]`.
- **Attempt breaker.** `compactionFailures` becomes `compactionAttempts`
  — ticks on every compaction call, resets when a completion returns.
  Catches both pathological single-message overflows and compacted-but-
  still-overflowing spirals (both manifest as completions that keep
  throwing). Doesn't false-positive on legitimate "compacts every turn"
  work (eae1899).

Other compaction improvements:

- Threshold check uses measured tokens (`inputTokens + outputTokens +
estimatedTokens + safetyMargin`), not char/4 estimates
  (3b90d75).
- Compaction prompt produces structured "continuation context" (never
  "summary" — it biases the model). Fidelity clause preserves absolute
  paths and identifiers verbatim. User trigger merged into system
  prompt. `CompactionContext.system` dropped
  (88a2147,
  ae7dd3c).

### Internal

- `send`/`append` replace the `send(msg, durable=true|false)` pattern.
  Both accept a single message or an array. `sendAssistantResponse` goes
  away — it only existed to compensate for the old pre-pair-message shape
  (eae1899).
- `@ronde/core/bytes` primitive with `utf8ByteLength`
  (28907d7).
- Backend-config flattening: `ResolvedBackendConfig` drops the `provider`
  field (agent loop never read it)
  (90ef0ad).
- `zip()` helper with load-bearing length-mismatch throw, used by the
  engine to pair tool calls with their results.
- `stripThinking` operates on the history array instead of per-message.
- Typecheck gap closed: `test/` directories now included in per-package
  tsconfig `include`, catching drift across 29 test files
  (b753953).

### Housekeeping

- Root `ronde` barrel re-exports every `@ronde/*` workspace; a single
  `import { ... } from "ronde"` covers the whole consumer-facing surface.
- `@ronde/ai-sdk` standalone; consumers install separately.
- Release script runs `check` + `test` + `build` before tagging;
  two-step `git push && git push origin vX.Y.Z` is intentional so
  branch protection gates the tag push
  (b753953).
