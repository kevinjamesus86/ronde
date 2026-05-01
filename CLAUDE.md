# CLAUDE.md

## What is this

ronde — agentic loop framework for TypeScript. Multi-provider completions, composable tools, structured observability.

## Commands

```
npm test               # package-local unit tests
npm run build          # per-package tsdown → root bundle → strip const enums
npm run build:packages # per-workspace tsdown only
npm run build:root     # root monolithic bundle only
npm run build:strip    # strip `const` from const enums in every emitted .d.mts
npm run typecheck      # TypeScript across packages/*
npm run check          # typecheck + oxlint + oxfmt
npm run lint           # oxlint
npm run fmt            # oxfmt
npm run release        # bump all versions, commit, tag (see Releases)
```

Run a single test file: `npx vitest run packages/engine/test/engine.test.ts`

## Architecture

`packages/*` is the canonical architecture and build source of truth. The full story lives in the core-concepts docs:

- [docs/core-concepts/domain-shape.md](./docs/core-concepts/domain-shape.md)
  — package responsibilities, boundaries, and semantic ownership
- [docs/core-concepts/architecture.md](./docs/core-concepts/architecture.md)
  — package layering, runtime flow, package map, and build/distribution structure

Keep both documents accurate; they are the authoritative source for how the package layer fits together. Don't duplicate them here.

### Platform matrix

Which packages run where. Platform-agnostic packages must not import `node:*`, reference `Buffer`, or touch `process`/`fs`/`os`/`path` — they rely on web globals (`TextEncoder`, `globalThis.crypto`) that exist in Node 19+, browsers, Deno, and workers alike.

| Package            | Node 19+ | Browser | Deno / Workers | Notes                                                                                                                                                                         |
| ------------------ | :------: | :-----: | :------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ronde/core`      |    ✓     |    ✓    |       ✓        | platform-agnostic — no Node-isms                                                                                                                                              |
| `@ronde/engine`    |    ✓     |    ✓    |       ✓        | platform-agnostic                                                                                                                                                             |
| `@ronde/backend`   |    ✓     |    ✓    |       ✓        | platform-agnostic                                                                                                                                                             |
| `@ronde/ai-sdk`    |    ✓     |    ✓    |       ✓        | peer dep `@ai-sdk/provider`                                                                                                                                                   |
| `@ronde/providers` |    ✓     |    ✓    |     ✓ / ?      | browser-safe for OpenAI + Anthropic + Gemini (auto-enabled); llamacpp inherits OpenAI. Non-Node runtimes must pass `apiKey` explicitly — env-var fallback needs `process.env` |
| `@ronde/tools`     |    ✓     |    ✗    |       ✗        | first-party tools use `node:fs`, `node:child_process`; shell sandbox enforcement is macOS-only (`sandbox-exec`), other Node platforms warn once and run unsandboxed           |
| `@ronde/fs`        |    ✓     |    ✗    |       ✗        | concrete fs runtime — `node:fs`, `node:path`                                                                                                                                  |
| `@ronde/lock`      |    ✓     |    ✗    |       ✗        | native addon (darwin-arm64, linux-x64-gnu)                                                                                                                                    |
| `ronde` (root)     |    ✓     |    ✗    |       ✗        | bundles `@ronde/fs` + `@ronde/tools` for the managed default; full shell sandbox enforcement currently requires macOS                                                         |

When editing a platform-agnostic package, grep for the banned patterns before committing:

```
node:|\bBuffer\b|process\.env|process\.cwd|\bos\.|\bpath\.|require\(|__dirname|__filename
```

## Code style

- **No semicolons**, 80 column width, enforced by oxfmt
- **Prefer vertical formatting** — tall code over long lines. Config objects, imports, and function arguments on their own lines when it reads better. Case by case.
- **Braces always required** on control flow (`curly` rule in oxlint)
- **Exhaustive switches on unions** — use `default: { const _: never = x }` on every switch over a discriminated union. Prefer explicit case lists over `default: return false` patterns.
- **Concise names** — `calc` not `calculator`, `echo` not `echoTool`. The type system carries context; suffixes are noise.
- **No unnecessary comments** — code should be self-explanatory. Comments explain _why_, not _what_.
- **No speculative abstractions** — three similar lines beats a premature helper.
- **No grab bags** (no `util.ts`, no `helpers.ts`, no `common.ts`). Each file names a specific concern — `tool-exec.ts`, `stream.ts`, `retry.ts`. If a theme accretes, nest and re-export: `<theme>/<thing>.ts` with `<theme>.ts` (or `<theme>/index.ts`) as the barrel — the way `@ronde/tools` splits into `shell.ts`, `read-file.ts`, etc. with `index.ts` as the entry.
- **Always use `ok()` / `err()` helpers** for tool results. Never raw `{ ok: true, data }` literals.
- Formatting: oxfmt (Prettier-compatible, Oxc ecosystem)
- Linting: oxlint (Oxc ecosystem)

## Documentation style

- **Consistent headings** — `###` preferred; `##` acceptable in longer docs where nesting reads better. `#` only for the first heading, if any.
- **Sections, paragraphs, code** — short prose when needed, lists for reference, code examples as concise as the use case allows.
- **ASCII flow diagrams** — for architecture, data flow, and decision trees. Complement prose, don't replace it.
- **Code examples match the use case** — simple examples are short; power examples show the full config. Vertical formatting preferred.

## Design principles

The codebase should explain itself through its shape — types, names, defaults — not through documentation. The principles below are specific applications of that rule, grouped by where they apply.

### Architecture

How modules are organized and what they're allowed to know about each other.

- **Strict boundaries**: primitives own one concern and don't cross. The engine records to the journal. Tools produce to the workspace. Neither side sees the other's internals.
- **One engine, many consumers**: the loop is a single primitive. Promise-based, streaming, and callback-based consumers are all sugar on top.
- **Primitives are the most general form**: the lowest layer is the richest one — it exposes the fullest signal so consumers can specialize. Less-general wrappers stack over it; they never drive the primitive in parallel. The more general form can always collapse into the less; the reverse is lossy.
- **Portable primitives, managed convenience**: core abstractions are backend-agnostic and work with any implementation. Convenience APIs are opinionated over the default managed layout. Two layers, cleanly separated. Don't leak managed-layout assumptions into the primitives.

### API surface

How callers interact with the codebase. Names, defaults, and capabilities should match what the API actually does.

- **Ergonomics over ceremony**: if the 90% case requires ceremony that only the 10% case needs, the API is wrong. The common path must be frictionless. Power features live behind opt-in patterns, not in the default call signature.
- **Durable by default**: every run is recorded, every artifact is persisted. The model forgets; the transcript doesn't. Resume across processes with one line.
- **Create may create; open must not**: APIs that construct resources may touch the filesystem. APIs that reopen existing resources fail if they're missing. No silent creation on open paths.
- **Hooks influence, observers watch**: hooks can modify loop behavior. Observers are read-only. If the caller can do it with resume, it shouldn't be a hook. If it requires intercepting something mid-turn, it should.

### Type discipline

How shape encodes meaning. Types should make valid states the only states that compile.

- **Unset is `undefined`**: don't use `null` as a sentinel for "not initialized" or "not yet." If you need to distinguish more than set vs unset, use a proper discriminator — a boolean flag, a discriminated union, or a typed state object. Magic values hide state transitions behind implicit conventions instead of making them visible in the type system.
- **Maybes don't pile up**: when `| null` / `| undefined` / `field?:` accumulate on a type, it's almost always hiding a discriminated union — different states with different valid fields. Reach for a tagged union, not a struct of maybes. Optionality is fine at the outermost public-API config layer where callers want to opt in (`AgenticConfig.system?: string`). Internally it's a smell — invalid combinations compile and every read gets a null check.
- **Types are a testable surface**: overload resolution, generic inference, and public-API shape are contracts. Pin them with compile-time assertions that sit alongside behavioral tests. A widened return type or a broken inference path can pass every runtime test; a shape assertion catches it at type-check.

### Naming

How names carry weight. Names pull from their surroundings — the type system, file context, domain vocabulary — and add only what's unique.

- **File context carries the prefix**: a file that names its concern earns the domain prefix; symbols inside drop it. A namespace import at the call site puts the prefix on the caller, once, instead of repeating it on every symbol. A name that restates its file's context is noise.

### Rigor

How we engage with claims about the code — bug reports, audits, reviews, second-hand assertions.

- **Prove before you fix**: every claim deserves a test before a fix. A failing test confirms a real bug; a passing test documents current behavior. The discipline keeps work grounded in evidence and blocks speculative rewrites that paper over misunderstandings.

## Commit convention

Use conventional commits:

```
feat: add structured output with schema validation
fix: observer lifecycle — onTurnEnd fires after turn processing
refactor: replace Prettier with oxlint + oxfmt
docs: rewrite README for new public API
test: add observer lifecycle unit tests with mock backend
chore: add noEmit to tsconfig
```

Type prefix required. Scope optional. Body optional. Keep the subject concise — describe the _why_, not the _what_.

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

## Testing

Package-local tests live under `packages/<pkg>/test/*.test.ts`. Vitest runs all of them via `npm test`.

## Build

Every workspace package is independently buildable. `npm run build` chains three stages:

- `build:packages` — `npm run build --workspaces --if-present`, runs each sub-package's `tsdown` in the topological order declared in root `workspaces`. Each `@ronde/*` produces its own `packages/<x>/dist/` (ESM `.mjs` + `.d.mts`).
- `build:root` — the root `tsdown.config.ts` produces the consumer-facing monolithic `dist/` bundle.
- `build:strip` — `scripts/strip-const-enums.mjs` patches every `.d.mts` in every dist (root + per-package), stripping `const` from each `const enum` so downstream `isolatedModules` consumers can use our enums.

Shared tsdown config lives at `packages/tsdown.shared.js`; each package's `tsdown.config.ts` is three lines over entry points.

Root `ronde` package exposes a single entry point — consumers `import { ... } from "ronde"` for everything: the agentic API, tool primitives, first-party tools, result/journal/workspace types, error types, stream helpers. No subpaths. `@ronde/ai-sdk` is a standalone opt-in adapter — consumers install it separately, not via `ronde`.

TypeScript's composite `tsc -b` build writes to `packages/<x>/.tsc/` (gitignored, type-checking cache only) to avoid colliding with tsdown's `dist/`.

## Releases

Distributed via GitHub tags, not npm. Each release branch (`release/vX.Y.Z`) ships pre-built `dist/` and native `.node` binaries so consumers install with no Rust toolchain and no bundler.

Cut a release with `npm run release <version>` — the script bumps every `packages/*/package.json` and `Cargo.toml` to match the root version, runs `npm run check`, `npm test`, and `npm run build`, then commits and tags. Push with `git push && git push origin vX.Y.Z`; CI produces the release branch.

The two-step push is intentional. The script stops at the local tag so you can inspect the bump commit before anything leaves the machine. `git push` lands the commit on `main` and lets branch protection / required checks run first; `git push origin vX.Y.Z` then publishes the tag, which is the trigger for the release workflow. Abort is trivial up to that point — delete the local tag, reset the commit, retry.

Never hand-bump individual package versions — the script keeps them in lockstep.
