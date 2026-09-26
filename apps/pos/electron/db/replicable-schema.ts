/**
 * The replicable tables as this database actually has them: columns, foreign
 * key parents and the order to send them in. Read from the live schema
 * (sqlite_master + PRAGMA table_info / foreign_key_list), so a migration that
 * adds a table or a column is picked up with no list to keep in step.
 *
 * Only `db.prepare` is used, so the same code runs on better-sqlite3 in the
 * app and on node:sqlite in the tests.
 */
import {
  PURE_LOCAL_TABLES,
  REPLICABLE_REQUIRED_COLUMNS,
  RECEIVER_OWNED_COLUMNS,
  ROW_IMAGE_KEY,
  ROW_IMAGE_VERSION,
  columnKey,
  isLocalOnlyColumn,
  type RowImage,
} from '@cheeseoclock/sync-core';

/** The one method this file needs; better-sqlite3 and node:sqlite both have it. */
interface SchemaDb {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
}

export interface ReplicableColumn {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}

export interface ReplicableTable {
  name: string;
  columns: ReplicableColumn[];
  /** Other replicable tables this one points at (foreign keys). */
  parents: string[];
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const cache = new WeakMap<object, { schemaVersion: number; tables: Map<string, ReplicableTable> }>();

function schemaVersion(db: SchemaDb): number {
  const r = db.prepare('PRAGMA schema_version').get() as { schema_version?: number } | undefined;
  return Number(r?.schema_version ?? 0);
}

/**
 * Every table that is not pure-local, keyed by name. Cached per connection
 * until the schema changes (one cheap PRAGMA per call).
 */
export function replicableTables(db: SchemaDb): Map<string, ReplicableTable> {
  const version = schemaVersion(db);
  const hit = cache.get(db);
  if (hit && hit.schemaVersion === version) return hit.tables;

  const names = (
    db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string | null }>
  ).filter((t) => !PURE_LOCAL_TABLES.has(t.name) && !/\bWITHOUT\s+ROWID\b/i.test(t.sql ?? ''));
  const tableNames = new Set(names.map((t) => t.name));

  const tables = new Map<string, ReplicableTable>();
  for (const { name } of names) {
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const have = new Set(info.map((c) => c.name));
    // A table without the sync columns is not something we can replicate
    // (db-contracts.test.ts keeps that from happening).
    if (!REPLICABLE_REQUIRED_COLUMNS.every((c) => have.has(c))) continue;
    const fks = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all() as Array<{
      table: string;
    }>;
    const parents = [
      ...new Set(fks.map((f) => f.table.toLowerCase()).filter((t) => t !== name && tableNames.has(t))),
    ].sort();
    tables.set(name, {
      name,
      columns: info.map((c) => ({
        name: c.name,
        notNull: c.notnull === 1,
        hasDefault: c.dflt_value !== null && c.dflt_value !== undefined,
      })),
      parents,
    });
  }
  cache.set(db, { schemaVersion: version, tables });
  return tables;
}

/**
 * Tables in foreign-key order: every table after all the tables it points at
 * (ties by name, so the order is stable). A self-reference (an order line's
 * parent line) is fine: rows go in rowid order, parents are written first.
 */
export function snapshotOrder(db: SchemaDb): string[] {
  const tables = replicableTables(db);
  const remaining = new Map<string, Set<string>>();
  for (const t of tables.values()) remaining.set(t.name, new Set(t.parents));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, parents]) => parents.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`Foreign keys form a loop: ${[...remaining.keys()].join(', ')}`);
    }
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const parents of remaining.values()) parents.delete(name);
    }
  }
  return order;
}

/**
 * The row as an image: every column except the receiver-owned and
 * local-only ones, keyed by columnKey. Values are copied as stored.
 */
export function rowImage(table: ReplicableTable, row: Record<string, unknown>): RowImage {
  const image: Record<string, unknown> = { [ROW_IMAGE_KEY]: ROW_IMAGE_VERSION };
  for (const col of table.columns) {
    if (RECEIVER_OWNED_COLUMNS.has(col.name) || isLocalOnlyColumn(table.name, col.name)) continue;
    const v = row[col.name];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
      // No BLOB or BIGINT columns exist; refuse rather than send something the
      // other side would read back differently.
      throw new Error(`Cannot send ${table.name}.${col.name}: unsupported value type ${typeof v}`);
    }
    image[columnKey(col.name)] = v;
  }
  return image as RowImage;
}

/** Read one row as an image, or null when there is no such row (or no such table). */
export function readRowImage(db: SchemaDb, tableName: string, id: string): RowImage | null {
  const table = replicableTables(db).get(tableName);
  if (!table) return null;
  const row = db.prepare(`SELECT * FROM ${quoteIdent(table.name)} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowImage(table, row) : null;
}
