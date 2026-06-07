# bun-workspace-updater

A catalog-aware, workspace-aware replacement for `bun update --latest` that **preserves
your `package.json` formatting**. It rewrites only the version-range string literals it
touches — key order, indentation, and comments are left byte-for-byte intact — by editing
the original source text at the offsets reported by the TypeScript compiler's JSON AST
(`ts.parseJsonText`).

The whole tool is a single file: [`src/update-latest.ts`](src/update-latest.ts). It is the
canonical source of a script that is deployed into many Bun workspaces (typically as an
`lupdate` package script), so it has to handle every workspace layout correctly.

## Why

`bun update --latest` rewrites and reformats `package.json`, doesn't understand Bun
[catalogs](https://bun.sh/docs/install/catalogs), and only operates on the file it is run
against. This tool:

- **Preserves formatting** — surgical string replacement at AST offsets, never a
  re-serialize.
- **Understands catalogs** — bumps `workspaces.catalog`, named `workspaces.catalogs.*`, and
  top-level `catalog` / `catalogs`.
- **Walks the workspace** — when the root declares `workspaces`, it discovers member
  `package.json` files via their declared globs and updates them too, then runs a single
  `bun install` at the root.
- **Migrates to catalogs** — `--to-catalog` lifts array-form workspace dependencies into a
  Bun `catalog`, unifying version conflicts to the latest range.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3.8 (developed against 1.3.14)
- TypeScript ≥ 6.0.3 (peer dependency; provides the JSON AST used for offset-preserving edits)
- ESM-only, no build step — the TypeScript source runs directly under Bun

## Install

```bash
bun install
```

To use it from another repo, copy `src/update-latest.ts` in (commonly as
`scripts/update-latest.ts`) and add a script:

```jsonc
// package.json
{
  "scripts": {
    "lupdate": "bun run scripts/update-latest.ts"
  }
}
```

## Quick start

```bash
# Preview every eligible bump across the workspace, write nothing:
bun run src/update-latest.ts --dry-run

# Apply the bumps and run `bun install` at the root:
bun run src/update-latest.ts

# Preview migrating array-form workspace deps into a catalog:
bun run src/update-latest.ts --to-catalog --dry-run
```

Within this repo the same commands are available as the `lupdate` script:

```bash
bun run lupdate --dry-run
```

## Usage

```
bun run src/update-latest.ts [options] [path/to/package.json]
```

The positional argument selects the **root** `package.json` to start from. When omitted, it
defaults to the `package.json` one directory above the script (the repo root). Recursion is
**on by default** whenever that root declares a `workspaces` field.

### Options

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Print the planned changes and write nothing (no `bun install`). |
| `--no-install` | install on | Apply edits but skip the final `bun install`. |
| `--no-recursive` | recursive on | Update only the root file, even if `workspaces` is declared. |
| `-r`, `--recursive` | on | Force recursion on (the default when `workspaces` exists). |
| `--tag <tag>` | `latest` | npm dist-tag to resolve (e.g. `next`, `canary`). |
| `--only <regex>` | — | Only consider packages whose name matches the JS regex. |
| `--resolve-sentinels` | off | Also resolve+pin sentinel ranges (`latest`/`next`/`*`/`x`/`X`/empty). |
| `--to-catalog` | off | Migrate array-form workspace deps into a Bun `catalog` (forces recursion). |

### Examples

```bash
# Use a different dist-tag, limited to one package:
bun run src/update-latest.ts --tag next --only typescript

# Root file only (don't walk workspace members):
bun run src/update-latest.ts --no-recursive

# Bump and also pin floating sentinels like "latest"/"*" to a concrete version:
bun run src/update-latest.ts --resolve-sentinels

# Review edits by hand before installing:
bun run src/update-latest.ts --no-install

# Target a specific package.json:
bun run src/update-latest.ts ../some-other-repo/package.json
```

## What gets updated (and what doesn't)

**Bumped:** plain semver ranges (with their prefix preserved — `^`, `~`, `>=`, `<=`, `>`,
`<`, `=`, or none) found in:

- `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`
- `workspaces.catalog` and named catalogs under `workspaces.catalogs.*`
- top-level `catalog` and `catalogs.*` (Bun also allows these outside `workspaces`)

**Left untouched:**

- Protocol/path specifiers: `catalog:`, `workspace:*`, `link:`, `file:`, `portal:`,
  `git+…` / `git://`, `http://` / `https://`, `npm:…`, and `./` / `../` / `/` paths.
- Sentinels — `latest`, `next`, `*`, `x`, `X`, and empty string — unless
  `--resolve-sentinels` is passed.
- `overrides` and `resolutions` (never collected).
- Dependencies that reference a **sibling workspace member by name** (kept as-is, even when
  written as plain semver), so internal links are never bumped to a registry version.

Each unique package is fetched from the npm registry exactly once per run (results are
deduplicated across all files), and the same `latest` value is applied to every site.

## `--to-catalog` migration

`--to-catalog` converts a workspace to use a single Bun `catalog`:

- Collects every direct dependency across the root and all members.
- Resolves each to its latest version **and** unifies conflicting range prefixes to the
  most permissive one (`^` > `~` > a single exotic prefix > exact), so version conflicts
  dissolve into one catalog entry.
- Rewrites the root `workspaces` value to host a sorted `catalog` (array-form is converted
  to object-form; object-form gains or extends its `catalog`).
- Rewrites each migrated member dependency site to `"catalog:"`.

It is **idempotent**: a second run finds everything already `catalog:` and does nothing. A
package whose registry fetch fails is left untouched and reported as a warning.

> [!WARNING]
> `--to-catalog` resolves to **latest** in the same pass, so a dependency intentionally
> pinned to an older major is moved up to latest. Always run `--to-catalog --dry-run`
> first and review the diff.

## Exit codes

`main()` returns the process exit code:

- `0` — success (or nothing to do).
- `1` — the target `package.json` was not found.
- the `bun install` exit code — when an install runs and fails, its non-zero status is
  propagated.

## Programmatic API

Every helper, the orchestrators, and the types are exported, so the module can be driven
in-process (this is how the test suite exercises it without touching the network or disk):

```ts
import { run, main, parseArgs, type RunResult } from './src/update-latest';

// Parse argv and run end-to-end, returning an exit code:
const code = await main(['--dry-run', './package.json']);

// Or drive `run` directly with parsed options:
const result: RunResult = await run(parseArgs(['--dry-run']));
```

`run(opts)` performs its host effects with the real APIs directly — `fetch` for the npm
registry, `Bun.write` for files, `Bun.spawn` for `bun install`, and `console.*` for output.
There is no injected boundary; tests mock the specific real invocation in place with `spyOn`
(e.g. `spyOn(Bun, 'write')`). `run` returns a `RunResult`:

```ts
interface RunResult {
  readonly changed: number;
  readonly skipped: number;            // already at the latest range
  readonly failed: number;             // registry lookups that failed
  readonly filesWritten: readonly string[];
  readonly installExitCode: number | null;   // null when no install ran
  readonly warnings: readonly string[];
}
```

## Architecture

The pipeline, all in `src/update-latest.ts`:

1. **Parse args** → `Options` (`parseArgs`).
2. **Build work files** (`buildWorkFiles`) — read + `ts.parseJsonText` the root; if recursive
   and `workspaces` is declared, discover member files (`discoverMemberFiles`, via
   `Bun.Glob`) and read them too.
3. **Find entries** (`findEntries`) — walk the JSON AST for bumpable version literals,
   recording each as a named `EntrySource` variant (`catalog` / `namedCatalog` / `deps`)
   plus the exact `[start, end)` offsets of the value literal.
4. **Resolve** the unique package set against the npm registry (`fetchLatest`,
   `mapConcurrent`).
5. **Apply edits** (`applyEdits`) — descending-offset string splices that preserve all
   surrounding text — then write each file and run one `bun install`.

`--to-catalog` follows the same shape via `runToCatalog`, additionally rewriting the root
`workspaces` value (`buildWorkspacesEdit`) with the JSON formatting helpers
(`detectIndentUnit` / `formatJsonArray` / `formatJsonObject`).

Design conventions worth knowing (enforced by [`AGENTS.md`](AGENTS.md)):

- **No top-level side effects** — the CLI runs only under `if (import.meta.main)`; importing
  the module is pure.
- **Real host calls, mocked in place** — side effects are the real `fetch` / `Bun.write` /
  `Bun.spawn` / `console.*`; tests `spyOn` the specific invocation, so there is no injected
  boundary or wrapper standing between the code and the real API.
- **Named discriminated-union variants** — each discriminant is one named constant referenced
  by both the type (`typeof`) and every construction site.

## Development

```bash
bun run typecheck   # tsc --noEmit, strict shared config
bun run lint        # eslint . — strict, type-aware flat config
bun run lint:fix    # eslint . --fix
bun run test        # bun test (coverage to coverage/)
bun run lupdate     # alias for `bun run src/update-latest.ts`
```

Settings live in [`bunfig.toml`](bunfig.toml): tests are randomized with a fixed-seed option,
each reruns 3× (`rerunEach`), files matching `*.concurrent.test.ts` run concurrently, and a
**95%** line/function/statement coverage threshold is enforced.

### Linting

ESLint uses a flat, shareable, **type-aware** TypeScript config in
[`eslint.config.ts`](eslint.config.ts), composed from the plugins' own ESM shareable configs:
`@eslint/js` recommended, `typescript-eslint`'s `strictTypeChecked` for strict, type-aware
**correctness**, and `@stylistic` — the idiomatic TypeScript **style** ruleset — via its factory
`customize({ indent: 2, quotes: 'single', semi: true, jsx: false })`. typescript-eslint's own
formatting rules were removed in favor of `@stylistic`, so all style comes from `@stylistic` alone.
Typed linting relies on `parserOptions.projectService`, so `eslint.config.ts` is part of
`tsconfig.json`; `tests/` sits outside the type-checking program, so `disableTypeChecked` applies
there (syntactic + stylistic rules still run). No preset rules are disabled.

ESLint loads the `.ts` config **natively under Bun** (no `jiti`): `bunfig.toml` sets
`[run] bun = true`, so `bun run lint` executes ESLint under Bun, and ESLint's config loader uses a
native import for `.ts` whenever it detects Bun.

### Testing approach

The suite is one file ([`tests/update-latest.test.ts`](tests/update-latest.test.ts)):

- **Pure-logic tests** are `test.concurrent` — they touch no process globals.
- **Host-effect tests** mock the *specific real invocation* with `spyOn` at the global call site —
  `spyOn(Bun, 'write')`, `spyOn(Bun, 'spawn')`, `spyOn(globalThis, 'fetch')`, `spyOn(console, …)`.
  That's the only seam that intercepts Bun's built-in APIs (mocking the `bun` *module* via
  `mock.module` does not). The spies are built by a factory (`installHostMocks`) and installed /
  restored through a parent-`describe` `beforeEach`/`afterEach(mock.restore)` lifecycle; there's no
  injected boundary. Because `spyOn` patches a process-global, these run serially (plain `test`).
- Dynamic per-call behavior uses `mockResolvedValueOnce` chains (the `fetchLatest` tests),
  `mockImplementation` (the URL-routed registry), and `mockReturnValue` (the install exit).
- `Bun.spawn` is mocked to return a **real** `Bun.spawn(['true'])` / `['false']` subprocess, so the
  install exit code is genuine without running `bun install`.
- Filesystem reads stay real over each test's `mkdtemp` tree (built with `node:fs`, so setup never
  hits the mocked `Bun.write`); assertions use Bun's deep-equality (`toEqual` / `toStrictEqual`).

`main` **returns** an exit code (the `import.meta.main` guard owns `process.exit`), so it is
callable from tests. Keeping everything in one file keeps coverage merged into one report.

> The `coverage/` directory is intentionally committed (it is **not** git-ignored), so the
> latest `lcov.info` and JUnit report travel with the repo.

## License

[Apache-2.0](LICENSE).
