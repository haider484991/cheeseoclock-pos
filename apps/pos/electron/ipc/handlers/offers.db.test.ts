/**
 * The owner's automatic offers (Settings → Money & discounts,
 * 'discounts.offers'; the owner, 28 Sep 2026: "the offer discount should
 * have settings … so it automatically applies on the whole order except
 * delivery fee"), through the real IPC handlers, repositories, FBR mapper,
 * receipt renderer and Reports readers, on a real SQLite database built from
 * every migration:
 *   - nothing saved: nothing changes;
 *   - an offer goes on by itself on a matching counter order, worked on the
 *     food (the delivery charge is paid in full), its minimum on the food;
 *     the biggest wins; its terms are FROZEN on the row, approved by the
 *     owner who saved it, audited and synced; the bill prints its name;
 *   - one discount per order: a cashier's F3 discount replaces it under the
 *     normal PIN rule and clearing that brings it back; it never replaces a
 *     staff discount; the × takes it off this order (Rs 0) until "Put it back";
 *   - never on a website or foodpanda order;
 *   - when the order was started (Pakistan time, the trading day from 05:00)
 *     decides the days, hours and dates;
 *   - the abuse controls: Phone / WhatsApp need the customer's phone; once
 *     per customer per day; how the order came in locks at send (a change
 *     then needs a manager's PIN and is audited);
 *   - a later Save never moves an open or paid order (history never moves);
 *   - Reports: the came-by split, the Standing offers per offer, and Team &
 *     leakage's flags at 1.5 × the shop;
 *   - only the owner saves or reads the setting; the audit chain stays whole.
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check (auth-service), the printer spooler and the FBR worker are stood in
 * for. node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, phone and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ChannelOffer, CheckoutRules, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { mapOrderToFbrPayload, type FbrSellerInfo } from '@cheeseoclock/fbr-core';
import { escPosToText, renderReceipt } from '@cheeseoclock/printer-core';
import { verifyAuditChain, type AuditChainRow } from '../../db/audit-chain.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const CASHIER_2 = session('u_cash2', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');
const SELLER: FbrSellerInfo = { sellerNTNCNIC: '0000000', sellerBusinessName: 'Test Shop', sellerProvince: 'Sindh', sellerAddress: 'Test Road' };
const BRANDING = { storeName: 'Test Shop' };
const PHONE_A = '03001234567';
const PHONE_B = '03007654321';

let db: ReturnType<typeof openMigrated>;
let menu: { pizza: string; side: string; charge: string };

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
  ...(await import('../../db/repositories/customer-repo.js')),
});

/** An offer as the owner's card would save it (made-up figures). */
function offer(over: Partial<ChannelOffer> = {}): ChannelOffer {
  return {
    id: 'test-wa',
    name: 'Test WhatsApp 10%',
    on: true,
    cameBy: ['whatsapp'],
    orderTypes: ['delivery'],
    type: 'percent',
    value: 10,
    minOrderCents: null,
    maxOffCents: null,
    days: [0, 1, 2, 3, 4, 5, 6],
    hours: null,
    startsOn: null,
    endsOn: null,
    oncePerCustomerPerDay: false,
    ...over,
  };
}

/** The owner saves the offers (Settings → Money & discounts). */
async function saveOffers(offers: ChannelOffer[], askCameBy = false): Promise<void> {
  const before = h.session;
  h.session = OWNER;
  try {
    const o = await call('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy, offers } });
    expect(o).toMatchObject({ ok: true });
  } finally {
    h.session = before;
  }
}

async function ownerSaves(key: string, value: unknown): Promise<void> {
  const before = h.session;
  h.session = OWNER;
  try {
    expect(await call('settings:setBusiness', { key, value })).toMatchObject({ ok: true });
  } finally {
    h.session = before;
  }
}

/** The customer's phone saved on the order, as Pay / Send do (customers:attachToOrder). */
async function savePhone(orderId: string, phone: string, who = CASHIER): Promise<void> {
  const r = await repos();
  const actor = { userId: who.id, deviceId: DEV };
  const found = r.findCustomerByPhone(db as never, phone);
  const c = found ?? r.createCustomer(db as never, { name: 'Test Customer', phone }, actor);
  const a = r.createAddress(db as never, { customerId: c.id, label: 'Home', addressLine: 'House 1, Test Street', area: 'Test Area' }, actor);
  r.snapshotCustomerOntoOrder(db as never, { orderId, customerId: c.id, addressId: a.id }, actor);
}

/**
 * A counter order rung up by the cashier: a Rs 1,000 pizza, two Rs 500 sides
 * (Rs 2,000 of food) and, on a delivery, the area's Rs 200 delivery charge,
 * all at 16%. `startedAt` moves when it was started (for the days, hours
 * and dates). `phone`: the customer's phone saved on it.
 */
async function counterOrder(
  opts: { mode?: 'delivery' | 'takeaway' | 'foodpanda'; cameBy?: string | null; phone?: string | null; startedAt?: string; who?: AuthenticatedUser } = {},
): Promise<string> {
  const mode = opts.mode ?? 'delivery';
  h.session = opts.who ?? CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode, ...(opts.cameBy ? { cameBy: opts.cameBy } : {}) });
  if (opts.startedAt) db.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`).run(opts.startedAt, order.id);
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  if (mode === 'delivery') await data('orders:addItem', { orderId: order.id, menuItemId: menu.charge, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
  if (opts.phone) await savePhone(order.id, opts.phone, opts.who ?? CASHIER);
  return order.id;
}

const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, tax_cents, total_cents, status, came_by FROM orders WHERE id = ?`).get(orderId);
const liveDiscounts = (orderId: string) =>
  db
    .prepare(
      `SELECT source, discount_type, value, reason, amount_cents, applied_by_user_id, approved_by_user_id, rule_json
         FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all(orderId);
const ruleOf = (row: Record<string, unknown> | undefined) => JSON.parse(String(row?.['rule_json'])) as Record<string, unknown>;
const audits = (action: string) =>
  db.prepare(`SELECT entity_id, actor_user_id, before_json, after_json FROM audit_log WHERE action = ? ORDER BY rowid`).all(action);
async function snap(orderId: string): Promise<OrderSnapshot> {
  return (await repos()).getOrderSnapshot(db as never, orderId)!;
}
async function pay(orderId: string, who = CASHIER): Promise<void> {
  const o = orderRow(orderId)!;
  h.session = who;
  await data('orders:tender', {
    orderId,
    payments: [{ method: 'cash', amountCents: Number(o['total_cents']), tenderedCents: Number(o['total_cents']) }],
  });
}
const fbrLines = (s: OrderSnapshot) =>
  Object.fromEntries(
    mapOrderToFbrPayload(s, SELLER).items.map((i) => [i.productDescription, { net: i.valueSalesExcludingST, tax: i.salesTaxApplicable, discount: i.discount ?? 0 }]),
  );
const receiptText = (s: OrderSnapshot) => escPosToText(renderReceipt(s, { branding: BRANDING }));
const NOW_RANGE = () => ({ sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });

function chainOk(): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_cash2', 'Test Cashier Two', 'cashier', T0, T0, DEV);
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
  const fees = createCategory(d, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, mgr);
  menu = {
    pizza: createMenuItem(d, { categoryId: food.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, mgr).id,
    side: createMenuItem(d, { categoryId: food.id, name: 'Test Side', basePriceCents: 50_000, taxCategoryId: tax.id }, mgr).id,
    charge: createMenuItem(d, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: tax.id }, mgr).id,
  };
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./customers-handlers.js')).registerCustomersHandlers(ctx);
});

describe.skipIf(!Sqlite)('nothing saved: nothing changes', () => {
  it('no offers, not asked: a WhatsApp delivery with the phone is billed as before; the counter hears there are none', async () => {
    const orderId = await counterOrder({ cameBy: 'whatsapp', phone: PHONE_A });
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 0, tax_cents: 35_200, total_cents: 255_200, came_by: 'whatsapp' });
    expect(liveDiscounts(orderId)).toEqual([]);
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.offers).toEqual({ askCameBy: false, offers: [] });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
    expect(audits('apply_offer')).toEqual([]);
  });
});

describe.skipIf(!Sqlite)('an offer goes on by itself, on the food only', () => {
  it('WhatsApp 10% on a delivery: waits for the phone, then takes Rs 200 off the Rs 2,000 of food; the Rs 200 charge is paid in full — frozen, approved by the owner, audited, synced, printed', async () => {
    await saveOffers([offer()]);
    const savedAt = String(db.prepare(`SELECT updated_at FROM business_settings WHERE key = 'discounts.offers'`).get()?.['updated_at']);
    const orderId = await counterOrder({ cameBy: 'whatsapp' });
    // WhatsApp needs the customer's phone on the order: not yet.
    expect(liveDiscounts(orderId)).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });

    await savePhone(orderId, PHONE_A);
    // 10% of the food = Rs 200; tax 16% of (900 + 900 + 200) = Rs 320; total Rs 2,320.
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 20_000, tax_cents: 32_000, total_cents: 232_000 });
    const [row] = liveDiscounts(orderId);
    expect(row).toMatchObject({
      source: 'offer',
      discount_type: 'percent',
      value: 10,
      reason: 'Test WhatsApp 10%',
      amount_cents: 20_000,
      applied_by_user_id: 'u_cash',
      // The owner who saved the offers approved it: never cleared by the approval re-check.
      approved_by_user_id: 'u_admin',
    });
    expect(ruleOf(row)).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: false,
      from: 'till',
      offer: {
        v: 1,
        id: 'test-wa',
        name: 'Test WhatsApp 10%',
        type: 'percent',
        value: 10,
        minOrderCents: null,
        maxOffCents: null,
        cameBy: ['whatsapp'],
        orderTypes: ['delivery'],
        oncePerCustomerPerDay: false,
        settingsAt: savedAt,
      },
    });
    expect(audits('apply_offer')).toHaveLength(1);
    const synced = db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'order_discounts' ORDER BY rowid DESC LIMIT 1`).get();
    expect(String(synced?.['payload_json'])).toContain('"source":"offer"');

    // The cart, Pay and the bill say its name.
    await pay(orderId);
    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([
      { source: 'offer', reason: 'Test WhatsApp 10%', alsoOffDeliveryCharge: false, offer: { id: 'test-wa', name: 'Test WhatsApp 10%', declined: false } },
    ]);
    expect(receiptText(s)).toContain('Test WhatsApp 10% (food only)');
    expect(receiptText(s)).not.toContain('Discount');
    // The FBR invoice: the delivery charge carries none of it.
    expect(fbrLines(s)).toEqual({
      'Test Pizza': { net: 900, tax: 144, discount: 100 },
      'Delivery Charge (Rs 200)': { net: 200, tax: 32, discount: 0 },
      'Test Side': { net: 900, tax: 144, discount: 100 },
    });
    // Profit and food cost: the charge is fee sales at its full Rs 200.
    const { getFoodCost } = await import('../../services/business-report.js');
    expect(getFoodCost(db as never, NOW_RANGE())).toMatchObject({ foodSalesCents: 180_000, feeSalesCents: 20_000 });
    expect(chainOk()).toBe(true);
  });

  it('the minimum is measured on the food, never the delivery charge', async () => {
    await saveOffers([offer({ cameBy: 'any', minOrderCents: 210_000 })]);
    // Rs 2,000 of food + the Rs 200 charge = Rs 2,200: still under Rs 2,100 of FOOD.
    const orderId = await counterOrder({ phone: PHONE_A });
    expect(liveDiscounts(orderId)).toEqual([]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 25_000 });
    // …and back under it, it comes off (audited).
    const s = await snap(orderId);
    const side = s.items.find((i) => i.menuItemName === 'Test Side' && i.quantity === 1)!;
    await data('orders:removeItem', { orderId, orderItemId: side.id });
    expect(liveDiscounts(orderId)).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
    expect(audits('offer_off')).toHaveLength(1);
  });

  it('the biggest fitting offer wins; a tie keeps the one on the order', async () => {
    await saveOffers([
      offer({ id: 'ten', name: 'Test 10% off', cameBy: 'any' }),
      offer({ id: 'flat', name: 'Test Rs 300 off', cameBy: 'any', type: 'flat', value: 30_000, minOrderCents: 200_000 }),
    ]);
    const orderId = await counterOrder();
    // Rs 2,000 of food: Rs 300 beats 10% (Rs 200).
    expect(liveDiscounts(orderId)).toMatchObject([{ reason: 'Test Rs 300 off', amount_cents: 30_000 }]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 2 });
    // Rs 3,000 of food: 10% = Rs 300, a tie — the one on the order stays.
    expect(liveDiscounts(orderId)).toMatchObject([{ reason: 'Test Rs 300 off', amount_cents: 30_000 }]);
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    // Rs 3,500: 10% = Rs 350 is bigger.
    expect(liveDiscounts(orderId)).toMatchObject([{ reason: 'Test 10% off', amount_cents: 35_000 }]);
    // Twice: the Rs 300 over the 10% (at Rs 2,000 of food), then the 10% over it.
    expect(audits('replaced_by_offer')).toHaveLength(2);
  });

  it('the approval limit does not apply: with every discount needing a manager, the owner’s offer still goes on and stays', async () => {
    await ownerSaves('discounts.approval', { v: 1, percentOver: 0, flatOverCents: 0 });
    await saveOffers([offer({ cameBy: 'any', value: 20 })]);
    const orderId = await counterOrder();
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 40_000 });
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 50_000 });
    expect(audits('auto_clear_needs_approval')).toEqual([]);
  });

  it('with the owner’s switch on (“A discount also comes off the delivery charge”), it comes off every line — frozen so', async () => {
    await ownerSaves('discounts.delivery', { v: 1, alsoOffDeliveryCharge: true });
    await saveOffers([offer({ cameBy: 'any' })]);
    const orderId = await counterOrder();
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 22_000 });
    expect(ruleOf(liveDiscounts(orderId)[0])).toMatchObject({ alsoOffDeliveryCharge: true });
  });
});

describe.skipIf(!Sqlite)('one discount per order', () => {
  it('a cashier’s F3 discount replaces the offer under the normal PIN rule; clearing it brings the offer back; the offer never replaces it', async () => {
    await saveOffers([offer({ cameBy: 'any' })]);
    const orderId = await counterOrder();
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 20_000 }]);
    h.session = CASHIER;
    // Over the limit: the normal rule asks for a manager, and the offer stays.
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 20 })).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer' }]);
    // Within it: no PIN; the offer is replaced, on record.
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 5, reason: 'Staff' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 5, amount_cents: 10_000 }]);
    expect(audits('replaced_offer')).toHaveLength(1);
    // The next cart change never swaps the staff discount for the (bigger) offer.
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 5, amount_cents: 12_500 }]);
    // Removing it lets the offer match again.
    await data('orders:clearDiscount', { orderId });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 25_000 }]);
  });

  it('an F3 discount over the limit, approved with a manager’s PIN, replaces the offer; the next cart change keeps it; clearing it brings the offer back', async () => {
    await saveOffers([offer({ cameBy: 'any' })]);
    const orderId = await counterOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 20, reason: 'Complaint', approverPin: MANAGER_SECRET });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 20, amount_cents: 40_000, approved_by_user_id: 'u_mgr' }]);
    expect(audits('replaced_offer')).toHaveLength(1);
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, value: 20, amount_cents: 50_000 }]);
    await data('orders:clearDiscount', { orderId });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 25_000 }]);
  });

  it('when the approval re-check takes a cashier’s F3 discount off, the offer goes back on in the same step — Pay never charges the full price', async () => {
    // Review 28 Sep (money): the offer step ran before the re-check, saw the F3 row, and nothing asked again.
    await saveOffers([offer({ cameBy: 'any' })]);
    const orderId = await counterOrder();
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 20_000 });
    h.session = CASHIER;
    // Rs 150 flat on Rs 2,000 of food: 7.5%, inside the limit, no PIN; it replaces the offer.
    await data('orders:applyDiscount', { orderId, discountType: 'flat', value: 15_000, reason: 'Staff' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: null, amount_cents: 15_000 }]);
    // The Rs 1,000 pizza comes off: Rs 150 is now 15% of Rs 1,000 of food — over the limit, taken off.
    const pizza = (await snap(orderId)).items.find((i) => i.menuItemName === 'Test Pizza')!;
    await data('orders:removeItem', { orderId, orderItemId: pizza.id });
    expect(audits('auto_clear_needs_approval')).toHaveLength(1);
    // The owner's 10% is back on the Rs 1,000 of food: Rs 100 off; tax 16% of (900 + 200) = Rs 176.
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 10_000 }]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 120_000, discount_cents: 10_000, tax_cents: 17_600, total_cents: 127_600 });
    expect(chainOk()).toBe(true);
  });

  it('the × takes the offer off THIS order (Rs 0, no PIN) and it stays off; "Put it back" brings it back', async () => {
    await saveOffers([offer({ cameBy: 'any' })]);
    const orderId = await counterOrder();
    h.session = CASHIER;
    await data('orders:clearDiscount', { orderId });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0, total_cents: 255_200 });
    const [declined] = liveDiscounts(orderId);
    expect(declined).toMatchObject({ source: 'offer', discount_type: 'flat', value: 0, amount_cents: 0, reason: 'Test WhatsApp 10%' });
    expect(ruleOf(declined)).toMatchObject({ offer: { id: 'test-wa', declined: true } });
    expect(audits('decline_offer')).toHaveLength(1);
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ source: 'offer', amountCents: 0, offer: { declined: true } }]);
    // Nothing off: the bill prints no offer line.
    expect(receiptText(s)).not.toContain('Test WhatsApp');
    await data('orders:clearDiscount', { orderId });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 25_000 }]);
  });
});

describe.skipIf(!Sqlite)('never on a website or foodpanda order', () => {
  it('a foodpanda order gets none; a delivery that becomes foodpanda loses it (and says foodpanda); back again, it is asked afresh', async () => {
    await saveOffers([offer({ cameBy: 'any', orderTypes: ['takeaway', 'delivery'] })]);
    const fp = await counterOrder({ mode: 'foodpanda' });
    expect(liveDiscounts(fp)).toEqual([]);
    expect(orderRow(fp)).toMatchObject({ came_by: 'foodpanda', discount_cents: 0 });

    const orderId = await counterOrder({ cameBy: 'walk_in' });
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer' }]);
    h.session = CASHIER;
    await data('orders:setMode', { orderId, mode: 'foodpanda' });
    expect(liveDiscounts(orderId)).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ came_by: 'foodpanda', discount_cents: 0 });
    expect(audits('remove_offer')).toHaveLength(1);
    await data('orders:setMode', { orderId, mode: 'delivery' });
    expect(orderRow(orderId)).toMatchObject({ came_by: null });
    // "Any way": back on the delivery it goes on again.
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer' }]);
  });

  it('a website order never: it says "website" itself, and Pay refuses an offer row put on one', async () => {
    await saveOffers([offer({ cameBy: 'any', orderTypes: ['takeaway', 'delivery'] })]);
    const r = await repos();
    const actor = { userId: 'u_admin', deviceId: DEV };
    // A website pick-up (no customer needed at Pay).
    const web = r.createOrder(db as never, { mode: 'takeaway', source: 'web' }, actor);
    r.addOrderItem(db as never, { orderId: web.id, menuItemId: menu.pizza, quantity: 2, modifierIds: [] }, actor);
    expect(liveDiscounts(web.id)).toEqual([]);
    expect(orderRow(web.id)).toMatchObject({ came_by: 'website', discount_cents: 0 });
    // A row a bug (or an older till) put on it: Pay says no.
    db.prepare(
      `INSERT INTO order_discounts (id, order_id, discount_type, value, reason, applied_by_user_id, amount_cents, source, rule_json, created_at, updated_at, device_id, version)
       VALUES ('d_bad', ?, 'percent', 10, 'Test', 'u_admin', 20000, 'offer', '{}', ?, ?, ?, 1)`,
    ).run(web.id, T0, T0, DEV);
    expect(() =>
      r.tenderOrder(db as never, { orderId: web.id, payments: [{ method: 'cash', amountCents: Number(orderRow(web.id)!['total_cents']) }] }, { userId: 'u_cash', deviceId: DEV }),
    ).toThrow(/offers are for counter orders only/);
  });
});

describe.skipIf(!Sqlite)('when the order was started: Pakistan time, the trading day from 05:00', () => {
  it('a Friday offer: an order started at 04:59 on Saturday is Friday’s; one at 05:00 is Saturday’s', async () => {
    await saveOffers([offer({ cameBy: 'any', days: [4] })]);
    const late = await counterOrder({ startedAt: '2026-10-02T23:59:00.000Z' }); // Sat 3 Oct, 04:59 PKT
    expect(orderRow(late)).toMatchObject({ discount_cents: 20_000 });
    const sat = await counterOrder({ startedAt: '2026-10-03T00:00:00.000Z' }); // Sat 3 Oct, 05:00 PKT
    expect(orderRow(sat)).toMatchObject({ discount_cents: 0 });
  });

  it('its hours (12:00 to 15:59) and its dates', async () => {
    await saveOffers([offer({ cameBy: 'any', hours: { fromHour: 12, toHour: 15 }, startsOn: '2026-10-02', endsOn: '2026-10-02' })]);
    expect(orderRow(await counterOrder({ startedAt: '2026-10-02T10:59:00.000Z' }))).toMatchObject({ discount_cents: 20_000 }); // 15:59
    expect(orderRow(await counterOrder({ startedAt: '2026-10-02T11:00:00.000Z' }))).toMatchObject({ discount_cents: 0 }); // 16:00
    expect(orderRow(await counterOrder({ startedAt: '2026-10-01T09:00:00.000Z' }))).toMatchObject({ discount_cents: 0 }); // the day before
  });
});

describe.skipIf(!Sqlite)('abuse controls', () => {
  it('Phone and WhatsApp offers need the customer’s phone: taken off with it', async () => {
    await saveOffers([offer({ cameBy: ['phone', 'whatsapp'] })]);
    const orderId = await counterOrder({ cameBy: 'phone', phone: PHONE_A });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 20_000 });
    h.session = CASHIER;
    await data('orders:detachCustomer', { orderId });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
    expect(liveDiscounts(orderId)).toEqual([]);
  });

  it('“the customer’s phone” is a phone: a customer saved as "1" gets no Phone / WhatsApp or once-a-day offer', async () => {
    // Review 28 Sep (money): any text counted, so a made-up number claimed the offer on a cash walk-in.
    await saveOffers([
      offer({ orderTypes: ['takeaway', 'delivery'] }),
      offer({ id: 'once', name: 'Test once a day', cameBy: 'any', orderTypes: ['takeaway'], value: 5, oncePerCustomerPerDay: true }),
    ]);
    const orderId = await counterOrder({ mode: 'takeaway', cameBy: 'whatsapp', phone: '1' });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
    expect(liveDiscounts(orderId)).toEqual([]);
    // A real number, however it is written, does.
    const real = await counterOrder({ mode: 'takeaway', cameBy: 'whatsapp', phone: '+92 300 123 4567' });
    expect(orderRow(real)).toMatchObject({ discount_cents: 20_000 });
  });

  it('once per customer per day, the link back up with both orders on screen: the one started first keeps it, only the later one loses it', async () => {
    // Review 28 Sep (history): each till saw the other's open order and both took it off.
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const first = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T09:00:00.000Z' });
    const later = await counterOrder({ phone: PHONE_B, startedAt: '2026-10-02T09:05:00.000Z' });
    expect([orderRow(first), orderRow(later)]).toMatchObject([{ discount_cents: 20_000 }, { discount_cents: 20_000 }]);
    // As if each till had given it to the same phone while the link was down.
    db.prepare(`UPDATE orders SET customer_phone_snapshot = (SELECT customer_phone_snapshot FROM orders WHERE id = ?) WHERE id = ?`).run(first, later);
    h.session = CASHIER;
    await data('orders:addItem', { orderId: first, menuItemId: menu.side, quantity: 1 });
    await data('orders:addItem', { orderId: later, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(first)).toMatchObject({ discount_cents: 25_000 });
    expect(orderRow(later)).toMatchObject({ discount_cents: 0 });
    // One already paid always counts, even against an order started before it.
    const early = await counterOrder({ startedAt: '2026-10-03T09:00:00.000Z' });
    const paid = await counterOrder({ phone: PHONE_B, startedAt: '2026-10-03T09:05:00.000Z' });
    await pay(paid);
    await savePhone(early, PHONE_B);
    expect(orderRow(early)).toMatchObject({ discount_cents: 0 });
  });

  it('once per customer per day: that phone’s second order today gets none; another phone does; the next trading day it does again', async () => {
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const day = '2026-10-02T09:00:00.000Z';
    const first = await counterOrder({ phone: PHONE_A, startedAt: day });
    expect(orderRow(first)).toMatchObject({ discount_cents: 20_000 });
    await pay(first);
    const second = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-02T15:00:00.000Z' });
    expect(orderRow(second)).toMatchObject({ discount_cents: 0 });
    const other = await counterOrder({ phone: PHONE_B, startedAt: '2026-10-02T15:00:00.000Z' });
    expect(orderRow(other)).toMatchObject({ discount_cents: 20_000 });
    // 05:00 PKT on the 3rd: a new trading day.
    const tomorrow = await counterOrder({ phone: PHONE_A, startedAt: '2026-10-03T00:00:00.000Z' });
    expect(orderRow(tomorrow)).toMatchObject({ discount_cents: 20_000 });
    // With no phone it can't be checked, so it isn't given.
    expect(orderRow(await counterOrder({ startedAt: day }))).toMatchObject({ discount_cents: 0 });
  });

  it('how the order came in locks at send: a change then needs a manager’s PIN, is audited, and the bill does not move', async () => {
    await saveOffers([offer()]);
    const orderId = await counterOrder({ cameBy: 'whatsapp', phone: PHONE_A });
    h.session = CASHIER;
    // While it is rung up the cashier changes it freely — and the offer follows.
    await data('orders:setCameBy', { orderId, cameBy: 'walk_in' });
    expect(orderRow(orderId)).toMatchObject({ came_by: 'walk_in', discount_cents: 0 });
    await data('orders:setCameBy', { orderId, cameBy: 'whatsapp' });
    expect(orderRow(orderId)).toMatchObject({ came_by: 'whatsapp', discount_cents: 20_000 });
    expect(audits('set_came_by')).toHaveLength(2);

    await data('orders:sendToKitchen', { orderId });
    expect(await call('orders:setCameBy', { orderId, cameBy: 'walk_in' })).toMatchObject({ ok: false, code: 'precondition_failed', message: expect.stringMatching(/locked/) });
    expect(await call('orders:setCameBy', { orderId, cameBy: 'walk_in', approverPin: 'wrong-pin' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(orderRow(orderId)).toMatchObject({ came_by: 'whatsapp' });
    await data('orders:setCameBy', { orderId, cameBy: 'walk_in', approverPin: MANAGER_SECRET });
    expect(orderRow(orderId)).toMatchObject({ came_by: 'walk_in', discount_cents: 20_000 });
    const [changed] = audits('change_came_by');
    expect(changed).toMatchObject({ actor_user_id: 'u_cash' });
    expect(JSON.parse(String(changed?.['before_json']))).toMatchObject({ cameBy: 'whatsapp' });
    expect(JSON.parse(String(changed?.['after_json']))).toMatchObject({ cameBy: 'walk_in', approverUserId: 'u_mgr' });
    // A website or foodpanda order says it itself.
    const fp = await counterOrder({ mode: 'foodpanda' });
    h.session = CASHIER;
    expect(await call('orders:setCameBy', { orderId: fp, cameBy: 'phone' })).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(chainOk()).toBe(true);
  });
});

describe.skipIf(!Sqlite)('history never moves', () => {
  it('a Save while an order is open (5%, then off) keeps its frozen 10%; a new order follows the Save; a paid order never moves', async () => {
    await saveOffers([offer({ cameBy: 'any' })]);
    const open = await counterOrder();
    const paid = await counterOrder({ phone: PHONE_A });
    await pay(paid);
    const paidBefore = { row: orderRow(paid), receipt: receiptText(await snap(paid)), fbr: fbrLines(await snap(paid)) };

    await saveOffers([offer({ cameBy: 'any', value: 5 })]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId: open, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(open)).toMatchObject({ discount_cents: 25_000 }); // 10% of Rs 2,500
    expect(orderRow(await counterOrder())).toMatchObject({ discount_cents: 10_000 }); // a new one: 5%

    await saveOffers([offer({ cameBy: 'any', on: false })]);
    await ownerSaves('discounts.delivery', { v: 1, alsoOffDeliveryCharge: true });
    await data('orders:addItem', { orderId: open, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(open)).toMatchObject({ discount_cents: 30_000 }); // still 10%, on the food
    expect(orderRow(await counterOrder())).toMatchObject({ discount_cents: 0 }); // switched off: none
    expect({ row: orderRow(paid), receipt: receiptText(await snap(paid)), fbr: fbrLines(await snap(paid)) }).toEqual(paidBefore);
  });

  it('a Save adding a BIGGER offer does not move an order already on screen either; a new order gets the bigger one', async () => {
    // Review 28 Sep (history): the new 15% replaced the frozen 10% at the next cart change.
    await saveOffers([offer({ cameBy: 'any' })]);
    const open = await counterOrder();
    expect(liveDiscounts(open)).toMatchObject([{ reason: 'Test WhatsApp 10%', amount_cents: 20_000 }]);
    await saveOffers([offer({ cameBy: 'any' }), offer({ id: 'test-15', name: 'Test 15%', cameBy: 'any', value: 15 })]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId: open, menuItemId: menu.side, quantity: 1 });
    expect(liveDiscounts(open)).toMatchObject([{ reason: 'Test WhatsApp 10%', amount_cents: 25_000 }]);
    expect(liveDiscounts(await counterOrder())).toMatchObject([{ reason: 'Test 15%', amount_cents: 30_000 }]);
  });
});

describe.skipIf(!Sqlite)('Reports', () => {
  it('Channels splits the orders by how they came in, even with no offers; Standing offers lists each offer; Team & leakage flags over 1.5 × the shop', async () => {
    await saveOffers([offer({ cameBy: ['whatsapp'], orderTypes: ['takeaway', 'delivery'] })]);
    const r = await repos();
    // Cashier one: 20 WhatsApp deliveries, each with the offer. Cashier two: 20 walk-in takeaways.
    for (let i = 0; i < 20; i += 1) {
      const a = await counterOrder({ cameBy: 'whatsapp', phone: PHONE_A });
      await pay(a);
      const b = await counterOrder({ mode: 'takeaway', cameBy: 'walk_in', who: CASHIER_2 });
      await pay(b, CASHIER_2);
    }
    // One takeaway nobody asked about, and a foodpanda order from before 0044 (no came_by kept).
    await pay(await counterOrder({ mode: 'takeaway', who: CASHIER_2 }), CASHIER_2);
    const fp = await counterOrder({ mode: 'foodpanda' });
    db.prepare(`UPDATE orders SET came_by = NULL WHERE id = ?`).run(fp);
    h.session = CASHIER;
    await data('orders:tender', { orderId: fp, payments: [{ method: 'foodpanda', amountCents: Number(orderRow(fp)!['total_cents']) }] });
    void r;

    const { buildChannelsTab, buildTeamTab } = await import('../../services/business-report.js');
    const req = NOW_RANGE();
    const channels = buildChannelsTab(db as never, req);
    const byWay = Object.fromEntries((channels.cameBy ?? []).map((l) => [l.cameBy, { orders: l.orderCount, offers: l.offerCount, offerCents: l.offerCents }]));
    expect(byWay).toEqual({
      whatsapp: { orders: 20, offers: 20, offerCents: 20 * 20_000 },
      walk_in: { orders: 20, offers: 0, offerCents: 0 },
      not_asked: { orders: 1, offers: 0, offerCents: 0 },
      foodpanda: { orders: 1, offers: 0, offerCents: 0 },
    });
    // Every way adds up to the orders.
    expect((channels.cameBy ?? []).reduce((n, l) => n + l.orderCount, 0)).toBe(channels.kpis.orderCount);

    const team = buildTeamTab(db as never, req);
    // Standing offers: the offer by its name, never under the cashier.
    expect(team.discounts.standing).toEqual([{ name: 'Test WhatsApp 10% (automatic offer)', count: 20, amountCents: 400_000 }]);
    expect(team.discounts.byPerson).toEqual([]);
    const one = team.staff.find((s) => s.key === 'u_cash')!;
    const two = team.staff.find((s) => s.key === 'u_cash2')!;
    expect(one).toMatchObject({ counterOrders: 20, phoneOrWhatsapp: 20, offerCount: 20, offerCents: 400_000, discountCents: 0, flags: ['phone_share', 'offer_rupees'] });
    // The takeaway nobody asked about is not in the check.
    expect(two).toMatchObject({ counterOrders: 20, phoneOrWhatsapp: 0, offerCents: 0 });
    expect(two.flags).toBeUndefined();
    // The shop's rates the flags are against: 20 of the 40 asked counter orders marked WhatsApp.
    expect(team.offerCheck).toMatchObject({ counterOrders: 40, phoneOrWhatsapp: 20, offerOrders: 20, phoneShareBps: 5_000, factorPct: 150, minMarked: 2 });
    expect(team.offerRepeats).toEqual([]);
  });

  it('beside the owner’s reason buttons (v0.7.27): the counter gets both, and Team & leakage lists the cancel by its button’s words and the offer under Standing offers', async () => {
    await saveOffers([offer({ id: 'test-walkin', name: 'Test walk-in 10%', cameBy: ['walk_in'], orderTypes: ['takeaway'] })]);
    const reasons = {
      v: 1,
      cancel: [{ id: 'customer_cancelled', label: 'Test changed mind', food: 'ask' }],
      refund: [{ id: 'customer_unhappy', label: 'Test unhappy', food: 'ask' }],
      cashOut: ['Test gas'],
    };
    await ownerSaves('orders.reasons', reasons);
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      const rules = await data<CheckoutRules>('checkout:getRules');
      expect(rules.reasons).toEqual({ cancel: reasons.cancel, refund: reasons.refund, cashOut: reasons.cashOut });
      expect(rules.offers?.offers.map((o) => o.name)).toEqual(['Test walk-in 10%']);
    }
    // One walk-in takeaway paid with the offer on (Rs 200 off Rs 2,000 of food)…
    const paid = await counterOrder({ mode: 'takeaway', cameBy: 'walk_in' });
    expect(liveDiscounts(paid)).toMatchObject([{ source: 'offer', reason: 'Test walk-in 10%', amount_cents: 20_000 }]);
    await pay(paid);
    // …and one sent to the kitchen, then cancelled with the owner's renamed button.
    const cancelled = await counterOrder({ mode: 'takeaway', cameBy: 'walk_in' });
    await data('orders:sendToKitchen', { orderId: cancelled });
    await data('orders:void', { orderId: cancelled, reason: 'Test changed mind', approverPin: MANAGER_SECRET, foodMade: 'not_made' });

    const { buildTeamTab } = await import('../../services/business-report.js');
    const team = buildTeamTab(db as never, NOW_RANGE());
    expect(team.voids.map((v) => [v.orderId, v.reason])).toEqual([[cancelled, 'Test changed mind']]);
    expect(team.discounts.standing).toEqual([{ name: 'Test walk-in 10% (automatic offer)', count: 1, amountCents: 20_000 }]);
    expect(team.discounts.byPerson).toEqual([]);
    expect(team.staff.find((s) => s.key === 'u_cash')).toMatchObject({ offerCount: 1, offerCents: 20_000, discountCents: 0 });
  });

  it('Team & leakage compares on the orders whose way in was tapped: orders nobody was asked about never dilute the shop and flag an honest cashier', async () => {
    // Review 28 Sep (history + screens): orders nobody was asked about diluted the shop's rate.
    await saveOffers([offer({ cameBy: ['whatsapp'], orderTypes: ['takeaway', 'delivery'] })]);
    const ring = async (n: number, opts: Parameters<typeof counterOrder>[0], who: AuthenticatedUser) => {
      for (let i = 0; i < n; i += 1) await pay(await counterOrder({ ...opts, who }), who);
    };
    // Cashier one: 4 WhatsApp (with the offer) and 6 walk-ins. Cashier two: 3 WhatsApp, 7 walk-ins, and 10 nobody asked about.
    await ring(4, { mode: 'takeaway', cameBy: 'whatsapp', phone: PHONE_A }, CASHIER);
    await ring(6, { mode: 'takeaway', cameBy: 'walk_in' }, CASHIER);
    await ring(3, { mode: 'takeaway', cameBy: 'whatsapp', phone: PHONE_B }, CASHIER_2);
    await ring(7, { mode: 'takeaway', cameBy: 'walk_in' }, CASHIER_2);
    await ring(10, { mode: 'takeaway' }, CASHIER_2);
    const { buildTeamTab } = await import('../../services/business-report.js');
    const team = buildTeamTab(db as never, NOW_RANGE());
    // The shop: 7 of 20 asked (35%). Cashier one's 40% is under 1.5 × (52.5%): no flag.
    expect(team.offerCheck).toMatchObject({ counterOrders: 20, phoneOrWhatsapp: 7, phoneShareBps: 3_500 });
    expect(team.staff.find((s) => s.key === 'u_cash')).toMatchObject({ counterOrders: 10, phoneOrWhatsapp: 4, offerCount: 4 });
    expect(team.staff.find((s) => s.key === 'u_cash')?.flags).toBeUndefined();
    expect(team.staff.find((s) => s.key === 'u_cash2')).toMatchObject({ orderCount: 20, counterOrders: 10, phoneOrWhatsapp: 3 });
  });

  it('Standing offers keep a renamed offer’s older orders under the name their bills printed', async () => {
    // Review 28 Sep (history): grouped by id only, and named after the newest row.
    await saveOffers([offer({ cameBy: 'any' })]);
    await pay(await counterOrder({ phone: PHONE_A }));
    await saveOffers([offer({ cameBy: 'any', name: 'Test renamed 10%' })]);
    await pay(await counterOrder({ phone: PHONE_A }));
    const { buildTeamTab } = await import('../../services/business-report.js');
    const standing = buildTeamTab(db as never, NOW_RANGE()).discounts.standing ?? [];
    expect([...standing].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Test renamed 10% (automatic offer)', count: 1, amountCents: 20_000 },
      { name: 'Test WhatsApp 10% (automatic offer)', count: 1, amountCents: 20_000 },
    ]);
  });

  it('a once-a-day offer one phone got twice on one day (the link between the tills was down) is listed, by the phone’s last four digits', async () => {
    // The owner's design: "with the link down it can repeat once on the other till, which Reports show".
    await saveOffers([offer({ cameBy: 'any', oncePerCustomerPerDay: true })]);
    const day = new Date().toISOString().slice(0, 10);
    const first = await counterOrder({ phone: PHONE_A, startedAt: `${day}T00:10:00.000Z` });
    const second = await counterOrder({ phone: PHONE_B, startedAt: `${day}T00:20:00.000Z` });
    await pay(first);
    await pay(second);
    // As the other till's order arrived once the link was back: the same phone, the same day.
    db.prepare(`UPDATE orders SET customer_phone_snapshot = (SELECT customer_phone_snapshot FROM orders WHERE id = ?) WHERE id = ?`).run(first, second);
    const numbers = [first, second].map((id) => String(db.prepare(`SELECT order_number FROM orders WHERE id = ?`).get(id)?.['order_number']));
    const { buildTeamTab } = await import('../../services/business-report.js');
    const team = buildTeamTab(db as never, { sinceIso: `${day}T00:00:00.000Z`, untilIso: new Date(Date.now() + 3_600_000).toISOString() });
    expect(team.offerRepeats).toEqual([{ day, offerName: 'Test WhatsApp 10%', phoneEnds: '4567', orderNumbers: numbers, amountCents: 40_000 }]);
  });
});

describe.skipIf(!Sqlite)('only the owner sets the offers', () => {
  it('a cashier and a manager are refused it (set, put back, read) and nothing is written; the counter reads the offers that run today, never who saved them', async () => {
    const counts = () => ['audit_log', 'sync_queue', 'business_settings'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
    const before = counts();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const payload of [
        { key: 'discounts.offers', value: { v: 1, askCameBy: true, offers: [offer()] } },
        { key: 'discounts.offers', useDefault: true },
      ]) {
        expect({ who: who.role, o: await call('settings:setBusiness', payload) }).toMatchObject({ who: who.role, o: { ok: false, code: 'forbidden' } });
      }
      expect(await call('settings:getBusiness', { key: 'discounts.offers' })).toMatchObject({ ok: false, code: 'forbidden' });
    }
    expect(counts()).toEqual(before);

    await saveOffers([offer(), offer({ id: 'old', name: 'Test ended', endsOn: '2026-01-31' })], true);
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.offers).toEqual({ askCameBy: true, offers: [offer()] });
    expect(JSON.stringify(rules)).not.toMatch(/commission|payout|updatedBy|savedBy/i);
    h.session = OWNER;
    expect(await data('settings:getBusiness', { key: 'discounts.offers' })).toMatchObject({ isDefault: false, value: { askCameBy: true } });
  });

  it('the counter keeps its answer across the day change, so an offer that starts tomorrow is already in it (the screen checks each order’s start); off and ended ones are not', async () => {
    // Review 28 Sep (screens): read the evening before, an offer starting the next day was missing on that day.
    const tomorrow = offer({ id: 'sat', name: 'Test from tomorrow', startsOn: '2026-10-03' });
    await saveOffers([tomorrow, offer({ id: 'off', name: 'Test off', on: false }), offer({ id: 'ended', name: 'Test ended', endsOn: '2026-10-01' })]);
    const { checkoutRules } = await import('../../services/shop-settings.js');
    // Friday 2 October, 22:00 Pakistan time.
    expect(checkoutRules(db as never, new Date('2026-10-02T17:00:00.000Z')).offers).toEqual({ askCameBy: false, offers: [tomorrow] });
  });

  it('saved by a newer version of the app (a field inside an offer this version does not know): never put on here, read-only, never saved over', async () => {
    await saveOffers([offer({ cameBy: 'any' })]);
    // An order already carrying the offer keeps its frozen terms.
    const open = await counterOrder();
    expect(orderRow(open)).toMatchObject({ discount_cents: 20_000 });
    db.prepare(`UPDATE business_settings SET value_json = ?, version = version + 1 WHERE key = 'discounts.offers'`).run(
      JSON.stringify({ v: 1, askCameBy: false, offers: [{ ...offer({ cameBy: 'any' }), items: ['test-item'] }] }),
    );
    h.session = OWNER;
    expect(await data('settings:getBusiness', { key: 'discounts.offers' })).toMatchObject({ readOnly: true });
    // Review 28 Sep (history): automatic money fails closed. "Rs 200 off these items only", read here
    // without its items, would come off every order — so none of those offers goes on here…
    expect(orderRow(await counterOrder())).toMatchObject({ discount_cents: 0 });
    // …the counter is not promised any…
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).offers).toEqual({ askCameBy: false, offers: [] });
    // …and the order that had one keeps it.
    await data('orders:addItem', { orderId: open, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(open)).toMatchObject({ discount_cents: 25_000 });
    h.session = OWNER;
    expect(await call('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy: false, offers: [] } })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/newer version/),
    });
  });

  it('the owner’s bounds are checked in the main process: at most 10, 1–50%, Rs 1–5,000, names unique, a day and an order type', async () => {
    h.session = OWNER;
    const refused = async (offers: ChannelOffer[]) => call('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy: false, offers } });
    expect(await refused(Array.from({ length: 11 }, (_, i) => offer({ id: `o${i}`, name: `Test ${i}` })))).toMatchObject({ ok: false, code: 'validation_failed', message: 'At most 10 offers' });
    expect(await refused([offer({ value: 60 })])).toMatchObject({ ok: false, message: expect.stringMatching(/1 to 50/) });
    expect(await refused([offer({ type: 'flat', value: 600_000 })])).toMatchObject({ ok: false, message: expect.stringMatching(/Rs 5,000/) });
    expect(await refused([offer(), offer({ id: 'twin' })])).toMatchObject({ ok: false, message: expect.stringMatching(/same name/) });
    expect(await refused([offer({ days: [] })])).toMatchObject({ ok: false, message: 'Pick at least one day' });
    expect(await refused([offer({ orderTypes: [] })])).toMatchObject({ ok: false, message: 'Pick takeaway, delivery or both' });
    expect(await refused([offer({ startsOn: '2026-10-05', endsOn: '2026-10-04' })])).toMatchObject({ ok: false, message: expect.stringMatching(/end before it starts/) });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM business_settings`).get()?.['n']).toBe(0);
  });
});

/**
 * Settings step 3 beside the offers (merge of v0.7.28 into step 3): the
 * owner's AUTOMATIC delivery charge (orders:setDeliveryArea, owner 28 Sep
 * 2026: "if delivery area selected the delivery fee should be automatically
 * added") and his automatic offers ("…applies on the whole order except
 * delivery fee"). Putting the charge on, swapping it or taking it off is a
 * cart change: the offer is worked out again, on the food, its minimum on
 * the food. Made-up figures (areas at today's Rs 200 / Rs 250).
 */
describe.skipIf(!Sqlite)('the automatic delivery charge and the offers', () => {
  /** A delivery rung up with no charge on it: a Rs 1,000 pizza and two Rs 500 sides (Rs 2,000 of food). */
  async function deliveryWithoutCharge(cameBy: string | null = 'whatsapp'): Promise<string> {
    h.session = CASHIER;
    const order = await data<{ id: string }>('orders:create', { mode: 'delivery', ...(cameBy ? { cameBy } : {}) });
    await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
    await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
    return order.id;
  }
  async function pickArea(orderId: string, area: string | null): Promise<OrderSnapshot> {
    h.session = CASHIER;
    return data<OrderSnapshot>('orders:setDeliveryArea', { orderId, area });
  }
  const chargeLines = (s: OrderSnapshot) =>
    s.items.filter((i) => i.menuItemName.startsWith('Delivery Charge')).map((i) => [i.menuItemName, i.unitPriceCents, i.quantity]);
  async function addRs250Charge(): Promise<void> {
    const d = db as never;
    const mgr = { userId: 'u_mgr', deviceId: DEV };
    const fees = db.prepare(`SELECT id FROM categories WHERE name = 'Delivery Charges'`).get()?.['id'];
    const tax = db.prepare(`SELECT id FROM tax_categories LIMIT 1`).get()?.['id'];
    const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
    createMenuItem(d, { categoryId: String(fees), name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000, taxCategoryId: String(tax) }, mgr);
  }

  it('picking the area puts the charge on and the offer stays on the food; a swap and a clear never move the offer', async () => {
    await addRs250Charge();
    await saveOffers([offer()]);
    const orderId = await deliveryWithoutCharge();
    await savePhone(orderId, PHONE_A);
    // 10% of the Rs 2,000 of food, before any charge.
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 200_000, discount_cents: 20_000, tax_cents: 28_800, total_cents: 208_800 });

    // DHA Phase 6: Rs 200 on by itself, paid in full (tax 16% of 900 + 900 + 200).
    expect(chargeLines(await pickArea(orderId, 'DHA Phase 6'))).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 20_000, tax_cents: 32_000, total_cents: 232_000 });

    // DHA Phase 8: swapped for Rs 250; still Rs 200 off (the food did not change).
    expect(chargeLines(await pickArea(orderId, 'DHA Phase 8'))).toEqual([['Delivery Charge (Rs 250)', 25_000, 1]]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 225_000, discount_cents: 20_000, tax_cents: 32_800, total_cents: 237_800 });

    // Cleared: the charge comes off, the offer stays.
    expect(chargeLines(await pickArea(orderId, null))).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 200_000, discount_cents: 20_000, tax_cents: 28_800, total_cents: 208_800 });

    // One offer row the whole time, frozen food-only; the charge never took a share of it.
    const rows = liveDiscounts(orderId);
    expect(rows).toHaveLength(1);
    expect(ruleOf(rows[0])).toMatchObject({ alsoOffDeliveryCharge: false });
    expect(audits('apply_offer')).toHaveLength(1);
    await pickArea(orderId, 'DHA Phase 6');
    await pay(orderId);
    const s = await snap(orderId);
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toMatchObject({ net: 200, tax: 32, discount: 0 });
    expect(chainOk()).toBe(true);
  });

  it('the charge going on re-works the offer with the minimum on the FOOD: Rs 2,000 of food + a Rs 200 charge does not reach a Rs 2,100 minimum; more food does', async () => {
    await saveOffers([offer({ id: 'test-min', name: 'Test min 10%', cameBy: 'any', minOrderCents: 210_000 })]);
    const orderId = await deliveryWithoutCharge(null);
    await pickArea(orderId, 'DHA Phase 6');
    // Rs 2,200 on the bill, only Rs 2,000 of it food: no offer.
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 0 });
    expect(liveDiscounts(orderId)).toEqual([]);

    // Another side: Rs 2,500 of food — 10% of the food, the charge still paid in full.
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 25_000 });
    // Clearing the area (the charge off) leaves the food, so the offer stays at 10% of it.
    await pickArea(orderId, null);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 250_000, discount_cents: 25_000 });
    // Back on: the same Rs 250 off, never 10% of Rs 2,700.
    await pickArea(orderId, 'DHA Phase 6');
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 25_000 });
  });

  it('a delivery-only offer and the charge both leave with Delivery (takeaway), and both come back with it', async () => {
    await saveOffers([offer({ id: 'test-del', name: 'Test delivery 10%', cameBy: 'any' })]);
    const orderId = await deliveryWithoutCharge(null);
    await pickArea(orderId, 'DHA Phase 6');
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 20_000 });

    h.session = CASHIER;
    await data('orders:setMode', { orderId, mode: 'takeaway' });
    expect(chargeLines(await snap(orderId))).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 200_000, discount_cents: 0 });

    await data('orders:setMode', { orderId, mode: 'delivery' });
    // The panel asks again for the area on the way back (the type changed).
    await pickArea(orderId, 'DHA Phase 6');
    expect(chargeLines(await snap(orderId))).toEqual([['Delivery Charge (Rs 200)', 20_000, 1]]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 20_000, tax_cents: 32_000, total_cents: 232_000 });
  });
});
