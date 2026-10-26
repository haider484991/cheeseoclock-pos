/**
 * The website's own data copied out to the till and put back into a new database (lib/website-copy.ts; 27 Oct
 * 2026), through the route handlers on two real Postgres databases (PGlite, in memory, with db/schema.sql): the old
 * one, and an empty one standing in for a replacement —
 *  - the copy holds every row, page by page, and a new database gets its own identity;
 *  - putting it back adds every row, the serial counters move past them, and a second time adds nothing;
 *  - a row the new database already has is never overwritten;
 *  - a child row whose parent is not there is left out;
 *  - only the bridge secret reads or writes it, and only the tables the copy carries;
 *  - the till's own client (apps/pos/electron/services/website-copy-client.ts) pulls and puts back the same.
 *
 * Every order, person and shop here is made up.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CopyManifest } from '@/lib/website-copy';
import type { BridgeApi } from '../../../pos/electron/services/cloud-copy-chunks';
import { pullWebsiteCopy, pushWebsiteCopy } from '../../../pos/electron/services/website-copy-client';

type Pg = { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[] }> };
const db = vi.hoisted(() => ({ current: null as unknown as Pg }));
/** Which database the routes talk to: the old one or the new one (each has its own address, as on the host). */
function use(pg: PGlite, address: string): void {
  db.current = pg as unknown as Pg;
  process.env['DATABASE_URL'] = address;
}
vi.mock('@/lib/db', () => ({
  // The Neon client: a tagged template, or an ordinary call (text, params); both return rows.
  sql: () => (first: TemplateStringsArray | string, ...rest: unknown[]) =>
    typeof first === 'string'
      ? db.current.query(first, (rest[0] as unknown[] | undefined) ?? []).then((r) => r.rows)
      : db.current.query(first.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), rest).then((r) => r.rows),
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const copyRoute = await import('@/app/api/bridge/website-copy/route');
const restoreRoute = await import('@/app/api/bridge/website-copy/restore/route');
const copyLib = await import('@/lib/website-copy');

const SECRET = 'test-bridge-secret-0123456789';
const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');

let oldDb: PGlite;
let newDb: PGlite;

async function call(path: string, init?: { method?: string; body?: unknown; secret?: string }) {
  const req = new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${init?.secret ?? SECRET}`, 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const res = path.startsWith('/api/bridge/website-copy/restore') ? await restoreRoute.POST(req) : await copyRoute.GET(req);
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: unknown; error?: string } };
}

/** The whole copy, the way the till takes it: the manifest, then each table page by page. */
async function takeCopy(): Promise<{ websiteId: string; tables: Record<string, unknown[]> }> {
  const manifest = (await call('/api/bridge/website-copy')).json.data as CopyManifest;
  const tables: Record<string, unknown[]> = {};
  for (const t of manifest.tables) {
    const rows: unknown[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (await call(`/api/bridge/website-copy?table=${t.name}&offset=${offset}`)).json.data as {
        rows: unknown[];
        next: number | null;
      };
      rows.push(...page.rows);
      offset = page.next;
    }
    expect(rows.length).toBe(t.rows);
    tables[t.name] = rows;
  }
  return { websiteId: manifest.websiteId, tables };
}

async function putBack(copy: { tables: Record<string, unknown[]> }): Promise<Record<string, number>> {
  const inserted: Record<string, number> = {};
  for (const t of copyLib.WEBSITE_COPY_TABLES) {
    const res = await call('/api/bridge/website-copy/restore', {
      method: 'POST',
      body: { format: copyLib.WEBSITE_COPY_FORMAT, table: t.name, rows: copy.tables[t.name] ?? [] },
    });
    expect(res.status).toBe(200);
    inserted[t.name] = (res.json.data as { inserted: number }).inserted;
  }
  return inserted;
}

const rows = async (pg: PGlite, q: string) => (await pg.query(q)).rows as Array<Record<string, unknown>>;

const PKG_A = '0192f000-0000-7000-8000-00000000000a';
const PKG_B = '0192f000-0000-7000-8000-00000000000b';
const LOGIN = '0192f000-0000-7000-8000-0000000000c1';
const ORDER_1 = '0192f000-0000-7000-8000-0000000000d1';
const ORDER_2 = '0192f000-0000-7000-8000-0000000000d2';

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  oldDb = new PGlite();
  newDb = new PGlite();
  await oldDb.exec(SCHEMA);
  await oldDb.exec(`
    INSERT INTO site_menu (id, menu_json, published_at)
      VALUES (1, '{"categories":[{"name":"Deals","items":[{"name":"Test Deal","priceCents":99900}]}]}', '2026-10-26T12:42:00Z');
    INSERT INTO web_orders (id, status, customer_name, customer_phone, address_line, items_json,
                            subtotal_cents, tax_cents, total_cents, created_at)
      VALUES ('${ORDER_1}', 'delivered', 'Test Customer', '03000000001', 'House 1, Test Street',
              '[{"name":"Test Deal","qty":1}]', 99900, 0, 99900, '2026-10-20T15:00:00Z'),
             ('${ORDER_2}', 'new', 'Another Test', '03000000002', 'House 2, Test Street',
              '[{"name":"Test Deal","qty":2}]', 199800, 0, 199800, '2026-10-26T15:00:00Z');
    INSERT INTO menu_deploy_key (id, key_hash, key_hint, device_id) VALUES (1, 'hash-of-a-made-up-key', 'ab12', 'till-test-1');
    INSERT INTO menu_packages (id, file_name, sha256, size_bytes, format_version, generated_at, item_count, ingredient_count, state, result_json)
      VALUES ('${PKG_A}', 'menu-1.json', 'aa', 10, 8, '2026-10-24T10:00:00Z', 3, 4, 'applied', '{"changed":3}'),
             ('${PKG_B}', 'menu-2.json', 'bb', 12, 8, '2026-10-26T10:00:00Z', 5, 6, 'pending', NULL);
    INSERT INTO menu_package_events (package_id, kind, device_id, detail)
      VALUES ('${PKG_A}', 'uploaded', NULL, '{"by":"test"}'), ('${PKG_A}', 'applied', 'till-test-1', '{"appVersion":"0.7.57"}'),
             ('${PKG_B}', 'uploaded', NULL, NULL);
    INSERT INTO dash_logins (id, username, display_name, role, sees_reports)
      VALUES ('${LOGIN}', 'owner', 'Test Owner', 'owner', true);
    INSERT INTO dash_sessions (token_hash, login_id) VALUES ('session-hash-1', '${LOGIN}');
    INSERT INTO dash_events (kind, login_id, detail) VALUES ('sign_in', '${LOGIN}', '{}'), ('sign_out', '${LOGIN}', '{}');
  `);
  // The old database has its own identity (made on its first copy).
  use(oldDb, 'postgres://old.test/db');
});

describe('the website copy (the website → the till → a new database)', () => {
  let copy: Awaited<ReturnType<typeof takeCopy>>;

  it('holds every row of every table it carries, page by page', async () => {
    copy = await takeCopy();
    expect(copy.tables['web_orders']).toHaveLength(2);
    expect(copy.tables['menu_package_events']).toHaveLength(3);
    expect(copy.tables['dash_sessions']).toHaveLength(1);
    expect((copy.tables['site_menu']![0] as { menu_json: unknown }).menu_json).toMatchObject({ categories: [{ name: 'Deals' }] });
    // The same identity every time on the same database.
    expect((await takeCopy()).websiteId).toBe(copy.websiteId);
  });

  it('pages a big table under the budget and in key order', async () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ id: i }));
    const table = copyLib.copyTable('dash_events')!;
    await oldDb.exec(`INSERT INTO dash_events (kind, detail) SELECT 'note', jsonb_build_object('pad', repeat('x', 400)) FROM generate_series(1, 30)`);
    const seen: number[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await copyLib.websiteCopyPage(table, offset, 2_000);
      seen.push(...page.rows.map((r) => Number((r as { id: number }).id)));
      offset = page.next;
      pages++;
    }
    expect(pages).toBeGreaterThan(5);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen).toHaveLength(big.length + 2);
    await oldDb.exec(`DELETE FROM dash_events WHERE kind = 'note'`);
    await oldDb.exec(`SELECT setval(pg_get_serial_sequence('dash_events', 'id'), 2)`);
  });

  it('a new database gets a new identity', async () => {
    use(newDb, 'postgres://new.test/db');
    const manifest = (await call('/api/bridge/website-copy')).json.data as CopyManifest;
    expect(manifest.websiteId).not.toBe(copy.websiteId);
    expect(manifest.tables.every((t) => t.rows === 0)).toBe(true);
  });

  it('puts every row back into the new database, and the counters move past them', async () => {
    use(newDb, 'postgres://new.test/db');
    const inserted = await putBack(copy);
    expect(inserted).toMatchObject({ site_menu: 1, web_orders: 2, menu_packages: 2, menu_package_events: 3, dash_logins: 1, dash_sessions: 1, dash_events: 2 });
    expect(await rows(newDb, `SELECT id::text, status FROM web_orders ORDER BY id`)).toEqual([
      { id: ORDER_1, status: 'delivered' },
      { id: ORDER_2, status: 'new' },
    ]);
    expect((await rows(newDb, `SELECT menu_json FROM site_menu`))[0]!['menu_json']).toEqual(
      (await rows(oldDb, `SELECT menu_json FROM site_menu`))[0]!['menu_json'],
    );
    // New rows after the restore get numbers past the restored ones.
    const oldSeqs = await rows(oldDb, `SELECT seq FROM menu_packages ORDER BY seq`);
    await newDb.exec(`INSERT INTO menu_packages (id, file_name, sha256, size_bytes, format_version, generated_at, item_count, ingredient_count)
                      VALUES ('0192f000-0000-7000-8000-00000000000e', 'menu-3.json', 'cc', 1, 8, now(), 1, 1)`);
    const seq = (await rows(newDb, `SELECT seq FROM menu_packages WHERE file_name = 'menu-3.json'`))[0]!['seq'] as number;
    expect(seq).toBeGreaterThan(Math.max(...oldSeqs.map((r) => r['seq'] as number)));
    await newDb.exec(`INSERT INTO dash_events (kind) VALUES ('after_restore')`);
    const ids = (await rows(newDb, `SELECT id::int AS id FROM dash_events ORDER BY id`)).map((r) => r['id']);
    expect(new Set(ids).size).toBe(ids.length);
    // The new database keeps its own identity.
    expect(((await call('/api/bridge/website-copy')).json.data as CopyManifest).websiteId).not.toBe(copy.websiteId);
  });

  it('a second time adds nothing', async () => {
    use(newDb, 'postgres://new.test/db');
    const again = await putBack(copy);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });

  it('never overwrites a row the database already has', async () => {
    use(newDb, 'postgres://new.test/db');
    await newDb.exec(`UPDATE web_orders SET status = 'cancelled' WHERE id = '${ORDER_2}'`);
    await putBack(copy);
    expect((await rows(newDb, `SELECT status FROM web_orders WHERE id = '${ORDER_2}'`))[0]!['status']).toBe('cancelled');
  });

  it('leaves out a child row whose parent is not there', async () => {
    const fresh = new PGlite();
    use(fresh, 'postgres://fresh.test/db');
    const res = await call('/api/bridge/website-copy/restore', {
      method: 'POST',
      body: { format: copyLib.WEBSITE_COPY_FORMAT, table: 'dash_sessions', rows: copy.tables['dash_sessions'] },
    });
    expect(res.json.data).toEqual({ inserted: 0 });
    const events = await call('/api/bridge/website-copy/restore', {
      method: 'POST',
      body: { format: copyLib.WEBSITE_COPY_FORMAT, table: 'menu_package_events', rows: copy.tables['menu_package_events'] },
    });
    expect(events.json.data).toEqual({ inserted: 0 });
    await fresh.close();
  });

  it('a copy older than a column puts the row back with that column at its default', async () => {
    use(newDb, 'postgres://new.test/db');
    const older: Record<string, unknown> = { ...(copy.tables['web_orders']![0] as Record<string, unknown>), id: '0192f000-0000-7000-8000-0000000000d3' };
    delete older['fulfilment'];
    delete older['discount_cents'];
    const res = await call('/api/bridge/website-copy/restore', {
      method: 'POST',
      body: { format: copyLib.WEBSITE_COPY_FORMAT, table: 'web_orders', rows: [older] },
    });
    expect(res.json.data).toEqual({ inserted: 1 });
    expect(await rows(newDb, `SELECT fulfilment, discount_cents FROM web_orders WHERE id = '${older['id']}'`)).toEqual([
      { fulfilment: 'delivery', discount_cents: 0 },
    ]);
  });

  it('the till’s own client pulls the whole copy and puts it back into a new database', async () => {
    const api: BridgeApi = async (path, init) => {
      const res = await call(path, { method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
      return { status: res.status, json: res.json };
    };
    use(oldDb, 'postgres://old.test/db');
    const doc = await pullWebsiteCopy(api);
    expect(doc.websiteId).toBe(copy.websiteId);
    expect(doc.tables.map((t) => t.name)).toEqual(copyLib.WEBSITE_COPY_TABLES.map((t) => t.name));
    const total = doc.tables.reduce((n, t) => n + t.rows.length, 0);
    const another = new PGlite();
    use(another, 'postgres://another.test/db');
    const put = await pushWebsiteCopy(api, doc, 'website-test.json.gz');
    expect(put.inserted).toBe(total);
    expect((await pushWebsiteCopy(api, doc, 'website-test.json.gz')).inserted).toBe(0);
    expect(await rows(another, `SELECT count(*)::int AS n FROM web_orders`)).toEqual([{ n: 2 }]);
    await another.close();
  });

  it('answers only the bridge secret, and only for the tables the copy carries', async () => {
    use(oldDb, 'postgres://old.test/db');
    expect((await call('/api/bridge/website-copy', { secret: 'wrong-secret-0123456789' })).status).toBe(401);
    expect(
      (await call('/api/bridge/website-copy/restore', { method: 'POST', secret: 'wrong-secret-0123456789', body: {} })).status,
    ).toBe(401);
    expect((await call('/api/bridge/website-copy?table=pos_backups&offset=0')).status).toBe(400);
    expect((await call('/api/bridge/website-copy?table=web_orders&offset=-1')).status).toBe(400);
    const refused = await call('/api/bridge/website-copy/restore', {
      method: 'POST',
      body: { format: copyLib.WEBSITE_COPY_FORMAT, table: 'store_status', rows: [{ id: 1 }] },
    });
    expect(refused.status).toBe(400);
  });
});
