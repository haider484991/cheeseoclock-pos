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
    // 0032: the shop-wide settings both tills share (costing targets) replicate;
    // the per-till `settings` above does not.
    expect(REPLICABLE_TABLES).toContain('business_settings');
    // 0033: the cost each sale kept travels to the other till (same ids on both).
    expect(REPLICABLE_TABLES).toContain('order_item_costs');
    // 0034: every ingredient's price history travels too (seed / import / batch rows by name-based id).
    expect(REPLICABLE_TABLES).toContain('ingredient_costs');
    expect([...(SCHEMA.get('ingredient_costs') ?? [])]).toEqual(
      expect.arrayContaining(['ingredient_id', 'effective_at', 'unit', 'pack_size', 'pack_price_cents', 'unit_cost_mc', 'prev_unit_cost_mc', 'source']),
    );
    // 0038: stock takes and their lines travel to the other till (shop stock is worked out from every till's rows).
    expect(REPLICABLE_TABLES).toContain('stock_counts');
    expect(REPLICABLE_TABLES).toContain('stock_count_lines');
    expect([...(SCHEMA.get('stock_count_lines') ?? [])]).toEqual(
      expect.arrayContaining(['stock_count_id', 'ingredient_id', 'counted_qty', 'unit', 'counted_at', 'expected_qty', 'till_qty', 'unit_cost_mc', 'value_cents', 'movement_id']),
    );
    // 0040: a foodpanda order's channel terms travel with it (one row per order, same id on both tills),
    // and a discount says where it came from and carries its frozen terms.
    expect(REPLICABLE_TABLES).toContain('order_channel_terms');
    expect([...(SCHEMA.get('order_channel_terms') ?? [])]).toEqual(
      expect.arrayContaining(['order_id', 'deal_bps', 'shop_bps', 'shop_discount_cents', 'platform_funded_cents', 'commission_bps', 'commission_cents', 'expected_payout_cents', 'tablet_total_cents', 'tablet_diff_cents']),
    );
    expect([...(SCHEMA.get('order_discounts') ?? [])]).toEqual(expect.arrayContaining(['source', 'rule_json']));
    // 0041: and the uplift in force at payment, and foodpanda's % of the total.
    expect([...(SCHEMA.get('order_channel_terms') ?? [])]).toEqual(expect.arrayContaining(['uplift_bps', 'payment_fee_cents']));
    // 0044: how an order came in (Walk-in / Phone / WhatsApp, website, foodpanda) travels with the order.
    expect([...(SCHEMA.get('orders') ?? [])]).toEqual(expect.arrayContaining(['came_by']));
    // 0045: where an item and a category sell on the website travels with the menu row.
    expect([...(SCHEMA.get('menu_items') ?? [])]).toEqual(expect.arrayContaining(['web_availability']));
    expect([...(SCHEMA.get('categories') ?? [])]).toEqual(expect.arrayContaining(['is_on_website']));
    // 0047: a category's "never discounted" travels with it, and so does each order line's snapshot of it.
    expect([...(SCHEMA.get('categories') ?? [])]).toEqual(expect.arrayContaining(['no_discount']));
    expect([...(SCHEMA.get('order_items') ?? [])]).toEqual(expect.arrayContaining(['no_discount']));
    // 0048: when an order was sent travels with the order.
    expect([...(SCHEMA.get('orders') ?? [])]).toEqual(expect.arrayContaining(['sent_at']));
    // 0049: what an outside rider keeps travels with the order, and a payout's order with the payout.
    expect([...(SCHEMA.get('orders') ?? [])]).toEqual(expect.arrayContaining(['rider_keeps_cents']));
    expect([...(SCHEMA.get('cash_movements') ?? [])]).toEqual(expect.arrayContaining(['order_id']));
    // 0050: the drawer counted note by note at close travels with the shift.
    expect([...(SCHEMA.get('shifts') ?? [])]).toEqual(expect.arrayContaining(['counted_notes_json']));
    // 0051: and so does the shift report saved at close.
    expect([...(SCHEMA.get('shifts') ?? [])]).toEqual(expect.arrayContaining(['close_report_json']));
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

// ------------------------------------------------------- ledger writers -

/**
 * Only two functions may append to the ledgers: writeAudit computes the hash
 * chain (a raw INSERT leaves prev_hash/row_hash NULL, and the verifier then
 * reports the chain broken from that row on) and enqueueSync owns the queue
 * row shape. shift-repo once inlined both — every shift close broke the chain.
 */
const LEDGER_WRITERS = new Set(['audit-repo.ts', 'sync-repo.ts']);

const LEDGER_CLIENT_FILES = readdirSync(REPOSITORIES_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .filter((f) => !LEDGER_WRITERS.has(f))
  .sort();

describe('repository contract: only writeAudit / enqueueSync append to the ledgers', () => {
  it.each(LEDGER_CLIENT_FILES)('%s', (file) => {
    // Comments may well talk about the forbidden statement; only code counts.
    const source = readFileSync(join(REPOSITORIES_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const raw = source.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?(?:audit_log|sync_queue)"?\b/gi) ?? [];
    expect(
      raw,
      `${file} inserts into a ledger table directly. Call writeAudit / enqueueSync ` +
        `(or writeWithSync) so the audit row is hash-chained and the sync row is well-formed.`,
    ).toEqual([]);
  });
});

describe('migrations: numbered in order, one file per number', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('run 0001 up to the newest with no gap and no number used twice; 0039 (0.7.21), 0040 and 0041 (0.7.22, foodpanda), then 0042 and 0043, then 0044 (came-by), then 0045 (on the website), then 0046 (website-order alerts), then 0047 (no discount on value deals), then 0048 (when an order was sent), then 0049 (outside riders), then 0050 (the note count at close), then 0051 (the shift report at close), by name', () => {
    const numbers = files.map((f) => Number(/^(\d{4})_/.exec(f)?.[1] ?? NaN));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    // 0040 / 0041 were released in v0.7.22: the drawer log and the test-order
    // delete were renumbered after them, so a 0.7.22 till runs just these two.
    expect(files.slice(38)).toEqual([
      '0039_shift_close_notes.sql',
      '0040_foodpanda_deal_and_terms.sql',
      '0041_channel_terms_uplift_and_fee.sql',
      '0042_drawer_log.sql',
      '0043_order_test_delete.sql',
      '0044_order_came_by.sql',
      '0045_web_availability.sql',
      '0046_web_order_alerts.sql',
      '0047_no_discount.sql',
      '0048_order_sent_at.sql',
      '0049_outside_rider.sql',
      '0050_shift_counted_notes.sql',
      '0051_shift_close_report.sql',
    ]);
  });

  it('0042 and 0043 assume nothing 0039, 0040 or 0041 changed: they touch neither the shifts table, order_discounts nor order_channel_terms', () => {
    for (const f of ['0042_drawer_log.sql', '0043_order_test_delete.sql']) {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      expect({ f, touches: /\bshifts\b|close_notes|carried_unpaid_count|carry_over_reason/i.test(sql) }).toEqual({ f, touches: false });
      expect({ f, touches: /\border_discounts\b|\border_channel_terms\b/i.test(sql) }).toEqual({ f, touches: false });
    }
  });

  it('0044 only adds orders.came_by: a plain nullable column, no CHECK, no backfill, nothing else touched', () => {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, '0044_order_came_by.sql'), 'utf8')).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe('ALTER TABLE orders ADD COLUMN came_by TEXT;');
    expect(/\border_discounts\b|\border_channel_terms\b|\bshifts\b|\bCHECK\b|\bUPDATE\b/i.test(sql)).toBe(false);
  });

  it('0045 only adds the two website columns, NOT NULL with today’s value as the default: no CHECK, no backfill, nothing else touched', () => {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, '0045_web_availability.sql'), 'utf8')).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe(
      "ALTER TABLE menu_items ADD COLUMN web_availability TEXT NOT NULL DEFAULT 'on'; ALTER TABLE categories ADD COLUMN is_on_website INTEGER NOT NULL DEFAULT 1;",
    );
    expect(/\bCHECK\b|\bUPDATE\b|\bINSERT\b|\bDROP\b|\bCREATE\b/i.test(sql)).toBe(false);
  });

  it('0046 only adds the six nullable web_order_imports columns, their backfill on imported rows and the unacked index; it touches no other table and stays pure-local', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0046_web_order_alerts.sql'), 'utf8');
    const sql = stripComments(raw).trim().replace(/\s+/g, ' ');
    expect(sql).toBe(
      [
        'ALTER TABLE web_order_imports ADD COLUMN web_created_at TEXT;',
        'ALTER TABLE web_order_imports ADD COLUMN web_total_cents INTEGER;',
        'ALTER TABLE web_order_imports ADD COLUMN acked_at TEXT;',
        'ALTER TABLE web_order_imports ADD COLUMN alert_seen_at TEXT;',
        'ALTER TABLE web_order_imports ADD COLUMN site_cancelled_at TEXT;',
        'ALTER TABLE web_order_imports ADD COLUMN cancel_noted_at TEXT;',
        'UPDATE web_order_imports SET acked_at = COALESCE(imported_at, updated_at), alert_seen_at = COALESCE(imported_at, updated_at)',
        "WHERE status = 'imported' AND pos_order_id IS NOT NULL;",
        'CREATE INDEX IF NOT EXISTS idx_web_imports_unacked ON web_order_imports(imported_at)',
        "WHERE status = 'imported' AND acked_at IS NULL;",
      ].join(' '),
    );
    // Every table it names is web_order_imports: no orders, no ledger, no settings.
    const tables = [...sql.matchAll(/\b(?:ALTER TABLE|UPDATE|ON|INTO|FROM)\s+(\w+)/gi)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(['web_order_imports']));
    expect(/\bCHECK\b|\bNOT NULL DEFAULT\b|\bDROP\b|\bDELETE\b|\bINSERT\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // Pure-local: no sync columns, so it must stay on the allowlist.
    expect(PURE_LOCAL_TABLES.has('web_order_imports')).toBe(true);
    expect([...(SCHEMA.get('web_order_imports') ?? [])]).toEqual(
      expect.arrayContaining(['web_created_at', 'web_total_cents', 'acked_at', 'alert_seen_at', 'site_cancelled_at', 'cancel_noted_at']),
    );
  });

  it('0047 only adds the two never-discounted columns: categories.no_discount nullable (NULL = by its name), order_items.no_discount NOT NULL DEFAULT 0; no CHECK, no backfill, nothing else touched', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0047_no_discount.sql'), 'utf8');
    const sql = stripComments(raw).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'ALTER TABLE categories ADD COLUMN no_discount INTEGER; ALTER TABLE order_items ADD COLUMN no_discount INTEGER NOT NULL DEFAULT 0;',
    );
    expect(/\bCHECK\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b|\bCREATE\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // Both tables replicate: the columns travel in their row images, no sync-core change.
    expect(PURE_LOCAL_TABLES.has('categories') || PURE_LOCAL_TABLES.has('order_items')).toBe(false);
  });

  it('0048 only adds orders.sent_at (nullable, no CHECK, no backfill) and its index on the Live Orders clock; nothing else touched', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0048_order_sent_at.sql'), 'utf8');
    const sql = stripComments(raw).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'ALTER TABLE orders ADD COLUMN sent_at TEXT; CREATE INDEX IF NOT EXISTS idx_orders_status_sent ON orders(status, COALESCE(sent_at, created_at)) WHERE deleted_at IS NULL;',
    );
    expect(/\bUPDATE\b|\bINSERT\b|\bCHECK\b|\bDROP\b|\bDELETE\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // orders replicates: the column travels in the order's row image, no sync-core change.
    expect(PURE_LOCAL_TABLES.has('orders')).toBe(false);
  });

  it('0049 only adds orders.rider_keeps_cents and cash_movements.order_id (nullable, no CHECK, no backfill) and the payout-by-order index; nothing else touched', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0049_outside_rider.sql'), 'utf8');
    const sql = stripComments(raw).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe(
      [
        'ALTER TABLE orders ADD COLUMN rider_keeps_cents INTEGER;',
        'ALTER TABLE cash_movements ADD COLUMN order_id TEXT REFERENCES orders(id);',
        'CREATE INDEX IF NOT EXISTS idx_cash_movements_order ON cash_movements(order_id) WHERE order_id IS NOT NULL;',
      ].join(' '),
    );
    expect(/\bUPDATE\b|\bINSERT\b|\bCHECK\b|\bDROP\b|\bDELETE\b|\bNOT NULL DEFAULT\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // Both tables replicate: the columns travel in their row images, no sync-core change.
    expect(PURE_LOCAL_TABLES.has('orders') || PURE_LOCAL_TABLES.has('cash_movements')).toBe(false);
  });

  it('0050 only adds shifts.counted_notes_json (nullable TEXT, no CHECK, no backfill, no index); nothing else touched', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0050_shift_counted_notes.sql'), 'utf8');
    const sql = stripComments(raw).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe('ALTER TABLE shifts ADD COLUMN counted_notes_json TEXT;');
    expect(sql.match(/\bALTER TABLE\b/gi)).toHaveLength(1);
    expect(/\bCHECK\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b|\bCREATE\b|\bNOT NULL\b|\bDEFAULT\b/i.test(sql)).toBe(false);
    expect(/\borders\b|\bcash_movements\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // shifts replicates: the column travels in the shift's row image, no sync-core change.
    expect(PURE_LOCAL_TABLES.has('shifts')).toBe(false);
  });

  it('0051 only adds shifts.close_report_json (nullable TEXT, no CHECK, no backfill, no index); nothing else touched', () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, '0051_shift_close_report.sql'), 'utf8');
    const sql = stripComments(raw).trim();
    expect(sql.replace(/\s+/g, ' ')).toBe('ALTER TABLE shifts ADD COLUMN close_report_json TEXT;');
    expect(sql.match(/\bALTER TABLE\b/gi)).toHaveLength(1);
    expect(/\bCHECK\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bDROP\b|\bCREATE\b|\bNOT NULL\b|\bDEFAULT\b/i.test(sql)).toBe(false);
    expect(/\borders\b|\bcash_movements\b|\bcounted_notes_json\b/i.test(sql)).toBe(false);
    // No BEGIN anywhere, comments included: the migrator runs it in its own transaction (migrator.ts managesOwnTransaction).
    expect(/\bBEGIN\b/i.test(raw)).toBe(false);
    // shifts replicates: the column travels in the shift's row image, no sync-core change.
    expect(PURE_LOCAL_TABLES.has('shifts')).toBe(false);
  });
});
