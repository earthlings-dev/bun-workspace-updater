// Flat, shareable ESLint config (TypeScript). ESLint loads this `.ts` file natively
// under Bun — no `jiti` — because `config-loader.js` only falls back to jiti when
// `!isDeno && !isBun`, and `bunfig.toml`'s `[run] bun = true` runs ESLint under Bun.
// Run via `bun run lint` (or `bun run lint:fix`). This config is part of the
// type-checking program (see tsconfig.json) so it is itself strictly type-checked.
//
// Strict, type-aware linting is composed entirely from the plugins' own ESM exports:
//   - eslint/config            → `defineConfig`, `globalIgnores`
//   - @eslint/js               → `js.configs.recommended`
//   - typescript-eslint        → `tseslint.configs.strictTypeChecked` (strict, type-aware correctness)
//                                and `disableTypeChecked` for tests; its base registers `tseslint.parser`
//                                + `tseslint.plugin`. typescript-eslint's own formatting rules were
//                                removed in favor of @stylistic, so style is NOT layered from here.
//   - @stylistic/eslint-plugin → `stylistic.configs.customize(...)` — the idiomatic TypeScript style
//                                ruleset (the factory; 2-space indent, single quotes, semicolons).
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Generated, intentionally-tracked coverage output is never linted.
  globalIgnores(['coverage']),

  // Strict, type-aware baseline for every TypeScript file: typescript-eslint's strict
  // correctness ruleset, plus @stylistic (the idiomatic TypeScript style ruleset) built
  // from the factory aligned to the repo (2-space indent, single quotes, semicolons).
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      stylistic.configs.customize({ indent: 2, quotes: 'single', semi: true, jsx: false }),
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dir,
      },
    },
  },

  // Tests live outside the type-checking program (tsconfig.json scopes it to `src`
  // and this config), so the type-aware rules cannot resolve them. Disable only the
  // type-checked rules for tests; every syntactic and @stylistic rule still applies.
  {
    files: ['tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
