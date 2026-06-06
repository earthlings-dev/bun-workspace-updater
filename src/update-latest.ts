/**
 * Catalog-aware replacement for `bun update --latest`.
 *
 * Bumps version ranges inside `workspaces.catalog`, named `workspaces.catalogs.*`,
 * and direct pins in `dependencies` / `devDependencies` / `peerDependencies` /
 * `optionalDependencies`, while leaving `"catalog:"`, `"workspace:*"`, `"link:*"`,
 * `"file:*"`, `"git+*"`, `"http*"`, and path refs untouched.
 *
 * Formatting, key order, and any comments are preserved by editing the original
 * source text at positions reported by the TypeScript compiler's JSON AST
 * (`ts.parseJsonText`).
 *
 * Usage (the `lupdate` script aliases `bun run scripts/update-latest.ts`):
 *   bun run scripts/update-latest.ts                  # bump all eligible entries
 *   bun run scripts/update-latest.ts --dry-run        # print changes, do not write
 *   bun run scripts/update-latest.ts --tag next       # use a different npm dist-tag
 *   bun run scripts/update-latest.ts --only @stylistic # regex filter on package names
 *   bun run scripts/update-latest.ts --no-install     # skip `bun install` at the end
 *   bun run scripts/update-latest.ts path/to/package.json
 */
import { resolve } from "node:path";

import ts from "typescript";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Options {
  readonly file: string;
  readonly tag: string;
  readonly dryRun: boolean;
  readonly install: boolean;
  readonly only: RegExp | undefined;
}

function parseArgs(argv: readonly string[]): Options {
  let file: string | undefined;
  let tag = "latest";
  let dryRun = false;
  let install = true;
  let only: RegExp | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-install") {
      install = false;
    } else if (arg === "--tag") {
      tag = argv[++i] ?? "latest";
    } else if (arg === "--only") {
      only = new RegExp(argv[++i] ?? "");
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (arg) {
      file = arg;
    }
  }

  const repoRoot = resolve(import.meta.dir, "..");
  return {
    file: file ? resolve(file) : resolve(repoRoot, "package.json"),
    tag,
    dryRun,
    install,
    only,
  };
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------

type DepField = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

const DEP_FIELDS: readonly DepField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

type EntrySource =
  | { readonly kind: "catalog" }
  | { readonly kind: "namedCatalog"; readonly name: string }
  | { readonly kind: "deps"; readonly field: DepField };

interface Entry {
  readonly pkg: string;
  readonly currentRange: string;
  /** Offset of the opening `"` of the version string literal. */
  readonly start: number;
  /** Offset just after the closing `"` of the version string literal. */
  readonly end: number;
  readonly source: EntrySource;
}

/** Skip specifiers that aren't plain semver ranges. */
function isBumpableRange(range: string): boolean {
  if (range === "catalog:") {
    return false;
  }
  if (range.startsWith("workspace:")) {
    return false;
  }
  if (range.startsWith("link:")) {
    return false;
  }
  if (range.startsWith("file:")) {
    return false;
  }
  if (range.startsWith("portal:")) {
    return false;
  }
  if (range.startsWith("git+") || range.startsWith("git://")) {
    return false;
  }
  if (range.startsWith("http://") || range.startsWith("https://")) {
    return false;
  }
  if (range.startsWith("npm:")) {
    return false;
  }
  if (range.startsWith("./") || range.startsWith("../") || range.startsWith("/")) {
    return false;
  }
  if (range.startsWith("catalog:")) {
    return false; // named catalog refs
  }
  return true;
}

function propKey(prop: ts.PropertyAssignment): string | undefined {
  const name = prop.name;
  if (ts.isStringLiteral(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  return undefined;
}

function collectStringMap(
  obj: ts.ObjectLiteralExpression,
  source: EntrySource,
  sourceFile: ts.JsonSourceFile,
  out: Entry[],
): void {
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
    if (!isBumpableRange(range)) {
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
}

function findEntries(sourceFile: ts.JsonSourceFile): Entry[] {
  const entries: Entry[] = [];
  const stmt = sourceFile.statements[0];
  if (!stmt || !ts.isExpressionStatement(stmt)) {
    return entries;
  }
  const root = stmt.expression;
  if (!ts.isObjectLiteralExpression(root)) {
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

    if (key === "workspaces" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const sub of prop.initializer.properties) {
        if (!ts.isPropertyAssignment(sub)) {
          continue;
        }
        const subKey = propKey(sub);
        if (subKey === "catalog" && ts.isObjectLiteralExpression(sub.initializer)) {
          collectStringMap(sub.initializer, { kind: "catalog" }, sourceFile, entries);
        } else if (subKey === "catalogs" && ts.isObjectLiteralExpression(sub.initializer)) {
          for (const named of sub.initializer.properties) {
            if (!ts.isPropertyAssignment(named)) {
              continue;
            }
            const name = propKey(named);
            if (name === undefined) {
              continue;
            }
            if (!ts.isObjectLiteralExpression(named.initializer)) {
              continue;
            }
            collectStringMap(named.initializer, { kind: "namedCatalog", name }, sourceFile, entries);
          }
        }
      }
      continue;
    }

    if ((DEP_FIELDS as readonly string[]).includes(key) && ts.isObjectLiteralExpression(prop.initializer)) {
      collectStringMap(prop.initializer, { kind: "deps", field: key as DepField }, sourceFile, entries);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Range prefix preservation
// ---------------------------------------------------------------------------

const PREFIX_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

function splitPrefix(range: string): { prefix: string; version: string } {
  const m = PREFIX_RE.exec(range.trim());
  if (!m) {
    return { prefix: "", version: range.trim() };
  }
  return { prefix: m[1] ?? "", version: m[2] ?? "" };
}

function bumpRange(oldRange: string, latest: string): string {
  const { prefix } = splitPrefix(oldRange);
  return `${prefix}${latest}`;
}

// ---------------------------------------------------------------------------
// Registry lookup
// ---------------------------------------------------------------------------

interface Manifest {
  readonly version: string;
}

async function fetchLatest(pkg: string, tag: string): Promise<string> {
  const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${String(res.status)} ${res.statusText}`);
  }
  const manifest = await res.json() as Manifest;
  if (!manifest.version) {
    throw new Error(`No version field on ${pkg}@${tag}`);
  }
  return manifest.version;
}

async function mapConcurrent<T, U>(
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

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

function describeSource(s: EntrySource): string {
  if (s.kind === "catalog") {
    return "catalog";
  }
  if (s.kind === "namedCatalog") {
    return `catalogs.${s.name}`;
  }
  return s.field;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const file = Bun.file(opts.file);
  if (!await file.exists()) {
    console.error(`Not found: ${opts.file}`);
    process.exit(1);
  }
  const text = await file.text();
  const sourceFile = ts.parseJsonText(opts.file, text);

  const allEntries = findEntries(sourceFile);
  const onlyPattern = opts.only;
  const entries = onlyPattern
    ? allEntries.filter((e) => onlyPattern.test(e.pkg))
    : allEntries;

  if (entries.length === 0) {
    console.log(`No bumpable entries in ${opts.file}`);
    return;
  }

  console.log(`Checking ${String(entries.length)} entries from ${opts.file}…`);

  const results = await mapConcurrent(entries, 10, async (e) => {
    try {
      const latest = await fetchLatest(e.pkg, opts.tag);
      return { entry: e, latest, error: undefined as string | undefined };
    } catch (err) {
      return { entry: e, latest: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  const edits: Edit[] = [];
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const { entry, latest, error } of results) {
    const label = `${describeSource(entry.source)} · ${entry.pkg}`;
    if (error) {
      console.warn(`  ✗ ${label}: ${error}`);
      failed += 1;
      continue;
    }
    const nextRange = bumpRange(entry.currentRange, latest);
    if (nextRange === entry.currentRange) {
      skipped += 1;
      continue;
    }
    console.log(`  ↑ ${label}: ${entry.currentRange} → ${nextRange}`);
    edits.push({
      start: entry.start,
      end: entry.end,
      replacement: JSON.stringify(nextRange),
    });
    changed += 1;
  }

  console.log(`\n${String(changed)} changed · ${String(skipped)} already current · ${String(failed)} failed`);

  if (edits.length === 0) {
    return;
  }

  const updated = applyEdits(text, edits);

  if (opts.dryRun) {
    console.log("\n(dry-run) no files written");
    return;
  }

  await Bun.write(opts.file, updated);
  console.log(`\nWrote ${opts.file}`);

  if (opts.install) {
    console.log("\nRunning bun install…");
    const proc = Bun.spawn(["bun", "install"], {
      cwd: resolve(opts.file, ".."),
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, AGENT: "1" },
    });
    const code = await proc.exited;
    if (code !== 0) {
      process.exit(code);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
