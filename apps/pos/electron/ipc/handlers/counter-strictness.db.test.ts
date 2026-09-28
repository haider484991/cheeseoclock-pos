/**
 * Settings sweep B7b and B10 (after v0.7.29), through the real IPC handlers,
 * repositories, website bridge and Reports readers, on a real SQLite
 * database built from every migration:
 *
 * "A discount needs a reason" ('discounts.approval' format 2, reasonRequired):
 *   - nothing saved: a hand discount with no reason saves, as before;
 *   - switched on: a hand discount with no reason (blank, spaces, or the
 *     words Reports use for none) is refused by the IPC handler BEFORE any
 *     manager's PIN is checked, and by the repository on its own — for every
 *     login, the owner's too, a manager replacing the foodpanda deal and a
 *     discount replacing an automatic offer; nothing is written;
 *   - exempt, they carry their own names: the automatic offers, the
 *     foodpanda deal, the website's pick-up % (a web order imports as
 *     before); taking a discount off needs no reason; a discount already on
 *     an open order keeps what it has; Team & leakage still groups by reason.
 *
 * The foodpanda tablet's tolerance ('foodpanda.checks' format 2,
 * tabletToleranceCents): Rs 1 by default; Pay (checkout:getRules) and
 * Reports (getFoodpanda) move together with the owner's value — Reports use
 * the value in force now, for old orders too; bounds Rs 0 to Rs 10, whole
 * rupees, refused in the main process.
 *
 * Format 1 (a value v0.7.29 saved, or one arriving from a v0.7.29 till)
 * reads with today's behaviour, is the default when it was the default, and
 * can be saved over in format 2; a newer format is read-only. Only the owner
 * reads or changes either card.
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check (auth-service), the printer spooler and the FBR worker are stood in
 * for. node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_FOODPANDA_CHECKS,
  type AuthenticatedUser,
  type ChannelOffer,
  type CheckoutRules,
  type UUID,
  type WebOrder,
} from '@cheeseoclock/shared-types';
import { DISCOUNT_REASON_REQUIRED, websiteDiscountRule } from '@cheeseoclock/pos-domain';
import { ROW_IMAGE_KEY, type SyncChange } from '@cheeseoclock/sync-core';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
  pinChecks: 0,
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
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    // Counted: a refusal for the reason must come before any PIN is looked at.
    h.pinChecks += 1;
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
 * Screen code, loaded by path as the screen loads it (the main process's
 * tsconfig does not take screen files): Pay's tablet check
 * (src/features/checkout/tabletAtPay.ts, what TenderDialog asks) and the F3
 * screen's reason buttons (src/features/checkout/discountPresets.ts).
 */
type TabletAtPay = (
  foodpanda: Pick<CheckoutRules['foodpanda'], 'tabletToleranceCents' | 'upliftBps'> | undefined,
  tillTotalCents: number,
) => { expectedCents: number; toleranceCents: number; differs: (tabletTotalCents: number) => boolean };
async function payTablet(): Promise<TabletAtPay> {
  const url = pathToFileURL(join(APP, 'src', 'features', 'checkout', 'tabletAtPay.ts')).href;
  return ((await import(/* @vite-ignore */ url)) as { tabletAtPay: TabletAtPay }).tabletAtPay;
}
type ReasonButtons = (reasons: readonly string[], reasonRequired: boolean) => readonly string[];
async function f3ReasonButtons(): Promise<ReasonButtons> {
  const url = pathToFileURL(join(APP, 'src', 'features', 'checkout', 'discountPresets.ts')).href;
  return ((await import(/* @vite-ignore */ url)) as { reasonButtons: ReasonButtons }).reasonButtons;
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

/** The owner's "Yes": everything else as released. */
const REASON_ON = { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: true };
const checksWith = (tabletToleranceCents: number) => ({ v: 2, orderCode: 'optional', tabletTotal: 'optional', tabletToleranceCents });

let db: ReturnType<typeof openMigrated>;
let menu: { pizza: string; side: string };
let REFUSED: Record<string, string>;

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

const repos = async () => ({
  ...(await import('../../db/repositories/order-repo.js')),
  ...(await import('../../db/repositories/business-settings-repo.js')),
  ...(await import('../../db/repositories/apply-remote.js')),
  ...(await import('../../services/shop-settings.js')),
});
const report = async () => await import('../../services/business-report.js');

async function saveAsOwner(key: string, value: unknown): Promise<Outcome> {
  const before = h.session;
  h.session = OWNER;
  try {
    return await call('settings:setBusiness', { key, value });
  } finally {
    h.session = before;
  }
}
async function ownerSaves(key: string, value: unknown): Promise<void> {
  expect(await saveAsOwner(key, value)).toMatchObject({ ok: true });
}

/** A Rs 2,000 order (a Rs 1,000 pizza and two Rs 500 sides, at 16%), rung up by `who`. */
async function openOrder(mode: 'takeaway' | 'foodpanda' = 'takeaway', who: AuthenticatedUser = CASHIER): Promise<string> {
  h.session = who;
  const order = await data<{ id: string }>('orders:create', { mode });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
  return order.id;
}
const liveDiscounts = (orderId: string) =>
  db
    .prepare(
      `SELECT source, value, reason, approved_by_user_id, rule_json FROM order_discounts
        WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all(orderId);
const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, total_cents, status FROM orders WHERE id = ?`).get(orderId);
/** The rows a refusal must not touch. */
const written = () =>
  Object.fromEntries(
    ['audit_log', 'sync_queue', 'order_discounts', 'business_settings'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']]),
  );
const NOW_RANGE = () => ({ sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });

/** A foodpanda order paid at Pay with this tablet total (its number typed). */
async function payFoodpanda(orderId: string, tabletTotalCents: number | null): Promise<void> {
  const total = Number(orderRow(orderId)!['total_cents']);
  h.session = CASHIER;
  await data('orders:tender', {
    orderId,
    payments: [{ method: 'foodpanda', amountCents: total, tenderedCents: null, referenceNo: `FP-${orderId.slice(-6)}` }],
    foodpanda: { tabletTotalCents },
  });
}
async function foodpandaOrderPaid(tabletOffCents: number): Promise<string> {
  const id = await openOrder('foodpanda');
  const total = Number(orderRow(id)!['total_cents']);
  await payFoodpanda(id, total + tabletOffCents);
  return id;
}

/** A value the other till saved, as the link brings it (apply-remote). */
async function fromOtherTill(key: string, value: unknown): Promise<void> {
  const { businessSettingId, applyRemoteBatch } = await repos();
  const id = businessSettingId(key as never);
  const existing = db.prepare(`SELECT version FROM business_settings WHERE id = ?`).get(id);
  const version = Number(existing?.['version'] ?? 0) + 1;
  const at = new Date(Date.now() + 60_000 * version).toISOString();
  const image = {
    [ROW_IMAGE_KEY]: 1,
    id,
    key,
    valueJson: JSON.stringify(value),
    updatedByUserId: 'u_admin',
    createdAt: T0,
    updatedAt: at,
    deletedAt: null,
    deviceId: OTHER_TILL,
    version,
  };
  const change: SyncChange = { entityType: 'business_settings', entityId: id, op: 'upsert', payload: image, updatedAt: at, deviceId: OTHER_TILL, version };
  expect(await applyRemoteBatch(db as never, [change])).toMatchObject({ applied: 1, settingsChanged: true });
}

/** An automatic offer as the owner's card saves it: 10% off any takeaway (made-up). */
const OFFER: ChannelOffer = {
  id: 'test-takeaway',
  name: 'Test takeaway 10%',
  on: true,
  cameBy: 'any',
  orderTypes: ['takeaway'],
  type: 'percent',
  value: 10,
  minOrderCents: null,
  maxOffCents: null,
  days: [0, 1, 2, 3, 4, 5, 6],
  hours: null,
  startsOn: null,
  endsOn: null,
  oncePerCustomerPerDay: false,
};

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  h.pinChecks = 0;
  db = openMigrated();
  ({ REFUSED } = (await import('../guards.js')) as unknown as { REFUSED: Record<string, string> });
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const d = db as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  openShift(d, { openingCashCents: 0, notes: null }, mgr);
  const tax = createTaxCategory(d, { name: 'Test GST', rateBps: 1_600 }, mgr);
  const food = createCategory(d, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  menu = {
    pizza: createMenuItem(d, { categoryId: food.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, mgr).id,
    side: createMenuItem(d, { categoryId: food.id, name: 'Test Side', basePriceCents: 50_000, taxCategoryId: tax.id }, mgr).id,
  };
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
});

describe.skipIf(!Sqlite)('nothing saved: the till works as before', () => {
  it('a hand discount with no reason saves — through the handler and the repository — and the counter hears "optional"', async () => {
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.discounts.reasonRequired).toBe(false);
    const viaIpc = await openOrder();
    await data('orders:applyDiscount', { orderId: viaIpc, discountType: 'percent', value: 5 });
    expect(liveDiscounts(viaIpc)).toMatchObject([{ source: null, value: 5, reason: null }]);
    const { applyDiscount, readDiscountReasonRequired } = await repos();
    const viaRepo = await openOrder();
    applyDiscount(db as never, { orderId: viaRepo, discountType: 'flat', value: 10_000, reason: null, approverUserId: null }, CASHIER_ACTOR);
    expect(liveDiscounts(viaRepo)).toMatchObject([{ value: 10_000, reason: null }]);
    // A blank reason too, as it always was.
    const blank = await openOrder();
    await data('orders:applyDiscount', { orderId: blank, discountType: 'percent', value: 5, reason: '   ' });
    expect(liveDiscounts(blank)).toHaveLength(1);
    expect(readDiscountReasonRequired(db as never)).toBe(false);
  });

  it('the tablet check tolerates Rs 1 — Pay and Reports alike', async () => {
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).foodpanda.tabletToleranceCents).toBe(100);
    const within = await foodpandaOrderPaid(100);
    const over = await foodpandaOrderPaid(101);
    const under = await foodpandaOrderPaid(-101);
    const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(fp.tabletToleranceCents).toBe(100);
    const differs = Object.fromEntries(fp.toCheck.map((l) => [l.orderId, l.differs]));
    expect({ within: differs[within], over: differs[over], under: differs[under] }).toEqual({ within: false, over: true, under: true });
    expect(fp.tabletDiffCount).toBe(2);
    const { readTabletToleranceCents } = await repos();
    expect(readTabletToleranceCents(db as never)).toBe(100);
  });

  it('both owner cards read their defaults: never changed, not read-only', async () => {
    h.session = OWNER;
    for (const [key, value] of [
      ['discounts.approval', DEFAULT_DISCOUNT_APPROVAL],
      ['foodpanda.checks', DEFAULT_FOODPANDA_CHECKS],
    ] as const) {
      expect(await data('settings:getBusiness', { key })).toMatchObject({ key, value, isDefault: true, readOnly: false, lastChanged: null });
    }
  });
});

describe.skipIf(!Sqlite)('"A discount needs a reason": Yes', () => {
  it('the handler refuses a hand discount with no reason — before any PIN is checked — for every login, and nothing is written', async () => {
    await ownerSaves('discounts.approval', REASON_ON);
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).discounts.reasonRequired).toBe(true);
    const orderId = await openOrder();
    const before = written();
    for (const reason of [undefined, null, '', '   ', 'No reason given', ' no reason GIVEN ', 'No  reason   given']) {
      const o = await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, ...(reason === undefined ? {} : { reason }) });
      expect({ reason, o }).toEqual({ reason, o: { ok: false, code: 'validation_failed', message: DISCOUNT_REASON_REQUIRED } });
    }
    // Over the limit, with a PIN (even a wrong one): the reason is said first, and no PIN is used up.
    for (const approverPin of ['wrong-pin', MANAGER_SECRET]) {
      expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 25, approverPin })).toMatchObject({
        ok: false,
        code: 'validation_failed',
      });
    }
    expect(h.pinChecks).toBe(0);
    // The owner and a manager, signed in on the till: the same.
    for (const who of [OWNER, MANAGER]) {
      h.session = who;
      expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 })).toMatchObject({
        ok: false,
        code: 'validation_failed',
        message: DISCOUNT_REASON_REQUIRED,
      });
    }
    expect(written()).toEqual(before);
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });

    // With a reason — a button's words or typed — it saves, as before.
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason: 'Staff' });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5, reason: 'Staff' }]);
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 25, reason: 'Test complaint', approverPin: MANAGER_SECRET });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 25, reason: 'Test complaint', approved_by_user_id: 'u_mgr' }]);
    expect(h.pinChecks).toBe(1);
  });

  it('the repository refuses one on its own (a caller that skips the handler), and writes nothing', async () => {
    await ownerSaves('discounts.approval', REASON_ON);
    const { applyDiscount } = await repos();
    const orderId = await openOrder();
    const before = written();
    for (const reason of [undefined, null, '', ' ', 'No reason given', 'No  reason given']) {
      expect(() =>
        applyDiscount(db as never, { orderId, discountType: 'percent', value: 5, ...(reason === undefined ? {} : { reason }), approverUserId: null }, CASHIER_ACTOR),
      ).toThrow(DISCOUNT_REASON_REQUIRED);
    }
    // Approved by a manager or not: a hand discount needs its reason.
    expect(() =>
      applyDiscount(db as never, { orderId, discountType: 'percent', value: 25, reason: null, approverUserId: 'u_mgr' }, CASHIER_ACTOR),
    ).toThrow(DISCOUNT_REASON_REQUIRED);
    expect(written()).toEqual(before);
    applyDiscount(db as never, { orderId, discountType: 'percent', value: 5, reason: 'Regular customer', approverUserId: null }, CASHIER_ACTOR);
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5, reason: 'Regular customer' }]);
  });

  it('the foodpanda deal goes on by itself and is paid as before; a manager replacing it needs a reason', async () => {
    await ownerSaves('foodpanda.deal', { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null });
    await ownerSaves('discounts.approval', REASON_ON);
    const paid = await openOrder('foodpanda');
    expect(liveDiscounts(paid)).toMatchObject([{ source: 'foodpanda', value: 20 }]);
    await payFoodpanda(paid, null);
    expect(orderRow(paid)).toMatchObject({ discount_cents: 40_000 });
    expect(db.prepare(`SELECT method FROM payments WHERE order_id = ?`).all(paid)).toMatchObject([{ method: 'foodpanda' }]);

    const orderId = await openOrder('foodpanda');
    h.session = MANAGER;
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 15, approverPin: MANAGER_SECRET })).toMatchObject({
      ok: false,
      code: 'validation_failed',
      message: DISCOUNT_REASON_REQUIRED,
    });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'foodpanda', value: 20 }]);
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 15, reason: 'As on the tablet', approverPin: MANAGER_SECRET });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 15, reason: 'As on the tablet', approved_by_user_id: 'u_mgr' }]);
  });

  it('an automatic offer goes on by itself under its own name; a hand discount replacing it needs a reason; taking it off needs none', async () => {
    await ownerSaves('discounts.offers', { v: 1, askCameBy: false, offers: [OFFER] });
    await ownerSaves('discounts.approval', REASON_ON);
    const orderId = await openOrder();
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', value: 10, reason: 'Test takeaway 10%' }]);
    h.session = CASHIER;
    // A cart change re-decides the offer: it stays on, with its own name.
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', value: 10 }]);
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', value: 10 }]);
    // Take the offer off (no reason asked), then put it back.
    await data('orders:clearDiscount', { orderId });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
    await data('orders:clearDiscount', { orderId });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', value: 10 }]);
    // With a reason, a hand discount replaces it.
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason: 'Friends & family' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 5, reason: 'Friends & family' }]);
    // …and Remove discount needs no reason either.
    await data('orders:clearDiscount', { orderId });
  });

  it('a web pick-up imports as before: the website’s % carries its own name', async () => {
    await ownerSaves('discounts.approval', REASON_ON);
    const { webOrdersBridge } = await import('../../services/web-orders-bridge.js');
    const bridge = webOrdersBridge as unknown as {
      db: unknown;
      deviceId: string;
      systemUserId: string | null;
      api: (...a: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
      importOne: (cfg: unknown, web: WebOrder) => Promise<void>;
    };
    bridge.db = db;
    bridge.deviceId = DEV;
    bridge.systemUserId = null;
    bridge.api = async () => ({ ok: true, json: async () => ({ data: {} }) });
    const web: WebOrder = {
      id: 'web-pickup-reason',
      status: 'new',
      customerName: 'Web Customer',
      customerPhone: '03111234567',
      addressLine: 'Collect from the shop',
      area: null,
      notes: null,
      fulfilment: 'pickup',
      items: [
        { posItemId: menu.pizza, name: 'Test', quantity: 1, unitPriceCents: 100_000, modifiers: [], notes: null },
        { posItemId: menu.side, name: 'Test', quantity: 2, unitPriceCents: 50_000, modifiers: [], notes: null },
      ],
      subtotalCents: 200_000,
      discountCents: 20_000,
      taxCents: 0,
      totalCents: 0,
      paymentMethod: 'cod',
      createdAt: new Date().toISOString(),
      posOrderId: null,
      posOrderNumber: null,
    };
    await bridge.importOne({}, web);
    const orderId = String(db.prepare(`SELECT pos_order_id FROM web_order_imports WHERE web_order_id = ?`).get(web.id)?.['pos_order_id']);
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 10, reason: 'Website pick-up 10% off' }]);
    expect(JSON.parse(String(liveDiscounts(orderId)[0]?.['rule_json']))).toMatchObject({ from: 'website' });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 20_000 });
    // The repository's own exemption: the website's rule, whatever the reason.
    const { applyDiscount } = await repos();
    const other = await openOrder();
    applyDiscount(db as never, { orderId: other, discountType: 'percent', value: 10, reason: null, approverUserId: 'u_admin' }, CASHIER_ACTOR, {
      rule: websiteDiscountRule(),
    });
    expect(liveDiscounts(other)).toMatchObject([{ value: 10, reason: null }]);
  });

  it('changing a discount given before the Yes: with no reason it is refused and the old one stays; with a reason it is replaced', async () => {
    const orderId = await openOrder();
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 });
    await ownerSaves('discounts.approval', REASON_ON);
    h.session = CASHIER;
    const before = written();
    for (const reason of [undefined, '', 'NO REASON GIVEN']) {
      const o = await call('orders:applyDiscount', { orderId, discountType: 'flat', value: 5_000, ...(reason === undefined ? {} : { reason }) });
      expect({ reason, o }).toMatchObject({ reason, o: { ok: false, code: 'validation_failed', message: DISCOUNT_REASON_REQUIRED } });
    }
    expect(written()).toEqual(before);
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5, reason: null }]);
    await data('orders:applyDiscount', { orderId, discountType: 'flat', value: 5_000, reason: 'Complaint' });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5_000, reason: 'Complaint' }]);
  });

  it('a takeaway order switched to foodpanda gets the deal by itself: no reason asked', async () => {
    await ownerSaves('foodpanda.deal', { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null });
    await ownerSaves('discounts.approval', REASON_ON);
    const orderId = await openOrder('takeaway');
    h.session = CASHIER;
    await data('orders:setMode', { orderId, mode: 'foodpanda' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'foodpanda', value: 20 }]);
  });

  it('a discount already on an open order keeps what it has: switching it on takes nothing off', async () => {
    const orderId = await openOrder();
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 });
    await ownerSaves('discounts.approval', REASON_ON);
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5, reason: null }]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 250_000, discount_cents: 12_500 });
  });

  it('Team & leakage still groups the discounts by their reason, the offers apart', async () => {
    await ownerSaves('discounts.approval', REASON_ON);
    const pay = async (orderId: string) => {
      const total = Number(orderRow(orderId)!['total_cents']);
      h.session = CASHIER;
      await data('orders:tender', { orderId, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] });
    };
    for (const reason of ['Staff', 'staff ', 'Birthday']) {
      const orderId = await openOrder();
      await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason });
      await pay(orderId);
    }
    // One of the owner's automatic offers, under its own name (no reason asked of anyone).
    await ownerSaves('discounts.offers', { v: 1, askCameBy: false, offers: [OFFER] });
    const withOffer = await openOrder();
    expect(liveDiscounts(withOffer)).toMatchObject([{ source: 'offer' }]);
    await pay(withOffer);
    const team = (await report()).buildTeamTab(db as never, NOW_RANGE());
    const byReason = Object.fromEntries(team.discounts.byReason.map((r) => [r.reason.trim().toLowerCase(), r.count]));
    expect(byReason).toEqual({ staff: 2, birthday: 1, 'test takeaway 10%': 1 });
    expect(team.discounts.standing).toMatchObject([{ count: 1 }]);
    expect(team.discounts.staffCount).toBe(3);
  });

  it('a Yes saved on the other till counts here at once — handler and repository', async () => {
    await fromOtherTill('discounts.approval', REASON_ON);
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).discounts.reasonRequired).toBe(true);
    const orderId = await openOrder();
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 })).toMatchObject({ ok: false, code: 'validation_failed' });
    const { applyDiscount } = await repos();
    expect(() => applyDiscount(db as never, { orderId, discountType: 'percent', value: 5, approverUserId: null }, CASHIER_ACTOR)).toThrow(
      DISCOUNT_REASON_REQUIRED,
    );
    // …and a No from there lets it through again.
    await fromOtherTill('discounts.approval', { ...REASON_ON, reasonRequired: false });
    expect((await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 })).ok).toBe(true);
  });
});

describe.skipIf(!Sqlite)('the tablet’s tolerance moves Pay and Reports together', () => {
  it('Rs 5: Pay hears Rs 5, and Reports list only the orders more than Rs 5 apart', async () => {
    await ownerSaves('foodpanda.checks', checksWith(500));
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.foodpanda.tabletToleranceCents).toBe(500);
    const ids = { at1: await foodpandaOrderPaid(101), at5: await foodpandaOrderPaid(500), over5: await foodpandaOrderPaid(501), short5: await foodpandaOrderPaid(-501) };
    // Pay's own check (TenderDialog), on the rules it reads: "Pay anyway?" only past Rs 5.
    const tabletAtPay = await payTablet();
    const total = Number(orderRow(ids.at1)!['total_cents']);
    const payAsks = (offCents: number) => tabletAtPay(rules.foodpanda, total).differs(total + offCents);
    const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(fp.tabletToleranceCents).toBe(500);
    const differs = Object.fromEntries(fp.toCheck.map((l) => [l.orderId, l.differs]));
    const expected = { at1: false, at5: false, over5: true, short5: true };
    expect({ at1: differs[ids.at1], at5: differs[ids.at5], over5: differs[ids.over5], short5: differs[ids.short5] }).toEqual(expected);
    expect({ at1: payAsks(101), at5: payAsks(500), over5: payAsks(501), short5: payAsks(-501) }).toEqual(expected);
    // Before the rules have read, Pay keeps Rs 1 — the till before the setting.
    expect(tabletAtPay(undefined, 200_000)).toMatchObject({ toleranceCents: 100, expectedCents: 200_000 });
    expect([tabletAtPay(undefined, 200_000).differs(200_100), tabletAtPay(undefined, 200_000).differs(200_101)]).toEqual([false, true]);
    expect(fp.tabletDiffCount).toBe(2);
    // Each order keeps its own difference: Reports re-read old orders with the value in force now.
    await ownerSaves('foodpanda.checks', checksWith(0));
    const now = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(now).toMatchObject({ tabletToleranceCents: 0, tabletDiffCount: 4 });
    expect(now.toCheck.find((l) => l.orderId === ids.at1)).toMatchObject({ diffCents: 101, differs: true });
  });

  it('Pay and Reports read the same value, whatever it is (one reader)', async () => {
    await foodpandaOrderPaid(0);
    const { checkoutRules } = await repos();
    for (const cents of [0, 100, 700, 1_000]) {
      await ownerSaves('foodpanda.checks', checksWith(cents));
      const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
      expect({ cents, pay: checkoutRules(db as never).foodpanda.tabletToleranceCents, reports: fp.tabletToleranceCents }).toEqual({
        cents,
        pay: cents,
        reports: cents,
      });
    }
  });

  it('Reports list EVERY foodpanda order to check; only the ones past the tolerance are marked and counted', async () => {
    await ownerSaves('foodpanda.checks', checksWith(500));
    const off3 = await foodpandaOrderPaid(300);
    const off6 = await foodpandaOrderPaid(600);
    const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(fp.toCheck.map((l) => l.orderId)).toEqual(expect.arrayContaining([off3, off6]));
    expect(fp.toCheck.find((l) => l.orderId === off3)).toMatchObject({ diffCents: 300, differs: false });
    expect(fp.toCheck.find((l) => l.orderId === off6)).toMatchObject({ diffCents: 600, differs: true });
    expect(fp.tabletDiffCount).toBe(1);
  });

  it('an order paid with NO tablet total typed is never flagged — at Rs 1 and at Rs 0', async () => {
    const none = await openOrder('foodpanda');
    await payFoodpanda(none, null);
    const typed = await foodpandaOrderPaid(0);
    for (const cents of [100, 0]) {
      await ownerSaves('foodpanda.checks', checksWith(cents));
      const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
      const byId = Object.fromEntries(fp.toCheck.map((l) => [l.orderId, l]));
      expect({ cents, none: byId[none]?.differs, typed: byId[typed]?.differs, count: fp.tabletDiffCount }).toEqual({
        cents,
        none: false,
        typed: false,
        count: 0,
      });
    }
  });

  it('a tolerance saved on the other till counts here at once, Pay and Reports', async () => {
    const id = await foodpandaOrderPaid(300);
    await fromOtherTill('foodpanda.checks', checksWith(300));
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).foodpanda.tabletToleranceCents).toBe(300);
    const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(fp.toCheck.find((l) => l.orderId === id)).toMatchObject({ diffCents: 300, differs: false });
  });
});

describe.skipIf(!Sqlite)('the bounds are the main process’s', () => {
  it('the tolerance: whole rupees, Rs 0 to Rs 10 — Rs 11, Rs 1.50, below Rs 0 and the wrong shape are refused with the reason; nothing is written', async () => {
    h.session = OWNER;
    const before = written();
    const BAD: Array<[unknown, string]> = [
      [checksWith(1_100), 'The difference allowed on the tablet is at most Rs 10'],
      [checksWith(10_000), 'The difference allowed on the tablet is at most Rs 10'],
      [checksWith(150), 'The difference allowed on the tablet is in whole rupees'],
      [checksWith(100.5), 'The difference allowed on the tablet is in whole rupees'],
      [checksWith(-100), "The difference allowed on the tablet can't be below Rs 0"],
      [{ ...checksWith(100), tabletToleranceCents: '100' }, ''],
      [{ ...checksWith(100), tabletToleranceCents: null }, ''],
      [{ v: 2, orderCode: 'optional', tabletTotal: 'optional' }, ''],
      [{ ...checksWith(100), v: 1 }, 'Saved by a different version of the app — update this till to change it'],
      [{ v: 1, orderCode: 'optional', tabletTotal: 'optional' }, 'Saved by a different version of the app — update this till to change it'],
      [{ ...checksWith(100), v: 3 }, 'Saved by a different version of the app — update this till to change it'],
      [{ ...checksWith(100), perOrder: true }, ''],
    ];
    for (const [value, why] of BAD) {
      const o = await call('settings:setBusiness', { key: 'foodpanda.checks', value });
      expect({ value, code: o.ok ? 'ok' : o.code }).toEqual({ value, code: 'validation_failed' });
      if (why) expect({ value, message: o.ok ? '' : o.message }).toEqual({ value, message: why });
    }
    expect(written()).toEqual(before);
    // Both ends are taken, synced and audited.
    for (const cents of [0, 1_000]) {
      expect(await call('settings:setBusiness', { key: 'foodpanda.checks', value: checksWith(cents) })).toMatchObject({
        ok: true,
        data: { value: { tabletToleranceCents: cents }, isDefault: false },
      });
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'business_settings'`).get()?.['n']).toBe(2);
    // "Put back the default": Rs 1.
    expect(await call('settings:setBusiness', { key: 'foodpanda.checks', useDefault: true })).toMatchObject({
      ok: true,
      data: { value: DEFAULT_FOODPANDA_CHECKS, isDefault: true },
    });
  });

  it('"a discount needs a reason": Yes or No, always sent; "Put back the default" is No', async () => {
    h.session = OWNER;
    const before = written();
    for (const reasonRequired of ['yes', 1, null, undefined]) {
      const value = { v: 2, percentOver: 10, flatOverCents: 50_000, ...(reasonRequired === undefined ? {} : { reasonRequired }) };
      expect(await call('settings:setBusiness', { key: 'discounts.approval', value })).toMatchObject({ ok: false, code: 'validation_failed' });
    }
    expect(written()).toEqual(before);
    expect(await call('settings:setBusiness', { key: 'discounts.approval', value: REASON_ON })).toMatchObject({ ok: true, data: { isDefault: false } });
    expect(await call('settings:setBusiness', { key: 'discounts.approval', useDefault: true })).toMatchObject({
      ok: true,
      data: { value: DEFAULT_DISCOUNT_APPROVAL, isDefault: true },
    });
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).discounts.reasonRequired).toBe(false);
  });

  it('a reason button reading as no reason is refused on Save; one saved before (or by an older till) still reads, and the F3 screen leaves it out while a reason is needed', async () => {
    h.session = OWNER;
    const before = written();
    const presets = (reasons: string[]) => ({ v: 1, percents: [10], flatCents: [10_000], reasons });
    for (const none of ['No reason given', 'no REASON Given', 'No  reason given']) {
      expect(await call('settings:setBusiness', { key: 'discounts.presets', value: presets(['Staff', none]) })).toEqual({
        ok: false,
        code: 'validation_failed',
        message: "A reason button can't be “No reason given”: Reports use those words for a discount with no reason",
      });
    }
    expect(written()).toEqual(before);
    // Any other words are a reason.
    expect(await call('settings:setBusiness', { key: 'discounts.presets', value: presets(['Staff', 'Test no charge']) })).toMatchObject({ ok: true });
    // A list with one, from a v0.7.29 till (or saved there before): still read, every button kept.
    await fromOtherTill('discounts.presets', presets(['Staff', 'No reason given']));
    const { readShopSetting } = await repos();
    expect(readShopSetting(db as never, 'discounts.presets').value.reasons).toEqual(['Staff', 'No reason given']);
    const reasonButtons = await f3ReasonButtons();
    h.session = CASHIER;
    const off = await data<CheckoutRules>('checkout:getRules');
    expect(reasonButtons(off.discounts.presets.reasons, off.discounts.reasonRequired)).toEqual(['Staff', 'No reason given']);
    // With the owner's Yes, the F3 screen shows only the button the till takes.
    await fromOtherTill('discounts.approval', REASON_ON);
    const on = await data<CheckoutRules>('checkout:getRules');
    expect(reasonButtons(on.discounts.presets.reasons, on.discounts.reasonRequired)).toEqual(['Staff']);
    const orderId = await openOrder();
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason: 'No reason given' })).toMatchObject({
      ok: false,
      message: DISCOUNT_REASON_REQUIRED,
    });
    expect((await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason: 'Staff' })).ok).toBe(true);
  });
});

describe.skipIf(!Sqlite)('a value saved in format 1 (v0.7.29 and before)', () => {
  it('reads as No and Rs 1 — the default when it was the default, not read-only — and is saved over in format 2', async () => {
    // As a v0.7.29 till leaves them: its own defaults, saved (e.g. "Put back the default" there).
    await fromOtherTill('discounts.approval', { v: 1, percentOver: 10, flatOverCents: 50_000 });
    await fromOtherTill('foodpanda.checks', { v: 1, orderCode: 'optional', tabletTotal: 'optional' });
    const { readShopSetting, getShopSettingCard } = await repos();
    expect(readShopSetting(db as never, 'discounts.approval')).toMatchObject({
      isDefault: false,
      newerFormat: false,
      value: { v: 1, percentOver: 10, flatOverCents: 50_000, reasonRequired: false },
    });
    expect(readShopSetting(db as never, 'foodpanda.checks').value).toEqual({ v: 1, orderCode: 'optional', tabletTotal: 'optional', tabletToleranceCents: 100 });
    const LINK_ON = { on: true, stale: false, lastHeardAt: null };
    for (const key of ['discounts.approval', 'foodpanda.checks'] as const) {
      const card = getShopSettingCard(db as never, key, LINK_ON);
      expect({ key, isDefault: card.isDefault, readOnly: card.readOnly }).toEqual({ key, isDefault: true, readOnly: false });
      // History reads the format-1 line with today's behaviour too.
      expect(card.history[0]?.value).toMatchObject(key === 'discounts.approval' ? { reasonRequired: false } : { tabletToleranceCents: 100 });
    }
    // Today's behaviour: a hand discount with no reason saves; a Rs 1.01 difference is flagged, Rs 1 is not.
    const orderId = await openOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 });
    expect((await data<CheckoutRules>('checkout:getRules')).foodpanda.tabletToleranceCents).toBe(100);
    const ok1 = await foodpandaOrderPaid(100);
    const off = await foodpandaOrderPaid(101);
    const fp = (await report()).getFoodpanda(db as never, NOW_RANGE())!;
    expect(Object.fromEntries(fp.toCheck.map((l) => [l.orderId, l.differs]))).toEqual({ [ok1]: false, [off]: true });
    // The owner saves here, in format 2, over the format-1 rows.
    await ownerSaves('discounts.approval', REASON_ON);
    await ownerSaves('foodpanda.checks', checksWith(200));
    expect(readShopSetting(db as never, 'discounts.approval').value).toEqual(REASON_ON);
    expect(readShopSetting(db as never, 'foodpanda.checks').value).toEqual(checksWith(200));
  });

  it('a format-1 value that is not the default reads as it was, reason optional', async () => {
    await fromOtherTill('discounts.approval', { v: 1, percentOver: 5, flatOverCents: 0 });
    const { getShopSettingCard } = await repos();
    expect(getShopSettingCard(db as never, 'discounts.approval', { on: false, stale: false, lastHeardAt: null })).toMatchObject({
      isDefault: false,
      readOnly: false,
      value: { percentOver: 5, flatOverCents: 0, reasonRequired: false },
    });
    const orderId = await openOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 5, reason: null }]);
  });

  it('a newer format (3) is used for what this version knows, shown read-only, and never saved over', async () => {
    await fromOtherTill('discounts.approval', { ...REASON_ON, v: 3, reasonList: ['Staff'] });
    const { getShopSettingCard, NEWER_FORMAT_REFUSAL } = await repos();
    expect(getShopSettingCard(db as never, 'discounts.approval', { on: false, stale: false, lastHeardAt: null })).toMatchObject({
      readOnly: true,
      isDefault: false,
      value: { reasonRequired: true },
    });
    // What it says that this version knows still counts: the reason is needed.
    const orderId = await openOrder();
    h.session = CASHIER;
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 5 })).toMatchObject({ ok: false, code: 'validation_failed' });
    const before = written();
    expect(await saveAsOwner('discounts.approval', REASON_ON)).toMatchObject({ ok: false, message: NEWER_FORMAT_REFUSAL });
    expect(written()).toEqual(before);
  });
});

describe.skipIf(!Sqlite)('only the owner reads or changes them', () => {
  it('a cashier AND a manager are refused both cards (set, put back, read), and nothing is written', async () => {
    const before = written();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const payload of [
        { key: 'discounts.approval', value: REASON_ON },
        { key: 'discounts.approval', useDefault: true },
        { key: 'foodpanda.checks', value: checksWith(1_000) },
        { key: 'foodpanda.checks', useDefault: true },
      ]) {
        expect({ who: who.role, payload, o: await call('settings:setBusiness', payload) }).toEqual({
          who: who.role,
          payload,
          o: { ok: false, code: 'forbidden', message: REFUSED['settings'] },
        });
      }
      for (const key of ['discounts.approval', 'foodpanda.checks']) {
        expect({ who: who.role, key, o: await call('settings:getBusiness', { key }) }).toMatchObject({
          who: who.role,
          key,
          o: { ok: false, code: 'forbidden' },
        });
      }
    }
    expect(written()).toEqual(before);
    // …while the counter still hears what it needs (any login), never who saved it.
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect({ reason: rules.discounts.reasonRequired, tolerance: rules.foodpanda.tabletToleranceCents }).toEqual({ reason: false, tolerance: 100 });
  });
});
