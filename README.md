# ronde

Agentic loop framework for TypeScript. Multi-provider, composable tools, structured observability.

```bash
npm install github:<user>/ronde#release/v0.11.0
```

> **Not on npm.** `ronde` is not published to the npm registry — `npm install ronde` will not find this package. Install from a `release/vX.Y.Z` GitHub branch instead. Each release branch ships pre-built `dist/` and the native `.node` binding, so consumers install with no Rust toolchain and no bundler.

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
