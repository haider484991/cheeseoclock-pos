/**
 * The menu files from the costing PC through the real IPC handlers (v0.7.32;
 * menu-deploy-handlers.ts), with the till's service wired to the stand-in
 * website:
 *   - the upload key is the OWNER's to make; only its hash and last 4
 *     characters reach the website; the key itself is in no setting, audit
 *     row, sync entry, log line or error; a website that refuses it changes
 *     nothing on the till;
 *   - putting a file in is menu.manage's (like Menu → Import), but a file that
 *     waits for the owner's OK ("Wait for my OK", the owner's-OK rule, a
 *     take-over) is the OWNER's — refused to a manager in the main process
 *     before anything is claimed or written; the counter is refused every
 *     channel;
 *   - Menu → Import itself: Start fresh still needs the owner, and the menu
 *     goes to the website after an import;
 *   - the file's marker ('menu.lastPackage') is never saved by hand.
 * EVERY NAME AND MENU IS MADE UP.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';
import { DatabaseSync } from '../../db/costing-shop.fixture.js';
import { openTill } from '../../db/two-tills.fixture.js';
import type { AppDatabase } from '../../db/connection.js';
import { FakeMenuWebsite, madeUpMenu, type Clock } from '../../services/menu-deploy-website.fixture.js';
import { menuRows, serviceTill, type ServiceTill } from '../../services/menu-package-till.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  /** Every log line, as text. */
  logged: [] as string[],
  published: 0,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => {
  const rec = (...args: unknown[]) => void h.logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  return { default: { info: rec, warn: rec, error: rec } };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
vi.mock('../../services/print-spooler.js', () => ({ printSpooler: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
// Menu → Import sends the menu to the website after an import: counted here.
vi.mock('../../services/web-orders-bridge.js', () => ({
  webOrdersBridge: {
    publishMenu: async () => {
      h.published += 1;
    },
    menuChanged: () => {},
  },
}));

const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({ id: id as UUID, fullName: id, role, sessionId: 'sess' as UUID });
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');
const DEV = 'till-1';
const T0 = Date.parse('2026-09-29T09:00:00.000Z');

let db: AppDatabase;
let clock: Clock;
let website: FakeMenuWebsite;
let till: ServiceTill;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function as(who: AuthenticatedUser | null, channel: string, payload?: unknown): Promise<Outcome> {
  h.session = who;
  return call(channel, payload);
}

/** Every place on the till a key could have been left. */
function tillText(): string {
  return [
    ...(db.prepare(`SELECT key, value_json AS v FROM settings`).all() as Array<{ key: string; v: string }>).map((r) => `${r.key}=${r.v}`),
    ...(db.prepare(`SELECT before_json AS b, after_json AS a FROM audit_log`).all() as Array<{ b: string | null; a: string | null }>).flatMap((r) => [r.b ?? '', r.a ?? '']),
    ...(db.prepare(`SELECT payload_json AS p FROM sync_queue`).all() as Array<{ p: string }>).map((r) => r.p),
    ...(db.prepare(`SELECT value_json AS v FROM business_settings`).all() as Array<{ v: string }>).map((r) => r.v),
  ].join('\n');
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.logged.length = 0;
  h.published = 0;
  clock = { t: T0 };
  website = new FakeMenuWebsite(clock);
  db = openTill(DEV);
  till = serviceTill(DEV, website, clock, { db });
  const { setMenuPackageService } = await import('../../services/menu-package-service.js');
  setMenuPackageService(till.service);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./menu-deploy-handlers.js')).registerMenuDeployHandlers(ctx);
  (await import('./menu-handlers.js')).registerMenuHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
});

const live = describe.skipIf(!DatabaseSync);

live('the upload key', () => {
  it('a manager and a cashier are refused; the owner gets it ONCE — the website gets only its hash and last 4 characters', async () => {
    for (const who of [CASHIER, MANAGER]) {
      expect(await as(who, 'menuDeploy:createKey')).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(await as(null, 'menuDeploy:createKey')).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(website.callsTo(/\/key$/)).toHaveLength(0);

    const o = await as(OWNER, 'menuDeploy:createKey');
    expect(o.ok).toBe(true);
    const made = (o as { data: { key: string; keyHint: string; createdAt: string } }).data;
    expect(made.key).toMatch(/^cocmenu_[A-Za-z0-9_-]{43}$/);
    const puts = website.callsTo(/\/key$/);
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0]!.body as object).sort()).toEqual(['appVersion', 'deviceId', 'deviceName', 'keyHash', 'keyHint']);
    expect(JSON.stringify(puts[0]!.body)).not.toContain(made.key);
    // Nowhere on the till, nowhere in a log line.
    expect(tillText()).not.toContain(made.key);
    expect(h.logged.join('\n')).not.toContain(made.key);
    // The owner's audit row says a key was made (its last 4 characters), by whom.
    const audit = db.prepare(`SELECT actor_user_id, after_json FROM audit_log WHERE entity_type = 'settings' AND entity_id = 'menuDeploy.keyInfo'`).get() as {
      actor_user_id: string;
      after_json: string;
    };
    expect(audit.actor_user_id).toBe('u_admin');
    expect(JSON.parse(audit.after_json)).toEqual({ keyHint: made.keyHint, keyCreatedAt: made.createdAt });
    // No field anywhere is called uploadKey.
    expect(tillText()).not.toMatch(/uploadKey/);
  });

  it('a new key replaces the old one; a website that refuses it leaves the till as it was, in plain words, without the key', async () => {
    const first = (await as(OWNER, 'menuDeploy:createKey')) as { ok: true; data: { key: string; keyHint: string } };
    const keyInfo = () => db.prepare(`SELECT value_json AS v FROM settings WHERE key = 'menuDeploy.keyInfo'`).get() as { v: string };
    const before = keyInfo().v;
    website.refuseNext(/\/key$/, 500);
    const o = await as(OWNER, 'menuDeploy:createKey');
    expect(o).toEqual({ ok: false, code: 'precondition_failed', message: 'The website did not take the new key — nothing changed; the old key still works.' });
    expect(keyInfo().v).toBe(before);
    expect(website.key!.keyHint).toBe(first.data.keyHint);
    // No answer at all (the website slow to wake): it may have saved the key after the till stopped
    // waiting, so the words never promise the old key still works.
    website.down = true;
    const unsure = await as(OWNER, 'menuDeploy:createKey');
    expect(unsure).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect((unsure as { message: string }).message).toBe(
      'The website did not answer in time. It may have saved the new key anyway, and then the old key has stopped working: make a new key again, and put that one on the costing PC.',
    );
    expect(keyInfo().v).toBe(before);
    website.down = false;
    const second = (await as(OWNER, 'menuDeploy:createKey')) as { ok: true; data: { key: string; keyHint: string } };
    expect(second.data.key).not.toBe(first.data.key);
    expect(website.key!.keyHint).toBe(second.data.keyHint);
    expect(h.logged.join('\n')).not.toContain(first.data.key);
    expect(h.logged.join('\n')).not.toContain(second.data.key);
  });
});

live('who may put a file in', () => {
  it('the counter is refused every channel; a manager may look and put it in; taking over needs the owner', async () => {
    const p = website.upload(madeUpMenu('one'));
    for (const [channel, payload] of [
      ['menuDeploy:getStatus', undefined],
      ['menuDeploy:checkNow', undefined],
      ['menuDeploy:preview', { packageId: p.id }],
      ['menuDeploy:apply', { packageId: p.id }],
    ] as const) {
      expect({ channel, o: await as(CASHIER, channel, payload) }).toMatchObject({ channel, o: { ok: false, code: 'forbidden' } });
    }
    expect(website.calls).toHaveLength(0);
    expect(menuRows(db).items).toBe(0);

    // A manager: the status, the preview, and the tap.
    expect(await as(MANAGER, 'menuDeploy:getStatus')).toMatchObject({ ok: true });
    expect(await as(MANAGER, 'menuDeploy:preview', { packageId: p.id })).toMatchObject({ ok: true, data: { packageId: p.id, fresh: null } });
    // …but never a take-over (it may double items).
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id, takeOver: true })).toMatchObject({
      ok: false,
      code: 'forbidden',
      message: 'Taking a menu file over from the other till needs the owner (admin) login',
    });
    expect(website.claims()).toHaveLength(0);
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id })).toMatchObject({ ok: true, data: { newItems: 2 } });
    expect(menuRows(db).items).toBe(2);
    // Not a package id: refused before anything.
    expect(await as(MANAGER, 'menuDeploy:preview', { packageId: '../../etc' })).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('a file another till holds: the tap is refused in plain words and nothing changes', async () => {
    const p = website.upload(madeUpMenu('one'));
    Object.assign(website.byId(p.id)!, { state: 'claimed', claimedBy: 'till-2', claimedAt: clock.t, leaseUntil: clock.t + 600_000 });
    expect(await as(OWNER, 'menuDeploy:apply', { packageId: p.id })).toEqual({
      ok: false,
      code: 'precondition_failed',
      message: 'The other till is putting a menu file in right now.',
    });
    expect(menuRows(db).items).toBe(0);
  });

  it('with history: the website’s last lines, in words', async () => {
    website.upload(madeUpMenu('one'), { uploader: 'TEST-PC' });
    await as(OWNER, 'menuDeploy:checkNow');
    const o = (await as(OWNER, 'menuDeploy:getStatus', { withHistory: true })) as { ok: true; data: { history: Array<{ text: string }> } };
    expect(o.data.history.map((l) => l.text)).toEqual([
      'This till put in test-menu-import.json: 2 new items, 2 new ingredients, 2 new categories, 1 recipe, 1 choice group',
      'This till started putting in test-menu-import.json',
      'test-menu-import.json sent from TEST-PC (2 items, 2 ingredients)',
    ]);
  });
});

live('Menu → Import is unchanged', () => {
  it('Start fresh needs the owner; the menu goes to the website after an import', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-menu-file-'));
    try {
      const file = path.join(dir, 'picked.json');
      fs.writeFileSync(file, JSON.stringify(madeUpMenu('picked')));
      process.env['COC_MENU_IMPORT_FILE'] = file;
      expect(await as(MANAGER, 'menu:importPick')).toMatchObject({ ok: true });
      expect(await as(MANAGER, 'menu:importApply', { fresh: true })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(menuRows(db).items).toBe(0);
      expect(await as(MANAGER, 'menu:importApply', { fresh: false })).toMatchObject({ ok: true });
      expect(menuRows(db).items).toBe(2);
      await vi.waitFor(() => expect(h.published).toBe(1));
    } finally {
      delete process.env['COC_MENU_IMPORT_FILE'];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the marker of the last file is never saved by hand (settings:setBusiness refuses it)', async () => {
    const o = await as(OWNER, 'settings:setBusiness', {
      key: 'menu.lastPackage',
      value: { v: 1, packageId: '0b8f6c8e-8f8a-4c8a-9d2e-1c6a7d2b9e10', seq: 99, sha256: 'a'.repeat(64), fileName: 'x.json', appliedByDevice: DEV, appliedAt: new Date().toISOString(), automatic: false, counts: {} },
    });
    expect(o).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()).toMatchObject({ n: 0 });
    // "Put in by themselves / wait for my OK" is the owner's card.
    expect(await as(MANAGER, 'settings:setBusiness', { key: 'menu.autoUpdate', value: { v: 1, mode: 'ask' } })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await as(OWNER, 'settings:setBusiness', { key: 'menu.autoUpdate', value: { v: 1, mode: 'ask' } })).toMatchObject({
      ok: true,
      data: { key: 'menu.autoUpdate', value: { v: 1, mode: 'ask' }, isDefault: false },
    });
    expect(await as(OWNER, 'settings:setBusiness', { key: 'menu.autoUpdate', value: { v: 1, mode: 'sometimes' } })).toMatchObject({ ok: false, code: 'validation_failed' });
  });
});

live('who may give the OK: a file that waits for the owner is the owner’s to put in (decided in the main process)', () => {
  const price = () => (db.prepare(`SELECT base_price_cents AS p FROM menu_items WHERE name = 'Test Margherita' AND deleted_at IS NULL`).get() as { p: number }).p;

  it('"Wait for my OK": a manager’s tap is refused before anything is claimed or written; the owner’s puts it in', async () => {
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    setBusinessSetting(db, 'menu.autoUpdate', { v: 1, mode: 'ask' }, { userId: 'u_admin', deviceId: DEV });
    const p = website.upload(madeUpMenu('one'));
    expect(await as(MANAGER, 'menuDeploy:checkNow')).toMatchObject({ ok: true, data: { phase: 'waiting_for_owner', applyNeedsOwner: true } });
    const rows = () => db.prepare(`SELECT (SELECT COUNT(*) FROM audit_log) AS a, (SELECT COUNT(*) FROM sync_queue) AS q`).get();
    const before = rows();
    // A manager may still look at the changes…
    expect(await as(MANAGER, 'menuDeploy:preview', { packageId: p.id })).toMatchObject({ ok: true, data: { packageId: p.id } });
    // …but not put it in.
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id })).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'Menu files from the costing PC wait for the owner’s OK (Settings → Kitchen & stock), so putting one in needs the owner’s login.',
    });
    // "Try again" is no way round it.
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id, retry: true })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(website.claims()).toHaveLength(0);
    expect(menuRows(db).items).toBe(0);
    expect(rows()).toEqual(before);
    expect(await as(OWNER, 'menuDeploy:apply', { packageId: p.id })).toMatchObject({ ok: true, data: { newItems: 2 } });
    expect(menuRows(db).items).toBe(2);
  });

  it('by themselves, a file the owner’s-OK rule holds (a 10× price): a manager is refused in words that name it; the owner puts it in', async () => {
    website.upload(madeUpMenu('one'));
    expect(await as(MANAGER, 'menuDeploy:checkNow')).toMatchObject({ ok: true, data: { phase: 'applied' } });
    const items = (madeUpMenu('rise')['items'] as Array<Record<string, unknown>>).map((i) =>
      i['name'] === 'Test Margherita' ? { ...i, priceCents: 1_100_000 } : i,
    );
    const p = website.upload(madeUpMenu('rise', { items }));
    clock.t += 3 * 60_000;
    expect(await as(MANAGER, 'menuDeploy:checkNow')).toMatchObject({ ok: true, data: { phase: 'waiting_for_owner', applyNeedsOwner: true } });
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id })).toEqual({
      ok: false,
      code: 'forbidden',
      message:
        'This file waits for the owner’s OK: it would move 1 price to less than half, more than double or Rs 0 (Test Margherita Rs 1,100 → Rs 11,000). Putting it in needs the owner’s login.',
    });
    expect(website.claims()).toHaveLength(1);
    expect(price()).toBe(110_000);
    expect(await as(OWNER, 'menuDeploy:apply', { packageId: p.id })).toMatchObject({ ok: true });
    expect(price()).toBe(1_100_000);
  });

  it('what a manager could do before is unchanged: "Try again" on a file that is not held, and Menu → Import’s own file picker even in "Wait for my OK"', async () => {
    const p = website.upload(madeUpMenu('one'));
    Object.assign(website.byId(p.id)!, { state: 'failed', attempts: 5, error: 'Test: the disk was full' });
    expect(await as(MANAGER, 'menuDeploy:checkNow')).toMatchObject({ ok: true, data: { phase: 'gave_up', applyNeedsOwner: false } });
    expect(await as(MANAGER, 'menuDeploy:apply', { packageId: p.id, retry: true })).toMatchObject({ ok: true, data: { newItems: 2 } });
    expect(menuRows(db).items).toBe(2);

    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    setBusinessSetting(db, 'menu.autoUpdate', { v: 1, mode: 'ask' }, { userId: 'u_admin', deviceId: DEV });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-menu-file-'));
    try {
      const file = path.join(dir, 'picked.json');
      const items = (madeUpMenu('picked')['items'] as Array<Record<string, unknown>>).map((i) => ({ ...i, priceCents: 1 }));
      fs.writeFileSync(file, JSON.stringify(madeUpMenu('picked', { items })));
      process.env['COC_MENU_IMPORT_FILE'] = file;
      expect(await as(MANAGER, 'menu:importPick')).toMatchObject({ ok: true });
      expect(await as(MANAGER, 'menu:importApply', { fresh: false })).toMatchObject({ ok: true });
      expect(price()).toBe(1);
    } finally {
      delete process.env['COC_MENU_IMPORT_FILE'];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file already in on this till: said plainly, nothing claimed again', async () => {
    const p = website.upload(madeUpMenu('one'));
    await as(OWNER, 'menuDeploy:checkNow');
    expect(await as(OWNER, 'menuDeploy:apply', { packageId: p.id })).toEqual({
      ok: false,
      code: 'precondition_failed',
      message: 'This menu file is already in on this till.',
    });
    expect(website.claims()).toHaveLength(1);
  });
});
