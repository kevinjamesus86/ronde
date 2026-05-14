# ronde

Agentic loop framework for TypeScript. Multi-provider, composable tools, durable runtime, multimodal content, structured observability.

```bash
npm install github:<user>/ronde#release/vX.Y.Z
```

> **Not on npm.** `ronde` is not published to the npm registry — `npm install ronde` will not find this package. Install from a `release/vX.Y.Z` GitHub branch instead. Each release branch ships pre-built `dist/` and the native `.node` binding, so consumers install with no Rust toolchain and no bundler.

### Quickstart

```ts
import { agentic, coreTools } from "ronde"

const { steps } = await agentic({
  model: "anthropic/claude-sonnet-4-6",
  prompt: "List the TypeScript files in src/ and count their lines.",
  tools: coreTools({ roots: [process.cwd()] }),
})

console.log(steps.at(-1)?.text)
```

That's it — no manual runtime setup, no context wiring. The default managed runtime journals every run under `~/.ronde/<project>/<entry>/`. Resume any run with a single line:

```ts
import { resume, agentic } from "ronde"

const runtime = await resume() // most recent run
await agentic({
  runtime,
  model: "anthropic/claude-sonnet-4-6",
  prompt: "continue",
})
```

Walk-through with tools, streaming, and resume → [Getting started](./docs/getting-started.md).

### Documentation

- [**Getting started**](./docs/getting-started.md) — install → first agent → tools → streaming → resume
- [Tool authoring](./docs/tool-authoring.md) — three tiers: text-only, multimodal, self-spilling
- [Architecture](./docs/core-concepts/architecture.md) — package boundaries, engine semantics, runtime layering
- [Domain shape](./docs/core-concepts/domain-shape.md) — primitive ownership and responsibility split
- [Sandbox as tool](./docs/patterns/sandbox-as-tool.md) — wrapping a remote sandbox as a multimodal toolkit
- [CLAUDE](./CLAUDE.md) — contributor-facing commands, conventions, and working notes

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
npm run build          # per-package tsdown → root bundle → strip const enums
npm run build:packages # per-workspace tsdown only
npm run build:root     # root monolithic bundle only
npm run build:strip    # strip `const` from const enums in every emitted .d.mts
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
npm run release X.Y.Z   # bumps every package.json + Cargo.toml,
                         # runs check + test + build, commits, tags vX.Y.Z
git push && git push origin vX.Y.Z   # triggers CI (~5-8 min)
```

The release script bumps the root plus every `packages/*/package.json` and `packages/lock/Cargo.toml` in lockstep — no version drift between the consumer-facing `ronde` and the internal `@ronde/*` packages.

Consumers install from the release branch:

```json
{
  "dependencies": {
    "ronde": "github:<user>/ronde#release/vX.Y.Z"
  }
}
```

Re-cut the same version (e.g. bad artifact):

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```
