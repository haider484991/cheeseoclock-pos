import { randomUUID } from 'node:crypto';
import { WEBSITE_COPY_FORMAT } from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import baseSchemaSql from '../../db/schema.sql?raw';

/**
 * The website's own data, copied to the till every night and put back from there (27 Oct 2026; the user, after the
 * database hit its monthly limit: "both sync to pos laptop and all data circular so if it go down other can back it
 * up"). The till holds the shop's real records; these are the tables only the website has — the owner's phone
 * logins and dashboard, the website orders and their tracking, the menu files and their key, the WhatsApp chats,
 * the comment replies — plus the published menu, so a new database sells again at once.
 *
 * Read with the bridge secret only (app/api/bridge/website-copy). Putting a copy back only ever ADDS rows the
 * database does not have (ON CONFLICT DO NOTHING): it never overwrites a newer row, so it is safe to run on a
 * database that has carried on since.
 *
 * Left out: the heartbeat (store_status — the till sends it every minute), the deploy refresh marks, the rate-limit
 * counts, the till's own cloud copies (pos_backups / pos_backup_chunks — the till has them), and this website's
 * identity (a new database gets a new one: that is how the till sees it was replaced).
 */

export { WEBSITE_COPY_FORMAT };

export interface CopyTable {
  name: string;
  /** The primary key, for a stable page order. */
  key: string[];
  /** Its SERIAL / BIGSERIAL columns: their sequences move past the restored rows. */
  serial?: string[];
  /** A row is put back only while its parent row is there. */
  parent?: { column: string; table: string; parentColumn: string };
}

/** In the order a restore puts them back (a parent before its children). */
export const WEBSITE_COPY_TABLES: readonly CopyTable[] = [
  { name: 'site_menu', key: ['id'] },
  { name: 'web_orders', key: ['id'] },
  { name: 'menu_deploy_key', key: ['id'] },
  { name: 'menu_packages', key: ['id'], serial: ['seq'] },
  { name: 'menu_package_events', key: ['id'], serial: ['id'], parent: { column: 'package_id', table: 'menu_packages', parentColumn: 'id' } },
  { name: 'dash_logins', key: ['id'] },
  { name: 'dash_sessions', key: ['token_hash'], parent: { column: 'login_id', table: 'dash_logins', parentColumn: 'id' } },
  { name: 'dash_events', key: ['id'], serial: ['id'] },
  { name: 'dash_tills', key: ['device_id'] },
  { name: 'dash_orders', key: ['id'] },
  { name: 'dash_shifts', key: ['id'] },
  { name: 'dash_cash_moves', key: ['id'] },
  { name: 'dash_drawer_opens', key: ['id'] },
  { name: 'dash_stock', key: ['device_id', 'id'] },
  { name: 'dash_stock_moves', key: ['id'] },
  { name: 'dash_menu', key: ['device_id'] },
  { name: 'dash_days', key: ['device_id', 'day'] },
  { name: 'wa_chats', key: ['wa_id'] },
  { name: 'wa_events', key: ['id'] },
  { name: 'wa_links', key: ['token'] },
  { name: 'wa_orders', key: ['order_id'] },
  { name: 'wa_sessions', key: ['wa_id'] },
  { name: 'wa_order_updates', key: ['order_id', 'status'] },
  { name: 'capi_till_sales', key: ['order_id'] },
  { name: 'comment_actions', key: ['comment_id'] },
  { name: 'comment_sweeps', key: ['id'] },
];

const TABLES = new Map(WEBSITE_COPY_TABLES.map((t) => [t.name, t]));

export function copyTable(name: string): CopyTable | null {
  return TABLES.get(name) ?? null;
}

/**
 * One page of a copy: rows up to this many characters of JSON (well under the host's 4.5 MB response limit; the till
 * gives each call 20 s on shop Wi-Fi).
 */
export const PAGE_BUDGET_CHARS = 1_000_000;
export const PAGE_MAX_ROWS = 500;

const baseReady = new Map<string, Promise<void>>();

/** Every statement of db/schema.sql (each one safe to run again), once per server instance and database. */
export function ensureBaseSchema(): Promise<void> {
  const database = process.env['DATABASE_URL'] ?? '';
  let ready = baseReady.get(database);
  if (!ready) {
    ready = (async () => {
      const q = sql();
      for (const statement of schemaStatements(baseSchemaSql)) await q(statement);
    })().catch((e) => {
      baseReady.delete(database);
      throw e;
    });
    baseReady.set(database, ready);
  }
  return ready;
}

/** db/schema.sql as single statements (it has no functions or quoted semicolons). */
export function schemaStatements(text: string): string[] {
  return text
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** This website's identity: made once per database; a new database gets a new one. */
export async function websiteIdentity(): Promise<{ websiteId: string; createdAt: string }> {
  const q = sql();
  await q`
    CREATE TABLE IF NOT EXISTS site_identity (
      id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      website_id  UUID NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await q`INSERT INTO site_identity (id, website_id) VALUES (1, ${randomUUID()}) ON CONFLICT (id) DO NOTHING`;
  const rows = (await q`SELECT website_id::text AS website_id, created_at FROM site_identity WHERE id = 1`) as Array<{
    website_id: string;
    created_at: string | Date;
  }>;
  const row = rows[0]!;
  return { websiteId: row.website_id, createdAt: new Date(row.created_at).toISOString() };
}

export interface CopyManifest {
  format: typeof WEBSITE_COPY_FORMAT;
  websiteId: string;
  websiteCreatedAt: string;
  takenAt: string;
  tables: Array<{ name: string; rows: number }>;
}

/** What a copy holds right now: the identity and each table's row count. */
export async function websiteCopyManifest(now: Date = new Date()): Promise<CopyManifest> {
  await ensureBaseSchema();
  const identity = await websiteIdentity();
  const q = sql();
  const tables: CopyManifest['tables'] = [];
  for (const t of WEBSITE_COPY_TABLES) {
    const rows = (await q(`SELECT count(*)::int AS n FROM ${t.name}`)) as Array<{ n: number }>;
    tables.push({ name: t.name, rows: rows[0]?.n ?? 0 });
  }
  return {
    format: WEBSITE_COPY_FORMAT,
    websiteId: identity.websiteId,
    websiteCreatedAt: identity.createdAt,
    takenAt: now.toISOString(),
    tables,
  };
}

/** One page of a table, in key order from `offset`; `next` = where the next page starts, null at the end. */
export async function websiteCopyPage(
  table: CopyTable,
  offset: number,
  budgetChars = PAGE_BUDGET_CHARS,
): Promise<{ rows: unknown[]; next: number | null }> {
  await ensureBaseSchema();
  const got = (await sql()(
    `SELECT row_to_json(t)::text AS r FROM ${table.name} t ORDER BY ${table.key.join(', ')} LIMIT $1 OFFSET $2`,
    [PAGE_MAX_ROWS, offset],
  )) as Array<{ r: string }>;
  const rows: unknown[] = [];
  let chars = 0;
  for (const g of got) {
    if (rows.length > 0 && chars + g.r.length > budgetChars) break;
    rows.push(JSON.parse(g.r));
    chars += g.r.length;
  }
  const done = rows.length === got.length && got.length < PAGE_MAX_ROWS;
  return { rows, next: done ? null : offset + rows.length };
}

/**
 * Put rows of one table back: only those the database does not have (by its primary key), never over a newer row; a
 * child row only while its parent is there. Returns how many went in.
 */
export async function restoreRows(table: CopyTable, rows: readonly unknown[]): Promise<{ inserted: number }> {
  await ensureBaseSchema();
  if (rows.length === 0) return { inserted: 0 };
  const q = sql();
  // Only the columns the copy has: one added since it was taken keeps its default instead of getting NULL.
  const inCopy = new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])));
  const columns = (
    (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table.name],
    )) as Array<{ column_name: string }>
  )
    .map((c) => c.column_name)
    .filter((c) => inCopy.has(c));
  if (columns.length === 0) return { inserted: 0 };
  const list = columns.map((c) => `"${c}"`).join(', ');
  const where = table.parent
    ? ` WHERE r.${table.parent.column} IS NULL OR EXISTS (SELECT 1 FROM ${table.parent.table} p WHERE p.${table.parent.parentColumn} = r.${table.parent.column})`
    : '';
  const done = (await q(
    `WITH ins AS (
       INSERT INTO ${table.name} (${list})
       SELECT ${columns.map((c) => `r."${c}"`).join(', ')} FROM json_populate_recordset(NULL::${table.name}, $1::json) r${where}
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [JSON.stringify(rows)],
  )) as Array<{ n: number }>;
  for (const column of table.serial ?? []) {
    await q(
      `SELECT setval(pg_get_serial_sequence('${table.name}', '${column}'), GREATEST(COALESCE((SELECT max(${column}) FROM ${table.name}), 0), 1))`,
    );
  }
  return { inserted: done[0]?.n ?? 0 };
}
