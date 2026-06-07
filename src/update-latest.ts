/**
 * Catalog-aware, workspace-aware replacement for `bun update --latest`.
 *
 * Bumps version ranges inside `workspaces.catalog`, named `workspaces.catalogs.*`,
 * top-level `catalog`/`catalogs`, and direct pins in `dependencies` /
 * `devDependencies` / `peerDependencies` / `optionalDependencies`, while leaving
 * `'catalog:'`, `'workspace:*'`, `'link:*'`, `'file:*'`, `'portal:*'`, `'git+*'`,
 * `'http*'`, `'npm:*'`, path refs, and sentinels (`latest`/`next`/`*`/`x`/`X`/empty)
 * untouched by default.
 *
 * When the root `package.json` declares `workspaces`, member `package.json` files
 * are discovered via their declared globs (positive + `!` negation + literal paths)
 * and updated too, then a single `bun install` runs at the root.
 *
 * Formatting, key order, and any comments are preserved by editing the original
 * source text at positions reported by the TypeScript compiler's JSON AST
 * (`ts.parseJsonText`).
 *
 * Usage (the `lupdate` script aliases `bun run src/update-latest.ts`):
 *   bun run src/update-latest.ts                  # bump all eligible entries (recursive)
 *   bun run src/update-latest.ts --dry-run        # print changes, do not write
 *   bun run src/update-latest.ts --no-recursive   # root file only (-r / --recursive force on)
 *   bun run src/update-latest.ts --tag next       # use a different npm dist-tag
 *   bun run src/update-latest.ts --only @stylistic # regex filter on package names
 *   bun run src/update-latest.ts --resolve-sentinels # also pin latest/next/* /x ranges
 *   bun run src/update-latest.ts --to-catalog     # migrate array-form workspace deps into a catalog
 *   bun run src/update-latest.ts --no-install     # skip `bun install` at the end
 *   bun run src/update-latest.ts path/to/package.json
 */
import { dirname, resolve } from 'node:path';

import { fetch, spawn, write } from 'bun';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/** Parsed CLI options. See {@link parseArgs} for the flag that populates each field. */
export interface Options {
  readonly file: string;
  readonly tag: string;
  readonly dryRun: boolean;
  readonly install: boolean;
  readonly only: RegExp | undefined;
  readonly recursive: boolean;
  readonly resolveSentinels: boolean;
  readonly toCatalog: boolean;
}

/**
 * Parse argv into {@link Options}. Recognizes `--dry-run`, `--no-install`,
 * `--no-recursive`, `-r`/`--recursive`, `--resolve-sentinels`, `--to-catalog`,
 * `--tag <tag>`, and `--only <regex>`, plus a single positional `package.json`
 * path (defaulting to the repo-root file). Throws on any unknown `--flag`; `-r`
 * is handled before the positional branch so it is never mistaken for a path.
 */
export function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let tag = 'latest';
  let dryRun = false;
  let install = true;
  let only: RegExp | undefined;
  let recursive = true;
  let resolveSentinels = false;
  let toCatalog = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    }
    else if (arg === '--no-install') {
      install = false;
    }
    else if (arg === '--no-recursive') {
      recursive = false;
    }
    else if (arg === '--recursive' || arg === '-r') {
      recursive = true;
    }
    else if (arg === '--resolve-sentinels') {
      resolveSentinels = true;
    }
    else if (arg === '--to-catalog') {
      toCatalog = true;
    }
    else if (arg === '--tag') {
      tag = argv[++i] ?? 'latest';
    }
    else if (arg === '--only') {
      only = new RegExp(argv[++i] ?? '');
    }
    else if (arg !== undefined && arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    else if (arg !== undefined && arg.length > 0) {
      file = arg;
    }
  }

  const repoRoot = resolve(import.meta.dir, '..');
  return {
    file: file !== undefined ? resolve(file) : resolve(repoRoot, 'package.json'),
    tag,
    dryRun,
    install,
    only,
    recursive,
    resolveSentinels,
    toCatalog,
  };
}

// ---------------------------------------------------------------------------
// Entry model — named discriminated-union variants with shared discriminants
// ---------------------------------------------------------------------------

// Each dependency-field name is ONE named definition, referenced by the type (`typeof`) AND the
// `DEP_FIELDS` array — never a bare string literal duplicated between the union and the array. A
// top-level `const` already infers the literal type, so no annotation or `as const` is needed.
const DEPENDENCIES = 'dependencies';
const DEV_DEPENDENCIES = 'devDependencies';
const PEER_DEPENDENCIES = 'peerDependencies';
const OPTIONAL_DEPENDENCIES = 'optionalDependencies';

export type DepField
  = | typeof DEPENDENCIES
    | typeof DEV_DEPENDENCIES
    | typeof PEER_DEPENDENCIES
    | typeof OPTIONAL_DEPENDENCIES;

export const DEP_FIELDS: readonly DepField[] = [
  DEPENDENCIES,
  DEV_DEPENDENCIES,
  PEER_DEPENDENCIES,
  OPTIONAL_DEPENDENCIES,
];

// One named definition per discriminant, referenced by the type (`typeof`) AND
// every construction site — never re-typed as a bare string literal at a call site.
// (A top-level `const` infers the literal type; no annotation or `as const` needed.)
export const CATALOG_KIND = 'catalog';
export const NAMED_CATALOG_KIND = 'namedCatalog';
export const DEPS_KIND = 'deps';

export interface CatalogSource {
  readonly kind: typeof CATALOG_KIND;
}
export interface NamedCatalogSource {
  readonly kind: typeof NAMED_CATALOG_KIND;
  readonly name: string;
}
export interface DepsSource {
  readonly kind: typeof DEPS_KIND;
  readonly field: DepField;
}
export type EntrySource = CatalogSource | NamedCatalogSource | DepsSource;

/** One bumpable version-range literal: where it lives, its current range, and its byte span. */
export interface Entry {
  readonly pkg: string;
  readonly currentRange: string;
  /** Offset of the opening `"` of the version string literal. */
  readonly start: number;
  /** Offset just after the closing `"` of the version string literal. */
  readonly end: number;
  readonly source: EntrySource;
}

// ---------------------------------------------------------------------------
// Range eligibility
// ---------------------------------------------------------------------------

const SENTINEL_RANGES: ReadonlySet<string> = new Set(['latest', 'next', '*', 'x', 'X', '']);

/** Skip specifiers that aren't plain semver ranges (and, by default, sentinels). */
export function isBumpableRange(range: string, resolveSentinels: boolean): boolean {
  if (!resolveSentinels && SENTINEL_RANGES.has(range.trim())) {
    return false;
  }
  if (range === 'catalog:') {
    return false;
  }
  if (range.startsWith('workspace:')) {
    return false;
  }
  if (range.startsWith('link:')) {
    return false;
  }
  if (range.startsWith('file:')) {
    return false;
  }
  if (range.startsWith('portal:')) {
    return false;
  }
  if (range.startsWith('git+') || range.startsWith('git://')) {
    return false;
  }
  if (range.startsWith('http://') || range.startsWith('https://')) {
    return false;
  }
  if (range.startsWith('npm:')) {
    return false;
  }
  if (range.startsWith('./') || range.startsWith('../') || range.startsWith('/')) {
    return false;
  }
  if (range.startsWith('catalog:')) {
    return false; // named catalog refs
  }
  return true;
}

// ---------------------------------------------------------------------------
// JSON AST walking
// ---------------------------------------------------------------------------

/** The property's key text for string/numeric/identifier names, else `undefined`. */
export function propKey(prop: ts.PropertyAssignment): string | undefined {
  const name = prop.name;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function rootObject(sourceFile: ts.JsonSourceFile): ts.ObjectLiteralExpression | undefined {
  const stmt = sourceFile.statements[0];
  if (stmt === undefined || !ts.isExpressionStatement(stmt)) {
    return undefined;
  }
  const root = stmt.expression;
  return ts.isObjectLiteralExpression(root) ? root : undefined;
}

function findProperty(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propKey(prop) === key) {
      return prop;
    }
  }
  return undefined;
}

/** Return an {@link Entry} for each `"pkg": "<bumpable range>"` pair in `obj`, tagged with `source`. */
function collectStringMap(
  obj: ts.ObjectLiteralExpression,
  source: EntrySource,
  sourceFile: ts.JsonSourceFile,
  resolveSentinels: boolean,
): Entry[] {
  const out: Entry[] = [];
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const pkg = propKey(prop);
    if (pkg === undefined) {
      continue;
    }
    const init = prop.initializer;
    if (!ts.isStringLiteral(init)) {
      continue;
    }
    const range = init.text;
    if (!isBumpableRange(range, resolveSentinels)) {
      continue;
    }
    out.push({
      pkg,
      currentRange: range,
      start: init.getStart(sourceFile),
      end: init.end,
      source,
    });
  }
  return out;
}

/** Collect entries from a `catalogs` object: each property is a named catalog of `pkg → range`. */
function collectNamedCatalogs(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.JsonSourceFile,
  resolveSentinels: boolean,
): Entry[] {
  const out: Entry[] = [];
  for (const named of obj.properties) {
    if (!ts.isPropertyAssignment(named)) {
      continue;
    }
    const name = propKey(named);
    if (name === undefined || !ts.isObjectLiteralExpression(named.initializer)) {
      continue;
    }
    const src: NamedCatalogSource = { kind: NAMED_CATALOG_KIND, name };
    out.push(...collectStringMap(named.initializer, src, sourceFile, resolveSentinels));
  }
  return out;
}

/**
 * Walk a parsed `package.json` and collect every bumpable {@link Entry} from
 * `workspaces.catalog`, `workspaces.catalogs.*`, top-level `catalog` / `catalogs`,
 * and the four dependency fields. `overrides` / `resolutions` and array-form
 * `workspaces` (member globs) are deliberately ignored.
 */
export function findEntries(sourceFile: ts.JsonSourceFile, resolveSentinels: boolean): Entry[] {
  const entries: Entry[] = [];
  const root = rootObject(sourceFile);
  if (root === undefined) {
    return entries;
  }

  for (const prop of root.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      continue;
    }
    const key = propKey(prop);
    if (key === undefined) {
      continue;
    }
    const init = prop.initializer;

    if (key === 'workspaces' && ts.isObjectLiteralExpression(init)) {
      for (const sub of init.properties) {
        if (!ts.isPropertyAssignment(sub)) {
          continue;
        }
        const subKey = propKey(sub);
        if (subKey === 'catalog' && ts.isObjectLiteralExpression(sub.initializer)) {
          const src: CatalogSource = { kind: CATALOG_KIND };
          entries.push(...collectStringMap(sub.initializer, src, sourceFile, resolveSentinels));
        }
        else if (subKey === 'catalogs' && ts.isObjectLiteralExpression(sub.initializer)) {
          entries.push(...collectNamedCatalogs(sub.initializer, sourceFile, resolveSentinels));
        }
      }
      continue;
    }

    if (key === 'catalog' && ts.isObjectLiteralExpression(init)) {
      const src: CatalogSource = { kind: CATALOG_KIND };
      entries.push(...collectStringMap(init, src, sourceFile, resolveSentinels));
      continue;
    }

    if (key === 'catalogs' && ts.isObjectLiteralExpression(init)) {
      entries.push(...collectNamedCatalogs(init, sourceFile, resolveSentinels));
      continue;
    }

    const field = DEP_FIELDS.find(f => f === key);
    if (field !== undefined && ts.isObjectLiteralExpression(init)) {
      const src: DepsSource = { kind: DEPS_KIND, field };
      entries.push(...collectStringMap(init, src, sourceFile, resolveSentinels));
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

function stringElements(arr: ts.ArrayLiteralExpression): readonly string[] {
  const out: string[] = [];
  for (const el of arr.elements) {
    if (ts.isStringLiteral(el)) {
      out.push(el.text);
    }
  }
  return out;
}

/**
 * The workspace member globs declared by the root: the array for array-form
 * `workspaces`, or the `packages` array for object-form. `[]` when none.
 */
export function readWorkspacePatterns(sourceFile: ts.JsonSourceFile): readonly string[] {
  const root = rootObject(sourceFile);
  if (root === undefined) {
    return [];
  }
  const ws = findProperty(root, 'workspaces');
  if (ws === undefined) {
    return [];
  }
  const init = ws.initializer;
  if (ts.isArrayLiteralExpression(init)) {
    return stringElements(init);
  }
  if (ts.isObjectLiteralExpression(init)) {
    const packages = findProperty(init, 'packages');
    if (packages !== undefined && ts.isArrayLiteralExpression(packages.initializer)) {
      return stringElements(packages.initializer);
    }
  }
  return [];
}

/** The top-level `name` string, or `undefined` (used to skip internal member-to-member refs). */
export function readPackageName(sourceFile: ts.JsonSourceFile): string | undefined {
  const root = rootObject(sourceFile);
  if (root === undefined) {
    return undefined;
  }
  const name = findProperty(root, 'name');
  if (name !== undefined && ts.isStringLiteral(name.initializer)) {
    return name.initializer.text;
  }
  return undefined;
}

const PKG_SUFFIX = '/package.json';

/**
 * Resolve workspace globs to absolute member `package.json` paths via `Bun.Glob`.
 * Each positive pattern is scanned with a `/package.json` suffix (so literal member
 * paths match the same way globs do); `!`-prefixed patterns exclude by member dir;
 * results are de-duplicated, the root file is dropped, and the list is sorted.
 */
export async function discoverMemberFiles(
  rootDir: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const positives = patterns.filter(p => !p.startsWith('!'));
  const negationGlobs = patterns
    .filter(p => p.startsWith('!'))
    .map(p => new Bun.Glob(p.slice(1)));

  const rels = new Set<string>();
  for (const p of positives) {
    const glob = new Bun.Glob(`${p}${PKG_SUFFIX}`);
    for await (const rel of glob.scan({ cwd: rootDir, onlyFiles: true, followSymlinks: false })) {
      rels.add(rel);
    }
  }

  const rootPkg = resolve(rootDir, 'package.json');
  const out: string[] = [];
  for (const rel of rels) {
    const memberDir = rel.endsWith(PKG_SUFFIX) ? rel.slice(0, -PKG_SUFFIX.length) : rel;
    if (negationGlobs.some(g => g.match(memberDir))) {
      continue;
    }
    const abs = resolve(rootDir, rel);
    if (abs === rootPkg) {
      continue;
    }
    out.push(abs);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Work files
// ---------------------------------------------------------------------------

/** One `package.json` under consideration: its path, original text, parsed AST, and entries. */
export interface WorkFile {
  readonly path: string;
  readonly dir: string;
  readonly text: string;
  readonly sourceFile: ts.JsonSourceFile;
  readonly entries: readonly Entry[];
}

async function readWorkFile(path: string, resolveSentinels: boolean): Promise<WorkFile> {
  const text = await Bun.file(path).text();
  const sourceFile = ts.parseJsonText(path, text);
  return {
    path,
    dir: dirname(path),
    text,
    sourceFile,
    entries: findEntries(sourceFile, resolveSentinels),
  };
}

/**
 * The set of {@link WorkFile}s to update: just the root, or — when `recursive`
 * and the root declares `workspaces` — the root plus every discovered member.
 */
export async function buildWorkFiles(
  rootPath: string,
  recursive: boolean,
  resolveSentinels: boolean,
): Promise<readonly WorkFile[]> {
  const rootWF = await readWorkFile(rootPath, resolveSentinels);
  const patterns = readWorkspacePatterns(rootWF.sourceFile);
  if (!recursive || patterns.length === 0) {
    return [rootWF];
  }
  const memberPaths = await discoverMemberFiles(dirname(rootPath), patterns);
  const members = await Promise.all(memberPaths.map(async p => await readWorkFile(p, resolveSentinels)));
  return [rootWF, ...members];
}

/** The set of `name`s across all work files — deps matching one are internal and never bumped. */
export function collectMemberNames(files: readonly WorkFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const file of files) {
    const name = readPackageName(file.sourceFile);
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Range prefix preservation
// ---------------------------------------------------------------------------

const PREFIX_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

/** Split a trimmed range into its leading operator (`^`, `~`, `>=`, …, or `''`) and the version. */
export function splitPrefix(range: string): { readonly prefix: string; readonly version: string } {
  const m = PREFIX_RE.exec(range.trim());
  if (m === null) {
    return { prefix: '', version: range.trim() };
  }
  return { prefix: m[1] ?? '', version: m[2] ?? '' };
}

/** Reapply `oldRange`'s prefix to `latest` (e.g. `^1.0.0` + `2.3.0` → `^2.3.0`). */
export function bumpRange(oldRange: string, latest: string): string {
  const { prefix } = splitPrefix(oldRange);
  return `${prefix}${latest}`;
}

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

/**
 * Resolve `pkg`'s version for dist-tag `tag` from the npm registry. Scoped names
 * are `%2F`-encoded; a non-2xx response or a body without a non-empty string
 * `version` throws. Calls the real `fetch`; tests `spyOn(globalThis, 'fetch')`.
 */
export async function fetchLatest(pkg: string, tag: string): Promise<string> {
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${String(res.status)} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  if (
    typeof body !== 'object'
    || body === null
    || !('version' in body)
    || typeof body.version !== 'string'
    || body.version.length === 0
  ) {
    throw new Error(`No version field on ${pkg}@${tag}`);
  }
  return body.version;
}

/** Map `fn` over `items` with at most `limit` in flight, preserving input order in the result. */
export async function mapConcurrent<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    let index = cursor++;
    while (index < items.length) {
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item);
      }
      index = cursor++;
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Edit application
// ---------------------------------------------------------------------------

/** A single text splice: replace the byte span `[start, end)` with `replacement`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Apply edits to `text`, splicing in descending start order so earlier offsets stay valid. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/** A short human label for an entry's source, e.g. `catalog`, `catalogs.react18`, `devDependencies`. */
export function describeSource(s: EntrySource): string {
  if (s.kind === CATALOG_KIND) {
    return 'catalog';
  }
  if (s.kind === NAMED_CATALOG_KIND) {
    return `catalogs.${s.name}`;
  }
  return s.field;
}

// ---------------------------------------------------------------------------
// JSON value formatting (for `--to-catalog`)
// ---------------------------------------------------------------------------

/** Detect the indentation unit (one level) from the first indented line. */
export function detectIndentUnit(text: string): string {
  for (const line of text.split('\n')) {
    const m = /^([ \t]+)\S/.exec(line);
    if (m !== null && m[1] !== undefined && m[1].length > 0) {
      return m[1];
    }
  }
  return '  ';
}

export function formatJsonArray(
  items: readonly string[],
  baseIndent: string,
  unit: string,
): string {
  if (items.length === 0) {
    return '[]';
  }
  const inner = baseIndent + unit;
  const body = items.map(item => `${inner}${JSON.stringify(item)}`).join(',\n');
  return `[\n${body}\n${baseIndent}]`;
}

export function formatJsonObject(
  entries: ReadonlyArray<readonly [string, string]>,
  baseIndent: string,
  unit: string,
): string {
  if (entries.length === 0) {
    return '{}';
  }
  const inner = baseIndent + unit;
  const body = entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n');
  return `{\n${body}\n${baseIndent}}`;
}

/** Like `formatJsonObject`, but each value is already-serialized JSON text (not re-quoted). */
function formatRawObject(
  entries: ReadonlyArray<readonly [string, string]>,
  baseIndent: string,
  unit: string,
): string {
  const inner = baseIndent + unit;
  const body = entries
    .map(([k, raw]) => `${inner}${JSON.stringify(k)}: ${raw}`)
    .join(',\n');
  return `{\n${body}\n${baseIndent}}`;
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

/** Run one `bun install` (with `AGENT=1`) in `cwd`; resolves its exit code. Uses the real `bun` `spawn`; tests mock it via `mock.module('bun', …)`. */
async function installDeps(cwd: string): Promise<number> {
  const proc = spawn(['bun', 'install'], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, AGENT: '1' },
  });
  return proc.exited;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// The mutable host effects are imported from the `bun` module (`fetch`/`write`/`spawn`, above) so tests
// replace them at the module boundary with `mock.module('bun', …)` registered via `--preload` (it must
// be mocked before this module is imported). Output uses `console.*` (tests `spyOn(console, …)`); reads
// use the global `Bun.file`/`Bun.Glob` and stay real (unmocked).

/** Machine-readable summary of a run; `installExitCode` is `null` when no install ran. */
export interface RunResult {
  readonly changed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly filesWritten: readonly string[];
  readonly installExitCode: number | null;
  readonly warnings: readonly string[];
}

/** Entry orchestrator: dispatch to the `--to-catalog` migration or the normal bump path. */
export async function run(opts: Options): Promise<RunResult> {
  const result = opts.toCatalog ? await runToCatalog(opts) : await runUpdate(opts);
  return result;
}

/**
 * Normal path: resolve every unique package once, rewrite each eligible range in
 * place across all work files, write changed files (unless `--dry-run`), and run a
 * single root `bun install` when anything changed.
 */
async function runUpdate(opts: Options): Promise<RunResult> {
  const files = await buildWorkFiles(opts.file, opts.recursive, opts.resolveSentinels);
  const memberNames = collectMemberNames(files);
  const onlyPattern = opts.only;

  const perFile = files.map(file => ({
    file,
    entries: file.entries.filter(
      e => (onlyPattern === undefined || onlyPattern.test(e.pkg)) && !memberNames.has(e.pkg),
    ),
  }));

  const uniquePkgs = [...new Set(perFile.flatMap(f => f.entries.map(e => e.pkg)))];

  if (uniquePkgs.length === 0) {
    console.log(`No bumpable entries in ${opts.file}`);
    return { changed: 0, skipped: 0, failed: 0, filesWritten: [], installExitCode: null, warnings: [] };
  }

  console.log(
    `Checking ${String(uniquePkgs.length)} package(s) across ${String(files.length)} file(s)…`,
  );

  const versions = new Map<string, string>();
  const failures = new Map<string, string>();
  await mapConcurrent(uniquePkgs, 10, async (pkg) => {
    try {
      versions.set(pkg, await fetchLatest(pkg, opts.tag));
    }
    catch (err) {
      failures.set(pkg, err instanceof Error ? err.message : String(err));
    }
  });

  const warnings: string[] = [];
  const filesWritten: string[] = [];
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const { file, entries } of perFile) {
    const edits: Edit[] = [];
    for (const entry of entries) {
      const label = `${describeSource(entry.source)} · ${entry.pkg}`;
      const latest = versions.get(entry.pkg);
      if (latest === undefined) {
        const reason = failures.get(entry.pkg) ?? 'unknown error';
        console.warn(`  ✗ ${label}: ${reason}`);
        warnings.push(`${file.path}: ${entry.pkg}: ${reason}`);
        failed += 1;
        continue;
      }
      const nextRange = bumpRange(entry.currentRange, latest);
      if (nextRange === entry.currentRange) {
        skipped += 1;
        continue;
      }
      console.log(`  ↑ ${label}: ${entry.currentRange} → ${nextRange}`);
      edits.push({ start: entry.start, end: entry.end, replacement: JSON.stringify(nextRange) });
      changed += 1;
    }
    if (edits.length === 0) {
      continue;
    }
    const updated = applyEdits(file.text, edits);
    if (!opts.dryRun) {
      await write(file.path, updated);
      filesWritten.push(file.path);
    }
  }

  console.log(
    `\n${String(changed)} changed · ${String(skipped)} already current · ${String(failed)} failed`,
  );
  if (opts.dryRun && changed > 0) {
    console.log('\n(dry-run) no files written');
  }

  let installExitCode: number | null = null;
  if (opts.install && !opts.dryRun && changed > 0) {
    console.log('\nRunning bun install…');
    installExitCode = await installDeps(dirname(opts.file));
  }

  return { changed, skipped, failed, filesWritten, installExitCode, warnings };
}

/** A single occurrence of a catalogued dependency: which file and which entry. */
interface CatalogSite {
  readonly file: WorkFile;
  readonly entry: Entry;
}

/** Per-package migration plan: the distinct range prefixes seen and every site to rewrite. */
interface CatalogPlanEntry {
  readonly prefixes: Set<string>;
  readonly sites: CatalogSite[];
}

/** Most-permissive prefix wins: `^` > `~` > a single exotic prefix > exact (`''`). */
export function unifyPrefix(prefixes: readonly string[]): string {
  if (prefixes.includes('^')) {
    return '^';
  }
  if (prefixes.includes('~')) {
    return '~';
  }
  if (prefixes.length === 1) {
    return prefixes[0] ?? '';
  }
  return '';
}

/**
 * The single edit that installs the catalog into the root `workspaces` value:
 * array-form is rewritten to object-form (`{ packages, catalog }`); object-form
 * without a catalog gains one; object-form with a catalog gains only the missing
 * keys. Returns `null` when there is nothing to add.
 */
function buildWorkspacesEdit(
  rootWF: WorkFile,
  patterns: readonly string[],
  catalogEntries: ReadonlyArray<readonly [string, string]>,
  unit: string,
): Edit | null {
  if (catalogEntries.length === 0) {
    return null;
  }
  const root = rootObject(rootWF.sourceFile);
  if (root === undefined) {
    return null;
  }
  const ws = findProperty(root, 'workspaces');
  if (ws === undefined) {
    return null;
  }
  const wsInit = ws.initializer;
  const depth1 = unit;
  const depth2 = unit + unit;
  const depth3 = unit + unit + unit;

  if (ts.isArrayLiteralExpression(wsInit)) {
    const packagesArrayText = formatJsonArray(patterns, depth2, unit);
    const catalogObjText = formatJsonObject(catalogEntries, depth2, unit);
    const workspacesText = formatRawObject(
      [
        ['packages', packagesArrayText],
        ['catalog', catalogObjText],
      ],
      depth1,
      unit,
    );
    return {
      start: wsInit.getStart(rootWF.sourceFile),
      end: wsInit.end,
      replacement: workspacesText,
    };
  }

  if (ts.isObjectLiteralExpression(wsInit)) {
    const catalogProp = findProperty(wsInit, 'catalog');
    if (catalogProp === undefined || !ts.isObjectLiteralExpression(catalogProp.initializer)) {
      const catalogObjText = formatJsonObject(catalogEntries, depth2, unit);
      const lastProp = wsInit.properties.at(-1);
      const insertAt
        = lastProp !== undefined ? lastProp.end : wsInit.getStart(rootWF.sourceFile) + 1;
      return {
        start: insertAt,
        end: insertAt,
        replacement: `,\n${depth2}${JSON.stringify('catalog')}: ${catalogObjText}`,
      };
    }

    const catalogObj = catalogProp.initializer;
    const existing = new Set<string>();
    for (const p of catalogObj.properties) {
      if (ts.isPropertyAssignment(p)) {
        const k = propKey(p);
        if (k !== undefined) {
          existing.add(k);
        }
      }
    }
    const missing = catalogEntries.filter(([k]) => !existing.has(k));
    if (missing.length === 0) {
      return null;
    }
    const lastCat = catalogObj.properties.at(-1);
    if (lastCat === undefined) {
      return {
        start: catalogObj.getStart(rootWF.sourceFile),
        end: catalogObj.end,
        replacement: formatJsonObject(missing, depth2, unit),
      };
    }
    const additions = missing
      .map(([k, v]) => `,\n${depth3}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join('');
    return { start: lastCat.end, end: lastCat.end, replacement: additions };
  }

  return null;
}

/**
 * `--to-catalog` path: collect every direct dependency across the workspace,
 * resolve each to latest while unifying conflicting prefixes, rewrite the matched
 * member sites to `'catalog:'`, and host a sorted catalog in the root `workspaces`.
 * Idempotent (an already-catalogued tree is a no-op); errors if the root has no
 * `workspaces`.
 */
async function runToCatalog(opts: Options): Promise<RunResult> {
  const files = await buildWorkFiles(opts.file, true, opts.resolveSentinels);
  const rootWF = files[0];
  if (rootWF === undefined) {
    throw new Error(`Could not read ${opts.file}`);
  }
  const patterns = readWorkspacePatterns(rootWF.sourceFile);
  if (patterns.length === 0) {
    throw new Error(`${opts.file} has no \`workspaces\`; nothing to convert to a catalog.`);
  }
  const memberNames = collectMemberNames(files);

  // 1. Collect the catalog plan from every file's direct dependency entries.
  const plan = new Map<string, CatalogPlanEntry>();
  for (const file of files) {
    for (const entry of file.entries) {
      if (entry.source.kind !== DEPS_KIND || memberNames.has(entry.pkg)) {
        continue;
      }
      const prefix = splitPrefix(entry.currentRange).prefix;
      const existing = plan.get(entry.pkg);
      if (existing === undefined) {
        plan.set(entry.pkg, { prefixes: new Set([prefix]), sites: [{ file, entry }] });
      }
      else {
        existing.prefixes.add(prefix);
        existing.sites.push({ file, entry });
      }
    }
  }

  // 2-3. Resolve each package; unify conflicting prefixes; collect warnings.
  const warnings: string[] = [];
  const catalogRanges = new Map<string, string>();
  await mapConcurrent([...plan.keys()], 10, async (pkg) => {
    const info = plan.get(pkg);
    if (info === undefined) {
      return;
    }
    let latest: string;
    try {
      latest = await fetchLatest(pkg, opts.tag);
    }
    catch (err) {
      warnings.push(`skipped ${pkg} (fetch failed): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const catalogRange = `${unifyPrefix([...info.prefixes])}${latest}`;
    catalogRanges.set(pkg, catalogRange);
    const originals = [...new Set(info.sites.map(s => s.entry.currentRange))];
    if (originals.length > 1) {
      warnings.push(`unified ${pkg}: ${originals.join(' | ')} → ${catalogRange}`);
    }
  });

  // 4. Sorted, case-insensitive catalog entries.
  const catalogEntries: ReadonlyArray<readonly [string, string]> = [...catalogRanges.entries()].sort(
    ([a], [b]) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    },
  );

  // 5-6. Build per-file edits: rewrite each catalogued dep site to `'catalog:'`,
  // and rewrite the root `workspaces` value to host the catalog.
  const editsByFile = new Map<string, Edit[]>();
  const pushEdit = (path: string, edit: Edit): void => {
    const arr = editsByFile.get(path);
    if (arr === undefined) {
      editsByFile.set(path, [edit]);
    }
    else {
      arr.push(edit);
    }
  };

  let changed = 0;
  for (const [pkg, info] of plan) {
    if (!catalogRanges.has(pkg)) {
      continue; // fetch failed → leave its sites untouched
    }
    for (const site of info.sites) {
      pushEdit(site.file.path, {
        start: site.entry.start,
        end: site.entry.end,
        replacement: JSON.stringify('catalog:'),
      });
      changed += 1;
    }
  }

  const wsEdit = buildWorkspacesEdit(rootWF, patterns, catalogEntries, detectIndentUnit(rootWF.text));
  if (wsEdit !== null) {
    pushEdit(rootWF.path, wsEdit);
  }

  // 7. Apply, write, install.
  const filesWritten: string[] = [];
  for (const file of files) {
    const fileEdits = editsByFile.get(file.path);
    if (fileEdits === undefined || fileEdits.length === 0) {
      continue;
    }
    const updated = applyEdits(file.text, fileEdits);
    if (!opts.dryRun) {
      await write(file.path, updated);
      filesWritten.push(file.path);
    }
  }

  for (const [pkg, range] of catalogEntries) {
    console.log(`  + catalog · ${pkg}: ${range}`);
  }
  for (const w of warnings) {
    console.warn(`  ! ${w}`);
  }
  const failed = plan.size - catalogRanges.size;
  console.log(
    `\n${String(catalogEntries.length)} catalog entries · ${String(changed)} refs → "catalog:" · ${String(failed)} failed`,
  );
  if (changed === 0) {
    console.log('Nothing to convert (already catalog-based?).');
  }
  if (opts.dryRun && changed > 0) {
    console.log('\n(dry-run) no files written');
  }

  let installExitCode: number | null = null;
  if (opts.install && !opts.dryRun && changed > 0) {
    console.log('\nRunning bun install…');
    installExitCode = await installDeps(dirname(opts.file));
  }

  return { changed, skipped: 0, failed, filesWritten, installExitCode, warnings };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse argv, verify the target exists, and run — returning the process exit code
 * (`1` if the file is missing, otherwise the install exit code or `0`). Returning
 * the code (rather than calling `process.exit`) keeps `main` callable from tests.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseArgs(argv);
  if (!(await Bun.file(opts.file).exists())) {
    console.error(`Not found: ${opts.file}`);
    return 1;
  }
  const result = await run(opts);
  return result.installExitCode ?? 0;
}

// The module's only side-effecting block: run the CLI when this file is the
// process entrypoint, and own the sole `process.exit`. Importing the module
// (e.g. from tests) does none of this.
if (import.meta.main) {
  main()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
