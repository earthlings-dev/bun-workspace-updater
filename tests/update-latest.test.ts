// Single test file. Every test is `test.concurrent` and touches NO shared process-global state:
// host effects (network/writes/install) are injected as per-test `mock()`s through the `io` boundary,
// terminal output is injected as a per-test capturing `Console` (so even output assertions touch no
// global), `fetchLatest`'s network is injected as `doFetch`, `main` is called with explicit argv + io,
// and each FS test gets its OWN `mkdtemp` dir. So the suite is safe under `bun test --parallel
// --concurrent` (= `bun run test`) — no global `spyOn`, no `mock.module`, no `test.serial`. One file
// keeps `--parallel` a single worker so coverage merges.
import { describe, expect, mock, test } from 'bun:test';
import { Console } from 'node:console';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';

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

// ---------------------------------------------------------------------------
// Helpers (all per-test; no shared mutable state)
// ---------------------------------------------------------------------------

function parse(text: string): ts.JsonSourceFile {
  return ts.parseJsonText('test.json', text);
}

/** Create an isolated temp tree, run `fn` against it, and always clean up. Returns `fn`'s result. */
async function withTree<T>(
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'wsu-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await Bun.write(join(dir, rel), content);
    }
    return await fn(dir);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A `Writable` that appends every chunk to `sink` — a per-test, in-memory capture (no real stream). */
function capturingStream(sink: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      sink.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  });
}

/**
 * A per-test injected `HostIo`: deterministic registry, no-op write, fake install, and a REAL
 * captured `Console` (`new Console` over capturing streams). All collaborators are local to the call
 * — nothing global is spied — so the suite stays `--concurrent`/`--parallel` safe AND no CLI line
 * ever leaks to the real terminal. `stdout()`/`stderr()` return the captured text so tests assert
 * printed output by stream (log/info → stdout; warn/error → stderr) without touching a global.
 */
function makeIo(
  versions: Readonly<Record<string, string>>,
  options: { readonly failOn?: ReadonlySet<string>; readonly installExit?: number } = {},
) {
  const failOn = options.failOn ?? new Set<string>();
  const fetchLatest = mock(async (pkg: string): Promise<string> => {
    if (failOn.has(pkg)) {
      throw new Error(`GET https://registry.npmjs.org/${pkg}/latest → 404 Not Found`);
    }
    const v = versions[pkg];
    if (v === undefined) {
      throw new Error(`No version field on ${pkg}`);
    }
    return v;
  });
  const write = mock(async () => 0);
  const spawn = mock(() => ({ exited: Promise.resolve(options.installExit ?? 0) }));
  const out: string[] = [];
  const err: string[] = [];
  const console = new Console({ stdout: capturingStream(out), stderr: capturingStream(err) });
  return {
    fetchLatest,
    write,
    spawn,
    console,
    stdout: (): string => out.join(''),
    stderr: (): string => err.join(''),
  };
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
    expect(await mapConcurrent([1, 2, 3, 4], 2, async n => n * 10)).toEqual([10, 20, 30, 40]);
    expect(await mapConcurrent([5], 10, async n => n + 1)).toEqual([6]);
    expect(await mapConcurrent<number, number>([], 5, async n => n)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchLatest (real fn, injected `doFetch`)
// ---------------------------------------------------------------------------

describe('fetchLatest', () => {
  test.concurrent('200 returns version and encodes scoped names with %2F', async () => {
    let seen = '';
    const doFetch = mock(async (input: unknown): Promise<Response> => {
      seen = String(input);
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
    });
    expect(await fetchLatest('@scope/pkg', 'next', doFetch)).toBe('9.9.9');
    expect(seen).toContain('@scope%2Fpkg');
    expect(seen).toContain('/next');
  });

  test.concurrent('404 throws with status', async () => {
    const doFetch = mock(async (): Promise<Response> => new Response('x', { status: 404, statusText: 'Not Found' }));
    await expect(fetchLatest('nope', 'latest', doFetch)).rejects.toThrow('404');
  });

  test.concurrent('rejects bodies without a string version', async () => {
    const noField = mock(async (): Promise<Response> => new Response('{}', { status: 200 }));
    await expect(fetchLatest('a', 'latest', noField)).rejects.toThrow('No version');

    const numberVersion = mock(
      async (): Promise<Response> => new Response(JSON.stringify({ version: 123 }), { status: 200 }),
    );
    await expect(fetchLatest('b', 'latest', numberVersion)).rejects.toThrow('No version');

    const nullBody = mock(async (): Promise<Response> => new Response('null', { status: 200 }));
    await expect(fetchLatest('c', 'latest', nullBody)).rejects.toThrow('No version');

    const stringBody = mock(async (): Promise<Response> => new Response('"juststring"', { status: 200 }));
    await expect(fetchLatest('d', 'latest', stringBody)).rejects.toThrow('No version');
  });
});

// ---------------------------------------------------------------------------
// run — normal update path
// ---------------------------------------------------------------------------

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

  test.concurrent('recursively bumps members, dedupes fetches, skips internal/protocol/sentinel', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS, { failOn: new Set(['broken-pkg']) });
      const res = await run(opts({ file: join(dir, 'package.json') }), io);

      expect(res.changed).toBe(3); // typescript + eslint(a) + eslint(b)
      expect(res.skipped).toBe(1); // already @ ^9.9.9
      expect(res.failed).toBe(1); // broken-pkg
      expect(res.filesWritten).toHaveLength(3);
      expect(res.installExitCode).toBeNull();
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain('broken-pkg');

      // unique packages only: typescript, already, eslint, broken-pkg (eslint deduped across 2 files)
      expect(io.fetchLatest).toHaveBeenCalledTimes(4);
      expect(io.write).toHaveBeenCalledTimes(3);
      expect(io.spawn).not.toHaveBeenCalled();

      const aWrite = io.write.mock.calls.find(c => c[0] === join(dir, 'packages/a/package.json'));
      const aText = String(aWrite?.[1]);
      expect(aText).toContain('"eslint": "^9.9.9"');
      expect(aText).toContain('"@it/b": "^1.0.0"'); // internal member ref left intact
      expect(aText).toContain('"left-pad": "catalog:"');
      expect(aText).toContain('"react": "workspace:*"');
      expect(aText).toContain('"stay": "latest"');
    });
  });

  test.concurrent('--dry-run writes nothing and never spawns install', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS, { failOn: new Set(['broken-pkg']) });
      const res = await run(opts({ file: join(dir, 'package.json'), dryRun: true }), io);
      expect(res.changed).toBe(3);
      expect(res.filesWritten).toEqual([]);
      expect(io.write).not.toHaveBeenCalled();
      expect(io.spawn).not.toHaveBeenCalled();
    });
  });

  test.concurrent('runs a single install at the root when changes are written', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS, { failOn: new Set(['broken-pkg']) });
      const res = await run(opts({ file: join(dir, 'package.json'), install: true }), io);
      expect(io.spawn).toHaveBeenCalledTimes(1);
      expect(io.spawn.mock.calls[0]?.[0]).toEqual(['bun', 'install']);
      expect(io.spawn.mock.calls[0]?.[1]?.cwd).toBe(dir);
      expect(res.installExitCode).toBe(0);
    });
  });

  test.concurrent('a non-zero install exit is surfaced as installExitCode', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS, { failOn: new Set(['broken-pkg']), installExit: 1 });
      const res = await run(opts({ file: join(dir, 'package.json'), install: true }), io);
      expect(res.installExitCode).toBe(1);
    });
  });

  test.concurrent('--only filters which packages are fetched and bumped', async () => {
    await withTree(
      { 'package.json': '{ "name": "x", "devDependencies": { "typescript": "^5.0.0", "eslint": "^8.0.0" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9', eslint: '9.9.9' });
        const res = await run(
          opts({ file: join(dir, 'package.json'), recursive: false, only: /typescript/ }),
          io,
        );
        expect(res.changed).toBe(1);
        expect(io.fetchLatest).toHaveBeenCalledTimes(1);
      },
    );
  });

  test.concurrent('reports nothing to do when no bumpable entries exist', async () => {
    await withTree(
      { 'package.json': '{ "name": "solo", "dependencies": { "a": "workspace:*", "b": "catalog:" } }' },
      async (dir) => {
        const io = makeIo({});
        const res = await run(opts({ file: join(dir, 'package.json'), recursive: false }), io);
        expect(res).toEqual({
          changed: 0,
          skipped: 0,
          failed: 0,
          filesWritten: [],
          installExitCode: null,
          warnings: [],
        });
        expect(io.fetchLatest).not.toHaveBeenCalled();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// run — --to-catalog migration path
// ---------------------------------------------------------------------------

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

  test.concurrent('array-form: rewrites workspaces to a sorted catalog, unifies conflicts, rewrites members', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS);
      const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);

      expect(res.changed).toBe(4); // eslint x2 + typescript + lodash
      expect(res.failed).toBe(0);
      expect(res.warnings).toHaveLength(1); // eslint ^8 | ^9 conflict
      expect(res.warnings[0]).toContain('eslint');

      const rootText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))?.[1]);
      expect(rootText).toBe(`{
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

      const aText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'packages/a/package.json'))?.[1]);
      expect(aText).toContain('"eslint": "catalog:"');
      expect(aText).toContain('"typescript": "catalog:"');
      expect(aText).toContain('"@cat/b": "workspace:*"');

      const bText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'packages/b/package.json'))?.[1]);
      expect(bText).toContain('"eslint": "catalog:"');
      expect(bText).toContain('"lodash": "catalog:"');
    });
  });

  test.concurrent('--dry-run writes nothing', async () => {
    await withTree(TREE, async (dir) => {
      const io = makeIo(VERSIONS);
      const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }), io);
      expect(res.changed).toBe(4);
      expect(io.write).not.toHaveBeenCalled();
    });
  });

  test.concurrent('a fetch failure leaves that dependency untouched and uncatalogued', async () => {
    await withTree(
      {
        'package.json': ARRAY_ROOT,
        'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "good": "^1.0.0", "bad": "^1.0.0" } }',
      },
      async (dir) => {
        const io = makeIo({ good: '9.9.9' }, { failOn: new Set(['bad']) });
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);

        expect(res.failed).toBe(1);
        expect(res.changed).toBe(1);
        expect(res.warnings.some(w => w.includes('bad'))).toBe(true);

        const rootText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))?.[1]);
        expect(rootText).toContain('"good": "^9.9.9"');
        expect(rootText).not.toContain('"bad"');
        const aText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'packages/a/package.json'))?.[1]);
        expect(aText).toContain('"good": "catalog:"');
        expect(aText).toContain('"bad": "^1.0.0"');
      },
    );
  });

  test.concurrent('object-form without a catalog inserts one', async () => {
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
        const io = makeIo({ lodash: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);
        const rootText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))?.[1]);
        expect(rootText).toContain('"catalog": {');
        expect(rootText).toContain('"lodash": "^9.9.9"');
        expect(rootText).toContain('"packages": [');
      },
    );
  });

  test.concurrent('object-form with an existing catalog merges only missing entries', async () => {
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
        const io = makeIo({ lodash: '9.9.9' });
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);
        expect(res.changed).toBe(1);
        const rootText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))?.[1]);
        expect(rootText).toContain('"eslint": "^9.9.9"');
        expect(rootText).toContain('"lodash": "^9.9.9"');
      },
    );
  });

  test.concurrent('object-form with an empty catalog populates it', async () => {
    await withTree(
      {
        'package.json': '{ "name": "@cat/root", "workspaces": { "packages": ["packages/*"], "catalog": {} } }',
        'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
      },
      async (dir) => {
        const io = makeIo({ lodash: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);
        const rootText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))?.[1]);
        expect(rootText).toContain('"lodash": "^9.9.9"');
      },
    );
  });

  test.concurrent('does not duplicate a catalog entry that already exists', async () => {
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
        const io = makeIo({ lodash: '9.9.9' });
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);
        expect(res.changed).toBe(1); // member lodash normalized to catalog:
        expect(io.write.mock.calls.find(c => c[0] === join(dir, 'package.json'))).toBeUndefined();
        const aText = String(io.write.mock.calls.find(c => c[0] === join(dir, 'packages/a/package.json'))?.[1]);
        expect(aText).toContain('"lodash": "catalog:"');
      },
    );
  });

  test.concurrent('runs a single install at the root after migrating when --install is set', async () => {
    await withTree(
      {
        'package.json': ARRAY_ROOT,
        'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "lodash": "^4.0.0" } }',
      },
      async (dir) => {
        const io = makeIo({ lodash: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), toCatalog: true, install: true }), io);
        expect(io.spawn).toHaveBeenCalledTimes(1);
        expect(io.spawn.mock.calls[0]?.[0]).toEqual(['bun', 'install']);
        expect(io.spawn.mock.calls[0]?.[1]?.cwd).toBe(dir);
      },
    );
  });

  test.concurrent('is idempotent: an already-catalogued workspace is a no-op', async () => {
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
        const io = makeIo({});
        const res = await run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io);
        expect(res.changed).toBe(0);
        expect(io.write).not.toHaveBeenCalled();
        expect(io.fetchLatest).not.toHaveBeenCalled();
      },
    );
  });

  test.concurrent('errors when the target is not a workspace', async () => {
    await withTree(
      { 'package.json': '{ "name": "solo", "dependencies": { "x": "^1.0.0" } }' },
      async (dir) => {
        const io = makeIo({});
        await expect(run(opts({ file: join(dir, 'package.json'), toCatalog: true }), io)).rejects.toThrow(
          'workspaces',
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// main — entry shell (returns an exit code; no process.* mutation)
// ---------------------------------------------------------------------------

describe('main', () => {
  test.concurrent('parses argv, runs (dry-run) and returns 0', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9' });
        const code = await main([join(dir, 'package.json'), '--dry-run', '--no-recursive'], io);
        expect(code).toBe(0);
        expect(io.write).not.toHaveBeenCalled();
        expect(io.spawn).not.toHaveBeenCalled();
      },
    );
  });

  test.concurrent('returns 1 when the target file is missing', async () => {
    await withTree({ 'package.json': '{}' }, async (dir) => {
      const io = makeIo({});
      const code = await main([join(dir, 'missing', 'package.json')], io);
      expect(code).toBe(1);
    });
  });

  test.concurrent('propagates a non-zero install exit code', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9' }, { installExit: 1 });
        const code = await main([join(dir, 'package.json')], io);
        expect(code).toBe(1);
        expect(io.spawn).toHaveBeenCalledTimes(1);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Terminal output — captured through the injected real `Console`. The output IS
// the subject here; we assert the captured stream text (log/info → stdout,
// warn/error → stderr) from a per-test `new Console`, never by spying the shared
// global (which would race under --concurrent/--parallel and leak to the real
// terminal). No assertion touches a global.
// ---------------------------------------------------------------------------

describe('terminal output (captured via the injected Console)', () => {
  test.concurrent('runUpdate: header, per-bump ↑ line, and summary go to stdout; stderr stays empty', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0", "eslint": "^8.0.0" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9', eslint: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), dryRun: true }), io);

        expect(io.stdout()).toContain('Checking 2 package(s) across 1 file(s)…');
        expect(io.stdout()).toContain('typescript: ^5.0.0 → ^9.9.9');
        expect(io.stdout()).toContain('eslint: ^8.0.0 → ^9.9.9');
        expect(io.stdout()).toContain('2 changed · 0 already current · 0 failed');
        expect(io.stdout()).toContain('(dry-run) no files written');
        expect(io.stderr()).toBe('');
      },
    );
  });

  test.concurrent('runUpdate: empty plan prints "No bumpable entries" and fetches nothing', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "typescript": "latest" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), dryRun: true }), io);

        expect(io.stdout()).toContain(`No bumpable entries in ${join(dir, 'package.json')}`);
        expect(io.fetchLatest).not.toHaveBeenCalled();
        expect(io.stdout()).not.toContain('(dry-run)');
        expect(io.stderr()).toBe('');
      },
    );
  });

  test.concurrent('runUpdate: a fetch failure prints ✗ to stderr; others still ↑ to stdout', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "good": "^1.0.0", "bad": "^1.0.0" } }' },
      async (dir) => {
        const io = makeIo({ good: '9.9.9' }, { failOn: new Set(['bad']) });
        await run(opts({ file: join(dir, 'package.json'), dryRun: true }), io);

        expect(io.stderr()).toContain('✗');
        expect(io.stderr()).toContain('bad');
        expect(io.stdout()).toContain('good: ^1.0.0 → ^9.9.9');
        expect(io.stdout()).not.toContain('bad:');
        expect(io.stdout()).toContain('1 changed · 0 already current · 1 failed');
      },
    );
  });

  test.concurrent('runUpdate: a real write run prints "Running bun install…" to stdout and spawns install', async () => {
    await withTree(
      { 'package.json': '{ "name": "m", "dependencies": { "typescript": "^5.0.0" } }' },
      async (dir) => {
        const io = makeIo({ typescript: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), install: true }), io);

        expect(io.stdout()).toContain('Running bun install…');
        expect(io.spawn).toHaveBeenCalledTimes(1);
        expect(io.write).toHaveBeenCalledTimes(1);
        expect(io.stdout()).not.toContain('(dry-run)');
      },
    );
  });

  test.concurrent('runToCatalog: prints "+ catalog ·" rows + summary to stdout, "!" conflicts to stderr', async () => {
    await withTree(
      {
        'package.json': '{ "name": "@cat/root", "workspaces": ["packages/*"] }',
        'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "^8.0.0" } }',
        'packages/b/package.json': '{ "name": "@cat/b", "dependencies": { "eslint": "^9.0.0" } }',
      },
      async (dir) => {
        const io = makeIo({ eslint: '9.9.9' });
        await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }), io);

        expect(io.stdout()).toContain('+ catalog · eslint: ^9.9.9');
        expect(io.stdout()).toContain('1 catalog entries · 2 refs → "catalog:" · 0 failed');
        expect(io.stdout()).toContain('(dry-run) no files written');
        expect(io.stderr()).toContain('!');
        expect(io.stderr()).toContain('eslint');
      },
    );
  });

  test.concurrent('runToCatalog: an already-catalog tree prints "Nothing to convert"', async () => {
    await withTree(
      {
        'package.json':
          '{ "name": "@cat/root", "workspaces": { "packages": ["packages/*"], "catalog": { "eslint": "^9.9.9" } } }',
        'packages/a/package.json': '{ "name": "@cat/a", "dependencies": { "eslint": "catalog:" } }',
      },
      async (dir) => {
        const io = makeIo({});
        await run(opts({ file: join(dir, 'package.json'), toCatalog: true, dryRun: true }), io);

        expect(io.stdout()).toContain('Nothing to convert (already catalog-based?).');
        expect(io.write).not.toHaveBeenCalled();
      },
    );
  });

  test.concurrent('main: a missing file prints "Not found:" to stderr and returns 1', async () => {
    await withTree({ 'package.json': '{}' }, async (dir) => {
      const io = makeIo({});
      const missing = join(dir, 'missing', 'package.json');
      const code = await main([missing], io);

      expect(code).toBe(1);
      expect(io.stderr()).toContain(`Not found: ${missing}`);
      expect(io.write).not.toHaveBeenCalled();
    });
  });
});
