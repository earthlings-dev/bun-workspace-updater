# Repository Guidelines

## Project Structure & Module Organization

This is a small Bun + TypeScript utility. Source code lives in `src/`, currently centered on `src/update-latest.ts`, a CLI that updates package ranges in `package.json` files while preserving JSON formatting through TypeScript JSON AST positions. Root configuration files include `package.json`, `bunfig.toml`, `tsconfig.json`, and `tsconfig.base.json`. `node_modules/` and `coverage/` are generated and should not be edited by hand. There is no dedicated assets directory.

## Build, Test, and Development Commands

- `bun install`: install dependencies and update `bun.lock`.
- `bun run src/update-latest.ts --dry-run`: run the updater without writing files.
- `bun run src/update-latest.ts --tag next --only typescript`: test registry lookup options against selected packages.
- `bun test`: run Bun tests using settings from `bunfig.toml`, including coverage output in `coverage/`.
- `bunx tsc --noEmit`: type-check the project with the strict shared TypeScript config.

The project currently has no package scripts, so prefer explicit Bun commands unless scripts are added later.

## Coding Style & Naming Conventions

Use TypeScript modules with ESM imports. Keep strict type-safety intact: avoid `any`, handle `undefined`, and preserve readonly annotations where data is not mutated. Follow the existing style in `src/update-latest.ts`: two-space indentation, double quotes, semicolons, descriptive interfaces, and small pure helper functions before CLI orchestration. Use camelCase for variables and functions, PascalCase for interfaces and types, and uppercase snake case for constants such as `DEP_FIELDS`.

## Testing Guidelines

Use Bun’s test runner. Name tests with `*.test.ts`; use `*.concurrent.test.ts` only for tests that are safe under the concurrent glob configured in `bunfig.toml`. Coverage thresholds are set to 95% for lines, functions, and statements, so new behavior should include focused tests for argument parsing, range filtering, AST collection, and edit application. Prefer dry-run or mocked registry behavior for CLI tests to avoid unnecessary network calls.

## Commit & Pull Request Guidelines

Commit subjects must use `type(scope): imperative description`, for example `docs(agents): clarify commit format`. Choose a meaningful type; do not use lazy categories like `chore`. Commit bodies should contain 1-5 plaintext sections. Put each section header immediately before its first bullet list item, with no blank line between the header and bullets. Each section should have 3-5 bullet items, and sections should be separated by one blank line.

Pull requests should include a concise summary, the commands run (`bun test`, `bunx tsc --noEmit`), and any behavior changes. Link related issues when available and include terminal output snippets for CLI-facing changes.

## Security & Configuration Tips

The updater fetches package metadata from the npm registry and may run `bun install`. Use `--dry-run` before writing changes and `--no-install` when reviewing edits manually. Do not commit registry tokens, local environment files, or generated coverage artifacts.
