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
    // Strict opt-in rules beyond `strictTypeChecked`. The type-aware ones
    // (strict-boolean-expressions, switch-exhaustiveness-check, require-array-sort-compare,
    // prefer-readonly-parameter-types, promise-function-async) are auto-disabled for tests
    // by `disableTypeChecked` below; the rest are syntactic and apply everywhere.
    rules: {
      // A — enforce the repo's own bans (no casts; no implicit truthiness):
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowString: false, allowNumber: false, allowNullableObject: false },
      ],
      // B — stricter typing:
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // C — correctness / immutability:
      '@typescript-eslint/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
      // Parameters must be deeply readonly. `treatMethodsAsReadonly` lets us pass the real
      // upstream types directly (a `ts.Node`'s props are `readonly` by design; only its
      // methods looked "mutable"); `ignoreInferredTypes` skips inline callbacks whose param
      // types we don't annotate. No wrappers, no widening — the real definitions are shared.
      '@typescript-eslint/prefer-readonly-parameter-types': [
        'error',
        {
          treatMethodsAsReadonly: true,
          ignoreInferredTypes: true,
          // Allow the literal external types we only ever read: the TypeScript
          // compiler AST nodes (their public surface is `readonly`; only their deep
          // internal graph looks mutable) and `RegExp`. This restricts misuse of our
          // OWN types while sharing the real external definitions — no facsimiles.
          allow: [
            {
              from: 'package',
              package: 'typescript',
              name: [
                'JsonSourceFile',
                'PropertyAssignment',
                'ObjectLiteralExpression',
                'ArrayLiteralExpression',
              ],
            },
            'RegExp',
          ],
        },
      ],
      '@typescript-eslint/promise-function-async': 'error',
    },
  },
);
