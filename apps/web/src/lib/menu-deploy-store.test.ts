/**
 * The menu file tables are made on demand (ensureMenuDeploySchema), so the
 * live database needs no hand migration and no existing route waits on them:
 * a first request works on a database without them, on one made from
 * db/schema.sql, again and again, and after a failed first try.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  fail: 0,
}));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (db.fail > 0) {
      db.fail--;
      return Promise.reject(new Error('made-up: the database is asleep'));
    }
    return db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows);
  },
}));

// Two PGlite databases per test in a full parallel run: slow to start, not what is tested.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRET = 'test-bridge-secret-0123456789';
process.env['BRIDGE_SECRET'] = SECRET;

/** Fresh module state (the memo) against a fresh database. */
async function fresh(withSchemaSql: boolean) {
  vi.resetModules();
  const pg = new PGlite();
  if (withSchemaSql) await pg.exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  db.pg = pg as unknown as typeof db.pg;
  db.fail = 0;
  return {
    pg,
    store: await import('@/lib/menu-deploy-store'),
    status: await import('@/app/api/bridge/menu-deploy/route'),
  };
}

const tillLook = () =>
  new Request('https://site.test/api/bridge/menu-deploy', { headers: { authorization: `Bearer ${SECRET}` } });

async function tables(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'menu_%' ORDER BY 1`,
  );
  return r.rows.map((x) => x.t);
}

describe('ensureMenuDeploySchema', () => {
  it('makes the tables on a database that has none, at the first request', async () => {
    const { pg, status } = await fresh(false);
    expect(await tables(pg)).toEqual([]);
    const res = await status.GET(tillLook());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key: null, latest: null, lastApplied: null, tills: [] });
    expect(await tables(pg)).toEqual(['menu_deploy_key', 'menu_package_events', 'menu_packages']);
  });

  it('works on a database made from db/schema.sql, whose tables are exactly the ones it makes', async () => {
    const shape = async (pg: PGlite) => [
      ...(
        await pg.query<{ c: string }>(
          `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
                  || ':' || coalesce(column_default, '') AS c
             FROM information_schema.columns WHERE table_name LIKE 'menu_%' ORDER BY 1`,
        )
      ).rows.map((r) => r.c),
      ...(
        await pg.query<{ c: string }>(
          `SELECT indexname || ':' || indexdef AS c FROM pg_indexes WHERE tablename LIKE 'menu_%' ORDER BY 1`,
        )
      ).rows.map((r) => r.c),
    ];
    const made = await fresh(false);
    await made.store.ensureMenuDeploySchema();
    const fromStore = await shape(made.pg);

    const { pg, status, store } = await fresh(true);
    expect(await tables(pg)).toEqual(['menu_deploy_key', 'menu_package_events', 'menu_packages']);
    expect(await shape(pg)).toEqual(fromStore);
    expect((await status.GET(tillLook())).status).toBe(200);
    await store.ensureMenuDeploySchema();
    expect(await shape(pg)).toEqual(fromStore);
  });

  it('is idempotent: run again on tables it made, and by a second server instance', async () => {
    const first = await fresh(false);
    await first.store.ensureMenuDeploySchema();
    await first.store.ensureMenuDeploySchema();
    vi.resetModules();
    const second = await import('@/lib/menu-deploy-store');
    await expect(second.ensureMenuDeploySchema()).resolves.toBeUndefined();
    expect(await tables(first.pg)).toHaveLength(3);
  });

  it('never remembers a failure: the next call tries again', async () => {
    const { pg, store, status } = await fresh(false);
    db.fail = 1;
    await expect(store.ensureMenuDeploySchema()).rejects.toThrow('asleep');
    db.fail = 1;
    const res = await status.GET(tillLook());
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: false, error: 'internal' });
    await expect(store.ensureMenuDeploySchema()).resolves.toBeUndefined();
    expect((await status.GET(tillLook())).status).toBe(200);
    expect(await tables(pg)).toHaveLength(3);
  });

  it('fails closed for the upload key when the database cannot be read', async () => {
    const { store } = await fresh(false);
    await store.ensureMenuDeploySchema();
    const route = await import('@/app/api/menu-deploy/route');
    db.fail = 5;
    const res = await route.GET(
      new Request('https://site.test/api/menu-deploy', {
        headers: { authorization: `Bearer cocmenu_${'A'.repeat(43)}`, 'x-forwarded-for': '192.0.2.1' },
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
