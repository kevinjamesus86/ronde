## Tool authoring

Three tiers of tool, ordered by how much of the framework they touch.
Most tools you write are tier one — text data through a formatter
that returns a string. The richer tiers are opt-in for tools that
need them.

### Tier 1 — Text-only tools (the common case)

`execute` returns structured data; `format` renders that data into a
string. Nothing else.

```ts
import { ok, tool } from "ronde"
import { z } from "zod"

const word_count = tool({
  name: "word_count",
  description: "Count words in a string.",
  parameters: z.object({ text: z.string() }),
  execute: async (args) => ok({ words: args.text.split(/\s+/).length }),
  format: (data) => `${data.words} words`,
})
```

The framework wraps the rendered string in a single `text` block
under the hood. Tool authors writing tier one never import the
`Block` vocabulary or see it in stack traces.

### Tier 2 — Multimodal tools

When the model can act on images, audio, or files (most current
frontier models can), the formatter widens its return type from
`string` to `string | Block[]`. Use the constructors to compose:

```ts
import { ok, tool, text, image } from "ronde"
import { z } from "zod"

const screenshot = tool({
  name: "screenshot",
  description: "Capture the active window.",
  parameters: z.object({}),
  execute: async () => {
    const png = await capture() // Uint8Array
    const data = bufferToBase64(png)
    return ok({ data, w: 1920, h: 1080, at: Date.now() })
  },
  format: (data) => [
    text(`Captured ${data.w}×${data.h}.`),
    image(data.data, "image/png"),
  ],
})
```

`text`, `image`, `audio`, `file`, and `ref` are the constructors.
`image`/`audio`/`file` all build the same `binary` block kind under
the hood — they're sugar that reads better at the call site than a
generic `binary(data, "image/png")`.

### Tier 3 — Self-spilling tools

For tools that produce output the engine's text-truncation slice
won't usefully represent — long log tails, paginated query results,
large CSV exports — call `ctx.workspace.spill()` directly and emit
a `ref` block from the formatter. The engine sees a small block
and skips its own substitution path.

```ts
import { ok, tool, text, ref } from "ronde"
import { z } from "zod"

const tail_log = tool({
  name: "tail_log",
  description: "Tail a log file.",
  parameters: z.object({ path: z.string(), lines: z.number().default(1000) }),
  execute: async (args, ctx) => {
    const content = await tailFile(args.path, args.lines)
    if (content.length > 50_000) {
      const r = await ctx.workspace.spill(content, {
        name: `tail-${path.basename(args.path)}`,
        mediaType: "text/plain",
      })
      return ok({
        kind: "spilled" as const,
        uri: r.uri,
        bytes: r.bytes,
        lines: args.lines,
      })
    }
    return ok({ kind: "inline" as const, content, lines: args.lines })
  },
  format: (data) => {
    switch (data.kind) {
      case "spilled":
        return [
          ref(data.uri, {
            mediaType: "text/plain",
            bytes: data.bytes,
            summary: `${data.lines} lines from tail`,
          }),
        ]
      case "inline":
        return data.content
      default: {
        const _: never = data
        throw new Error(`unreachable: ${_}`)
      }
    }
  },
})
```

The discriminated-union discipline keeps the `spilled` and `inline`
branches obvious — no `field?:` pile-up, no nullable URIs that
"exist sometimes."

### Composing toolkits

`merge(...toolkits)` combines any number of `Toolkit` values into one.
Schemas, formatters, truncate strategies, and dispose hooks are all
pooled. Name collisions resolve right-most-wins — useful for overriding
a single tool out of a larger pack.

```ts
import { coreTools, merge, tool, ok } from "ronde"
import { z } from "zod"

const wordCount = tool({
  /* ... */
})
const customGrep = tool({ name: "grep_files" /* ... */ })

// Extend coreTools with a new tool.
const tools = merge(coreTools({ roots: [process.cwd()] }), wordCount)

// Override a coreTool by name (right-most-wins).
const overridden = merge(coreTools({ roots: [process.cwd()] }), customGrep)
```

Each constituent toolkit keeps its own runtime cell, so stateful tools
inside one toolkit don't interfere with stateful tools inside another.
Disposing the merged toolkit disposes each child; a child's dispose error
doesn't block siblings.

### What doesn't change between tiers

- `execute` returns `ToolResult<D>` — `ok(data) | err(msg)`.
- `ok()` and `err()` are the only result helpers; never write
  `{ ok: true, data }` literals.
- Stateful tools, generator tools, retries, observers — all
  unchanged.
- Provider adapters route blocks to native shapes; the tool author
  doesn't think about provider differences.

### Block constructors at a glance

```ts
text(s: string): Block
image(data: string | URL, mediaType: string): Block
file(data: string | URL, opts: { mediaType: string; filename?: string }): Block
audio(data: string | URL, mediaType: string): Block
ref(uri: string, opts?: { mediaType?: string; bytes?: number; summary?: string }): Block
```

`image`/`audio`/`file` produce the same `binary` block kind; the
mediaType discriminates further at the provider adapter. `ref`
carries an addressable handle plus advisory metadata.
