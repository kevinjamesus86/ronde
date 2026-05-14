## Getting started

This is the shortest path from "I want to try ronde" to a working agent. Five
sections, each runnable on its own.

### Install

ronde isn't on npm. Install from a release branch:

```bash
npm install github:<user>/ronde#release/v0.8.0
```

Each release branch ships pre-built `dist/` and the native `.node` binding —
no Rust toolchain or bundler needed on the consumer side. See
[README](../README.md#releases) for the release flow.

Set your provider key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, GEMINI_API_KEY
```

### Your first agent

Three lines. No tools, no runtime setup, just a prompt:

```ts
import { agentic } from "ronde"

const { steps } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Summarize what a finite state machine is.",
})

console.log(steps.at(-1)?.text)
```

`agentic()` runs the full loop and returns when the model settles. By
default it uses a _managed durable runtime_ — a journal + workspace pair
under `~/.ronde/<project>/<entry>/`. Every run is recorded; resume is one
line away (see below).

For one-shot text generation without tool calls, `generate()` is a thin
alias over `agentic()`:

```ts
import { generate } from "ronde"

const { steps } = await generate({
  model: "anthropic/claude-haiku-4-5",
  prompt: "One sentence: what is currying?",
})
```

### Tools

A tool is a typed function the model can call. ronde provides a batteries-
included set; you can write your own; you can mix the two.

#### Using `coreTools`

`coreTools()` ships file ops, shell, glob/grep, fetch, and a few utilities,
all sandboxed to the roots you declare:

```ts
import { agentic, coreTools } from "ronde"

const { steps } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "List the TypeScript files in src/ and count their lines.",
  tools: coreTools({ roots: [process.cwd()] }),
})
```

The `roots` array is a path jail — every file/shell tool reads, writes, and
spawns within those directories. Pass multiple roots to allow several, or
declare them read-only via `ro(path)` / read-write via `rw(path)`.

#### Writing your own

`tool()` is the entry point. The shape is `parameters` (Zod schema),
`execute` (returns `ok(data) | err(msg)`), and `format` (renders data to
the string the model sees):

```ts
import { agentic, tool, ok } from "ronde"
import { z } from "zod/v4"

const wordCount = tool({
  name: "word_count",
  description: "Count words in a string.",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => ok({ words: args.text.split(/\s+/).length }),
  format: (data) => `${data.words} words`,
})

const { steps } = await agentic({
  model: "anthropic/claude-haiku-4-5",
  prompt: "How many words in 'the quick brown fox jumps'?",
  tools: wordCount,
})
```

That's tier-one tool authoring — text in, text out. The same `tool()`
function scales up to multimodal output (return `Block[]` with images,
files, refs) and to self-spilling for large outputs. The three tiers,
with worked examples, live in [tool-authoring.md](./tool-authoring.md).

#### Extending core tools

`merge()` combines toolkits. Name collisions resolve right-most-wins, so
you can both extend and override:

```ts
import { agentic, coreTools, merge, tool, ok } from "ronde"
import { z } from "zod/v4"

const wordCount = tool({
  name: "word_count",
  description: "Count words in a string.",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => ok({ words: args.text.split(/\s+/).length }),
  format: (data) => `${data.words} words`,
})

const tools = merge(coreTools({ roots: [process.cwd()] }), wordCount)

await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Word-count the README.",
  tools,
})
```

The merge is shallow — every constituent toolkit keeps its own state,
formatter, and dispose hook. Same pattern works for combining multiple
custom toolkits.

#### Stateful and streaming

Tools that need per-run state (DB pools, auth contexts, cached resources)
opt into a `state` block; the framework initializes it lazily on first call
and disposes it when the engine settles. Tools that want to surface live
progress (sub-step deltas, intermediate output) use an `async function*`
executor — its yields become `tool_delta` events in
[`agenticStream`](#watching-the-loop).

Both patterns are covered in
[tool-authoring.md](./tool-authoring.md#what-doesnt-change-between-tiers).

### Watching the loop

`agentic()` gives you the final result. `agenticStream()` yields live events
as the loop runs:

```ts
import { agenticStream } from "ronde"

const gen = agenticStream({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Plan a weekend trip to Lisbon.",
})

for await (const event of gen) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.content)
      break
    case "tool_call":
      console.log("\n→", event.call.name)
      break
    case "tool_result":
      console.log("  ✓")
      break
  }
}
```

Events are classified `lifecycle` / `progress` / `diagnostic`. The full
taxonomy is in [architecture.md](./core-concepts/architecture.md#engine-events).

### Resuming a session

Every managed run is durable. Pick up where you left off — same process,
new process, doesn't matter:

```ts
import { agentic, resume } from "ronde"

const runtime = await resume() // opens the most recent run in the default project

const { steps } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "Continue from where we left off.",
  runtime,
})
```

Name runs to pick a specific one:

```ts
const runtime = await resume("trip-planning")
```

The journal replays as `history` before the new turn fires. The model sees
the full prior conversation; no manual context passing.

### Where to next

- [Tool authoring](./tool-authoring.md) — three tiers: text-only,
  multimodal, self-spilling.
- [Architecture](./core-concepts/architecture.md) — package boundaries,
  engine loop, tool-pair journaling, compaction, the content-substitution
  model.
- [Domain shape](./core-concepts/domain-shape.md) — who owns what and why.
- [Sandbox as tool](./patterns/sandbox-as-tool.md) — wrapping a remote
  sandbox (E2B, Modal, your own) as a multimodal toolkit.

### When to reach past `agentic`

`agentic` and friends are conveniences. The raw primitive is `engine()`,
which takes a `{ backend, journal, workspace, toolkit }` set explicitly.
Use it when you want full control — custom journal backend, ephemeral
workspace, bring-your-own compaction. The conveniences are sugar over the
primitive; nothing about the framework is locked behind them.

```ts
import { engine } from "ronde"

const gen = engine(backend, {
  journal, // any Journal — fs, custom, in-memory test stub
  workspace, // any Workspace — fs, custom
  toolkit,
  prompt: "go",
})

for await (const event of gen) {
  /* ... */
}
```

See [architecture.md](./core-concepts/architecture.md#the-engine-loop) for
the raw loop semantics.
