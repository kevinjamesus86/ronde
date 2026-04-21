### How a run flows

One raw engine, several outer surfaces.

`generate()` is a naming alias over `agentic()` for prompt-first call
sites. `agentic()` collects a full result. `agenticStream()` yields live
engine events. All of them ultimately drive the same raw engine package.

```text
generate() / agentic() / agenticStream()
    |
    → ronde
         |
         ├── managed runtime policy      → create/open/select runtime pair
         ├── provider convenience        → parse model string, choose official provider
         ├── backend policy              → apply generic retry over backend
         ├── observer adapter            → project EngineEvent into callbacks
         |
         → engine()
               |
               ├── CompletionBackend     → model completion → Message[]
               ├── Toolkit               → tool execution → ToolResult
               ├── CompactionStrategy    → summary + active-history replacement
               ├── Journal               → event(), commit(), scan(), partition()
               └── Workspace             → spill()
```

These are peers, not a pipeline. The engine coordinates them, but they do not
know about each other. A backend never touches the toolkit. A tool never
touches the journal. A journal never chooses a provider.

### Package boundaries

The split exists to make ownership explicit.

```text
@ronde/core
  → stable contracts and vocabularies

@ronde/engine
  → raw loop orchestration over those contracts

@ronde/lock
  → generic exclusive file-lock primitive

@ronde/fs / @ronde/mem
  → concrete runtime implementations

@ronde/tools
  → first-party fs-oriented tools

@ronde/providers
  → official built-in model providers

@ronde/backend
  → generic behavior over any CompletionBackend

ronde
  → product policy, convenience APIs, adapters, managed defaults
```

The important negative space matters as much as the positive ownership:

- `engine` does not create or open runtimes
- `lock` does not own runtime policy
- `tools` does not care about journal backend family
- `providers` does not own retry policy
- `backend` does not implement official providers
- `ronde` does not own the raw loop primitive
- `core` does not own product policy

### Current package map

The `packages/*` tree is the canonical architecture and build source of truth.

```text
packages/
  core/
    completion.ts   journal.ts   message.ts   workspace.ts
    runtime.ts      toolkit.ts   tool.ts      result.ts

  engine/
    engine.ts       types.ts     compaction.ts
    tool-exec.ts    replay.ts

  lock/
    index.js        index.d.ts   Cargo.toml   src/lib.rs

  fs/
    runtime.ts      journal.ts   workspace.ts internal.ts

  mem/
    runtime.ts      journal.ts   workspace.ts

  tools/
    index.ts        fs-tool.ts   workspace-path.ts   ...

  providers/
    factory.ts      registry.ts  openai.ts   anthropic.ts   ...

  backend/
    retry.ts        errors.ts    shared.ts   defaults.ts

  ai-sdk/
    index.ts

  ronde/
    api.ts          managed-runtime.ts   default-runtime.ts
    compaction.ts   observer.ts          index.ts
```

This is intentionally trimmed. The point is package ownership and the anchor
files that express each boundary, not a file-by-file inventory.

### Runtime layers

Ronde has three runtime layers:

```text
Runtime primitive       → { journal, workspace }
Concrete backends       → @ronde/fs, @ronde/mem
Managed convenience     → ronde createRuntime(...), openRuntime(...), resume(...)
```

The primitive contract is the coherent pair. The backend packages implement
that contract concretely. The managed helpers add policy on top: project
bucketing, optional naming, and "open latest" selection. Managed fs is the
batteries-included default in `ronde`.

The engine only receives the pair:

```ts
engine(backend, {
  journal,
  workspace,
  toolkit,
  prompt: "go",
})
```

How that pair was obtained is outside the engine's responsibility.

The fs backend is fully append-only:

- active events are written to JSONL generation segments
- derived runtime state is reduced from append-only `meta.jsonl`

Write paths repair only the writable tail before appending again. `scan(...)`
is the full trust boundary: it emits incrementally and throws if it later
discovers malformed interior history.

### Tools

`@ronde/tools` owns the first-party fs-oriented tools.

It is responsible for:

- file and shell tools
- path sandboxing and workspace-path resolution
- tool adapters that require an fs-capable workspace

It is not responsible for:

- journal semantics
- runtime policy
- provider behavior

This boundary is deliberate. The first-party tools care about workspace
capability, not whether history is fs-backed or memory-backed.

### Canonical messages

A `Message` is a batch of parts that commit together — the atomic unit of
journal durability. Role lives on the parts, not on the message, so a single
`Message` can legitimately contain contributions from multiple roles.

```text
Message
  └── parts: MessagePart[]
        ├── TextPart       — role: user | assistant | system | developer
        ├── ThinkingPart   — implicit: assistant
        ├── ToolCallPart   — implicit: assistant
        └── ToolResultPart — implicit: user
```

Text is the only part where role is genuinely ambiguous (user prompts,
assistant responses, system/developer instructions) and so carries it
explicitly. Every other part type has one legal role by protocol, across
every supported provider, and the shape encodes that directly. `partRole(part)`
resolves the effective role for any part.

This lets a tool call and its result live inside one `Message`:

```ts
{ parts: [toolCallPart({ ... }), toolResultPart({ ... })] }
```

which is the atomic unit the engine writes durably for each completed tool
(see "Tool-pair journaling" below).

Each part may carry opaque `meta` for provider-specific replay data
(signatures, encrypted reasoning, internal provider state). Core treats that
data as provider-owned. It is preserved when it stays within the same provider
boundary and stripped or dropped when crossing provider boundaries would make
it meaningless.

Provider serializers project canonical messages into each wire protocol.
`coalesceByRole` (Anthropic, Gemini) and the OpenAI Responses serializer both
pool `ToolCallPart` and `ToolResultPart` parts across contiguous messages and
emit them batched — all tool_uses in one assistant turn, all tool_results in
one user turn — so the wire shape matches the original parallel-call
inference even when the canonical history stores each tool as its own pair
message.

### Providers, backend policy, and adapters

Completion has three distinct layers:

```text
@ronde/core
  → CompletionBackend contract

@ronde/providers
  → official built-in providers

@ronde/backend
  → generic backend behavior like retry

@ronde/ai-sdk
  → opt-in adapter from the wider AI SDK ecosystem into CompletionBackend
```

This split is intentional.

Official built-ins use the providers package:

```ts
const raw = createBackend({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey,
})
```

Generic backend policy lives separately:

```ts
const backend = withRetry(raw, { maxRetries: 5 })
```

That separation matters because retry is useful for:

- official built-in providers
- `fromAiSdk(...)`
- custom bring-your-own backends

If retry lived in `providers`, users would need official provider dependencies
just to decorate their own backend. That would be the wrong ownership boundary.

### Cross-provider resume

History is not provider-locked. Canonicalization happens at provider
boundaries so a conversation can cross from one provider to another cleanly.

```text
Anthropic run → canonicalize() → OpenAI run
                    |
               own-provider meta    → passed through
               foreign text/tools   → meta omitted, content preserved
               foreign thinking     → dropped entirely
```

Tool calls and results survive the crossing. Thinking does not.

Reasoning traces exist for multi-turn continuity within a single provider.
When the provider changes, the trace itself stops being meaningful. What
matters is its effect on the conversation, which is already represented in
text and tool activity.

**`EngineResult.history` is the handoff surface.** After every run, the
returned `EngineResult` carries the current in-memory `Message[]` — the
active partition (post-compaction, if any occurred). That means
cross-provider orchestration, one-shot consumers, and callers that used
an ephemeral runtime all get the canonical conversation back without
having to scan, replay, or even keep the journal around. Feed
`result.history` straight into the next `engine(...)` / `agentic(...)`
call against a different provider and the handoff is complete.

This is deliberate. Don't treat the field as redundant with the journal
— it's the load-bearing path for consumers that don't want the durable
half of the runtime pair at all.

### The engine loop

The engine is an async generator. It yields `EngineEvent` and also returns an
`EngineResult` via the generator's `TReturn`. A terminal `run_end` lifecycle
event carries the same `EngineResult` as its payload so `for-await` consumers
see the final outcome without switching to manual `.next()` iteration.
`run_end` is also a `JournalEvent` — the journal carries a compact
`{ settleReason, totals }` summary so reload can answer "did the last run
finish?" without re-aggregating from `turn_end` events.

Hooks are passed in as `EngineHooks` and called directly by the engine. They
are inbound control points, not outbound events.

```text
turn_start(N)
    |
    → preStep hook       → optional override of model / effort / messages / tools
    → backend.complete() → Message with parts
    → thinking(N)        → EngineEvent (ephemeral)
    → text(N)            → EngineEvent (ephemeral)
    → durable assistant  → journal text/thinking portion only
    |
    [if tool calls:]
    → approve hook       → per tool; return false to reject
    → tool_call(N)       → EngineEvent (one per pending call, up front)
    → execute tools      → bounded concurrency; each settle writes one
                           canonical pair message { tool_use, tool_result }
                           to the journal and yields tool_result(N)
    |
    → turn_end(N, step)  → EngineEvent; engine calls journal.commit()
    → postStep hook      → optional string feedback → loop continues next turn
    |
    [when the loop settles:]
    → run_end(result)    → final EngineEvent (also durable); engine commits
                           once more so "run_end at the tail" is a reliable
                           "finished cleanly" signal for reload consumers
```

`turn_start` and `turn_end` are always paired. The engine wraps the turn body
in `try/catch`; on any mid-turn throw, it still finalizes the step and emits
`turn_end` before propagating the error.

Tool-result events stream as each tool settles, not buffered to the end of
the batch — a fast tool's result is observable mid-batch while a slow sibling
is still running.

### Tool-pair journaling

A tool call and its result are one atomic durability unit. `executeToolCalls`
writes them as a single canonical `Message` with parts `[ToolCallPart,
ToolResultPart]` — one `journal.event()` call per completed tool. `turn_end`
is the commit boundary.

```text
[parallel tools running]
   each settle → journal.event(message({ parts: [tool_use, tool_result] }))
turn_end       → journal.commit()  (fsync)
```

This makes an orphaned `tool_use` impossible by construction: a tool_use
never reaches the journal without its result in the same record. A crash
before `turn_end` loses any pair writes that hadn't committed — the
corresponding tools were in-flight from the engine's perspective and
replay simply omits them. The model re-decides on fresh context.

The engine also journals the assistant response's text/thinking portion
separately, stripped of tool_use parts — those belong to pairs and don't
need a second durable copy.

The engine depends only on the `Journal` contract's per-event atomicity.
How a concrete backend delivers that guarantee is its own concern.

### Tool output pipeline

Tool output flows through three responsibilities, each owned by a
different layer:

```text
tool.execute(args, ctx)  →  domain data          (tool)
tool.format(data)        →  rendered string      (tool)
framework                →  size governance      (engine + workspace)
```

A tool's `execute` returns purely domain-shaped data. Its `format`
renders that data to the string the model reads. Neither concerns
itself with how big the string is. The framework layer caps inline
size, spills the full text to the workspace, slices the rendered
output per the tool's declared `truncate` strategy, and appends a
neutral hint pointing at the spill URI.

```text
formatToolOutput(toolkit, name, output, { workspace, toolUseId, maxInline })
    |
    → formatter renders data → string
    → if string <= maxInline  → pass through
    → else:
        workspace.spill(string) → { uri, bytes }
        sliceByStrategy(string, maxInline, toolkit.truncate[name] ?? "head")
        append "[Full output at <uri> (<bytes> bytes).]"
```

Tools declare their preferred cut at the definition site:

```ts
tool({
  name: "shell",
  execute: async (args, ctx) => ok<ShellData>({ exitCode, stdout, stderr }),
  format: (data) => renderShell(data),
  truncate: "middle", // keep both ends; drop the middle
})
```

Three strategies are supported: `"head"` (default — keep the
beginning), `"tail"` (keep the end), `"middle"` (keep both ends).
The cut walks up to 200 chars in the chosen direction to snap to a
newline boundary; pathological long lines fall through to an exact
char-index cut.

Callers can override the inline budget per run:

```ts
engine(backend, {
  toolkit,
  journal,
  workspace,
  truncation: { maxInline: 100_000 }, // default: 25_000
})
```

The neutral hint deliberately never names a specific tool ("Use
`read_file`..."). That coupling would bake the framework into one
toolkit's idioms; the model figures out which of its tools can read
the spill URI from its own toolkit schemas.

Artifact-producing tools (rare edge cases — image generation, binary
exports) that genuinely need to persist beyond their formatter
output reach for `ctx.workspace.spill(content, { name })` directly.
The common-case tool never touches the workspace.

### Engine events

All live output from the engine is classified under `EngineEvent`.

```text
EngineEvent
  ├── EngineLifecycleEvent
  ├── EngineProgressEvent
  └── EngineDiagnosticEvent
```

Current concrete variants are:

- lifecycle
  - `turn_start`, `turn_end`, `compaction_start`, `compaction_end`, `cutoff`,
    `run_end`
- progress
  - `thinking`, `thinking_delta`, `text`, `text_delta`, `tool_call`,
    `tool_delta`, `tool_input_delta`, `tool_result`
- diagnostic
  - `warning`, `error`

`run_end` fires exactly once as the final yield before the generator returns.
Its payload is the same `EngineResult` the generator returns via `TReturn`,
so both consumption shapes (for-await and manual `.next()`) see the outcome.

This classification belongs in `engine` because the engine is the producer.
Consumers can regroup or smooth the events later, but the raw semantic
taxonomy starts here.

### Streaming

Every piece of live content in a turn goes through the same two (or four)
phase lifecycle, and each phase is its own progress event.

| Phase                       | Text         | Thinking         | Tool               |
| --------------------------- | ------------ | ---------------- | ------------------ |
| Model composing (streaming) | `text_delta` | `thinking_delta` | `tool_input_delta` |
| Authoritative (assembled)   | `text`       | `thinking`       | `tool_call`        |
| Running (executing)         | —            | —                | `tool_delta`       |
| Settled                     | —            | —                | `tool_result`      |

Text and thinking only have two phases — the model emits them and they're
done. A tool call has four: the model streams its JSON input
(`tool_input_delta`), the engine parses the final call (`tool_call`), the
tool runs and optionally yields progress chunks (`tool_delta`), then
settles (`tool_result`).

**Delta events are ephemeral.** Nothing streams durably — deltas are live
UX only, not in the journal. Reload sees only the authoritative
counterparts (via the assistant message the engine writes, and the
tool-pair message each completed tool produces).

**Why both phases exist.** Deltas are optional; they only fire when the
provider streams (and the tool author chose `async *execute`). The
authoritative events always fire, so consumers can subscribe at either
granularity:

- Live UI rendering tokens as they arrive → subscribe to `*_delta` events.
- Post-parse logic (analytics, summaries, observers that don't care about
  token-by-token): subscribe to the authoritative events and ignore deltas.

**Shape of streaming opt-in.** Both sides use the same contract:

```ts
// Tool author:
execute: async () => ok(result)                    // non-streaming
execute: async function* () { yield "..."; return ok(result) }  // streaming

// Backend author:
complete(req): Promise<CompletionResponse>                       // non-streaming
complete(req): AsyncGenerator<CompletionDelta, CompletionResponse> // streaming
```

The consumer side is uniform: both get normalized to a generator via
`asGenerator()` (from `@ronde/core/stream`) if the caller wants
iteration, or drained to a Promise via `drain()` if they just want the
final value.

**`tool_input_delta` carries less than `tool_call`.** While the model is
streaming the call's input as JSON, we don't know the full name/args
yet — only the provider's correlation id. Payload is
`{ toolCallId, chunk }`, not a `ToolCall`. The authoritative `ToolCall`
arrives on the subsequent `tool_call` event once the input parses.

### Engine events vs journal events

The engine has one live output channel, and the journal has one durable output
channel. They are related, but they are not the same thing.

```text
EngineEvent   → emitted live by engine (rich, ephemeral)
JournalEvent  → written durably via Journal (lean, replay-oriented)
```

Some events correspond closely across the boundary. Others do not.

- `message` is durable-only. The engine writes it (assistant text/thinking
  portions, and one canonical pair per completed tool — see "Tool-pair
  journaling"); live consumers subscribe to the progress events, not a
  separate `message` engine event.
- `turn_end` exists on both sides; the durable form is leaner than the
  live step object. The engine calls `journal.commit()` right after
  writing it — turn boundaries are the natural durability checkpoint.
- `run_end` also exists on both sides. The durable payload is
  `{ settleReason, totals }` — enough to answer "did the last run finish?"
  on reload without scanning every `turn_end`. The engine commits again
  after the `run_end` record so "run_end at the journal tail" is a
  reliable cleanly-finished signal.
- `thinking*`, `text*`, `tool_call`, `tool_delta`, `tool_input_delta`, and
  `tool_result` are live engine exhaust and are not durably journaled in
  full.

The engine enforces this split explicitly. Not every emitted `EngineEvent`
deserves to become a durable `JournalEvent`.

### Observers are not an engine primitive

The engine does not own an observer concept.

It owns:

- `EngineHooks`
- `EngineEvent`

`ronde` owns the callback adapter:

```text
EngineEvent stream
    |
    → ronde dispatches to RunObserver callbacks
```

That is why `RunObserver` belongs in `ronde`, not in `@ronde/engine`.

An observer is a consumer-side projection of engine events, not part of the raw
engine domain.

### Compaction

When context fills up, the loop compacts instead of stopping. A compaction
strategy summarizes history, the journal publishes a new active slice, and the
loop continues from that replacement context.

```text
context budget exceeded
    |
    → CompactionStrategy.compact(history)
    |       default: LLM summarizes the conversation
    |
    → replacement active history published via Journal.partition(...)
    |       prior history stays on disk, but falls out of active replay
    |
    → loop resumes with summary as active context
```

The important ownership split is:

- `@ronde/engine` owns the compaction interface
- `ronde` owns the default compaction implementation

That lets the engine depend on a compaction contract without depending on
ronde's preferred strategy.

### Consumers

The raw engine is unopinionated about who consumes it.

```text
engine()         → yields EngineEvent, returns EngineResult
generate()       → naming alias over agentic() for prompt-first call sites
agentic()        → collects everything, returns AgenticResult
agenticStream()  → yields EngineEvent via for-await
RunObserver      → ronde callback adapter over EngineEvent
EngineHooks      → inbound control points called by engine
```

Power users can bypass the convenience layer entirely with:

- `engine(backend, { journal, workspace, ... })` for the raw loop
- `agentic(backend, config)` for product conveniences without model parsing
- `fromAiSdk(...)` to adapt the wider AI SDK ecosystem into a backend

### Why the split matters

The package split is not cosmetic. It encodes responsibility:

- `core` defines the contracts
- `engine` defines the raw loop
- `fs` and `mem` implement runtime primitives
- `providers` implements official model providers
- `backend` decorates any backend generically
- `ronde` chooses defaults and exposes the product surface

When those boundaries stay sharp, each layer is simpler to test, easier to
replace, and harder to misuse.
