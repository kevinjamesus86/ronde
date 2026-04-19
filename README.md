# ronde

Agentic loop framework for TypeScript. Multi-provider, composable tools, structured observability.

```bash
npm install github:<user>/ronde#release/v0.11.0
```

> **Not on npm.** `ronde` is not published to the npm registry — `npm install ronde` will not find this package. Install from a `release/vX.Y.Z` GitHub branch instead. Each release branch ships pre-built `dist/` and the native `.node` binding, so consumers install with no Rust toolchain and no bundler. See [Development](#development) for the release flow.

By default, `ronde` creates a managed fs runtime and records each run.

**Why ronde**

- Durable by default — the built-in managed fs runtime records runs and persists tool artifacts automatically. Resume across processes with one line. Zero config.
- One engine, multiple API surfaces — `generate()`, `agentic()`, and `agenticStream()` are layered over the same loop primitive.
- Portable primitives, managed convenience — use the batteries-included defaults or bring your own backend, runtime, and tools.
- Cross-provider by design — canonical messages let a run continue across provider boundaries without provider-locked history.

### Generate text

```typescript
import { generate } from "ronde"

const { output } = await generate({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Explain monads in one sentence.",
})
```

### Structured output

```typescript
import { z } from "zod/v4"
import { generate } from "ronde"

const { output } = await generate({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Classify this ticket: 'My invoice is wrong'",
  schema: z.object({
    type: z.enum(["billing", "technical", "general"]),
    urgency: z.enum(["low", "medium", "high"]),
  }),
})
```

### Agentic loop

```typescript
import { agentic, coreTools } from "ronde"

const { output, steps } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Read the README and summarize it.",
  tools: coreTools({
    roots: [process.cwd()],
  }),
})
```

### Custom tools

```typescript
import { z } from "zod/v4"
import { agentic, tool, merge, coreTools, ok, err } from "ronde"

const weather = tool({
  name: "get_weather",
  description: "Get weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => fetchWeather(city).then(ok).catch(err),
})

const { output } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "What's the weather in Tokyo?",
  tools: merge(coreTools({ roots: ["/workspace"] }), weather),
})
```

### Stateful tools

```typescript
const db = tool({
  name: "query",
  description: "Run SQL",
  parameters: z.object({ sql: z.string() }),
  state: {
    init: async () => ({
      pool: await createPool(process.env.DB_URL!),
    }),
    dispose: async (s) => await s.pool.end(),
  },
  execute: async (args, ctx) => {
    const rows = await ctx.state.pool.query(args.sql)
    return ok({ rows })
  },
})
```

Add a `state` field and `ctx.state` is available in `execute` — typed from `init`'s return, no type parameters needed.

- State initializes on first call and is disposed automatically when the run ends
- Each engine gets its own isolated state — the same toolkit is safely reusable across sequential and concurrent runs
- Durable state (cross-run caches, accumulators) is an external concern — pass it in via closure

### Streaming

Iterate the loop live and render tokens as they arrive:

```typescript
import { agenticStream } from "ronde"

for await (const event of agenticStream({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Fix the failing tests.",
  tools,
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.content)
  }
}
```

That's it for the simple case. Same config shape as `agentic()`, except
`observers` are not accepted here. `break` terminates the loop early.

**Richer UIs.** Each piece of live content goes through a short lifecycle,
and each phase is its own event:

| Phase                       | Text         | Thinking         | Tool               |
| --------------------------- | ------------ | ---------------- | ------------------ |
| Model composing (streaming) | `text_delta` | `thinking_delta` | `tool_input_delta` |
| Authoritative (assembled)   | `text`       | `thinking`       | `tool_call`        |
| Running (executing)         | —            | —                | `tool_delta`       |
| Settled                     | —            | —                | `tool_result`      |

```typescript
for await (const event of agenticStream({ ... })) {
  switch (event.type) {
    case "thinking_delta":
    case "text_delta":
      process.stdout.write(event.content)
      break
    case "tool_call":
      process.stdout.write(
        `\n[${event.call.name}] ${JSON.stringify(event.call.arguments)}\n`,
      )
      break
    case "tool_result":
      process.stdout.write(
        `${event.result.ok ? "✓" : "✗"} ${event.result.content.slice(0, 80)}\n\n`,
      )
      break
    case "run_end":
      process.stdout.write(`\ndone: ${event.result.settleReason}\n`)
      break
  }
}
```

Running that against an agentic run looks roughly like:

```
Let me check the README to see what the project is about.
[read_file] {"path":"README.md"}
✓ # ronde\nAgentic loop framework for TypeScript. Multi-provider, co

Based on the README, this is a TypeScript agentic loop framework…

done: end_turn
```

The other delta events (`tool_input_delta` streaming the model's JSON
before it parses, `tool_delta` streaming progress from a tool's own
`async *execute`, `turn_end`, etc.) are there when you want them — skip
them when you don't.

Not every event fires for every run — deltas only stream when the provider
supports it (most first-party providers do) and tools only produce
`tool_delta` when their `execute` is an async generator. The authoritative
events always fire, so you can subscribe at whatever granularity you need.

Deltas are live-only — they don't land in the journal. Reload reconstructs
from the authoritative messages instead. See
[architecture.md](./docs/core-concepts/architecture.md#streaming) for the
full event taxonomy.

### Resume

Every run writes a durable transcript. Continue a prior run later by managed name:

```typescript
await agentic({
  resume: "merger-experiment",
  model: "anthropic/claude-sonnet-4-6",
  prompt: "keep going",
  tools,
})
```

`resume` is open-only and throws if no runtime with that name exists. For a fresh named run, call `createRuntime({ name })` first; for an unnamed run, just omit `resume` and one is created automatically.

Or explicitly, for full control:

```typescript
import { resume, agentic } from "ronde"

const runtime = await resume("merger-experiment")
await agentic({
  ...runtime,
  model: "anthropic/claude-sonnet-4-6",
  prompt: "keep going",
  tools,
})
```

### Replay

Reconstruct the message history from a prior run without starting a new loop.

```typescript
import { replay } from "ronde"

const messages = await replay("merger-experiment")
```

Accepts a managed name, a managed options object, or a `Journal` directly. Returns `Message[]`.

### Hydrate

Seed a fresh runtime with a hand-crafted message history — useful when importing a conversation from another store.

```typescript
import { hydrate, agentic } from "ronde"

const runtime = await hydrate(priorMessages)
await agentic({
  ...runtime,
  model: "anthropic/claude-sonnet-4-6",
  prompt: "keep going",
  tools,
})
```

The messages are written as `message` events, so a subsequent `replay()` reproduces them.

### Observers

```typescript
const { output } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Fix the tests.",
  tools,
  observers: {
    onTurnStart: (turn) => console.log(`[turn ${turn}]`),
    onToolCall: (_, tc) => console.log(`  ${tc.name}`),
    onToolResult: (_, tc, r) => console.log(`  ${r.ok ? "ok" : "err"}`),
    onTurnEnd: (_, step) => console.log(`  ${step.toolCalls.length} tools`),
  },
})
```

All methods optional. Accepts a single observer or an array. Errors in observers never crash the loop.

### Hooks

Hooks influence loop behavior. Unlike observers (read-only), hooks can modify state, reject tools, or inject feedback.

```typescript
const runProjectTests = async () => {
  // replace with your project's test command
  return { code: 0, stderr: "" }
}

await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Refactor the auth module to use JWT.",
  tools: coreTools({ roots: [process.cwd()] }),
  hooks: {
    approve: ({ name, arguments: args }) =>
      name !== "shell" || !/rm\b/.test(args.command as string),
    postStep: async (step) => {
      const edited = step.toolCalls.some((tc) =>
        ["write_file", "edit_file"].includes(tc.name),
      )
      if (edited) {
        const { code, stderr } = await runProjectTests()
        if (code !== 0) {
          return `Tests failing after your edits:\n${stderr.slice(0, 500)}`
        }
      }
    },
  },
})
```

- `approve` — gate tool execution. Rejected tools return an error the model can see.
- `preStep` — override model, effort, or tools per turn.
- `postStep` — review results after each turn. Return a string to inject feedback.

### Providers

Model strings use `provider/model` format. API keys read from the environment.

| Provider  | Format                         | Env var             |
| --------- | ------------------------------ | ------------------- |
| Anthropic | `anthropic/claude-sonnet-4-6`  | `ANTHROPIC_API_KEY` |
| OpenAI    | `openai/gpt-5.4-nano`          | `OPENAI_API_KEY`    |
| Gemini    | `gemini/gemini-2.5-flash`      | `GEMINI_API_KEY`    |
| LlamaCpp  | `llamacpp/gemma4-26b-a4b-q4km` | local               |

### AI SDK providers

```typescript
import { createGroq } from "@ai-sdk/groq"
import { fromAiSdk } from "@ronde/ai-sdk"
import { agentic } from "ronde"

const { output } = await agentic(
  fromAiSdk(createGroq().languageModel("llama-4-scout")),
  {
    prompt: "Summarize the README.",
    tools,
  },
)
```

### Errors

```typescript
import { CompletionError } from "ronde"

try {
  await agentic({
    model: "...",
    prompt: "...",
  })
} catch (err) {
  if (err instanceof CompletionError) {
    console.error(err.kind, err.message)
  }
}
```

Transient errors (429, 500, network) are retried automatically. Context overflow triggers compaction. Everything else bubbles up.

### Documentation

The canonical references are:

- [Architecture](./docs/core-concepts/architecture.md) — package boundaries, engine semantics, and runtime layering
- [Domain Shape](./docs/core-concepts/domain-shape.md) — primitive ownership and responsibility split
- [CLAUDE](./CLAUDE.md) — contributor-facing commands, architecture notes, and working conventions

### Development

Prerequisites:

- Node 22+
- Rust 1.89+ ([rustup.rs](https://rustup.rs)) — needed to build `@ronde/lock`'s native binding

First-time setup:

```bash
git clone <repo>
cd ronde
npm ci              # prepare hook auto-builds @ronde/lock + dist (~10s cold)
```

Common commands:

```bash
npm test               # package-local unit tests
npm run build          # per-package tsdown + root bundle + strip const enums
npm run build:packages # per-workspace tsdown only
npm run build:root     # root monolithic bundle only
npm run typecheck      # TypeScript across packages/*
npm run check          # typecheck + oxlint + oxfmt
```

Force a rebuild:

```bash
rm packages/lock/*.node              # rebuild native on next npm ci
rm -rf dist packages/*/dist          # rebuild tsdown output on next build
```

### Releases

Releases are cut as GitHub tags. CI builds native binaries for `darwin-arm64` and `linux-x64-gnu` in parallel, then pushes a `release/vX.Y.Z` branch with everything pre-built.

Cut a release:

```bash
npm run release 0.11.0   # bumps every package.json + Cargo.toml,
                         # runs check + test, commits, tags v0.11.0
git push && git push origin v0.11.0   # triggers CI (~5-8 min)
```

The release script bumps the root plus every `packages/*/package.json` and `packages/lock/Cargo.toml` in lockstep — no version drift between the consumer-facing `ronde` and the internal `@ronde/*` packages.

Consumers install from the release branch:

```json
{
  "dependencies": {
    "ronde": "github:<user>/ronde#release/v0.11.0"
  }
}
```

Re-cut the same version (e.g. bad artifact):

```bash
git tag -d v0.11.0
git push origin :refs/tags/v0.11.0
git tag v0.11.0
git push origin v0.11.0
```
