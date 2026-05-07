## Sandbox as tool

Wrap a remote sandbox (E2B, Modal, your own internal HTTP service)
as a `Toolkit`. The agent runs in your process; the heavy lifting
runs over the network. The pattern is a `Toolkit` whose `execute`
makes RPC calls and returns `Block[]` rich enough to carry text,
screenshots, and artifact URIs back to the model.

This example is provider-neutral — it speaks plain HTTP/JSON. Drop
in any sandbox SDK in place of `httpRpc`.

### The toolkit

```ts
import { z } from "zod"
import {
  type Block,
  type Toolkit,
  err,
  image,
  ok,
  ref,
  text,
  tool,
} from "ronde"

interface SandboxRpc {
  execute(spec: { code: string; timeoutMs?: number }): Promise<{
    stdout: string
    stderr: string
    exitCode: number
    screenshot?: { data: string; mediaType: string } // base64
    artifacts?: Array<{ uri: string; mediaType: string; bytes: number }>
  }>
}

export function sandboxToolkit(rpc: SandboxRpc): Toolkit {
  const run = tool({
    name: "run_python",
    description:
      "Run a Python snippet in a sandbox. Returns stdout/stderr, optional screenshots, and any persisted artifacts.",
    parameters: z.object({
      code: z.string(),
      timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    }),
    execute: async (args) => {
      try {
        const result = await rpc.execute(args)
        if (result.exitCode !== 0) {
          return err(result.stderr || `exit ${result.exitCode}`)
        }
        return ok(result)
      } catch (e) {
        return err((e as Error).message)
      }
    },
    format: (data) => {
      const blocks: Block[] = []
      if (data.stdout) {
        blocks.push(text(data.stdout))
      }
      if (data.screenshot) {
        blocks.push(image(data.screenshot.data, data.screenshot.mediaType))
      }
      for (const a of data.artifacts ?? []) {
        blocks.push(
          ref(a.uri, {
            mediaType: a.mediaType,
            bytes: a.bytes,
          }),
        )
      }
      // Fall back to a marker if the call produced nothing visible —
      // some "successful" runs only side-effect (e.g. write to disk).
      return blocks.length > 0 ? blocks : "ok"
    },
  })

  return run
}
```

### What's happening at each layer

- **Tool execution boundary**. `rpc.execute` runs over the network.
  Whatever wire format you use, the result lands as a structured
  object the formatter can introspect.
- **Block routing**. `format` returns a heterogeneous `Block[]` —
  prose for stdout, an `image` block for an inline screenshot, and
  one `ref` block per persisted artifact. No string concatenation;
  no inline base64 in the text.
- **Provider adapters take over**. Anthropic maps the image to a
  native image content block in the tool result; AI SDK routes
  through `output: { type: "content", value: [...] }`; OpenAI's
  text-only function-call output flattens with descriptors. The
  tool author doesn't write per-provider code.
- **Spill substitution still applies**. If the formatter renders a
  20MB stdout because the sandbox spat out the world, the engine's
  content-substitution kicks in: text gets sliced, the rest is
  spilled to the workspace and emerges as an additional ref block.

### Wiring it up

```ts
import { agentic } from "ronde"

const tools = sandboxToolkit(httpRpc("https://sandbox.internal"))

const { history } = await agentic({
  model: "anthropic/claude-opus-4-7",
  prompt: "Plot the histogram of column X from /data/sales.csv.",
  tools,
})
```

The agent runs locally — engine, journal, workspace co-located in
your process — while `run_python` calls land on the sandbox. The
sandbox's filesystem is unrelated to the local workspace; if your
sandbox host wants to surface the same files the agent sees, hand
it the workspace dir or stage them across the boundary explicitly.

### When to reach for this pattern

- Code execution, browser automation, or any compute you don't want
  in your agent's process.
- Multimodal output where the heavy lifting (rendering charts,
  taking screenshots) is the sandbox's job and the agent only needs
  to see the result.
- Bring-your-own scaling: the sandbox host can fan out
  independently of the agent loop.

### When not to

- The sandbox doesn't return useful structured data — its output is
  free-form text that's hard to format. A tier-one text-only tool
  is simpler.
- The agent needs tight back-and-forth with the sandbox state. The
  RPC round-trip cost makes that painful; consider running the
  agent inside the sandbox instead (sandbox-as-host pattern).
