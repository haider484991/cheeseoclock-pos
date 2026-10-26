/**
 * The website's SQL client answers the same through both of its drivers (lib/db.ts; 27 Oct 2026, the move from
 * Neon to Supabase's free plan): Neon's HTTP driver — here through the dev stand-in's protocol, which hands back
 * every value as Postgres text for the driver to parse, as Neon does — and postgres.js over TCP, here through
 * PGlite's wire-protocol server. Both on real Postgres (PGlite, in memory, with db/schema.sql) —
 *  - every column type the website stores comes back as the same JavaScript value;
 *  - every kind of value the website sends goes in the same way (text, numbers, booleans, null, undefined, dates,
 *    JSON text, arrays cast to text[] / uuid[], base64 bytes);
 *  - a plain statement with its $1… values, and a hand-made template (dashboard/schema.ts), run on both;
 *  - a Postgres error keeps its SQLSTATE code (schema-on-demand.ts and the logins route read it);
 *  - the website's own copy and put-back (lib/website-copy.ts, its routes, the till's client) run whole through
 *    postgres.js, from one database into an empty one.
 *
 * Every order, person and shop here is made up.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { PGlite, types } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CopyManifest } from '@/lib/website-copy';

// The website's functions run in UTC (Vercel, Cloudflare): a date-only value means midnight UTC on both drivers.
process.env.TZ = 'UTC';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
const SECRET = 'test-bridge-secret-0123456789';

/** The dev stand-in's answer to Neon's HTTP protocol (scripts/dev-neon-shim.mjs), on a given database. */
function neonStandIn(pg: PGlite): Promise<{ server: Server; endpoint: string }> {
  const raw = (value: string) => value;
  const parsers: Record<number, (v: string) => string> = {};
  for (const oid of Object.values(types)) if (typeof oid === 'number') parsers[oid] = raw;
  for (const oid of [1000, 1005, 1007, 1009, 1015, 1016, 1021, 1022, 1028, 1115, 1182, 1185, 199, 3807, 1231, 2951]) parsers[oid] = raw;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const { query, params } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; params?: unknown[] };
          const r = await pg.query<unknown[]>(query, params ?? [], { rowMode: 'array', parsers });
          const body = {
            command: (query.trim().split(/\s+/)[0] ?? '').toUpperCase(),
            rowCount: r.affectedRows ?? r.rows.length,
            fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: r.rows.map((row) => row.map((v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v)))),
          };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        } catch (e) {
          const err = e as { message?: string; code?: string };
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: err.message, code: err.code }));
        }
      })();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sql` })),
  );
}

/** PGlite on a TCP port, the way postgres.js reaches Supabase. */
async function wireServer(pg: PGlite): Promise<{ server: PGLiteSocketServer; url: string }> {
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  return { server, url: `postgres://postgres:postgres@${server.getServerConn()}/postgres` };
}

let pg: PGlite;
let neonServer: Server;
let neonEndpoint: string;
let wire: PGLiteSocketServer;
let wireUrl: string;
let db: typeof import('@/lib/db');

/** The client the website builds for each driver (lib/db.ts decides by the address). */
function neonSql() {
  process.env['DEV_NEON_ENDPOINT'] = neonEndpoint;
  process.env['DATABASE_URL'] = 'postgresql://dev:dev@127.0.0.1/dev';
  return db.sql();
}
function tcpSql(url = wireUrl) {
  delete process.env['DEV_NEON_ENDPOINT'];
  process.env['DATABASE_URL'] = url;
  return db.sql();
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  ({ server: neonServer, endpoint: neonEndpoint } = await neonStandIn(pg));
  ({ server: wire, url: wireUrl } = await wireServer(pg));
  // Neon's driver takes its endpoint when lib/db.ts loads, as `next dev` does.
  process.env['DEV_NEON_ENDPOINT'] = neonEndpoint;
  db = await import('@/lib/db');
});

afterAll(async () => {
  await new Promise((r) => neonServer.close(r));
  await wire.stop();
});

const ORDER_UUID = '0192f000-0000-7000-8000-0000000000d1';
const OTHER_UUID = '0192f000-0000-7000-8000-0000000000d2';

describe('lib/db.ts picks the driver by the address', () => {
  it('Neon and the dev stand-in get Neon’s driver; any other Postgres gets postgres.js', async () => {
    expect(await neonSql()`SELECT 'neon' AS via`).toEqual([{ via: 'neon' }]);
    expect(await tcpSql()`SELECT 'tcp' AS via`).toEqual([{ via: 'tcp' }]);
  });
});

describe('the same values back through both drivers', () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE driver_check (
        k text PRIMARY KEY, t text, i int, s smallint, b bigint, bs bigserial, n numeric(12,2), d double precision,
        bo boolean, ts timestamptz, dt date, j jsonb, js json, u uuid, ta text[], ua uuid[], ia int[], by bytea, nul text
      )`);
  });

  const detail = { name: 'Zinger "spicy" \\ 🍕', priceCents: 99900, nested: { list: [1, 'two', null, true] } };

  async function insertWith(sql: ReturnType<typeof neonSql>, k: string) {
    await sql`
      INSERT INTO driver_check (k, t, i, s, b, n, d, bo, ts, dt, j, js, u, ta, ua, ia, by, nul)
      VALUES (${k}, ${'Chicken Fajita – 12" (Large), Rs. 1,899'}, ${42}, ${3}, ${'9007199254740993'}, ${'1234.50'},
              ${0.1}, ${true}, ${new Date('2026-10-26T18:32:00.123Z')}, ${'2026-10-26'}, ${JSON.stringify(detail)}::jsonb,
              ${JSON.stringify(detail)}::json, ${ORDER_UUID}, ${['a', 'b,c', '"q"', 'd e']}::text[],
              ${[ORDER_UUID, OTHER_UUID]}::uuid[], ${[1, 2, 3]}::int[], decode(${Buffer.from([0, 1, 2, 255]).toString('base64')}, 'base64'),
              ${undefined})`;
  }

  it('a row written by either driver is the same row, and both read it back the same', async () => {
    await insertWith(neonSql(), 'neon');
    await insertWith(tcpSql(), 'tcp');
    const viaNeon = await neonSql()`SELECT * FROM driver_check ORDER BY k`;
    const viaTcp = await tcpSql()`SELECT * FROM driver_check ORDER BY k`;
    expect(viaTcp).toEqual(viaNeon);
    const [byNeon, byTcp] = viaTcp as Array<Record<string, unknown>>;
    expect({ ...byTcp, k: '', bs: '' }).toEqual({ ...byNeon, k: '', bs: '' });
    // What the website reads back, by type (as Neon's driver has always given it).
    expect(byTcp).toMatchObject({
      t: 'Chicken Fajita – 12" (Large), Rs. 1,899',
      i: 42,
      s: 3,
      b: '9007199254740993',
      n: '1234.50',
      d: 0.1,
      bo: true,
      j: detail,
      js: detail,
      u: ORDER_UUID,
      ta: ['a', 'b,c', '"q"', 'd e'],
      ua: [ORDER_UUID, OTHER_UUID],
      ia: [1, 2, 3],
      nul: null,
    });
    expect((byTcp!['ts'] as Date).toISOString()).toBe('2026-10-26T18:32:00.123Z');
    expect((byTcp!['dt'] as Date).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(Buffer.from(byTcp!['by'] as Uint8Array)).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('computed values (counts, casts, empty results) come back the same', async () => {
    const q = (sql: ReturnType<typeof neonSql>) => sql`
      SELECT count(*) AS c, count(*)::int AS ci, sum(i) AS total, 1.5::numeric AS num, ARRAY[1, 2]::int[] AS ia,
             '2026-10-26 10:00:00'::timestamp AS local_ts, NULL::jsonb AS nothing, max(ts) AS newest,
             coalesce(max(dt), '2026-01-01'::date) AS day, array_agg(k ORDER BY k) AS keys
        FROM driver_check`;
    expect(await q(tcpSql())).toEqual(await q(neonSql()));
    const none = (sql: ReturnType<typeof neonSql>) => sql`SELECT k FROM driver_check WHERE k = ${'no such row'}`;
    expect(await none(tcpSql())).toEqual([]);
    expect(await none(neonSql())).toEqual([]);
  });

  it('every kind of value the website sends goes in the same way', async () => {
    const q = (sql: ReturnType<typeof neonSql>) => sql`
      SELECT ${null}::text AS a_null, ${undefined}::text AS an_undefined, ${5}::text AS number_as_text,
             ${'7'}::int AS text_as_int, ${false} AS a_false, ${new Date('2026-10-26T00:00:00Z')}::date AS date_from_date,
             ${'2026-10-26T23:30:00+05:00'}::timestamptz AS ts_from_text, ${[]}::text[] AS empty_list,
             ${'x'} = ANY(${['x', 'y']}::text[]) AS in_list, ${ORDER_UUID}::uuid = ANY(${[OTHER_UUID]}::uuid[]) AS not_in_list,
             ${JSON.stringify([{ qty: 2 }])}::jsonb -> 0 ->> 'qty' AS qty, ${'O\'Brien; DROP TABLE x;--'} AS quote_safe,
             ${new Date('2026-10-26T18:32:00.123Z')}::text AS date_as_text, ${true}::text AS true_as_text,
             ${{ a: 1 }}::jsonb AS object_as_json, ${['x', null, 'a "b"']}::text[] AS list_with_null,
             ${[1, null, 3]}::int[] AS ints_with_null, ARRAY[true, NULL]::bool[] AS bools, ARRAY[1::bigint, NULL] AS bigs,
             ARRAY['2026-10-26T18:32:00Z'::timestamptz, NULL] AS times, ARRAY[ARRAY['a', 'b'], ARRAY['c', NULL]] AS nested,
             ARRAY['{"a":[1,"x,y"]}'::jsonb, NULL] AS jsons, ARRAY['{"a":1}'::json] AS plain_jsons,
             (SELECT array_agg(v) FROM (VALUES ('cash'), (NULL), ('card')) AS t(v)) AS aggregated`;
    const viaTcp = await q(tcpSql());
    expect(viaTcp).toEqual(await q(neonSql()));
    expect(viaTcp[0]).toMatchObject({ a_null: null, an_undefined: null, number_as_text: '5', text_as_int: 7, in_list: true, not_in_list: false, qty: '2', quote_safe: "O'Brien; DROP TABLE x;--" });
    expect(viaTcp[0]).toMatchObject({ date_as_text: '2026-10-26T18:32:00.123+00:00', true_as_text: 'true', object_as_json: { a: 1 }, list_with_null: ['x', null, 'a "b"'] });
    expect(viaTcp[0]).toMatchObject({
      ints_with_null: [1, null, 3],
      bools: [true, null],
      bigs: ['1', null],
      nested: [['a', 'b'], ['c', null]],
      jsons: [{ a: [1, 'x,y'] }, null],
      plain_jsons: [{ a: 1 }],
      aggregated: ['cash', null, 'card'],
    });
  });

  it('writes report the same (RETURNING, ON CONFLICT, an UPDATE with no row)', async () => {
    for (const [sql, k] of [[neonSql(), 'w-neon'], [tcpSql(), 'w-tcp']] as const) {
      expect(await sql`INSERT INTO driver_check (k, i) VALUES (${k}, 1) RETURNING k, i`).toEqual([{ k, i: 1 }]);
      expect(await sql`INSERT INTO driver_check (k, i) VALUES (${k}, 2) ON CONFLICT (k) DO NOTHING RETURNING k`).toEqual([]);
      expect(await sql`UPDATE driver_check SET i = i + 1 WHERE k = ${k} RETURNING i`).toEqual([{ i: 2 }]);
      expect(await sql`UPDATE driver_check SET i = 0 WHERE k = ${'missing-' + k}`).toEqual([]);
      expect(await sql`DELETE FROM driver_check WHERE k = ${k}`).toEqual([]);
    }
  });
});

describe('the other two ways the website calls it', () => {
  it('a plain statement with its $1… values (lib/website-copy.ts)', async () => {
    for (const sql of [neonSql(), tcpSql()]) {
      expect(await sql('SELECT $1::int + $2::int AS n, $3::text AS t', [2, 3, 'x'])).toEqual([{ n: 5, t: 'x' }]);
      expect(await sql('SELECT count(*)::int AS n FROM driver_check')).toEqual([{ n: 2 }]);
    }
  });

  it('a hand-made template with no values (dashboard/schema.ts statementParts)', async () => {
    const text = 'CREATE TABLE IF NOT EXISTS driver_made (id INT PRIMARY KEY)';
    const parts = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
    for (const sql of [neonSql(), tcpSql()]) {
      expect(await sql(parts)).toEqual([]);
      expect(await sql(Object.assign(['SELECT 2 AS two'], { raw: ['SELECT 2 AS two'] }) as unknown as TemplateStringsArray)).toEqual([{ two: 2 }]);
    }
  });
});

describe('a Postgres error keeps its SQLSTATE on both drivers', () => {
  it('missing table (42P01) and missing column (42703), which schema-on-demand.ts answers', async () => {
    const { isMissingSchema } = await import('@/lib/schema-on-demand');
    for (const sql of [neonSql(), tcpSql()]) {
      const table = await Promise.resolve(sql`SELECT * FROM no_such_table`).catch((e: unknown) => e);
      expect((table as { code?: string }).code).toBe('42P01');
      expect(isMissingSchema(table)).toBe(true);
      const column = await Promise.resolve(sql`SELECT no_such_column FROM driver_check`).catch((e: unknown) => e);
      expect((column as { code?: string }).code).toBe('42703');
      expect(isMissingSchema(column)).toBe(true);
    }
  });

  it('a duplicate key (23505), which the logins route answers', async () => {
    for (const sql of [neonSql(), tcpSql()]) {
      const dup = await Promise.resolve(sql`INSERT INTO driver_check (k) VALUES ('neon')`).catch((e: unknown) => e);
      expect((dup as { code?: string }).code).toBe('23505');
    }
  });
});

describe('the website copy, whole, through postgres.js (old database → an empty new one)', () => {
  let oldDb: PGlite;
  let newDb: PGlite;
  let oldWire: Awaited<ReturnType<typeof wireServer>>;
  let newWire: Awaited<ReturnType<typeof wireServer>>;

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
        VALUES ('${ORDER_UUID}', 'delivered', 'Test Customer', '03000000001', 'House 1, Test Street',
                '[{"name":"Test Deal","qty":1}]', 99900, 0, 99900, '2026-10-20T15:00:00Z'),
               ('${OTHER_UUID}', 'new', 'Another Test', '03000000002', 'House 2, Test Street',
                '[{"name":"Test Deal","qty":2}]', 199800, 0, 199800, '2026-10-26T15:00:00Z');
      INSERT INTO menu_packages (id, file_name, sha256, size_bytes, format_version, generated_at, item_count, ingredient_count, state, result_json)
        VALUES ('0192f000-0000-7000-8000-00000000000a', 'menu-1.json', 'aa', 10, 8, '2026-10-24T10:00:00Z', 3, 4, 'applied', '{"changed":3}');
      INSERT INTO menu_package_events (package_id, kind, device_id, detail)
        VALUES ('0192f000-0000-7000-8000-00000000000a', 'uploaded', NULL, '{"by":"test"}');
      INSERT INTO dash_logins (id, username, display_name, role, sees_reports)
        VALUES ('0192f000-0000-7000-8000-0000000000c1', 'owner', 'Test Owner', 'owner', true);
      INSERT INTO dash_events (kind, login_id, detail) VALUES ('sign_in', '0192f000-0000-7000-8000-0000000000c1', '{}');
    `);
    oldWire = await wireServer(oldDb);
    newWire = await wireServer(newDb);
  });

  afterAll(async () => {
    await oldWire.server.stop();
    await newWire.server.stop();
  });

  it('copies every row out of one and puts every row into the other, with the same values', async () => {
    const copyRoute = await import('@/app/api/bridge/website-copy/route');
    const restoreRoute = await import('@/app/api/bridge/website-copy/restore/route');
    const copyLib = await import('@/lib/website-copy');
    const call = async (path: string, body?: unknown) => {
      const req = new Request(`https://site.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const res = body === undefined ? await copyRoute.GET(req) : await restoreRoute.POST(req);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: unknown }).data;
    };

    tcpSql(oldWire.url);
    const manifest = (await call('/api/bridge/website-copy')) as CopyManifest;
    const tables: Record<string, unknown[]> = {};
    for (const t of manifest.tables) {
      const rows: unknown[] = [];
      for (let offset: number | null = 0; offset !== null; ) {
        const page = (await call(`/api/bridge/website-copy?table=${t.name}&offset=${offset}`)) as { rows: unknown[]; next: number | null };
        rows.push(...page.rows);
        offset = page.next;
      }
      tables[t.name] = rows;
    }
    expect(tables['web_orders']).toHaveLength(2);

    tcpSql(newWire.url);
    const inserted: Record<string, number> = {};
    for (const t of copyLib.WEBSITE_COPY_TABLES) {
      inserted[t.name] = ((await call('/api/bridge/website-copy/restore', { format: copyLib.WEBSITE_COPY_FORMAT, table: t.name, rows: tables[t.name] ?? [] })) as { inserted: number }).inserted;
    }
    expect(inserted).toMatchObject({ site_menu: 1, web_orders: 2, menu_packages: 1, menu_package_events: 1, dash_logins: 1, dash_events: 1 });

    // Every table the copy carries holds the same rows in both databases.
    for (const t of copyLib.WEBSITE_COPY_TABLES) {
      const dump = async (d: PGlite) =>
        (await d.query<{ r: string }>(`SELECT row_to_json(x)::text AS r FROM ${t.name} x ORDER BY ${t.key.join(', ')}`)).rows.map((r) => JSON.parse(r.r) as unknown);
      expect(await dump(newDb), t.name).toEqual(await dump(oldDb));
    }
    // The phone dashboard's own tables are made on the new database through postgres.js as well.
    const { ensureDashSchema } = await import('@/lib/dashboard/schema');
    await expect(ensureDashSchema()).resolves.toBeUndefined();
  });
});
