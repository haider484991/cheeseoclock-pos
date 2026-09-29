/**
 * Menu files from the costing PC (v0.7.32), in the database: the import of a
 * package is Menu → Import's own (plan, then applyMenuImport in ONE
 * transaction) with the package's marker ('menu.lastPackage') written last
 * in that transaction; and two linked tills — one puts the file in, the
 * other gets it through the link and never imports it again.
 *
 * Real migrations on node:sqlite (costing-shop.fixture.ts); the website is
 * the stand-in (services/menu-deploy-website.fixture.ts). EVERY MENU IS MADE UP.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuImportFileSchema } from '@cheeseoclock/shared-schemas';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push, lastSyncPass } from './two-tills.fixture.js';
import type { AppDatabase } from './connection.js';
import { FakeMenuWebsite, madeUpMenu, type Clock } from '../services/menu-deploy-website.fixture.js';
import { menuRows, serviceTill } from '../services/menu-package-till.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const live = describe.skipIf(!DatabaseSync);
const T0 = Date.parse('2026-09-29T09:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

const repo = () => import('./repositories/menu-import-repo.js');
const readRepo = () => import('./business-settings-read.js');

const n = (db: AppDatabase, sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);

const pkgOf = (over: Partial<{ id: string; seq: number; sha256: string; automatic: boolean }> = {}) => ({
  id: over.id ?? randomUUID(),
  seq: over.seq ?? 1,
  sha256: over.sha256 ?? 'a'.repeat(64),
  fileName: 'test-menu-import.json',
  uploadedAt: '2026-09-29T09:00:00.000Z',
  generatedAt: '2026-09-29T08:55:00.000Z',
  automatic: over.automatic ?? true,
});

live('a package goes in as Menu → Import does, with its marker in the same transaction', () => {
  it('the marker is written last, synced and audited, and the import audit row names the package', async () => {
    const { applyMenuImport } = await repo();
    const db = openTill('till-1');
    const file = menuImportFileSchema.parse(madeUpMenu('a'));
    const pkg = pkgOf({ seq: 3, automatic: true });
    const summary = applyMenuImport(db, file, pkg.fileName, { userId: null, deviceId: 'till-1' }, { package: pkg });
    expect(summary.newItems).toBe(2);
    const { getBusinessSetting } = await readRepo();
    expect(getBusinessSetting(db, 'menu.lastPackage')?.value).toMatchObject({
      v: 1,
      packageId: pkg.id,
      seq: 3,
      sha256: pkg.sha256,
      appliedByDevice: 'till-1',
      automatic: true,
      counts: { newItems: 2, newIngredients: 2, newCategories: 2 },
    });
    // The marker is the LAST sync entry: it reaches the other till after the rows it made.
    const last = db.prepare(`SELECT entity_type FROM sync_queue ORDER BY rowid DESC LIMIT 1`).get() as { entity_type: string };
    expect(last.entity_type).toBe('business_settings');
    // The import's own audit row: who (nobody — it went in by itself), and which package.
    const audit = db.prepare(`SELECT actor_user_id, after_json FROM audit_log WHERE entity_type = 'menu_import'`).get() as {
      actor_user_id: string | null;
      after_json: string;
    };
    expect(audit.actor_user_id).toBeNull();
    expect(JSON.parse(audit.after_json)).toMatchObject({ fresh: false, package: { id: pkg.id, seq: 3, automatic: true } });
  });

  it('a failure anywhere — even at the marker, last — leaves no marker and no rows', async () => {
    const { applyMenuImport } = await repo();
    const db = openTill('till-1');
    const file = menuImportFileSchema.parse(madeUpMenu('a'));
    const queued = n(db, `SELECT COUNT(*) AS n FROM sync_queue`);
    const audited = n(db, `SELECT COUNT(*) AS n FROM audit_log`);
    // A package the marker refuses (not a checksum): everything before it rolls back too.
    expect(() =>
      applyMenuImport(db, file, 'x.json', { userId: null, deviceId: 'till-1' }, { package: pkgOf({ sha256: 'not-a-checksum' }) }),
    ).toThrow();
    expect(menuRows(db)).toEqual({ categories: 0, items: 0, choiceGroups: 0, options: 0, ingredients: 0 });
    expect(n(db, `SELECT COUNT(*) AS n FROM business_settings`)).toBe(0);
    expect(n(db, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(queued);
    expect(n(db, `SELECT COUNT(*) AS n FROM audit_log`)).toBe(audited);
  });

  it('a package is never a fresh start', async () => {
    const { applyMenuImport, MenuImportRefusedError } = await repo();
    const db = openTill('till-1');
    const file = menuImportFileSchema.parse(madeUpMenu('a'));
    expect(() => applyMenuImport(db, file, 'x.json', { userId: 'u_admin', deviceId: 'till-1' }, { fresh: true, package: pkgOf() })).toThrow(
      MenuImportRefusedError,
    );
    expect(menuRows(db).items).toBe(0);
  });

  it('the owner’s import rules hold: with "keep the till’s price" the till keeps its price', async () => {
    const { applyMenuImport } = await repo();
    const { setBusinessSetting } = await import('./repositories/business-settings-repo.js');
    const db = openTill('till-1');
    const actor = { userId: 'u_admin', deviceId: 'till-1' };
    applyMenuImport(db, menuImportFileSchema.parse(madeUpMenu('a')), 'a.json', actor);
    setBusinessSetting(db, 'menu.importPolicy', { v: 1, itemPrices: 'till', choices: 'file', recipes: 'file', tax: 'file' }, actor);
    const dearer = madeUpMenu('b');
    (dearer['items'] as Array<Record<string, unknown>>)[0]!['priceCents'] = 150_000;
    applyMenuImport(db, menuImportFileSchema.parse(dearer), 'b.json', { userId: null, deviceId: 'till-1' }, { package: pkgOf({ seq: 2 }) });
    const price = db.prepare(`SELECT base_price_cents AS p FROM menu_items WHERE name = 'Test Margherita'`).get() as { p: number };
    expect(Number(price.p)).toBe(110_000);
  });
});

live('two linked tills: ONE puts the file in, the other gets it through the link', () => {
  async function twoTills() {
    const clock: Clock = { t: T0 };
    const website = new FakeMenuWebsite(clock);
    const t1 = serviceTill('till-1', website, clock);
    const t2 = serviceTill('till-2', website, clock, { db: openTill('till-2', { usersFrom: 'till-1' }) });
    // The users were made on till 1: nothing of them waits on till 1's queue in these tests.
    return { clock, website, t1, t2 };
  }

  it('till 1 imports file #1; after the link, till 2 has the marker, says "received", never claims — one of everything', async () => {
    const { clock, website, t1, t2 } = await twoTills();
    const p1 = website.upload(madeUpMenu('one'));
    clock.t += 60_000;
    expect((await t1.service.checkNow()).phase).toBe('applied');
    expect(website.byId(p1.id)).toMatchObject({ state: 'applied', appliedBy: 'till-1' });
    // Before the link brings it: till 2 knows another till put it in.
    expect((await t2.service.checkNow()).phase).toBe('other_till');
    expect(website.claims('till-2')).toHaveLength(0);

    const res = await push(t1.db, 'till-1', t2.db);
    expect(res).toMatchObject({ waiting: 0, dropped: 0 });
    lastSyncPass(t2.db, clock.t);
    clock.t += 60_000;
    const v2 = await t2.service.checkNow();
    expect(v2.phase).toBe('received');
    expect(v2.appliedHere).toMatchObject({ byThisTill: false, seq: p1.seq });
    expect(website.claims('till-2')).toHaveLength(0);
    expect(website.reports('received', 'till-2')).toHaveLength(1);
    // Exactly one of each on both tills: nothing doubled.
    const one = { categories: 2, items: 2, choiceGroups: 1, options: 2, ingredients: 2 };
    expect(menuRows(t1.db)).toEqual(one);
    expect(menuRows(t2.db)).toEqual(one);
    // Said once: another look says nothing more.
    clock.t += 3 * 60_000;
    await t2.service.checkNow();
    expect(website.reports('received', 'till-2')).toHaveLength(1);
    // The note on till 2 said where it came from.
    expect(t2.emits.map((e) => e.notice).filter(Boolean)).toEqual([expect.objectContaining({ kind: 'received', title: 'New menu arrived from Test till-1' })]);
  });

  it('a till behind (the other till’s last file not here yet) waits and never imports; after the link it claims the next file', async () => {
    const { clock, website, t1, t2 } = await twoTills();
    website.upload(madeUpMenu('one'));
    await t1.service.checkNow();
    // File #2 arrives before till 2 has #1's rows.
    clock.t += 60_000;
    const p2 = website.upload(madeUpMenu('two', { items: [{ name: 'Test Pepperoni', category: 'Test Pizzas', priceCents: 130_000 }] }));
    const v = await t2.service.checkNow();
    expect(v.phase).toBe('waiting_link');
    expect(v.message).toContain('waits for the other till’s last menu changes');
    expect(menuRows(t2.db).items).toBe(0);
    expect(website.byId(p2.id)!.state).toBe('pending');

    await push(t1.db, 'till-1', t2.db);
    lastSyncPass(t2.db, clock.t);
    clock.t += 60_000;
    expect((await t2.service.checkNow()).phase).toBe('applied');
    expect(website.byId(p2.id)).toMatchObject({ state: 'applied', appliedBy: 'till-2' });
    expect(menuRows(t2.db).items).toBe(3);
    // …and back the other way: till 1 receives #2, never claims it.
    await push(t2.db, 'till-2', t1.db);
    lastSyncPass(t1.db, clock.t);
    clock.t += 60_000;
    expect((await t1.service.checkNow()).phase).toBe('received');
    expect(website.claims('till-1').filter((c) => c.path.includes(p2.id))).toHaveLength(0);
    expect(menuRows(t1.db)).toEqual(menuRows(t2.db));
  });

  it('both tills look at once: one claim wins, the other hears "another till is putting it in"', async () => {
    const { clock, website, t1, t2 } = await twoTills();
    website.upload(madeUpMenu('one'));
    clock.t += 60_000;
    const [a, b] = await Promise.all([t1.service.checkNow(), t2.service.checkNow()]);
    expect([a.phase, b.phase].sort()).toEqual(['applied', 'other_till']);
    expect(menuRows(t1.db).items + menuRows(t2.db).items).toBe(2);
  });

  it('an unknown setting from a newer till (standing in for these two keys reaching an older till) is stored, audited, and changes nothing here', async () => {
    const { t1, t2 } = await twoTills();
    const { readShopSetting } = await readRepo();
    const { SHOP_SETTING_KEYS } = await import('@cheeseoclock/shared-types');
    const before = SHOP_SETTING_KEYS.map((k) => readShopSetting(t2.db, k).value);
    // A key this version does not know, written on till 1 as a newer till would (row + sync + audit).
    const id = randomUUID();
    const now = new Date().toISOString();
    t1.db
      .prepare(
        `INSERT INTO business_settings (id, key, value_json, updated_by_user_id, created_at, updated_at, device_id, version)
         VALUES (?, 'menu.fromTheFuture', ?, 'u_admin', ?, ?, 'till-1', 1)`,
      )
      .run(id, JSON.stringify({ v: 9, anything: true }), now, now);
    const { enqueueSync } = await import('./repositories/sync-repo.js');
    enqueueSync(t1.db, { entityType: 'business_settings', entityId: id, op: 'upsert', payload: { id, key: 'menu.fromTheFuture', value: { v: 9, anything: true } } });
    const res = await push(t1.db, 'till-1', t2.db);
    expect(res).toMatchObject({ waiting: 0, dropped: 0 });
    expect(n(t2.db, `SELECT COUNT(*) AS n FROM business_settings WHERE key = 'menu.fromTheFuture'`)).toBe(1);
    expect(n(t2.db, `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings' AND action = 'remote_apply'`)).toBeGreaterThanOrEqual(1);
    expect(SHOP_SETTING_KEYS.map((k) => readShopSetting(t2.db, k).value)).toEqual(before);
  });
});
