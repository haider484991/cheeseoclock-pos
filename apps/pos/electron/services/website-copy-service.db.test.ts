/**
 * The website's own data kept on this till (website-copy-service.ts), against a real SQLite database (node:sqlite
 * with a small transaction() shim; skips where it is missing), real temporary folders and a website in memory that
 * answers like the real routes (apps/web/src/lib/website-copy.ts; the real routes and this till's client are tested
 * together in apps/web/src/lib/website-copy.test.ts):
 *  - a copy is taken when one is due and not before; a failed one is tried again after an hour, and recorded;
 *  - the newest 14 are kept, and always the newest of each website;
 *  - a website that answers as a new one with nothing of its own gets the old one's data back by itself;
 *  - one with orders of its own is shown to the owner, who puts it back;
 *  - a till linked to another site since never sends one site's data to the other;
 *  - the copies also go to the owner's second-copy folder.
 *
 * Every order and person here is made up.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readdirSync as readMigrations } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEBSITE_COPY_FORMAT } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { setSetting } from '../db/repositories/settings-repo.js';
import type { BridgeApi } from './cloud-copy-chunks.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { DUE_MS, KEEP_COPIES, RETRY_MS, WebsiteCopyService, copiesToRotate, listWebsiteCopies } from './website-copy-service.js';
import { restoreBatches } from './website-copy-client.js';

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated(): AppDatabase {
  const raw = new Sqlite!(':memory:');
  for (const f of readMigrations(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
  return db as unknown as AppDatabase;
}

const roots: string[] = [];
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `coc-${name}-`));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TABLES = ['site_menu', 'web_orders', 'menu_packages', 'dash_logins'] as const;

/** A website in memory that answers like the real routes: two rows a page, a put-back adds only rows it lacks. */
class FakeWebsite {
  websiteId = '0192f000-0000-7000-8000-00000000aaaa';
  down = false;
  calls = 0;
  tables = new Map<string, Map<string, Record<string, unknown>>>(TABLES.map((t) => [t, new Map()]));
  constructor(private readonly clock: () => number) {}

  add(table: (typeof TABLES)[number], id: string, extra: Record<string, unknown> = {}): void {
    this.tables.get(table)!.set(id, { id, ...extra });
  }

  replace(websiteId: string): void {
    this.websiteId = websiteId;
    for (const t of this.tables.values()) t.clear();
  }

  count(table: string): number {
    return this.tables.get(table)!.size;
  }

  api: BridgeApi = async (path, init) => {
    this.calls++;
    if (this.down) return { status: 500, json: { ok: false, error: 'internal' } };
    const url = new URL(`https://site.test${path}`);
    if (url.pathname === '/api/bridge/website-copy/restore' && init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { format: string; table: string; rows: Array<Record<string, unknown>> };
      if (body.format !== WEBSITE_COPY_FORMAT || !this.tables.has(body.table)) return { status: 400, json: { ok: false } };
      const t = this.tables.get(body.table)!;
      let inserted = 0;
      for (const r of body.rows) {
        if (t.has(String(r['id']))) continue;
        t.set(String(r['id']), r);
        inserted++;
      }
      return { status: 200, json: { ok: true, data: { inserted } } };
    }
    if (url.pathname !== '/api/bridge/website-copy') return { status: 404, json: null };
    const name = url.searchParams.get('table');
    if (name === null) {
      return {
        status: 200,
        json: {
          ok: true,
          data: {
            format: WEBSITE_COPY_FORMAT,
            websiteId: this.websiteId,
            websiteCreatedAt: '2026-10-01T00:00:00.000Z',
            takenAt: new Date(this.clock()).toISOString(),
            tables: TABLES.map((t) => ({ name: t, rows: this.count(t) })),
          },
        },
      };
    }
    const all = [...(this.tables.get(name)?.values() ?? [])].sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
    const offset = Number(url.searchParams.get('offset'));
    const rows = all.slice(offset, offset + 2);
    return { status: 200, json: { ok: true, data: { rows, next: offset + rows.length < all.length ? offset + rows.length : null } } };
  };
}

describe.skipIf(!Sqlite)('the website’s data on this till', () => {
  let db: AppDatabase;
  let dir: string;
  let now: number;
  let site: FakeWebsite;
  let linked: boolean;
  let siteUrl: string;
  let restored: number;
  let svc: WebsiteCopyService;

  beforeEach(() => {
    db = openMigrated();
    dir = join(tmp('userdata'), 'website-copies');
    now = Date.parse('2026-10-27T10:00:00.000Z');
    site = new FakeWebsite(() => now);
    site.add('site_menu', '1', { menu_json: { categories: [] } });
    site.add('web_orders', 'o1', { customer_name: 'Test Customer' });
    site.add('web_orders', 'o2', { customer_name: 'Another Test' });
    site.add('web_orders', 'o3', { customer_name: 'Third Test' });
    site.add('menu_packages', 'p1');
    site.add('dash_logins', 'l1', { username: 'owner' });
    linked = true;
    siteUrl = 'https://www.cheeseoclock.test';
    restored = 0;
    svc = new WebsiteCopyService({
      db,
      dir,
      api: site.api,
      linked: () => linked,
      siteUrl: () => siteUrl,
      afterRestore: async () => {
        restored++;
      },
      now: () => now,
    });
  });

  it('takes a copy when one is due, and not before', async () => {
    linked = false;
    await svc.look();
    expect(site.calls).toBe(0);
    linked = true;
    await svc.look();
    const [first] = listWebsiteCopies(dir);
    expect(first).toMatchObject({ websiteId: site.websiteId, site: 'cheeseoclock.test', rows: 6 });
    const doc = JSON.parse(gunzipSync(readFileSync(join(dir, first!.fileName))).toString('utf8'));
    expect(doc.tables.find((t: { name: string }) => t.name === 'web_orders').rows).toHaveLength(3);
    expect(svc.status()).toMatchObject({ linked: true, lastAt: new Date(now).toISOString(), lastError: null, replaced: null });
    const calls = site.calls;
    now += DUE_MS - 60_000;
    await svc.look();
    expect(site.calls).toBe(calls);
    now += 120_000;
    await svc.look();
    expect(listWebsiteCopies(dir)).toHaveLength(2);
  });

  it('records a failed copy and tries again after an hour', async () => {
    site.down = true;
    await svc.look();
    expect(svc.status().lastError?.message).toMatch(/did not answer/);
    expect(listWebsiteCopies(dir)).toHaveLength(0);
    const calls = site.calls;
    now += RETRY_MS - 60_000;
    await svc.look();
    expect(site.calls).toBe(calls);
    site.down = false;
    now += 120_000;
    await svc.look();
    expect(listWebsiteCopies(dir)).toHaveLength(1);
    expect(svc.status().lastError).toBeNull();
    await expect(svc.take()).resolves.toMatchObject({ busy: false });
  });

  it('keeps the newest 14, and always the newest of each website', async () => {
    await svc.take();
    const oldest = listWebsiteCopies(dir)[0]!;
    site.add('web_orders', 'o9'); // the new website has orders of its own: no put-back by itself
    site.replace('0192f000-0000-7000-8000-00000000bbbb');
    site.add('web_orders', 'n1');
    for (let i = 0; i < KEEP_COPIES + 3; i++) {
      now += DUE_MS;
      await svc.take();
    }
    const kept = listWebsiteCopies(dir);
    expect(kept).toHaveLength(KEEP_COPIES + 1);
    expect(kept.map((c) => c.fileName)).toContain(oldest.fileName);
    expect(readdirSync(dir).filter((n) => n.endsWith('.meta.json'))).toHaveLength(KEEP_COPIES + 1);
    expect(copiesToRotate(kept)).toEqual([]);
  });

  it('puts the old website’s data back by itself when a new one has nothing of its own', async () => {
    await svc.take();
    site.replace('0192f000-0000-7000-8000-00000000cccc');
    now += DUE_MS;
    await svc.look();
    expect(site.count('web_orders')).toBe(3);
    expect(site.count('dash_logins')).toBe(1);
    expect(restored).toBe(1);
    const st = svc.status();
    expect(st.replaced).toBeNull();
    expect(st.lastRestore).toMatchObject({ by: 'auto', inserted: 6 });
    // The copy after it is of the new website, with the old data in it.
    expect(st.copies[0]).toMatchObject({ websiteId: '0192f000-0000-7000-8000-00000000cccc', rows: 6 });
  });

  it('a new website with orders of its own is shown to the owner, who puts the old data back', async () => {
    await svc.take();
    site.replace('0192f000-0000-7000-8000-00000000dddd');
    site.add('web_orders', 'new-1');
    now += DUE_MS;
    await svc.look();
    expect(site.count('web_orders')).toBe(1);
    expect(svc.status().replaced).toMatchObject({ from: '0192f000-0000-7000-8000-00000000aaaa', to: '0192f000-0000-7000-8000-00000000dddd' });
    const r = await svc.restore();
    expect(r.inserted).toBe(6);
    expect(site.count('web_orders')).toBe(4);
    expect(svc.status()).toMatchObject({ replaced: null, lastRestore: { by: 'owner', inserted: 6 } });
    expect((await svc.restore(r.fileName)).inserted).toBe(0);
  });

  it('never sends one site’s data to another site', async () => {
    await svc.take();
    const old = listWebsiteCopies(dir)[0]!;
    siteUrl = 'https://another-shop.test';
    site.replace('0192f000-0000-7000-8000-00000000eeee');
    now += DUE_MS;
    await svc.look();
    expect(site.count('web_orders')).toBe(0);
    expect(svc.status().replaced).toBeNull();
    await expect(svc.restore(old.fileName)).rejects.toThrow(/one site’s data never goes to another/);
    expect(site.count('web_orders')).toBe(0);
  });

  it('copies to the owner’s second-copy folder too', async () => {
    const usb = tmp('usb');
    setSetting(db, 'backup.secondCopy', { dir: usb });
    await svc.take();
    const there = join(usb, 'website-copies');
    expect(existsSync(there)).toBe(true);
    expect(listWebsiteCopies(there)).toEqual(listWebsiteCopies(dir));
  });

  it('splits a put-back into batches under the limits; a big row goes alone', () => {
    const rows = [{ a: 'x'.repeat(50) }, { a: 'y'.repeat(50) }, { a: 'z'.repeat(500) }, { a: 1 }, { a: 2 }, { a: 3 }];
    const batches = restoreBatches(rows, 200, 2);
    expect(batches.flat()).toEqual(rows);
    expect(batches.map((b) => b.length)).toEqual([2, 1, 2, 1]);
  });
});
