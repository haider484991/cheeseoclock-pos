import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PURE_LOCAL_TABLES,
  REPLICABLE_REQUIRED_COLUMNS,
} from '@cheeseoclock/sync-core';

/**
 * The two invariants CLAUDE.md and sync-contract.ts say CI enforces.
 *
 * Both work on source text rather than a live database on purpose: they must
 * run in plain Vitest, and better-sqlite3 here is built against Electron's
 * ABI, so opening a real connection under node would fail.
 */

const DB_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const REPOSITORIES_DIR = join(DB_DIR, 'repositories');

// ---------------------------------------------------------------- parsing --

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Body inside the parens that open at `openIdx`, respecting nesting. */
function readBalanced(sql: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIdx + 1, i);
    }
  }
  throw new Error('Unbalanced parentheses in migration SQL');
}

/** Split a CREATE TABLE body on commas that sit outside any nested parens. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'check',
  'primary',
  'foreign',
  'unique',
  'constraint',
]);

function columnNames(body: string): string[] {
  return topLevelParts(body)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.split(/\s+/)[0] ?? '').toLowerCase())
    .filter((n) => n.length > 0 && !TABLE_CONSTRAINT_KEYWORDS.has(n));
}

/**
 * Statements must be applied in document order, not grouped by kind: 0009
 * swaps a table with CREATE payments_new → DROP payments → RENAME
 * payments_new TO payments. Running all DROPs after all RENAMEs would delete
 * the very table the rename just produced, quietly dropping `payments` out of
 * the checked set.
 */
const STATEMENT_RE = new RegExp(
  [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(/.source,
    /ALTER\s+TABLE\s+"?(\w+)"?\s+RENAME\s+TO\s+"?(\w+)"?/.source,
    /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+(?:COLUMN\s+)?"?(\w+)"?/.source,
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/.source,
  ].join('|'),
  'gi',
);

/** table name -> every column it has after all migrations are applied. */
function collectSchema(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    STATEMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = STATEMENT_RE.exec(sql)) !== null) {
      const [, created, renameFrom, renameTo, addTable, addColumn, dropped] = m;

      if (created !== undefined) {
        const name = created.toLowerCase();
        const cols = tables.get(name) ?? new Set<string>();
        for (const c of columnNames(readBalanced(sql, STATEMENT_RE.lastIndex - 1))) {
          cols.add(c);
        }
        tables.set(name, cols);
      } else if (renameFrom !== undefined && renameTo !== undefined) {
        const from = renameFrom.toLowerCase();
        const cols = tables.get(from);
        if (cols) {
          tables.delete(from);
          tables.set(renameTo.toLowerCase(), cols);
        }
      } else if (addTable !== undefined && addColumn !== undefined) {
        const name = addTable.toLowerCase();
        const cols = tables.get(name) ?? new Set<string>();
        cols.add(addColumn.toLowerCase());
        tables.set(name, cols);
      } else if (dropped !== undefined) {
        tables.delete(dropped.toLowerCase());
      }
    }
  }
  return tables;
}

const SCHEMA = collectSchema();
const REPLICABLE_TABLES = [...SCHEMA.keys()]
  .filter((t) => !PURE_LOCAL_TABLES.has(t))
  .sort();

// ------------------------------------------------------------ sync contract -

describe('sync contract: every replicable table carries the sync columns', () => {
  it('parsed a plausible schema out of the migrations', () => {
    expect(SCHEMA.size).toBeGreaterThan(10);
    expect(REPLICABLE_TABLES.length).toBeGreaterThan(5);
    // Spot-check the parser itself: users is replicable, settings is not.
    expect(REPLICABLE_TABLES).toContain('users');
    expect(REPLICABLE_TABLES).not.toContain('settings');
    // 0009 swaps payments via a temp table; the rename must survive the drop
    // and the scratch name must not linger.
    expect(REPLICABLE_TABLES).toContain('payments');
    expect(SCHEMA.has('payments_new')).toBe(false);
  });

  it.each(REPLICABLE_TABLES)('%s', (table) => {
    const cols = SCHEMA.get(table);
    expect(cols, `table ${table} vanished from the parsed schema`).toBeDefined();
    const missing = REPLICABLE_REQUIRED_COLUMNS.filter(
      (c) => !(cols as Set<string>).has(c),
    );
    expect(
      missing,
      `Table "${table}" is missing sync columns. Either add them, or add the ` +
        `table to PURE_LOCAL_TABLES in packages/sync-core/src/sync-contract.ts.`,
    ).toEqual([]);
  });
});

// ------------------------------------------------------ repository contract -

/**
 * apply-remote.ts is the *inbound* sync applier: the rows it writes arrived
 * from another device. Re-enqueueing them would echo every change back around
 * the ring forever, so it is deliberately outside the contract.
 */
const EXEMPT_REPOSITORIES = new Set(['apply-remote.ts']);

function writtenTables(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/gi,
    /UPDATE\s+"?(\w+)"?\s+SET\b/gi,
    /DELETE\s+FROM\s+"?(\w+)"?/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.add((m[1] ?? '').toLowerCase());
  }
  return [...out];
}

const REPOSITORY_FILES = readdirSync(REPOSITORIES_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .filter((f) => !EXEMPT_REPOSITORIES.has(f))
  .sort();

describe('repository contract: replicable writes also sync and audit', () => {
  it.each(REPOSITORY_FILES)('%s', (file) => {
    const source = readFileSync(join(REPOSITORIES_DIR, file), 'utf8');
    const replicableWrites = writtenTables(source).filter((t) =>
      REPLICABLE_TABLES.includes(t),
    );
    if (replicableWrites.length === 0) return; // pure-local repo, nothing to prove

    // Either the shared helper, or the same three steps inlined in one
    // transaction (user-repo does this because PIN hashing must stay outside).
    //
    // These match *calls*, not bare identifiers: order-repo and
    // stock-movement-repo both carried a stale `writeWithSync` import they
    // never called, which a substring check would have happily accepted.
    const usesHelper = /\bwriteWithSync\s*\(/.test(source);
    const inlinesContract =
      /\benqueueSync\s*\(/.test(source) &&
      /\bwriteAudit\s*\(/.test(source) &&
      /\.transaction\s*\(/.test(source);

    expect(
      usesHelper || inlinesContract,
      `${file} writes replicable tables [${replicableWrites.join(', ')}] but ` +
        `neither calls writeWithSync nor inlines enqueueSync + writeAudit ` +
        `inside a transaction. See "Writes (the repositories rule)" in CLAUDE.md.`,
    ).toBe(true);
  });
});
