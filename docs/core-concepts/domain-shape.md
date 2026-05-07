# Domain Shape

This note describes the current package boundaries and, more importantly, why
they exist.

The short version is:

- `@ronde/core` defines stable contracts and vocabularies
- `@ronde/engine` defines the raw loop over those contracts
- `@ronde/lock` owns generic file-lock semantics
- `@ronde/fs` implements the durable runtime primitives concretely
- `@ronde/providers` owns official built-in model providers
- `@ronde/backend` owns generic behavior over any `CompletionBackend`
- `@ronde/ai-sdk` is an opt-in adapter over Vercel AI SDK providers
- `ronde` owns product policy, convenience APIs, and managed defaults

The point of the split is semantic clarity, not file movement. Each package
should own one kind of responsibility and resist absorbing neighboring policy.

## The layers

### `@ronde/core`

`core` owns the stable nouns that multiple layers depend on:

- `Message`
- `CompletionBackend`
- `CompletionRequest`
- `CompletionResponse`
- `CompletionError`
- `Journal`
- `Workspace`
- `Runtime<W>`
- `Toolkit`

These are contracts, not policies.

Small example:

```ts
await journal.event(JournalEvent.message(userMessage("hello")))

await journal.scan((event) => {
  // replay active durable history
})
```

That is `Journal` responsibility.

This is not:

```ts
const latest = await openRuntime({ project: "acme" })
```

That is managed product policy, not a core contract.

### `@ronde/engine`

`engine` owns raw loop orchestration.

It is responsible for:

- replaying history from `journal`
- calling the completion backend
- executing tools through `toolkit`
- building steps and final loop result
- yielding `EngineEvent`
- invoking `EngineHooks`
- invoking compaction if provided

It is not responsible for:

- creating or opening runtimes
- managed defaults
- provider registry or env lookup
- observer callback fanout
- default compaction policy

Direct usage looks like:

```ts
const gen = engine(backend, {
  journal,
  workspace,
  toolkit,
  prompt: "fix the issue",
})
```

The engine receives the pair. It does not decide how the pair was obtained.

The engine surface is intentionally raw:

- `EngineHooks` are inbound control points
- `EngineEvent` is outbound live exhaust
- `EngineResult` is the generator's `TReturn` — final outcome, totals,
  settle reason, and the canonical `Message[]` history

`EngineEvent` is currently classified into:

- `EngineLifecycleEvent`
- `EngineProgressEvent`
- `EngineDiagnosticEvent`

That classification belongs in `engine` because the engine is the producer.

`EngineResult.history` returns the active in-memory message list
(post-compaction, if any). It's the canonical handoff format for
cross-provider orchestration and the escape hatch for callers on
ephemeral runtimes who don't want to keep the journal around just
to retrieve the conversation.

### `@ronde/lock`

`lock` owns the generic exclusive file-lock primitive.

It is responsible for:

- acquiring an exclusive lock on a file path
- releasing that lock deterministically
- surfacing lock contention distinctly

It is not responsible for:

- choosing which runtime path to lock
- same-process runtime reentrancy policy
- journal semantics
- managed runtime policy

`@ronde/fs` depends on `@ronde/lock`, but it owns the runtime-specific
questions: when to lock, what path to lock, and how that interacts with
cached same-process runtime handles.

### `@ronde/fs`

This package implements the durable runtime primitives concretely.

`@ronde/fs` owns:

- `FsJournal`
- `FsWorkspace`
- runtime-specific writer-lock policy built on `@ronde/lock`
- exact-dir helpers like `createFsRuntime(dir)` and `openFsRuntime(dir)`

`FsJournal` keeps both durable histories append-only:

- active-generation events live in JSONL segment files under `segments/`
- derived journal state lives in append-only `meta.jsonl`

That means `@ronde/fs` owns:

- tail repair before first mutation of an opened generation
- full history trust only when `scan(...)` walks the active segment
- reduction of append-only metadata into current fs runtime state

This package may provide convenience constructors, but it does not own
managed product policy like project bucketing, latest-runtime selection, or
default runtime choice.

### `@ronde/providers`

`providers` owns the official built-in model providers.

It is responsible for:

- official provider implementations
- provider registry
- raw backend factory for those providers
- provider-specific request/response translation
- provider-specific error wrapping

It is not responsible for:

- generic backend policy like retry
- product-facing model string parsing
- AI SDK adaptation

Example:

```ts
const raw = createBackend({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey,
})
```

That gives you a raw official backend.

There is one official providers package. We do not split into per-provider
packages.

### `@ronde/backend`

`backend` owns generic behavior over any `CompletionBackend`.

It is responsible for:

- retry policy
- generic backend helpers shared across official providers and adapters
- generic error classification helpers

It is not responsible for:

- implementing official providers
- engine orchestration
- runtime policy

Example:

```ts
const backend = withRetry(raw, { maxRetries: 5 })
```

The important semantic line is:

- `@ronde/providers` creates official raw backends
- `@ronde/backend` decorates any backend, including custom backends and
  adapters

That is why retry does not live in `providers`.

### `@ronde/ai-sdk`

`ai-sdk` is an opt-in adapter. Its `fromAiSdk()` wraps a Vercel
`LanguageModelV3` (from `@ai-sdk/provider`) into a ronde
`CompletionBackend`, letting consumers reach 50+ model providers via
the AI SDK ecosystem without ronde having to implement each one.

It is responsible for:

- converting between canonical `Message` and AI SDK prompt shapes
- normalizing finish reasons and usage into ronde's shapes
- carrying provider metadata through without interpreting it

It is not responsible for:

- first-party provider implementations (those live in `@ronde/providers`)
- any product policy — it just adapts the shape

Crucially it depends only on `@ronde/core` + `@ronde/backend` and has
`@ai-sdk/provider` as an optional peer dependency. It does **not**
depend on `ronde` — consumers opt in by adding `@ronde/ai-sdk` as a
separate dependency, never via `ronde`. This keeps `ronde` free of
any AI SDK awareness.

```ts
import { fromAiSdk } from "@ronde/ai-sdk"
import { createAnthropic } from "@ai-sdk/anthropic"

const backend = fromAiSdk(createAnthropic().languageModel("claude-sonnet-4-6"))
```

### `ronde`

`ronde` is the outer product layer.

It owns:

- `agentic`, `generate`, `agenticStream`
- managed runtime helpers
- default runtime choice: managed fs by default
- product-level model parsing and convenience behavior
- default compaction strategy
- observer adapter over `EngineEvent`

It is not the home of:

- the raw loop primitive
- official provider implementations
- backend retry policy
- backend contracts
- the AI SDK adapter (lives in `@ronde/ai-sdk`, opt-in)

Example:

```ts
await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "fix the bug",
})
```

That is a `ronde` concern because it decides:

- how to parse the model string
- how to obtain a backend for convenience mode
- what runtime to use if none was provided
- what product defaults to apply

## Responsibility by primitive

### `Journal`

Owns durable history semantics:

- append journal events
- expose active durable history
- support commit and partition semantics
- per-event atomicity: a write either lands or it doesn't; a partial
  write is never observable on scan

Does not own:

- filesystem layout policy
- runtime naming
- turn-loop orchestration
- tool-pair atomicity — that's an engine contract expressed on top of the
  journal's per-event atomicity

The concrete backend (`@ronde/fs`) owns its own recovery mechanisms. The
abstract `Journal` contract only promises the guarantee; how the fs
backend delivers it (e.g. tail repair) is an implementation detail
nothing outside `@ronde/fs` should care about.

### `Workspace`

Owns artifact persistence:

- `spill(content, opts?)` persists `string | Uint8Array` and returns
  `{ uri, bytes }`. `opts.mediaType` selects file extensions in
  fs-backed implementations and rides through into resulting `ref`
  blocks during content-substitution.
- exposes backend-specific capabilities where needed (e.g. `dir` on
  fs-backed implementations — checked structurally at the call site)

Does not own:

- conversation history
- turn loop state
- provider behavior
- truncation, preview construction, or size policy — those are
  framework concerns (see "Tool output pipeline" in architecture.md)

### `Block`

The universal content vocabulary used by `ContentPart`,
`ToolResultPart`, and the format pipeline. Three variants:

- `text { kind: "text", text }` — UTF-8 prose
- `binary { kind: "binary", data: string | URL, mediaType, filename? }`
  — discriminated by `mediaType` (image/audio/file all collapse here)
- `ref { kind: "ref", uri, mediaType?, bytes?, summary? }` — addressable
  handle, used by content-substitution and for inputs that live elsewhere

Provider adapters route on `block.kind` and `mediaType`. Spill
substitution (engine-side) replaces oversized blocks with `ref`
variants pointing at the workspace artifact.

### `Toolkit`

Owns tool surface and execution:

- tool schemas
- named tool execution (`execute` returns domain-shaped data)
- output formatting (`format` renders data to `string | Block[]`)
- per-tool truncation strategy declaration (`truncate: "head" | "tail"
| "middle"` — text-block-specific policy under the substitution model)

Does not own:

- history durability
- runtime creation
- provider calls
- size governance of formatted blocks — the framework runs
  content-substitution per block: oversized text gets sliced + a
  trailing ref block; oversized binary gets spilled and replaced with
  a ref block; existing ref blocks pass through.

### `CompletionBackend`

Owns model invocation only:

- canonical request in
- canonical response out
- normalized failure contract

Does not own:

- tools
- journals
- workspaces
- turn loop control

### `EngineEvent`

Owns the live outbound vocabulary emitted by `engine`.

It is:

- ephemeral
- engine-classified
- consumer-facing as a stream

It is not:

- a durable history format
- an observer-specific type

`ronde` may translate `EngineEvent` into callbacks, but that adapter is not part
of `engine` itself.

### `RunObserver`

Owns a callback projection over `EngineEvent`.

It belongs in `ronde`, not `engine`, because it is an adapter pattern for the
product surface, not a core engine primitive.

### `engine`

Owns turn-loop mechanics:

- replay
- tool-use cycle
- tool-pair durability: a committed tool pair journals as one canonical
  `Message { parts: [ToolCallPart, ToolResultPart] }`, which is the
  atomic unit — a `tool_use` never lands durably without its result.
  Per-pair budget sizing may buffer some pairs for preemptive compaction
  instead of journaling them as pairs; buffered pairs replay as
  translated text post-partition.
- step aggregation
- settle reason
- event emission
- hook invocation

Does not own:

- runtime policy
- backend selection
- managed defaults
- observer dispatch

## One turn, split by ownership

For:

```ts
await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "read the failing tests and patch them",
  tools: coreTools(...),
})
```

Ownership breaks down like this:

### `ronde`

- parses the model string
- obtains or builds a backend for convenience mode
- applies default retry policy
- creates or opens a runtime if needed
- chooses default compaction
- fans out observer callbacks

### `@ronde/providers`

- constructs the official raw provider backend

### `@ronde/backend`

- applies retry behavior over that backend

### `@ronde/engine`

- replays journal history
- starts the turn
- calls `backend.complete(...)`
- executes tools
- appends resulting state
- emits `EngineEvent`
- finalizes steps and settle reason

### `Toolkit`

- exposes tool schemas
- executes named tools

### `Workspace`

- stores large tool outputs

### `Journal`

- stores replay-relevant durable events
- exposes active history
- handles commit and partition boundaries

### `CompletionBackend`

- turns canonical messages plus tools into canonical assistant messages

## Important invariants

### `@ronde/core`

Contracts must stay backend-agnostic.

### `@ronde/engine`

The engine must never decide how a runtime is obtained.

It only consumes:

- `journal`
- `workspace`

### `@ronde/fs`

The fs runtime package may offer convenience constructors, but it does
not own managed product policy.

### `@ronde/providers`

Official provider implementations live here, not in `ronde`.

### `@ronde/backend`

Generic backend policy lives here, not in `providers`.

### `ronde`

`ronde` may choose defaults and adapters, but it should not redefine lower-layer
contracts.

## Small examples

### Official provider plus retry

```ts
const raw = createBackend({
  provider: "openai",
  model: "gpt-5.4",
  apiKey,
})

const backend = withRetry(raw, { maxRetries: 5 })
```

Valid because raw provider creation and generic backend policy are separate.

### Bring your own backend

```ts
const backend = withRetry(myBackend, { maxRetries: 5 })
```

Valid because retry is generic backend behavior, not provider-specific behavior.

### AI SDK adapter

```ts
const backend = withRetry(
  fromAiSdk(createGroq().languageModel("llama-4-scout")),
  { maxRetries: 5 },
)
```

Valid because `@ronde/ai-sdk` is an opt-in adapter into the wider model ecosystem,
not part of the official providers package and not bundled into `ronde`.

### Managed convenience

```ts
await agentic({
  model: "openai/gpt-5.4",
  prompt: "continue yesterday's task",
  resume: { project: "acme" },
})
```

This is `ronde`, not `engine`, because "resume latest in project bucket" is
product policy.

## Short version

If the question is "who owns what?":

- `Journal`: durable history semantics
- `Workspace`: tool artifact semantics
- `Toolkit`: tool surface and execution
- `CompletionBackend`: model-call abstraction
- `@ronde/engine`: raw turn loop
- `@ronde/fs`: concrete durable runtime implementation
- `@ronde/providers`: official built-in providers
- `@ronde/backend`: generic backend policy
- `@ronde/ai-sdk`: opt-in Vercel AI SDK adapter
- `ronde`: convenience, defaults, and managed policy
