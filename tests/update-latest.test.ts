// Single test file. Pure-logic tests are `test.concurrent` (they touch no process globals).
//
// Host effects are mocked at the MODULE boundary: `src` imports `{ fetch, spawn, write }` from the
// `bun` module, and `tests/preload.ts` (bunfig `[test] preload`) registers `mock.module('bun', …)`
// BEFORE the test files import `src` — `mock.module` won't update an already-imported module's
// bindings, so it must run first. The shared mocks live in `preload.ts`; this file imports and
// configures them per test. `console.*` is spied directly (`spyOn(console, …)`); reads use the global
// `Bun.file`/`Bun.Glob` and stay real (unmocked). The mocks are installed/reset through a
// parent-`describe` `beforeEach`/`afterEach(mock.restore)` lifecycle, with dynamic per-call behavior
// (`mockResolvedValueOnce` for sequential calls, `mockImplementation` for the URL-routed registry).
// Because the mocks are process-global, host-effect tests are serial; the `test` script is plain
// `bun test`. Assertions use Bun's deep-equality (`toEqual`/`toStrictEqual`) and the asymmetric
// `stringContaining`/`objectContaining` matchers; rejections go through `rejectsWith` (Bun types
// `expect().rejects.toThrow()` as `void`, so it can't be awaited cleanly).
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

import {
  applyEdits,
  bumpRange,
  buildWorkFiles,
  CATALOG_KIND,
  collectMemberNames,
  DEPS_KIND,
  describeSource,
  detectIndentUnit,
  discoverMemberFiles,
  fetchLatest,
  findEntries,
  formatJsonArray,
  formatJsonObject,
  isBumpableRange,
  main,
  mapConcurrent,
  NAMED_CATALOG_KIND,
  parseArgs,
  propKey,
  readPackageName,
  readWorkspacePatterns,
  run,
  splitPrefix,
  unifyPrefix,
  type Edit,
  type Options,
} from '../src/update-latest';
import { fetchMock, spawnMock, writeMock } from './preload';

// Real subprocesses via the GLOBAL `Bun.spawn` (mock.module only replaces the `bun` MODULE, not the
// global namespace), reused as the mocked `spawn`'s return value so the install path yields a genuine
// awaited exit code with no real `bun install`: `true` → 0, `false` → 1.
const PROC_OK = Bun.spawn(['true']);
const PROC_FAIL = Bun.spawn(['false']);

function parse(text: string): ts.JsonSourceFile {
  return ts.parseJsonText('test.json', text);
}

/** Create an isolated temp tree (built with `node:fs`, so it never hits the mocked `bun` `write`). */
async function withTree<T>(
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'wsu-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    return await fn(dir);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function opts(over: Partial<Options>): Options {
  return {
    file: '',
    tag: 'latest',
    dryRun: false,
    install: false,
    only: undefined,
    recursive: true,
    resolveSentinels: false,
    toCatalog: false,
    ...over,
  };
}

/** Assert `promise` rejects with an `Error` whose message contains `substring` (typed; no `as`). */
async function rejectsWith(promise: Promise<unknown>, substring: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  }
  catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (caught instanceof Error) {
    expect(caught.message).toContain(substring);
  }
}

// --- response factories ---
const okResponse = (version: string): Response => Response.json({ version });
const notFound = (): Response => new Response('not found', { status: 404, statusText: 'Not Found' });

/** A `fetch` implementation that answers from a version map (package `%2F`-decoded from the URL). */
function registryFrom(versions: Readonly<Record<string, string>>, failOn: readonly string[] = []) {
  const fail = new Set(failOn);
  return async (input: string): Promise<Response> => {
    await Promise.resolve();
    const path = input.slice('https://registry.npmjs.org/'.length);
    const pkg = decodeURIComponent(path.slice(0, path.lastIndexOf('/')));
    if (fail.has(pkg)) {
      return notFound();
    }
    const version = versions[pkg];
    return version === undefined ? new Response('{}', { status: 200 }) : okResponse(version);
  };
}

/**
 * Configure the preloaded `bun`-module mocks (`fetch`/`write`/`spawn` from `./preload`) plus `console`
 * spies for one test, returning the handles so tests set behaviour (`fetch.mockImplementation(...)`)
 * and assert on them. The `mock.module('bun', …)` registration itself lives in `tests/preload.ts`.
 */
function installHostMocks() {
  writeMock.mockResolvedValue(0);
  spawnMock.mockReturnValue(PROC_OK);

  const log = spyOn(console, 'log');
  log.mockImplementation(() => undefined);
  const warn = spyOn(console, 'warn');
  warn.mockImplementation(() => undefined);
  const error = spyOn(console, 'error');
  error.mockImplementation(() => undefined);

  return { fetch: fetchMock, write: writeMock, spawn: spawnMock, log, warn, error };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test.concurrent('defaults', () => {
    const o = parseArgs([]);
    expect(o.recursive).toBe(true);
    expect(o.resolveSentinels).toBe(false);
    expect(o.toCatalog).toBe(false);
    expect(o.dryRun).toBe(false);
    expect(o.install).toBe(true);
    expect(o.tag).toBe('latest');
    expect(o.only).toBeUndefined();
    expect(o.file.endsWith('package.json')).toBe(true);
  });

  test.concurrent('boolean + value flags', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--no-install']).install).toBe(false);
    expect(parseArgs(['--no-recursive']).recursive).toBe(false);
    expect(parseArgs(['--recursive']).recursive).toBe(true);
    expect(parseArgs(['--resolve-sentinels']).resolveSentinels).toBe(true);
    expect(parseArgs(['--to-catalog']).toCatalog).toBe(true);
    expect(parseArgs(['--tag', 'next']).tag).toBe('next');
    expect(parseArgs(['--tag']).tag).toBe('latest');
    expect(parseArgs(['--only', '@stylistic']).only?.test('@stylistic/x')).toBe(true);
    expect(parseArgs(['--only']).only?.test('anything')).toBe(true);
  });

  test.concurrent('positional file is absolute-resolved', () => {
    expect(parseArgs(['/abs/pkg.json']).file).toBe('/abs/pkg.json');
    expect(parseArgs(['rel/pkg.json']).file).toBe(resolve('rel/pkg.json'));
  });

  test.concurrent('`-r` is a recursive flag, not a positional file', () => {
    const o = parseArgs(['-r']);
    expect(o.recursive).toBe(true);
    expect(o.file.endsWith('package.json')).toBe(true);
    expect(o.file).not.toBe(resolve('-r'));
  });

  test.concurrent('unknown flag throws', () => {
    expect(() => parseArgs(['--bogus'])).toThrow('Unknown flag: --bogus');
  });
});

// ---------------------------------------------------------------------------
// isBumpableRange
// ---------------------------------------------------------------------------

describe('isBumpableRange', () => {
  test.concurrent('protocol specifiers are never bumpable', () => {
    const protocols = [
      'catalog:',
      'catalog:foo',
      'workspace:*',
      'link:../x',
      'file:../x',
      'portal:../x',
      'git+https://x',
      'git://x',
      'http://x',
      'https://x',
      'npm:left-pad@1',
      './local',
      '../local',
      '/abs',
    ];
    for (const r of protocols) {
      expect(isBumpableRange(r, false)).toBe(false);
    }
  });

  test.concurrent('sentinels are skipped by default, bumpable with --resolve-sentinels', () => {
    for (const s of ['latest', 'next', '*', 'x', 'X', '', '  latest  ']) {
      expect(isBumpableRange(s, false)).toBe(false);
      expect(isBumpableRange(s, true)).toBe(true);
    }
  });

  test.concurrent('plain semver (incl. partial-x) is bumpable', () => {
    for (const r of ['^1.2.3', '~1', '>=1', '1.2.3', '1.2.x']) {
      expect(isBumpableRange(r, false)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// splitPrefix / bumpRange
// ---------------------------------------------------------------------------

describe('splitPrefix / bumpRange', () => {
  test.concurrent('splits every prefix form', () => {
    expect(splitPrefix('^1.2.3')).toEqual({ prefix: '^', version: '1.2.3' });
    expect(splitPrefix('~1.2.3')).toEqual({ prefix: '~', version: '1.2.3' });
    expect(splitPrefix('>=1.0.0')).toEqual({ prefix: '>=', version: '1.0.0' });
    expect(splitPrefix('<=1.0.0')).toEqual({ prefix: '<=', version: '1.0.0' });
    expect(splitPrefix('>1.0.0')).toEqual({ prefix: '>', version: '1.0.0' });
    expect(splitPrefix('<1.0.0')).toEqual({ prefix: '<', version: '1.0.0' });
    expect(splitPrefix('=1.0.0')).toEqual({ prefix: '=', version: '1.0.0' });
    expect(splitPrefix('1.2.3')).toEqual({ prefix: '', version: '1.2.3' });
    expect(splitPrefix('  ^1.2.3  ')).toEqual({ prefix: '^', version: '1.2.3' });
    expect(splitPrefix('')).toEqual({ prefix: '', version: '' });
  });

  test.concurrent('bumpRange preserves prefix; equal range is a no-op', () => {
    expect(bumpRange('^1.0.0', '2.0.0')).toBe('^2.0.0');
    expect(bumpRange('1.0.0', '2.0.0')).toBe('2.0.0');
    expect(bumpRange('~1.0.0', '1.0.0')).toBe('~1.0.0');
  });
});

// ---------------------------------------------------------------------------
// findEntries / propKey
// ---------------------------------------------------------------------------

describe('findEntries', () => {
  const FIXTURE = `{
  "name": "root",
  "workspaces": {
    "packages": [
      "packages/*"
    ],
    "catalog": {
      "eslint": "^8.0.0",
      "ws-ref": "workspace:*"
    },
    "catalogs": {
      "react18": {
        "react": "^18.0.0"
      }
    }
  },
  "catalog": {
    "top": "^1.0.0"
  },
  "catalogs": {
    "tools": {
      "tsx": "^4.0.0"
    }
  },
  "dependencies": {
    "left-pad": "^1.3.0",
    "linked": "catalog:"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "overrides": {
    "ignored": "^9.9.9"
  }
}`;

  test.concurrent('collects catalog, named catalogs (nested + top-level) and dep fields', () => {
    const entries = findEntries(parse(FIXTURE), false);
    const byPkg = new Map(entries.map(e => [e.pkg, e]));

    expect([...byPkg.keys()].sort()).toEqual(
      ['eslint', 'react', 'top', 'tsx', 'left-pad', 'typescript'].sort(),
    );
    expect(byPkg.has('ignored')).toBe(false);
    expect(byPkg.has('ws-ref')).toBe(false);
    expect(byPkg.has('linked')).toBe(false);

    expect(byPkg.get('eslint')?.source.kind).toBe(CATALOG_KIND);
    expect(byPkg.get('top')?.source.kind).toBe(CATALOG_KIND);
    const react = byPkg.get('react')?.source;
    expect(react?.kind).toBe(NAMED_CATALOG_KIND);
    expect(react?.kind === NAMED_CATALOG_KIND ? react.name : '').toBe('react18');
    const tsx = byPkg.get('tsx')?.source;
    expect(tsx?.kind === NAMED_CATALOG_KIND ? tsx.name : '').toBe('tools');
    const tsDep = byPkg.get('typescript')?.source;
    expect(tsDep?.kind).toBe(DEPS_KIND);
    expect(tsDep?.kind === DEPS_KIND ? tsDep.field : '').toBe('devDependencies');
  });

  test.concurrent('value-span offsets land on the quoted version literal', () => {
    const entries = findEntries(parse(FIXTURE), false);
    const tsEntry = entries.find(e => e.pkg === 'typescript');
    expect(tsEntry).toBeDefined();
    if (tsEntry !== undefined) {
      expect(FIXTURE.slice(tsEntry.start, tsEntry.end)).toBe('"^5.0.0"');
    }
  });

  test.concurrent('non-string/identifier/numeric keys do not throw and are ignored', () => {
    const entries = findEntries(parse('{ "dependencies": { "a": "^1.0.0" }, plain: "x", 9: "y" }'), false);
    expect(entries.map(e => e.pkg)).toEqual(['a']);
  });

  test.concurrent('empty / non-object / array roots yield no entries', () => {
    expect(findEntries(parse(''), false)).toEqual([]);
    expect(findEntries(parse('[1, 2]'), false)).toEqual([]);
    expect(findEntries(parse('"scalar"'), false)).toEqual([]);
  });

  test.concurrent('sentinels collected only with resolveSentinels', () => {
    const text = '{ "dependencies": { "a": "latest", "b": "^1.0.0" } }';
    expect(findEntries(parse(text), false).map(e => e.pkg)).toEqual(['b']);
    expect(findEntries(parse(text), true).map(e => e.pkg).sort()).toEqual(['a', 'b']);
  });
});

describe('propKey', () => {
  test.concurrent('reads the key of a string-named property', () => {
    const sf = parse('{ "dependencies": { "x": "^1.0.0" } }');
    const stmt = sf.statements[0];
    expect(stmt).toBeDefined();
    if (stmt !== undefined && ts.isExpressionStatement(stmt) && ts.isObjectLiteralExpression(stmt.expression)) {
      const first = stmt.expression.properties[0];
      if (first !== undefined && ts.isPropertyAssignment(first)) {
        expect(propKey(first)).toBe('dependencies');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// readWorkspacePatterns / readPackageName
// ---------------------------------------------------------------------------

describe('readWorkspacePatterns', () => {
  test.concurrent('array form', () => {
    expect(readWorkspacePatterns(parse('{ "workspaces": ["packages/*", "apps/*"] }'))).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });
  test.concurrent('object form reads `packages`', () => {
    expect(readWorkspacePatterns(parse('{ "workspaces": { "packages": ["packages/*"] } }'))).toEqual([
      'packages/*',
    ]);
  });
  test.concurrent('object form without `packages` -> []', () => {
    expect(readWorkspacePatterns(parse('{ "workspaces": { "catalog": {} } }'))).toEqual([]);
  });
  test.concurrent('non-array/non-object workspaces -> []', () => {
    expect(readWorkspacePatterns(parse('{ "workspaces": "oops" }'))).toEqual([]);
  });
  test.concurrent('absent workspaces / non-object root -> []', () => {
    expect(readWorkspacePatterns(parse('{ "name": "x" }'))).toEqual([]);
    expect(readWorkspacePatterns(parse('[1]'))).toEqual([]);
    expect(readWorkspacePatterns(parse(''))).toEqual([]);
  });
  test.concurrent('negation + multi-glob preserved verbatim', () => {
    expect(readWorkspacePatterns(parse('{ "workspaces": ["packages/*", "!packages/docs"] }'))).toEqual([
      'packages/*',
      '!packages/docs',
    ]);
  });
});

describe('readPackageName', () => {
  test.concurrent('reads string name or undefined', () => {
    expect(readPackageName(parse('{ "name": "@s/a" }'))).toBe('@s/a');
    expect(readPackageName(parse('{ "private": true }'))).toBeUndefined();
    expect(readPackageName(parse('{ "name": 123 }'))).toBeUndefined();
    expect(readPackageName(parse('[1]'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// discoverMemberFiles (real Bun.Glob over a per-test temp tree)
// ---------------------------------------------------------------------------

describe('discoverMemberFiles', () => {
  const TREE = {
    'package.json': '{}',
    'packages/a/package.json': '{}',
    'packages/b/package.json': '{}',
    'packages/docs/package.json': '{}',
    'apps/web/package.json': '{}',
    'tests/package.json': '{}',
    'packages/c/README.md': 'no package here',
  };
  const relOf = (dir: string, abs: string): string => abs.slice(dir.length + 1);

  test.concurrent('expands `*` globs, skipping dirs without a package.json', async () => {
    await withTree(TREE, async (dir) => {
      const found = (await discoverMemberFiles(dir, ['packages/*'])).map(p => relOf(dir, p));
      expect(found).toEqual([
        'packages/a/package.json',
        'packages/b/package.json',
        'packages/docs/package.json',
      ]);
    });
  });

  test.concurrent('handles literal member paths', async () => {
    await withTree(TREE, async (dir) => {
      const found = (await discoverMemberFiles(dir, ['apps/*', 'tests'])).map(p => relOf(dir, p));
      expect(found).toEqual(['apps/web/package.json', 'tests/package.json']);
    });
  });

  test.concurrent('honors `!` negation', async () => {
    await withTree(TREE, async (dir) => {
      const found = (await discoverMemberFiles(dir, ['packages/*', '!packages/docs'])).map(p =>
        relOf(dir, p),
      );
      expect(found).toEqual(['packages/a/package.json', 'packages/b/package.json']);
    });
  });

  test.concurrent('dedupes overlapping globs and returns absolute paths', async () => {
    await withTree(TREE, async (dir) => {
      const found = await discoverMemberFiles(dir, ['packages/*', 'packages/a']);
      expect(found.filter(p => p.endsWith('packages/a/package.json'))).toHaveLength(1);
      expect(found.every(p => p.startsWith(dir))).toBe(true);
    });
  });

  test.concurrent('drops the root package.json itself', async () => {
    await withTree(TREE, async (dir) => {
      const found = (await discoverMemberFiles(dir, ['**'])).map(p => relOf(dir, p));
      expect(found).not.toContain('package.json');
      expect(found).toContain('packages/a/package.json');
    });
  });

  test.concurrent('no matches -> []', async () => {
    await withTree(TREE, async (dir) => {
      expect(await discoverMemberFiles(dir, ['nonexistent/*'])).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// buildWorkFiles / collectMemberNames
// ---------------------------------------------------------------------------

describe('buildWorkFiles / collectMemberNames', () => {
  const ROOT = `{
  "name": "@w/root",
  "workspaces": ["packages/*"],
  "devDependencies": { "typescript": "^5.0.0" }
}`;
  const A = '{ "name": "@w/a", "dependencies": { "eslint": "^8.0.0" } }';
  const B = '{ "name": "@w/b", "dependencies": { "react": "^18.0.0" } }';

  test.concurrent('non-recursive -> root only', async () => {
    await withTree({ 'package.json': ROOT, 'packages/a/package.json': A }, async (dir) => {
      const wfs = await buildWorkFiles(join(dir, 'package.json'), false, false);
      expect(wfs).toHaveLength(1);
      expect(wfs[0]?.entries.map(e => e.pkg)).toEqual(['typescript']);
    });
  });

  test.concurrent('recursive array-form -> root + members, each with its own entries', async () => {
    await withTree(
      { 'package.json': ROOT, 'packages/a/package.json': A, 'packages/b/package.json': B },
      async (dir) => {
        const wfs = await buildWorkFiles(join(dir, 'package.json'), true, false);
        expect(wfs).toHaveLength(3);
        expect([...collectMemberNames(wfs)].sort()).toEqual(['@w/a', '@w/b', '@w/root']);
        expect(wfs.flatMap(w => w.entries.map(e => e.pkg)).sort()).toEqual([
          'eslint',
          'react',
          'typescript',
        ]);
      },
    );
  });

  test.concurrent('no workspaces -> root only', async () => {
    await withTree(
      { 'package.json': '{ "name": "solo", "dependencies": { "x": "^1.0.0" } }' },
      async (dir) => {
        expect(await buildWorkFiles(join(dir, 'package.json'), true, false)).toHaveLength(1);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// applyEdits / describeSource / formatting / unifyPrefix / mapConcurrent
// ---------------------------------------------------------------------------

describe('applyEdits', () => {
  test.concurrent('applies edits in descending order, preserving surrounding text', () => {
    const text = '{"a":"1","b":"2"}';
    const edits: Edit[] = [
      { start: 5, end: 8, replacement: JSON.stringify('X') },
      { start: 13, end: 16, replacement: JSON.stringify('Y') },
    ];
    expect(applyEdits(text, edits)).toBe('{"a":"X","b":"Y"}');
    expect(applyEdits(text, [...edits].reverse())).toBe('{"a":"X","b":"Y"}');
  });

  test.concurrent('no edits returns the original text', () => {
    expect(applyEdits('untouched', [])).toBe('untouched');
  });
});

describe('describeSource', () => {
  test.concurrent('labels each variant', () => {
    expect(describeSource({ kind: CATALOG_KIND })).toBe('catalog');
    expect(describeSource({ kind: NAMED_CATALOG_KIND, name: 'react18' })).toBe('catalogs.react18');
    expect(describeSource({ kind: DEPS_KIND, field: 'devDependencies' })).toBe('devDependencies');
  });
});

describe('detectIndentUnit / formatJsonArray / formatJsonObject', () => {
  test.concurrent('detectIndentUnit', () => {
    expect(detectIndentUnit('{\n  "a": 1\n}')).toBe('  ');
    expect(detectIndentUnit('{\n    "a": 1\n}')).toBe('    ');
    expect(detectIndentUnit('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndentUnit('{}')).toBe('  ');
  });

  test.concurrent('formatJsonArray', () => {
    expect(formatJsonArray([], '  ', '  ')).toBe('[]');
    expect(formatJsonArray(['packages/*'], '  ', '  ')).toBe('[\n    "packages/*"\n  ]');
  });

  test.concurrent('formatJsonObject', () => {
    expect(formatJsonObject([], '  ', '  ')).toBe('{}');
    expect(
      formatJsonObject(
        [
          ['a', '^1.0.0'],
          ['b', '~2.0.0'],
        ],
        '  ',
        '  ',
      ),
    ).toBe('{\n    "a": "^1.0.0",\n    "b": "~2.0.0"\n  }');
  });
});

describe('unifyPrefix', () => {
  test.concurrent('most-permissive wins', () => {
    expect(unifyPrefix(['^', '~'])).toBe('^');
    expect(unifyPrefix(['~', ''])).toBe('~');
    expect(unifyPrefix(['>='])).toBe('>=');
    expect(unifyPrefix([''])).toBe('');
    expect(unifyPrefix(['', '>='])).toBe('');
  });
});

describe('mapConcurrent', () => {
  test.concurrent('maps with a concurrency limit, preserving order', async () => {
    expect(await mapConcurrent([1, 2, 3, 4], 2, async (n) => {
      await Promise.resolve();
      return n * 10;
    })).toEqual([10, 20, 30, 40]);
    expect(await mapConcurrent([5], 10, async (n) => {
      await Promise.resolve();
      return n + 1;
    })).toEqual([6]);
    expect(await mapConcurrent<number, number>([], 5, async (n) => {
      await Promise.resolve();
      return n;
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Host effects — `bun` module mocked via `mock.module`, `console` via spyOn, installed/torn down
// through this parent describe's lifecycle hooks. These tests are serial (process-wide mock state).
// ---------------------------------------------------------------------------

describe('host effects', () => {
  let h!: ReturnType<typeof installHostMocks>;
  beforeEach(() => {
    h = installHostMocks();
  });
  afterEach(() => {
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // fetchLatest (real fn; the `bun` `fetch` it calls is mocked, dynamic per-call)
  // -------------------------------------------------------------------------

  describe('fetchLatest', () => {
    test('200 returns version and encodes scoped names with %2F', async () => {
      h.fetch.mockResolvedValueOnce(okResponse('9.9.9'));
      expect(await fetchLatest('@scope/pkg', 'next')).toBe('9.9.9');
      expect(h.fetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/@scope%2Fpkg/next',
        { headers: { accept: 'application/json' } },
      );
    });

    test('404 throws with status', async () => {
      h.fetch.mockResolvedValueOnce(notFound());
      await rejectsWith(fetchLatest('nope', 'latest'), '404');
    });

    test('rejects bodies without a string version (dynamic per-call queue)', async () => {
      h.fetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(Response.json({ version: 123 }))
        .mockResolvedValueOnce(new Response('null', { status: 200 }))
        .mockResolvedValueOnce(new Response('"juststring"', { status: 200 }));
      await rejectsWith(fetchLatest('a', 'latest'), 'No version');
      await rejectsWith(fetchLatest('b', 'latest'), 'No version');
      await rejectsWith(fetchLatest('c', 'latest'), 'No version');
      await rejectsWith(fetchLatest('d', 'latest'), 'No version');
    });
  });

  // -------------------------------------------------------------------------
  // run — normal update path
  // -------------------------------------------------------------------------

  describe('run (update)', () => {
    const ROOT = `{
  "name": "@it/root",
  "workspaces": [
    "packages/*"
  ],
  "devDependencies": {
    "typescript": "^5.0.0",
    "already": "^9.9.9"
  }
}`;
    const A = `{
  "name": "@it/a",
  "dependencies": {
    "eslint": "^8.0.0",
    "@it/b": "^1.0.0",
    "left-pad": "catalog:",
    "react": "workspace:*",
    "stay": "latest"
  }
}`;
    const B = `{
  "name": "@it/b",
  "dependencies": {
    "eslint": "^8.0.0",
    "broken-pkg": "^1.0.0"
  }
}`;
    const TREE = { 'package.json': ROOT, 'packages/a/package.json': A, 'packages/b/package.json': B };
    const VERSIONS = { typescript: '9.9.9', already: '9.9.9', eslint: '9.9.9' };

    test('recursively bumps members, dedupes fetches, skips internal/protocol/sentinel', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS, ['broken-pkg']));
        const res = await run(opts({ file: join(dir, 'package.json') }));

        expect(res.changed).toBe(3); // typescript + eslint(a) + eslint(b)
        expect(res.skipped).toBe(1); // already @ ^9.9.9
        expect(res.failed).toBe(1); // broken-pkg
        expect(res.filesWritten).toHaveLength(3);
        expect(res.installExitCode).toBeNull();
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0]).toContain('broken-pkg');

        // unique packages only: typescript, already, eslint, broken-pkg (eslint deduped across 2 files)
        expect(h.fetch).toHaveBeenCalledTimes(4);
        expect(h.write).toHaveBeenCalledTimes(3);
        expect(h.spawn).not.toHaveBeenCalled();

        const aPath = join(dir, 'packages/a/package.json');
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"eslint": "^9.9.9"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"@it/b": "^1.0.0"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"left-pad": "catalog:"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"react": "workspace:*"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"stay": "latest"'));
      });
    });

    test('--dry-run writes nothing and never spawns install', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS, ['broken-pkg']));
        const res = await run(opts({ file: join(dir, 'package.json'), dryRun: true }));
        expect(res.changed).toBe(3);
        expect(res.filesWritten).toEqual([]);
        expect(h.write).not.toHaveBeenCalled();
        expect(h.spawn).not.toHaveBeenCalled();
      });
    });

    test('runs a single install at the root when changes are written', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS, ['broken-pkg']));
        const res = await run(opts({ file: join(dir, 'package.json'), install: true }));
        expect(h.spawn).toHaveBeenCalledTimes(1);
        expect(h.spawn).toHaveBeenCalledWith(['bun', 'install'], expect.objectContaining({ cwd: dir }));
        expect(res.installExitCode).toBe(0);
      });
    });

    test('a non-zero install exit is surfaced as installExitCode', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS, ['broken-pkg']));
        h.spawn.mockReturnValue(PROC_FAIL);
        const res = await run(opts({ file: join(dir, 'package.json'), install: true }));
        expect(h.spawn).toHaveBeenCalledTimes(1);
        expect(res.installExitCode).toBe(1);
      });
    });

    test('--only filters which packages are fetched and bumped', async () => {
      await withTree(
        { 'package.json': '{ "name": "x", "devDependencies": { "typescript": "^5.0.0", "eslint": "^8.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ typescript: '9.9.9', eslint: '9.9.9' }));
          const res = await run(
            opts({ file: join(dir, 'package.json'), recursive: false, only: /typescript/ }),
          );
          expect(res.changed).toBe(1);
          expect(h.fetch).toHaveBeenCalledTimes(1);
        },
      );
    });

    test('reports nothing to do when no bumpable entries exist', async () => {
      await withTree(
        { 'package.json': '{ "name": "solo", "dependencies": { "a": "workspace:*", "b": "catalog:" } }' },
        async (dir) => {
          const res = await run(opts({ file: join(dir, 'package.json'), recursive: false }));
          expect(res).toStrictEqual({
            changed: 0,
            skipped: 0,
            failed: 0,
            filesWritten: [],
            installExitCode: null,
            warnings: [],
          });
          expect(h.fetch).not.toHaveBeenCalled();
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // run — --to-catalog migration path
  // -------------------------------------------------------------------------

  describe('run (--to-catalog)', () => {
    const ARRAY_ROOT = `{
  "name": "@cat/root",
  "workspaces": [
    "packages/*"
  ]
}`;
    const A = `{
  "name": "@cat/a",
  "dependencies": {
    "eslint": "^8.0.0",
    "typescript": "^5.0.0",
    "@cat/b": "workspace:*"
  }
}`;
    const B = `{
  "name": "@cat/b",
  "dependencies": {
    "eslint": "^9.0.0",
    "lodash": "~4.0.0"
  }
}`;
    const TREE = { 'package.json': ARRAY_ROOT, 'packages/a/package.json': A, 'packages/b/package.json': B };
    const VERSIONS = { eslint: '9.9.9', typescript: '9.9.9', lodash: '9.9.9' };

    test('array-form: rewrites workspaces to a sorted catalog, unifies conflicts, rewrites members', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS));
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));

        expect(res.changed).toBe(4); // eslint x2 + typescript + lodash
        expect(res.failed).toBe(0);
        expect(res.warnings).toHaveLength(1); // eslint ^8 | ^9 conflict
        expect(res.warnings[0]).toContain('eslint');

        expect(h.write).toHaveBeenCalledWith(join(dir, 'package.json'), `{
  "name": "@cat/root",
  "workspaces": {
    "packages": [
      "packages/*"
    ],
    "catalog": {
      "eslint": "^9.9.9",
      "lodash": "~9.9.9",
      "typescript": "^9.9.9"
    }
  }
}`);

        const aPath = join(dir, 'packages/a/package.json');
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"eslint": "catalog:"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"typescript": "catalog:"'));
        expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"@cat/b": "workspace:*"'));

        const bPath = join(dir, 'packages/b/package.json');
        expect(h.write).toHaveBeenCalledWith(bPath, expect.stringContaining('"eslint": "catalog:"'));
        expect(h.write).toHaveBeenCalledWith(bPath, expect.stringContaining('"lodash": "catalog:"'));
      });
    });

    test('--dry-run writes nothing', async () => {
      await withTree(TREE, async (dir) => {
        h.fetch.mockImplementation(registryFrom(VERSIONS));
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }));
        expect(res.changed).toBe(4);
        expect(h.write).not.toHaveBeenCalled();
      });
    });

    test('a fetch failure leaves that dependency untouched and uncatalogued', async () => {
      await withTree(
        {
          'package.json': ARRAY_ROOT,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "good": "^1.0.0", "bad": "^1.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ good: '9.9.9' }, ['bad']));
          const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));

          expect(res.failed).toBe(1);
          expect(res.changed).toBe(1);
          expect(res.warnings.some(w => w.includes('bad'))).toBe(true);

          expect(h.write).toHaveBeenCalledWith(join(dir, 'package.json'), expect.stringContaining('"good": "^9.9.9"'));
          expect(h.write).not.toHaveBeenCalledWith(join(dir, 'package.json'), expect.stringContaining('"bad"'));
          const aPath = join(dir, 'packages/a/package.json');
          expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"good": "catalog:"'));
          expect(h.write).toHaveBeenCalledWith(aPath, expect.stringContaining('"bad": "^1.0.0"'));
        },
      );
    });

    test('object-form without a catalog inserts one', async () => {
      await withTree(
        {
          'package.json': `{
  "name": "@cat/root",
  "workspaces": {
    "packages": [
      "packages/*"
    ]
  }
}`,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ lodash: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));
          const rootPath = join(dir, 'package.json');
          expect(h.write).toHaveBeenCalledWith(rootPath, expect.stringContaining('"catalog": {'));
          expect(h.write).toHaveBeenCalledWith(rootPath, expect.stringContaining('"lodash": "^9.9.9"'));
          expect(h.write).toHaveBeenCalledWith(rootPath, expect.stringContaining('"packages": ['));
        },
      );
    });

    test('object-form with an existing catalog merges only missing entries', async () => {
      await withTree(
        {
          'package.json': `{
  "name": "@cat/root",
  "workspaces": {
    "packages": [
      "packages/*"
    ],
    "catalog": {
      "eslint": "^9.9.9"
    }
  }
}`,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "catalog:", "lodash": "^4.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ lodash: '9.9.9' }));
          const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));
          expect(res.changed).toBe(1);
          const rootPath = join(dir, 'package.json');
          expect(h.write).toHaveBeenCalledWith(rootPath, expect.stringContaining('"eslint": "^9.9.9"'));
          expect(h.write).toHaveBeenCalledWith(rootPath, expect.stringContaining('"lodash": "^9.9.9"'));
        },
      );
    });

    test('object-form with an empty catalog populates it', async () => {
      await withTree(
        {
          'package.json': '{ "name": "@cat/root", "workspaces": { "packages": ["packages/*"], "catalog": {} } }',
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ lodash: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));
          expect(h.write).toHaveBeenCalledWith(join(dir, 'package.json'), expect.stringContaining('"lodash": "^9.9.9"'));
        },
      );
    });

    test('does not duplicate a catalog entry that already exists', async () => {
      await withTree(
        {
          'package.json': `{
  "name": "@cat/root",
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": { "lodash": "^9.9.9" }
  }
}`,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ lodash: '9.9.9' }));
          const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));
          expect(res.changed).toBe(1); // member lodash normalized to catalog:
          expect(h.write).toHaveBeenCalledTimes(1); // root already has the entry → only the member is written
          expect(h.write).toHaveBeenCalledWith(
            join(dir, 'packages/a/package.json'),
            expect.stringContaining('"lodash": "catalog:"'),
          );
        },
      );
    });

    test('runs a single install at the root after migrating when --install is set', async () => {
      await withTree(
        {
          'package.json': ARRAY_ROOT,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ lodash: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), toCatalog: true, install: true }));
          expect(h.spawn).toHaveBeenCalledTimes(1);
          expect(h.spawn).toHaveBeenCalledWith(['bun', 'install'], expect.objectContaining({ cwd: dir }));
        },
      );
    });

    test('is idempotent: an already-catalogued workspace is a no-op', async () => {
      await withTree(
        {
          'package.json': `{
  "name": "@cat/root",
  "workspaces": {
    "packages": ["packages/*"],
    "catalog": { "eslint": "^9.9.9" }
  }
}`,
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "catalog:" } }',
        },
        async (dir) => {
          const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }));
          expect(res.changed).toBe(0);
          expect(h.write).not.toHaveBeenCalled();
          expect(h.fetch).not.toHaveBeenCalled();
        },
      );
    });

    test('errors when the target is not a workspace', async () => {
      await withTree(
        { 'package.json': '{ "name": "solo", "dependencies": { "x": "^1.0.0" } }' },
        async (dir) => {
          await rejectsWith(
            run(opts({ file: join(dir, 'package.json'), toCatalog: true })),
            'workspaces',
          );
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // main — entry shell (returns an exit code; no process.* mutation)
  // -------------------------------------------------------------------------

  describe('main', () => {
    test('parses argv, runs (dry-run) and returns 0', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ typescript: '9.9.9' }));
          const code = await main([join(dir, 'package.json'), '--dry-run', '--no-recursive']);
          expect(code).toBe(0);
          expect(h.write).not.toHaveBeenCalled();
          expect(h.spawn).not.toHaveBeenCalled();
        },
      );
    });

    test('returns 1 when the target file is missing', async () => {
      await withTree({ 'package.json': '{}' }, async (dir) => {
        const code = await main([join(dir, 'missing', 'package.json')]);
        expect(code).toBe(1);
        expect(h.error).toHaveBeenCalledWith(expect.stringContaining('Not found:'));
      });
    });

    test('propagates a non-zero install exit code', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ typescript: '9.9.9' }));
          h.spawn.mockReturnValue(PROC_FAIL);
          const code = await main([join(dir, 'package.json')]);
          expect(code).toBe(1);
          expect(h.spawn).toHaveBeenCalledTimes(1);
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Terminal output — the real `console.*` invocations, spied and asserted with
  // `toHaveBeenCalledWith(stringContaining(...))`. The output IS the subject here.
  // -------------------------------------------------------------------------

  describe('terminal output', () => {
    test('runUpdate: header, per-bump line, and summary go to log; nothing to warn/error', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0", "eslint": "^8.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ typescript: '9.9.9', eslint: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), dryRun: true }));

          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Checking 2 package(s) across 1 file(s)…'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('typescript: ^5.0.0 → ^9.9.9'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('eslint: ^8.0.0 → ^9.9.9'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('2 changed · 0 already current · 0 failed'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('(dry-run) no files written'));
          expect(h.warn).not.toHaveBeenCalled();
          expect(h.error).not.toHaveBeenCalled();
        },
      );
    });

    test('runUpdate: empty plan prints "No bumpable entries" and fetches nothing', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "typescript": "latest" } }' },
        async (dir) => {
          await run(opts({ file: join(dir, 'package.json'), dryRun: true }));

          expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`No bumpable entries in ${join(dir, 'package.json')}`));
          expect(h.fetch).not.toHaveBeenCalled();
          expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining('(dry-run)'));
          expect(h.warn).not.toHaveBeenCalled();
          expect(h.error).not.toHaveBeenCalled();
        },
      );
    });

    test('runUpdate: a fetch failure prints ✗ to warn; others still bump to log', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "good": "^1.0.0", "bad": "^1.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ good: '9.9.9' }, ['bad']));
          await run(opts({ file: join(dir, 'package.json'), dryRun: true }));

          expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('✗'));
          expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('bad'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('good: ^1.0.0 → ^9.9.9'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('1 changed · 0 already current · 1 failed'));
        },
      );
    });

    test('runUpdate: a real write run logs "Running bun install…" and installs', async () => {
      await withTree(
        { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ typescript: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), install: true }));

          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Running bun install…'));
          expect(h.spawn).toHaveBeenCalledTimes(1);
          expect(h.write).toHaveBeenCalledTimes(1);
          expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining('(dry-run)'));
        },
      );
    });

    test('runToCatalog: logs "+ catalog ·" rows + summary, "!" conflicts to warn', async () => {
      await withTree(
        {
          'package.json': '{ "name": "@cat/root", "workspaces": ["packages/*"] }',
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "^8.0.0" } }',
          'packages/b/package.json': '{ "name": "@cat/b", "dependencies": { "eslint": "^9.0.0" } }',
        },
        async (dir) => {
          h.fetch.mockImplementation(registryFrom({ eslint: '9.9.9' }));
          await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }));

          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('+ catalog · eslint: ^9.9.9'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('1 catalog entries · 2 refs → "catalog:" · 0 failed'));
          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('(dry-run) no files written'));
          expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('!'));
          expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('eslint'));
        },
      );
    });

    test('runToCatalog: an already-catalog tree logs "Nothing to convert"', async () => {
      await withTree(
        {
          'package.json':
            '{ "name": "@cat/root", "workspaces": { "packages": ["packages/*"], "catalog": { "eslint": "^9.9.9" } } }',
          'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "catalog:" } }',
        },
        async (dir) => {
          await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }));

          expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Nothing to convert (already catalog-based?).'));
          expect(h.write).not.toHaveBeenCalled();
        },
      );
    });

    test('main: a missing file prints "Not found:" to error and returns 1', async () => {
      await withTree({ 'package.json': '{}' }, async (dir) => {
        const missing = join(dir, 'missing', 'package.json');
        const code = await main([missing]);

        expect(code).toBe(1);
        expect(h.error).toHaveBeenCalledWith(expect.stringContaining(`Not found: ${missing}`));
        expect(h.write).not.toHaveBeenCalled();
      });
    });
  });
});
