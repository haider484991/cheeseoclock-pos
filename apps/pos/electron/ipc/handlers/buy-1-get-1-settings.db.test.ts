/**
 * Settings → Money & discounts → "Buy 1 Get 1 deals" ('deals.buy1Get1', v0.7.39; the owner, 7 Oct 2026: "all
 * these settings should be in the settings"). Through the real settings handlers and repositories on a real SQLite
 * database built from every migration:
 *   - nothing saved: the poster's rules (on, 1 PM up to 7 PM, the name asked for), and nothing is written;
 *   - the owner alone saves them (settings.manage); a manager or a cashier is refused and nothing is written; a
 *     Save tells the web bridge (the settings block goes alone);
 *   - the counter's rules (checkout:getRules, any login) carry them at once;
 *   - the bounds are the main process's: a start and an end, not the same, this version's whole value only;
 *   - the settings block carries them as saved (and counts them in its stamp).
 *
 * Only `defineHandler` (captured) and the signed-in session are stood in for. node's own `node:sqlite` stands in
 * for better-sqlite3; skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUY_1_GET_1_DEALS,
  DEFAULT_BUY_1_GET_1_RULES,
  type AuthenticatedUser,
  type Buy1Get1Deals,
  type CheckoutRules,
  type PublishedMenu,
  type ShopSettingCard,
  type UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  websiteChanged: 0,
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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({ getCurrentSession: () => h.session }));
// The word to the web bridge (a Save the website needs): counted, nothing sent.
vi.mock('../../services/website-settings-events.js', () => ({
  websiteSettingsChanged: () => {
    h.websiteChanged += 1;
  },
  onWebsiteSettingsChanged: () => () => {},
}));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

let db: ReturnType<typeof openMigrated>;

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };
async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function card(): Promise<ShopSettingCard<'deals.buy1Get1'>> {
  const o = await call('settings:getBusiness', { key: 'deals.buy1Get1' });
  if (!o.ok) throw new Error(`refused: ${o.message}`);
  return o.data as ShopSettingCard<'deals.buy1Get1'>;
}
async function counterRules(): Promise<CheckoutRules> {
  const o = await call('checkout:getRules');
  if (!o.ok) throw new Error(`refused: ${o.message}`);
  return o.data as CheckoutRules;
}
const save = (value: unknown) => call('settings:setBusiness', { key: 'deals.buy1Get1', value });
const rows = () => (db.prepare(`SELECT COUNT(*) AS n FROM business_settings WHERE key = 'deals.buy1Get1'`).get() as { n: number }).n;

/** Late nights only, the name optional (made up). */
const LATE: Buy1Get1Deals = { v: 1, on: true, opensMinute: 22 * 60, closesMinute: 60, asksSocial: false };

/** A menu with today's two delivery-charge items, as the block's check needs them (made-up ids). */
const MENU = {
  categories: [
    {
      posCategoryId: 'fees',
      name: 'Delivery Charges',
      displayOrder: 0,
      items: [
        { posItemId: 'fee-200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000 },
        { posItemId: 'fee-250', name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000 },
      ],
    },
  ],
} as unknown as PublishedMenu;

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.websiteChanged = 0;
  db = openMigrated({});
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  (await import('./settings-handlers.js')).registerSettingsHandlers({ db, deviceId: DEV } as never);
});

live('the Buy 1 Get 1 deals’ rules are the owner’s', () => {
  it('nothing saved: the poster’s rules on the card, at the counter and in the reader — and nothing is written', async () => {
    h.session = OWNER;
    const c = await card();
    expect(c.value).toEqual(DEFAULT_BUY_1_GET_1_DEALS);
    expect(c).toMatchObject({ isDefault: true, readOnly: false, lastChanged: null });
    h.session = CASHIER;
    expect((await counterRules()).buy1Get1).toEqual(DEFAULT_BUY_1_GET_1_RULES);
    const { readBuy1Get1Rules } = await import('../../db/business-settings-read.js');
    expect(readBuy1Get1Rules(db as AppDatabase)).toEqual({ on: true, opensMinute: 780, closesMinute: 1140, asksSocial: true });
    expect(rows()).toBe(0);
  });

  it('the owner saves them (the web bridge is told); a manager or a cashier is refused and nothing is written', async () => {
    for (const who of [MANAGER, CASHIER]) {
      h.session = who;
      expect(await save(LATE)).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await call('settings:getBusiness', { key: 'deals.buy1Get1' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(await call('settings:setBusiness', { key: 'deals.buy1Get1', useDefault: true })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(rows()).toBe(0);
    expect(h.websiteChanged).toBe(0);
    h.session = OWNER;
    expect(await save(LATE)).toMatchObject({ ok: true });
    expect(h.websiteChanged).toBe(1);
    expect(await card()).toMatchObject({ value: LATE, isDefault: false });
    // Row, sync entry and audit row together (the repositories rule).
    const { businessSettingId } = await import('../../db/business-settings-ids.js');
    const id = businessSettingId('deals.buy1Get1');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`).get(id)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`).get(id)).toEqual({ n: 1 });
    // The counter has them at once — a cashier's login reads them (never the card).
    h.session = CASHIER;
    expect((await counterRules()).buy1Get1).toEqual({ on: true, opensMinute: 1320, closesMinute: 60, asksSocial: false });
    // "Put back the default" writes the poster's rules.
    h.session = OWNER;
    expect(await call('settings:setBusiness', { key: 'deals.buy1Get1', useDefault: true })).toMatchObject({ ok: true });
    expect(await card()).toMatchObject({ value: DEFAULT_BUY_1_GET_1_DEALS, isDefault: true });
    expect(h.websiteChanged).toBe(2);
  });

  it('refuses hours that start and end together, minutes off the clock, another format or an unknown field — in words, writing nothing', async () => {
    h.session = OWNER;
    const refused = async (value: unknown) => {
      const o = await save(value);
      expect(o, JSON.stringify(value)).toMatchObject({ ok: false, code: 'validation_failed' });
      return o.ok ? '' : o.message;
    };
    expect(await refused({ ...LATE, opensMinute: 600, closesMinute: 600 })).toMatch(/start and end at the same time/);
    await refused({ ...LATE, opensMinute: 1440 });
    await refused({ ...LATE, closesMinute: 0 });
    await refused({ ...LATE, opensMinute: 12.5 });
    await refused({ ...LATE, v: 2 });
    await refused({ ...LATE, weekdays: ['mon'] });
    await refused({ v: 1, on: true });
    expect(rows()).toBe(0);
    expect(h.websiteChanged).toBe(0);
  });

  it('the settings block carries them as saved, and their Save moves its stamp', async () => {
    const { settingsBlockFor } = await import('../../services/website-settings-block.js');
    // Nothing saved anywhere: no block (the website goes on as before).
    expect(settingsBlockFor(db as AppDatabase, MENU, DEV)).toMatchObject({ block: null, problem: null, stamp: { settingsRev: 0 } });
    h.session = OWNER;
    expect(await save({ ...LATE, on: false })).toMatchObject({ ok: true });
    const out = settingsBlockFor(db as AppDatabase, MENU, DEV);
    expect(out.problem).toBeNull();
    expect(out.stamp.settingsRev).toBe(1);
    expect(out.block?.buy1Get1).toEqual({ on: false, opensMinute: 1320, closesMinute: 60, asksSocial: false });
    // The rest of the block as before: the areas and the pick-up offer at their defaults.
    expect(out.block?.pickup).toEqual({ offered: true, percent: 10 });
  });
});
