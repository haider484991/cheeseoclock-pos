/**
 * Settings step 2 (Money & discounts) and step 6 (Staff & kitchen timing),
 * through the real IPC handlers and repositories, on a real SQLite database
 * built from every migration:
 *   - a till with nothing saved answers today's numbers (10% / Rs 500, the
 *     old buttons, amber 15 / red 30, reminders 10 / 30);
 *   - every bound is refused in the main process, with the reason, and
 *     nothing is written; the ends of each bound are taken;
 *   - a cashier and a manager are refused settings:setBusiness (and
 *     getBusiness) for every new key, and nothing is written;
 *   - ONE approval rule in all three places: the F3 screen's lock (the
 *     renderer's previewDiscount with checkout:getRules' limit), the IPC
 *     check and the repository's save agree case by case with a saved
 *     limit — and every call site in the app passes the live limit;
 *   - a lowered limit takes an unapproved discount off an open order at its
 *     next cart change (audited auto_clear_needs_approval, synced), never an
 *     approved one or the foodpanda deal;
 *   - a limit saved on the other till counts here at once.
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check (auth-service), the printer spooler and the FBR worker are stood in
 * for. node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_PRESETS,
  DEFAULT_KITCHEN_TIMING,
  DEFAULT_STAFF_TIMING,
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type CheckoutRules,
  type UUID,
} from '@cheeseoclock/shared-types';
import { requiresManagerApproval } from '@cheeseoclock/pos-domain';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
}));

const MANAGER_SECRET = 'Test-manager-7';

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
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Test-manager-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));

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
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'db', 'migrations');
/** The app's root (src/ is the screens, electron/ the main process). */
const APP = join(HERE, '..', '..', '..');

/**
 * The F3 screen's own preview (src/features/checkout/discountPresets.ts),
 * loaded as the screen loads it. The main process's tsconfig does not take
 * screen files, so it is imported by path, with its shape spelled here.
 */
type PreviewDiscount = (
  lines: ReadonlyArray<{ lineTotalCents: number; taxRateBps?: number }>,
  subtotalCents: number,
  choice: { type: 'percent' | 'flat'; value: number } | null,
  limits?: { percentOver: number; flatOverCents: number },
) => { needsApproval: boolean };
async function screenPreview(): Promise<PreviewDiscount> {
  const url = pathToFileURL(join(APP, 'src', 'features', 'checkout', 'discountPresets.ts')).href;
  return ((await import(/* @vite-ignore */ url)) as { previewDiscount: PreviewDiscount }).previewDiscount;
}

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
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
}

const DEV = 'dev-till-1';
const OTHER_TILL = 'dev-till-2';
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
const CASHIER_ACTOR = { userId: 'u_cash', deviceId: DEV };

let db: ReturnType<typeof openMigrated>;
let REFUSED: Record<string, string>;
let menu: { pizza: string; side: string };

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
async function data<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

/** How many rows the audit trail, the sync queue and both settings tables hold: a refusal changes none. */
const writtenRows = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'settings', 'business_settings'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']]),
  );

const repos = async () => ({
  ...(await import('../../db/repositories/order-repo.js')),
  ...(await import('../../db/repositories/business-settings-repo.js')),
  ...(await import('../../db/repositories/apply-remote.js')),
});

/** An order of Rs 2,000 (a Rs 1,000 pizza and two Rs 500 sides), rung up by the cashier. */
async function openOrder(mode: 'takeaway' | 'foodpanda' = 'takeaway'): Promise<string> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
  return order.id;
}
const liveDiscounts = (orderId: string) =>
  db
    .prepare(`SELECT id, source, value, approved_by_user_id FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`)
    .all(orderId);
const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, total_cents FROM orders WHERE id = ?`).get(orderId);

async function saveAsOwner(key: string, value: unknown): Promise<Outcome> {
  const before = h.session;
  h.session = OWNER;
  try {
    return await call('settings:setBusiness', { key, value });
  } finally {
    h.session = before;
  }
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  const d = db as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  openShift(d, { openingCashCents: 0, notes: null }, mgr);
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, mgr);
  const cat = createCategory(d, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  menu = {
    pizza: createMenuItem(d, { categoryId: cat.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, mgr).id,
    side: createMenuItem(d, { categoryId: cat.id, name: 'Test Side', basePriceCents: 50_000, taxCategoryId: tax.id }, mgr).id,
  };
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
});

const NEW_KEYS = ['discounts.approval', 'discounts.presets', 'staff.timing', 'kitchen.timing'] as const;

/** A good value for each new key, different from its default. */
const GOOD: Record<(typeof NEW_KEYS)[number], unknown> = {
  'discounts.approval': { v: 1, percentOver: 15, flatOverCents: 25_000 },
  'discounts.presets': { v: 1, percents: [5, 15], flatCents: [15_000, 25_000], reasons: ['Birthday', 'Test reason'] },
  'staff.timing': { v: 1, idleLogoutMin: 5, maxLoginHours: 8, stepInMin: 5, freeReprints: 0, reprintWindowMin: 60 },
  'kitchen.timing': { v: 1, amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
};

describe.skipIf(!Sqlite)('a till with nothing saved answers today’s numbers', () => {
  it('checkout:getRules gives the counter the released limit, buttons and kitchen minutes', async () => {
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.discounts).toEqual({
      approval: { percentOver: 10, flatOverCents: 50_000 },
      presets: {
        percents: [10, 20, 25, 50, 100],
        flatCents: [10_000, 20_000, 50_000],
        reasons: ['Staff', 'Friends & family', 'Regular customer', 'Complaint'],
      },
    });
    expect(rules.kitchen).toEqual({ amberMin: 15, redMin: 30, notStartedMin: 10, notDoneMin: 30 });
    // …and never a cost, a commission or who saved something.
    expect(JSON.stringify(rules)).not.toMatch(/commission|payout|updatedBy|idleLogout|maxLogin/i);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
  });

  it('each owner card reads its default, never changed, not read-only', async () => {
    h.session = OWNER;
    for (const key of NEW_KEYS) {
      const card = await data<Record<string, unknown>>('settings:getBusiness', { key });
      expect({ key, card }).toMatchObject({
        key,
        card: { key, value: SHOP_SETTING_DEFAULTS[key], defaultValue: SHOP_SETTING_DEFAULTS[key], isDefault: true, readOnly: false, lastChanged: null },
      });
    }
  });

  it('the main process reads the defaults for the approval check and the staff timings', async () => {
    const { readApprovalLimits, readStaffTiming } = await import('../../db/business-settings-read.js');
    expect(readApprovalLimits(db as never)).toEqual({ percentOver: DEFAULT_DISCOUNT_APPROVAL.percentOver, flatOverCents: DEFAULT_DISCOUNT_APPROVAL.flatOverCents });
    expect(readStaffTiming(db as never)).toEqual(DEFAULT_STAFF_TIMING);
    expect(readStaffTiming(null)).toEqual(DEFAULT_STAFF_TIMING);
    // Today's numbers, as the tills behaved before the setting: 10% passes, 11% does not; Rs 200 off Rs 2,000 passes, Rs 201 does not.
    const limits = readApprovalLimits(db as never);
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, 200_000, limits)).toBe(false);
    expect(requiresManagerApproval({ type: 'percent', value: 11 }, 200_000, limits)).toBe(true);
    expect(requiresManagerApproval({ type: 'flat', value: 20_000 }, 200_000, limits)).toBe(false);
    expect(requiresManagerApproval({ type: 'flat', value: 20_100 }, 200_000, limits)).toBe(true);
    expect(DEFAULT_DISCOUNT_PRESETS.percents).toEqual([10, 20, 25, 50, 100]);
    expect(DEFAULT_KITCHEN_TIMING).toMatchObject({ amberMin: 15, redMin: 30 });
  });
});

describe.skipIf(!Sqlite)('the bounds are the main process’s', () => {
  /** Per key: values the main process must refuse (outside a bound, not whole, the wrong shape). */
  const BAD: Record<(typeof NEW_KEYS)[number], Array<Record<string, unknown>>> = {
    'discounts.approval': [
      { v: 1, percentOver: -1, flatOverCents: 50_000 },
      { v: 1, percentOver: 51, flatOverCents: 50_000 },
      { v: 1, percentOver: 10.5, flatOverCents: 50_000 },
      { v: 1, percentOver: 10, flatOverCents: -100 },
      { v: 1, percentOver: 10, flatOverCents: 500_100 },
      { v: 1, percentOver: 10, flatOverCents: 50_050 },
      { v: 1, percentOver: '10', flatOverCents: 50_000 },
      { v: 1, percentOver: 10 },
      { v: 1, percentOver: 10, flatOverCents: 50_000, managerOnly: false },
      { v: 2, percentOver: 10, flatOverCents: 50_000 },
    ],
    'discounts.presets': [
      { v: 1, percents: [], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [5, 10, 15, 20, 25, 30], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [0], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [101], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [12.5], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [10, 10], flatCents: [10_000], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [10_000, 20_000, 30_000, 40_000], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [0], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [500_100], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [10_050], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [10_000, 10_000], reasons: ['Staff'] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: [] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: ['x'.repeat(31)] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: [''] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: [' Staff'] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: ['Two\nlines'] },
      { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff', 'staff'] },
    ],
    'staff.timing': [
      { ...(GOOD['staff.timing'] as object), idleLogoutMin: 4 },
      { ...(GOOD['staff.timing'] as object), idleLogoutMin: 0 },
      { ...(GOOD['staff.timing'] as object), idleLogoutMin: 61 },
      { ...(GOOD['staff.timing'] as object), maxLoginHours: 7 },
      { ...(GOOD['staff.timing'] as object), maxLoginHours: 25 },
      { ...(GOOD['staff.timing'] as object), stepInMin: 4 },
      { ...(GOOD['staff.timing'] as object), stepInMin: 31 },
      { ...(GOOD['staff.timing'] as object), freeReprints: -1 },
      { ...(GOOD['staff.timing'] as object), freeReprints: 4 },
      { ...(GOOD['staff.timing'] as object), reprintWindowMin: 9 },
      { ...(GOOD['staff.timing'] as object), reprintWindowMin: 121 },
      { ...(GOOD['staff.timing'] as object), idleLogoutMin: 7.5 },
      { ...(GOOD['staff.timing'] as object), idleLogoutMin: null },
      { ...(GOOD['staff.timing'] as object), cashierIdleMin: 10 },
    ],
    'kitchen.timing': [
      { ...(GOOD['kitchen.timing'] as object), amberMin: 4 },
      { ...(GOOD['kitchen.timing'] as object), amberMin: 61 },
      { ...(GOOD['kitchen.timing'] as object), redMin: 9 },
      { ...(GOOD['kitchen.timing'] as object), redMin: 121 },
      { ...(GOOD['kitchen.timing'] as object), notStartedMin: 4 },
      { ...(GOOD['kitchen.timing'] as object), notStartedMin: 61 },
      { ...(GOOD['kitchen.timing'] as object), notDoneMin: 9 },
      { ...(GOOD['kitchen.timing'] as object), notDoneMin: 121 },
      { v: 1, amberMin: 30, redMin: 30, notStartedMin: 10, notDoneMin: 30 },
      { v: 1, amberMin: 15, redMin: 30, notStartedMin: 30, notDoneMin: 20 },
      { ...(GOOD['kitchen.timing'] as object), amberMin: 12.5 },
    ],
  };

  it('every value outside a bound is refused with the reason, and nothing is written', async () => {
    h.session = OWNER;
    const before = writtenRows();
    for (const key of NEW_KEYS) {
      for (const value of BAD[key]) {
        const o = await call('settings:setBusiness', { key, value });
        expect({ key, value, code: o.ok ? 'ok' : o.code }).toEqual({ key, value, code: 'validation_failed' });
        // A plain-words reason, never a stack or a database error.
        expect(o.ok ? '' : o.message).toMatch(/^[A-Z"“]/);
      }
    }
    expect(writtenRows()).toEqual(before);
  });

  it('says why in plain words', async () => {
    h.session = OWNER;
    const why = async (key: string, value: unknown) => {
      const o = await call('settings:setBusiness', { key, value });
      return o.ok ? 'saved' : o.message;
    };
    expect(await why('discounts.approval', { v: 1, percentOver: 51, flatOverCents: 0 })).toBe('The % limit is at most 50%');
    expect(await why('discounts.approval', { v: 1, percentOver: 10, flatOverCents: 500_100 })).toBe('The rupee limit is at most Rs 5,000');
    expect(await why('staff.timing', { ...(GOOD['staff.timing'] as object), idleLogoutMin: 0 })).toBe(
      'Signing out an idle owner or manager is at least 5 minutes',
    );
    expect(await why('staff.timing', { ...(GOOD['staff.timing'] as object), maxLoginHours: 25 })).toBe('The longest a login lasts is at most 24 hours');
    expect(await why('kitchen.timing', { v: 1, amberMin: 30, redMin: 30, notStartedMin: 10, notDoneMin: 30 })).toBe(
      'A card turns red after it turns amber: give red more minutes',
    );
    expect(await why('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['x'.repeat(31)] })).toBe(
      'Keep a reason to 30 letters',
    );
  });

  it('the ends of every bound are taken (each save synced and audited)', async () => {
    h.session = OWNER;
    const EDGES: Array<[string, unknown]> = [
      ['discounts.approval', { v: 1, percentOver: 0, flatOverCents: 0 }],
      ['discounts.approval', { v: 1, percentOver: 50, flatOverCents: 500_000 }],
      ['discounts.presets', { v: 1, percents: [1], flatCents: [100], reasons: ['x'.repeat(30)] }],
      [
        'discounts.presets',
        { v: 1, percents: [1, 25, 50, 75, 100], flatCents: [100, 250_000, 500_000], reasons: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
      ],
      ['staff.timing', { v: 1, idleLogoutMin: 5, maxLoginHours: 8, stepInMin: 5, freeReprints: 0, reprintWindowMin: 10 }],
      ['staff.timing', { v: 1, idleLogoutMin: 60, maxLoginHours: 24, stepInMin: 30, freeReprints: 3, reprintWindowMin: 120 }],
      ['kitchen.timing', { v: 1, amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 10 }],
      ['kitchen.timing', { v: 1, amberMin: 60, redMin: 120, notStartedMin: 60, notDoneMin: 120 }],
    ];
    for (const [key, value] of EDGES) {
      const o = await call('settings:setBusiness', { key, value });
      expect({ key, value, ok: o.ok }).toEqual({ key, value, ok: true });
    }
    const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'business_settings'`).get()?.['n'];
    const queued = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`).get()?.['n'];
    expect({ audited, queued }).toEqual({ audited: EDGES.length, queued: EDGES.length });
    // "Put back the default" writes the default's values.
    for (const key of NEW_KEYS) {
      const o = await call('settings:setBusiness', { key, useDefault: true });
      expect({ key, o }).toMatchObject({ key, o: { ok: true, data: { isDefault: true, value: SHOP_SETTING_DEFAULTS[key] } } });
    }
  });
});

describe.skipIf(!Sqlite)('only the owner changes them', () => {
  it('a cashier AND a manager are refused every new key (set, put back, read), and nothing is written', async () => {
    const before = writtenRows();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const key of NEW_KEYS) {
        for (const payload of [{ key, value: GOOD[key] }, { key, useDefault: true }]) {
          expect({ who: who.role, payload, o: await call('settings:setBusiness', payload) }).toEqual({
            who: who.role,
            payload,
            o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
          });
        }
        expect({ who: who.role, key, o: await call('settings:getBusiness', { key }) }).toMatchObject({
          who: who.role,
          key,
          o: { ok: false, code: 'forbidden' },
        });
      }
    }
    h.session = null;
    expect(await call('settings:setBusiness', { key: 'discounts.approval', value: GOOD['discounts.approval'] })).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    });
    expect(writtenRows()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
  });

  it('the owner saves each one; the counter then reads the approval limit, the buttons and the kitchen minutes — never the staff timings', async () => {
    for (const key of NEW_KEYS) expect((await saveAsOwner(key, GOOD[key])).ok).toBe(true);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<CheckoutRules>('checkout:getRules');
      expect(rules.discounts).toEqual({
        approval: { percentOver: 15, flatOverCents: 25_000 },
        presets: { percents: [5, 15], flatCents: [15_000, 25_000], reasons: ['Birthday', 'Test reason'] },
      });
      expect(rules.kitchen).toEqual({ amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 });
      expect(JSON.stringify(rules)).not.toMatch(/idleLogout|maxLogin|stepIn|freeReprints|commission/i);
    }
  });
});

describe.skipIf(!Sqlite)('one approval rule in all three places', () => {
  /** Rs 2,000 orders, with the owner's limit of 15% or Rs 250. */
  const LIMIT = { v: 1, percentOver: 15, flatOverCents: 25_000 };
  const CASES: Array<{ d: { type: 'percent' | 'flat'; value: number }; needs: boolean; why: string }> = [
    { d: { type: 'percent', value: 5 }, needs: false, why: 'well under' },
    { d: { type: 'percent', value: 12 }, needs: false, why: 'over the old 10%, under the owner’s 15%' },
    { d: { type: 'percent', value: 15 }, needs: false, why: 'at the limit' },
    { d: { type: 'percent', value: 16 }, needs: true, why: 'over the limit' },
    { d: { type: 'flat', value: 25_000 }, needs: false, why: 'Rs 250 is 12.5% of Rs 2,000 and at the Rs 250 limit (the old rule asked)' },
    { d: { type: 'flat', value: 25_100 }, needs: true, why: 'over Rs 250' },
    { d: { type: 'flat', value: 30_000 }, needs: true, why: 'over Rs 250' },
  ];

  it('the F3 lock, the IPC check and the repository agree, case by case, with the saved limit', async () => {
    expect((await saveAsOwner('discounts.approval', LIMIT)).ok).toBe(true);
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    const { applyDiscount, getOrderSnapshot } = await repos();
    const previewDiscount = await screenPreview();
    for (const { d, needs, why } of CASES) {
      // 1. The screen: the renderer's preview with the limit checkout:getRules gave it.
      const screenOrder = await openOrder();
      const snap = getOrderSnapshot(db as never, screenOrder)!;
      expect(snap.order.subtotalCents).toBe(200_000);
      const screen = previewDiscount(snap.items, snap.order.subtotalCents, d, rules.discounts.approval).needsApproval;
      // 2. The IPC handler, with no manager's PIN.
      h.session = CASHIER;
      const ipcOutcome = await call('orders:applyDiscount', { orderId: screenOrder, discountType: d.type, value: d.value });
      const ipcSays = !ipcOutcome.ok && ipcOutcome.code === 'precondition_failed';
      if (ipcOutcome.ok) expect(liveDiscounts(screenOrder)).toMatchObject([{ value: d.value, approved_by_user_id: null }]);
      // 3. The repository, called straight (no handler in front of it).
      const repoOrder = await openOrder();
      let repoSays = false;
      try {
        applyDiscount(db as never, { orderId: repoOrder, discountType: d.type, value: d.value, approverUserId: null }, CASHIER_ACTOR);
      } catch (e) {
        expect(String(e)).toMatch(/Manager approval is required/);
        repoSays = true;
      }
      expect({ d, why, screen, ipc: ipcSays, repository: repoSays }).toEqual({ d, why, screen: needs, ipc: needs, repository: needs });
    }
  });

  it('the refusal says the owner’s rule in words; a manager’s PIN lets it through, as before', async () => {
    expect((await saveAsOwner('discounts.approval', LIMIT)).ok).toBe(true);
    const orderId = await openOrder();
    h.session = CASHIER;
    const refused = await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 20 });
    expect(refused).toEqual({
      ok: false,
      code: 'precondition_failed',
      message:
        "Manager approval required for this discount. Up to 15% off, or up to Rs 250 off if that is no more than 15% of the order, without a manager. More needs a manager's PIN or password.",
    });
    const approved = await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 20, approverPin: MANAGER_SECRET });
    expect(approved.ok).toBe(true);
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 20, approved_by_user_id: 'u_mgr' }]);
  });

  it('every call of the rule in the app passes the live limit (a new call site must too)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules' || name === 'out' || name === 'dist') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(join(APP, 'src'));
    walk(join(APP, 'electron'));
    const calls: Array<{ file: string; fn: string; args: string[] }> = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const fn of ['requiresManagerApproval', 'previewDiscount']) {
        let i = 0;
        while ((i = src.indexOf(`${fn}(`, i)) !== -1) {
          const prev = src[i - 1] ?? '';
          const isDefinition = /function\s+$/.test(src.slice(Math.max(0, i - 12), i));
          if (/[\w$]/.test(prev) || isDefinition) {
            i += fn.length;
            continue;
          }
          let depth = 1;
          let j = i + fn.length + 1;
          let cur = '';
          const args: string[] = [];
          for (; j < src.length; j++) {
            const c = src[j]!;
            if ('([{'.includes(c)) depth += 1;
            else if (')]}'.includes(c)) depth -= 1;
            if (depth === 0) break;
            if (c === ',' && depth === 1) {
              args.push(cur.trim());
              cur = '';
            } else cur += c;
          }
          if (cur.trim()) args.push(cur.trim());
          calls.push({ file: relative(APP, file).replace(/\\/g, '/'), fn, args });
          i = j;
        }
      }
    }
    const rule = calls.filter((c) => c.fn === 'requiresManagerApproval');
    // The IPC check, the repository's save and cart re-check, the F3 screen's preview, and the
    // locks Settings → Money & discounts shows on its example buttons.
    expect(rule.map((c) => c.file).sort()).toEqual([
      'electron/db/repositories/order-repo.ts',
      'electron/db/repositories/order-repo.ts',
      'electron/ipc/handlers/orders-handlers.ts',
      'src/features/checkout/discountPresets.ts',
      'src/features/settings/shop-rules/discountRules.ts',
      'src/features/settings/shop-rules/discountRules.ts',
    ]);
    for (const c of rule) expect({ ...c, limitPassed: c.args.length === 3 }).toMatchObject({ limitPassed: true });
    expect(rule.filter((c) => c.file.startsWith('electron/db')).map((c) => c.args[2])).toEqual(['readApprovalLimits(db)', 'readApprovalLimits(db)']);
    // The screen's previews all carry the limit from checkout:getRules.
    const previews = calls.filter((c) => c.fn === 'previewDiscount');
    expect(previews.length).toBeGreaterThan(0);
    for (const c of previews) expect({ ...c, limitPassed: c.args.length === 4 }).toMatchObject({ limitPassed: true });
  });
});

describe.skipIf(!Sqlite)('lowering the limit', () => {
  it('takes an unapproved discount off an open order at its next cart change — audited and synced; an approved one and the foodpanda deal stay', async () => {
    // A cashier's 10% (fine today), a manager-approved 25%, and the owner's foodpanda deal.
    const cashierOrder = await openOrder();
    await data('orders:applyDiscount', { orderId: cashierOrder, discountType: 'percent', value: 10 });
    const approvedOrder = await openOrder();
    await data('orders:applyDiscount', { orderId: approvedOrder, discountType: 'percent', value: 25, approverPin: MANAGER_SECRET });
    expect(
      (
        await saveAsOwner('foodpanda.deal', {
          v: 1,
          percent: 20,
          shopPercent: 20,
          minOrderCents: null,
          maxOffCents: null,
          startsOn: null,
          endsOn: null,
        })
      ).ok,
    ).toBe(true);
    const dealOrder = await openOrder('foodpanda');
    expect(liveDiscounts(dealOrder)).toMatchObject([{ source: 'foodpanda', value: 20 }]);
    const [discount] = liveDiscounts(cashierOrder) as Array<{ id: string }>;
    expect(orderRow(cashierOrder)).toMatchObject({ subtotal_cents: 200_000, discount_cents: 20_000 });

    // The owner lowers the limit to 5%.
    expect((await saveAsOwner('discounts.approval', { v: 1, percentOver: 5, flatOverCents: 50_000 })).ok).toBe(true);
    // Nothing moves by itself: the order is as it was until its cart changes.
    expect(liveDiscounts(cashierOrder)).toHaveLength(1);
    expect(orderRow(cashierOrder)).toMatchObject({ discount_cents: 20_000 });
    // The counter's screen already shows the lock on it.
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, 200_000, rules.discounts.approval)).toBe(true);

    // The next cart change: one more side.
    await data('orders:addItem', { orderId: cashierOrder, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(cashierOrder)).toEqual([]);
    expect(orderRow(cashierOrder)).toMatchObject({ subtotal_cents: 250_000, discount_cents: 0 });
    const audit = db
      .prepare(`SELECT action, actor_user_id, before_json, after_json FROM audit_log WHERE entity_type = 'order_discounts' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(discount!.id);
    expect(audit).toMatchObject({ action: 'auto_clear_needs_approval', actor_user_id: 'u_cash', after_json: null });
    expect(JSON.parse(String(audit?.['before_json']))).toMatchObject({ id: discount!.id, value: 10, approved_by_user_id: null });
    const synced = db
      .prepare(`SELECT op FROM sync_queue WHERE entity_type = 'order_discounts' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(discount!.id);
    expect(synced).toMatchObject({ op: 'delete' });
    // Put back with a manager's PIN, it stays.
    await data('orders:applyDiscount', { orderId: cashierOrder, discountType: 'percent', value: 10, approverPin: MANAGER_SECRET });
    await data('orders:addItem', { orderId: cashierOrder, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(cashierOrder)).toMatchObject([{ value: 10, approved_by_user_id: 'u_mgr' }]);

    // The approved 25% and the owner's foodpanda deal are never taken off by the re-check.
    await data('orders:addItem', { orderId: approvedOrder, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(approvedOrder)).toMatchObject([{ value: 25, approved_by_user_id: 'u_mgr' }]);
    await data('orders:addItem', { orderId: dealOrder, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(dealOrder)).toMatchObject([{ source: 'foodpanda', value: 20 }]);
  });

  it('a limit saved on the other till counts here at once, for the screen, the handler and the repository', async () => {
    const { businessSettingId, applyRemoteBatch, applyDiscount } = await repos();
    const id = businessSettingId('discounts.approval');
    const at = new Date(Date.now() + 60_000).toISOString();
    const image = {
      [ROW_IMAGE_KEY]: 1,
      id,
      key: 'discounts.approval',
      valueJson: JSON.stringify({ v: 1, percentOver: 0, flatOverCents: 0 }),
      updatedByUserId: 'u_admin',
      createdAt: T0,
      updatedAt: at,
      deletedAt: null,
      deviceId: OTHER_TILL,
      version: 1,
    };
    const change: SyncChange = { entityType: 'business_settings', entityId: id, op: 'upsert', payload: image, updatedAt: at, deviceId: OTHER_TILL, version: 1 };
    expect(await applyRemoteBatch(db as never, [change])).toMatchObject({ applied: 1, settingsChanged: true });
    // Its own audit row here (History shows it came from the other till).
    expect(db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(id)).toMatchObject({ action: 'remote_apply' });

    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).discounts.approval).toEqual({ percentOver: 0, flatOverCents: 0 });
    const orderId = await openOrder();
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 1 })).toMatchObject({
      ok: false,
      code: 'precondition_failed',
      message: expect.stringContaining("Every discount needs a manager's PIN or password."),
    });
    expect(() =>
      applyDiscount(db as never, { orderId, discountType: 'flat', value: 100, approverUserId: null }, CASHIER_ACTOR),
    ).toThrow(/Manager approval is required/);
  });
});
