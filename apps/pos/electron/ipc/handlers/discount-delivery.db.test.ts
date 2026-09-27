/**
 * The owner, 28 Sep 2026: "Delivery charges is separate we don't want to add
 * discount to it". Through the real IPC handlers, repositories, FBR mapper,
 * receipt renderer and Reports readers, on a real SQLite database built from
 * every migration:
 *   - a delivery order with a Rs 200 delivery charge at 10%, 100% and a
 *     rupee amount bigger than the food: the stored totals, the tax, the FBR
 *     sale invoice and debit note line by line, profit's split and the
 *     receipt's words — the delivery charge takes none of the discount;
 *   - the approval limit is checked on the same food-only amount, in all
 *     three places (the F3 screen's preview, the IPC check, the repository);
 *   - the rule is FROZEN on the discount row: a legacy row (no rule) and a
 *     paid order never move, whatever the switch says after; turning the
 *     switch on restores the old maths for new discounts only;
 *   - a web order keeps the website's own rule (never the till's switch);
 *   - the foodpanda deal works on the food: its % and its minimum.
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
import type { AuthenticatedUser, CheckoutRules, OrderSnapshot, UUID, WebOrder } from '@cheeseoclock/shared-types';
import { mapOrderToFbrPayload, mapRefundToFbrDebitNote, type FbrSellerInfo } from '@cheeseoclock/fbr-core';
import { escPosToText, renderReceipt } from '@cheeseoclock/printer-core';

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
/** The app's root (src/ is the screens, electron/ the main process). */
const APP = join(HERE, '..', '..', '..');

/** The F3 screen's own preview (src/features/checkout/discountPresets.ts), loaded by path as the screen loads it. */
type PreviewDiscount = (
  lines: ReadonlyArray<{ lineTotalCents: number; taxRateBps?: number; menuItemName?: string }>,
  subtotalCents: number,
  choice: { type: 'percent' | 'flat'; value: number } | null,
  rules?: { approval: { percentOver: number; flatOverCents: number }; alsoOffDeliveryCharge: boolean },
) => { needsApproval: boolean; discountCents: number; taxCents: number; totalCents: number };
async function screenPreview(): Promise<PreviewDiscount> {
  const url = pathToFileURL(join(APP, 'src', 'features', 'checkout', 'discountPresets.ts')).href;
  return ((await import(/* @vite-ignore */ url)) as { previewDiscount: PreviewDiscount }).previewDiscount;
}

/** The website's own pricing (apps/web lib/pricing priceOrder), loaded by path: what the customer was shown. */
type PriceOrder = (lines: Array<{ lineTotalCents: number; taxRateBps: number }>, pct?: number) => { discountCents: number; taxCents: number; totalCents: number };
async function websitePricing(): Promise<PriceOrder> {
  const url = pathToFileURL(join(APP, '..', 'web', 'src', 'lib', 'pricing.ts')).href;
  return ((await import(/* @vite-ignore */ url)) as { priceOrder: PriceOrder }).priceOrder;
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
const SELLER: FbrSellerInfo = { sellerNTNCNIC: '0000000', sellerBusinessName: 'Test Shop', sellerProvince: 'Sindh', sellerAddress: 'Test Road' };
const BRANDING = { storeName: 'Test Shop' };

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

/** The owner's switch: "A discount also comes off the delivery charge" (Settings → Money & discounts). */
async function setSwitch(alsoOffDeliveryCharge: boolean): Promise<void> {
  const before = h.session;
  h.session = OWNER;
  try {
    const o = await call('settings:setBusiness', { key: 'discounts.delivery', value: { v: 1, alsoOffDeliveryCharge } });
    expect(o.ok).toBe(true);
  } finally {
    h.session = before;
  }
}

/**
 * A delivery order rung up by the cashier: a Rs 1,000 pizza and two Rs 500
 * sides (Rs 2,000 of food) and the area's Rs 200 delivery charge, all at 16%.
 */
async function deliveryOrder(mode: 'delivery' | 'foodpanda' = 'delivery'): Promise<string> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.pizza, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.charge, quantity: 1 });
  await data('orders:addItem', { orderId: order.id, menuItemId: menu.side, quantity: 2 });
  if (mode === 'delivery') {
    const r = await repos();
    const c = r.createCustomer(db as never, { name: 'Test Customer', phone: '03001234567' }, CASHIER_ACTOR);
    const a = r.createAddress(db as never, { customerId: c.id, label: 'Home', addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER_ACTOR);
    r.snapshotCustomerOntoOrder(db as never, { orderId: order.id, customerId: c.id, addressId: a.id }, CASHIER_ACTOR);
  }
  return order.id;
}

const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, tax_cents, total_cents, status FROM orders WHERE id = ?`).get(orderId);
const liveDiscounts = (orderId: string) =>
  db.prepare(`SELECT source, value, amount_cents, rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`).all(orderId);
async function snap(orderId: string): Promise<OrderSnapshot> {
  return (await repos()).getOrderSnapshot(db as never, orderId)!;
}
async function pay(orderId: string): Promise<void> {
  const o = orderRow(orderId)!;
  h.session = CASHIER;
  await data('orders:tender', {
    orderId,
    payments: [{ method: 'cash', amountCents: Number(o['total_cents']), tenderedCents: Number(o['total_cents']) }],
  });
}
/** The FBR sale invoice's lines, by name: what each is before tax, its tax, and its discount (rupees). */
const fbrLines = (s: OrderSnapshot) =>
  Object.fromEntries(
    mapOrderToFbrPayload(s, SELLER).items.map((i) => [i.productDescription, { net: i.valueSalesExcludingST, tax: i.salesTaxApplicable, discount: i.discount ?? 0 }]),
  );
const receiptText = (s: OrderSnapshot) => escPosToText(renderReceipt(s, { branding: BRANDING }));
const NOW_RANGE = () => ({ sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });
/** Reports → Food cost's food and fee sales, and the Profit tab's sales of the delivery charge. */
async function reportsSay(): Promise<{ food: number; fee: number; chargeSales: number }> {
  const { getFoodCost } = await import('../../services/business-report.js');
  const { readSales } = await import('../../services/analytics/profit.js');
  const f = getFoodCost(db as never, NOW_RANGE());
  const pass = readSales(db as never, NOW_RANGE(), { estimates: false });
  return { food: f.foodSalesCents, fee: f.feeSalesCents, chargeSales: pass.items.get(menu.charge)?.salesCents ?? 0 };
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
});

describe.skipIf(!Sqlite)('a discount leaves the delivery charge alone (the default)', () => {
  it('10% off: worked on the Rs 2,000 of food; the Rs 200 charge is taxed and paid in full — stored, frozen, on the FBR invoice, in profit and on the receipt', async () => {
    const orderId = await deliveryOrder();
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 0 });
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10 });

    // 10% of the food = Rs 200; tax 16% of (900 + 900 + 200) = Rs 320; total Rs 2,320.
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 20_000, tax_cents: 32_000, total_cents: 232_000 });
    // The rule is frozen on the row (source stays NULL: a staff discount).
    const [row] = liveDiscounts(orderId);
    expect(row).toMatchObject({ source: null, value: 10, amount_cents: 20_000 });
    expect(JSON.parse(String(row?.['rule_json']))).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' });
    // …audited and synced with it.
    const audit = db.prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'order_discounts' AND action = 'create' ORDER BY rowid DESC LIMIT 1`).get();
    expect(JSON.parse(String(audit?.['after_json']))).toMatchObject({ rule: { alsoOffDeliveryCharge: false } });
    const synced = db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'order_discounts' ORDER BY rowid DESC LIMIT 1`).get();
    expect(String(synced?.['payload_json'])).toContain('discount_base');

    await pay(orderId);
    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: false }]);
    // The FBR sale invoice: the delivery charge carries no discount; per-line tax adds up to the stored tax.
    expect(fbrLines(s)).toEqual({
      'Test Pizza': { net: 900, tax: 144, discount: 100 },
      'Delivery Charge (Rs 200)': { net: 200, tax: 32, discount: 0 },
      'Test Side': { net: 900, tax: 144, discount: 100 },
    });
    const fbrTax = mapOrderToFbrPayload(s, SELLER).items.reduce((t, i) => t + Math.round(i.salesTaxApplicable * 100), 0);
    expect(fbrTax).toBe(32_000);
    // A refund's debit note, mapped days later from the snapshot: split as the sale was.
    const note = mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-1', refundedCents: 232_000, refundedAt: new Date().toISOString() });
    expect(note.items.find((i) => i.productDescription === 'Delivery Charge (Rs 200)')).toMatchObject({ valueSalesExcludingST: 200, salesTaxApplicable: 32 });
    expect(note.items.find((i) => i.productDescription === 'Delivery Charge (Rs 200)')?.discount).toBeUndefined();
    // Profit and food cost: the charge is fee sales at its full Rs 200; the food carries the whole discount.
    expect(await reportsSay()).toEqual({ food: 180_000, fee: 20_000, chargeSales: 20_000 });
    // The receipt says so.
    expect(receiptText(s)).toContain('Discount 10% (food only)');
  });

  it('100% off leaves the delivery charge and its tax to pay (a manager’s PIN)', async () => {
    const orderId = await deliveryOrder();
    h.session = CASHIER;
    expect(await call('orders:applyDiscount', { orderId, discountType: 'percent', value: 100 })).toMatchObject({ ok: false, code: 'precondition_failed' });
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 100, reason: 'Complaint', approverPin: MANAGER_SECRET });
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 200_000, tax_cents: 3_200, total_cents: 23_200 });
    await pay(orderId);
    const s = await snap(orderId);
    expect(fbrLines(s)).toEqual({
      'Test Pizza': { net: 0, tax: 0, discount: 1_000 },
      'Delivery Charge (Rs 200)': { net: 200, tax: 32, discount: 0 },
      'Test Side': { net: 0, tax: 0, discount: 1_000 },
    });
    expect(await reportsSay()).toEqual({ food: 0, fee: 20_000, chargeSales: 20_000 });
    expect(receiptText(s)).toContain('Discount 100% (Complaint, food only)');
  });

  it('a rupee amount bigger than the food takes the food only', async () => {
    const orderId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'flat', value: 300_000, approverPin: MANAGER_SECRET });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 300_000, amount_cents: 200_000 }]);
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 200_000, tax_cents: 3_200, total_cents: 23_200 });
    const s = await snap(orderId);
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toEqual({ net: 200, tax: 32, discount: 0 });
    // The screen said the same before it was saved.
    const previewDiscount = await screenPreview();
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(previewDiscount(s.items, 220_000, { type: 'flat', value: 300_000 }, rules.discounts)).toMatchObject({
      discountCents: 200_000,
      taxCents: 3_200,
      totalCents: 23_200,
    });
    expect(receiptText(s)).toContain('Discount (food only)');
  });

  it('the F3 screen’s preview is the stored bill, paisa for paisa, on an order with a delivery charge', async () => {
    const previewDiscount = await screenPreview();
    h.session = CASHIER;
    const rules = await data<CheckoutRules>('checkout:getRules');
    expect(rules.discounts.alsoOffDeliveryCharge).toBe(false);
    for (const choice of [
      { type: 'percent' as const, value: 5 },
      { type: 'percent' as const, value: 7.5 },
      { type: 'flat' as const, value: 3_333 },
      { type: 'flat' as const, value: 19_999 },
    ]) {
      const orderId = await deliveryOrder();
      const before = await snap(orderId);
      const screen = previewDiscount(before.items, before.order.subtotalCents, choice, rules.discounts);
      h.session = CASHIER;
      await data('orders:applyDiscount', { orderId, discountType: choice.type, value: choice.value, approverPin: MANAGER_SECRET });
      const stored = orderRow(orderId)!;
      expect({ choice, discount: screen.discountCents, tax: screen.taxCents, total: screen.totalCents }).toEqual({
        choice,
        discount: stored['discount_cents'],
        tax: stored['tax_cents'],
        total: stored['total_cents'],
      });
    }
  });
});

describe.skipIf(!Sqlite)('only the owner changes the switch', () => {
  it('a cashier and a manager are refused it (set, put back, read) in the main process, and nothing is written', async () => {
    const counts = () =>
      ['audit_log', 'sync_queue', 'business_settings'].map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
    const before = counts();
    for (const who of [CASHIER, MANAGER]) {
      h.session = who;
      for (const payload of [{ key: 'discounts.delivery', value: { v: 1, alsoOffDeliveryCharge: true } }, { key: 'discounts.delivery', useDefault: true }]) {
        expect({ who: who.role, o: await call('settings:setBusiness', payload) }).toMatchObject({ who: who.role, o: { ok: false, code: 'forbidden' } });
      }
      expect(await call('settings:getBusiness', { key: 'discounts.delivery' })).toMatchObject({ ok: false, code: 'forbidden' });
      // …while the counter reads the rule in force (No).
      expect((await data<CheckoutRules>('checkout:getRules')).discounts.alsoOffDeliveryCharge).toBe(false);
    }
    expect(counts()).toEqual(before);
    // The owner reads the card: No, the default, never changed.
    h.session = OWNER;
    expect(await data('settings:getBusiness', { key: 'discounts.delivery' })).toMatchObject({
      value: { v: 1, alsoOffDeliveryCharge: false },
      isDefault: true,
      lastChanged: null,
    });
  });
});

describe.skipIf(!Sqlite)('the approval limit is checked on the food, in all three places', () => {
  it('Rs 210 off Rs 2,000 of food is over 10% of the food: the screen, the IPC check and the repository all ask for a manager', async () => {
    const previewDiscount = await screenPreview();
    const { applyDiscount } = await repos();
    const d = { type: 'flat' as const, value: 21_000 };
    for (const [alsoOff, needs] of [
      [false, true],
      // The switch on: 10% of Rs 2,200 is Rs 220, as before — no manager.
      [true, false],
    ] as const) {
      await setSwitch(alsoOff);
      h.session = CASHIER;
      const rules = await data<CheckoutRules>('checkout:getRules');
      const screenOrder = await deliveryOrder();
      const s = await snap(screenOrder);
      const screen = previewDiscount(s.items, s.order.subtotalCents, d, rules.discounts).needsApproval;
      h.session = CASHIER;
      const ipc = await call('orders:applyDiscount', { orderId: screenOrder, discountType: d.type, value: d.value });
      const repoOrder = await deliveryOrder();
      let repository = false;
      try {
        applyDiscount(db as never, { orderId: repoOrder, discountType: d.type, value: d.value, approverUserId: null }, CASHIER_ACTOR);
      } catch (e) {
        expect(String(e)).toMatch(/Manager approval is required/);
        repository = true;
      }
      expect({ alsoOff, screen, ipc: !ipc.ok && ipc.code === 'precondition_failed', repository }).toEqual({ alsoOff, screen: needs, ipc: needs, repository: needs });
    }
  });

  it('the refusal says what it was checked on: "10% of the food" on an order with a delivery charge, "of the order" otherwise', async () => {
    const orderId = await deliveryOrder();
    h.session = CASHIER;
    // Rs 210 is under 10% of the Rs 2,200 order, over 10% of the Rs 2,000 of food: the words must not contradict the refusal.
    const refused = await call('orders:applyDiscount', { orderId, discountType: 'flat', value: 21_000 });
    expect(refused).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(refused.ok ? '' : refused.message).toBe(
      "Manager approval required for this discount. Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food, without a manager. More needs a manager's PIN or password.",
    );
    // No delivery charge: the order, as before.
    const plain = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
    await data('orders:addItem', { orderId: plain.id, menuItemId: menu.pizza, quantity: 2 });
    const refusedPlain = await call('orders:applyDiscount', { orderId: plain.id, discountType: 'flat', value: 21_000 });
    expect(refusedPlain.ok ? '' : refusedPlain.message).toContain('no more than 10% of the order, without a manager');
    // The switch on: the order again.
    await setSwitch(true);
    h.session = CASHIER;
    const refusedYes = await call('orders:applyDiscount', { orderId, discountType: 'flat', value: 23_000 });
    expect(refusedYes.ok ? '' : refusedYes.message).toContain('no more than 10% of the order, without a manager');
  });
});

/**
 * Both tills not yet on this version: the other till (0.7.25 or before)
 * changes the cart of an open order whose discount this till gave on the food
 * only. It re-works the discount over every line and leaves the row's rule
 * saying "food only"; its rows reach this till by sync. The stored bill is
 * the truth (never recomputed): the FBR invoice, the debit note, Reports and
 * the receipt follow how it was worked, and add up to it.
 */
describe.skipIf(!Sqlite)('a discount an older till re-worked over every line: readers follow the stored bill', () => {
  /** The rows as the older till writes them (a cart change there: the discount over the whole subtotal). */
  async function olderTillReworks(
    orderId: string,
    d: { type: 'percent' | 'flat'; value: number },
  ): Promise<{ discount: number; tax: number; total: number }> {
    const { computeDiscountCents, taxAfterDiscount } = await import('@cheeseoclock/pos-domain');
    const s = await snap(orderId);
    const subtotal = s.order.subtotalCents as number;
    const discount = computeDiscountCents(subtotal, d) as number;
    const tax = taxAfterDiscount(s.items, discount, true).taxCents;
    const total = subtotal - discount + tax;
    db.prepare(`UPDATE order_discounts SET amount_cents = ?, version = version + 1 WHERE order_id = ? AND deleted_at IS NULL`).run(discount, orderId);
    db.prepare(`UPDATE orders SET discount_cents = ?, tax_cents = ?, total_cents = ?, version = version + 1 WHERE id = ?`).run(discount, tax, total, orderId);
    return { discount, tax, total };
  }
  /** The FBR sale invoice's totals, in paisa: before tax, tax, and the discount on its lines. */
  const fbrTotals = (s: OrderSnapshot) => {
    const items = mapOrderToFbrPayload(s, SELLER).items;
    const p = (x: number) => Math.round(x * 100);
    return {
      net: items.reduce((t, i) => t + p(i.valueSalesExcludingST), 0),
      tax: items.reduce((t, i) => t + p(i.salesTaxApplicable), 0),
      discount: items.reduce((t, i) => t + p(i.discount ?? 0), 0),
    };
  };

  it('100% off re-worked to Rs 2,200 (more than the food): the invoice is Rs 0, the charge is not invoiced at Rs 232', async () => {
    const orderId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 100, approverPin: MANAGER_SECRET });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 200_000, tax_cents: 3_200, total_cents: 23_200 });
    const stored = await olderTillReworks(orderId, { type: 'percent', value: 100 });
    expect(stored).toEqual({ discount: 220_000, tax: 0, total: 0 });
    // The row still says "food only".
    expect(JSON.parse(String(liveDiscounts(orderId)[0]?.['rule_json']))).toMatchObject({ alsoOffDeliveryCharge: false });

    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: true }]);
    expect(fbrTotals(s)).toEqual({ net: 0, tax: 0, discount: 220_000 });
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toEqual({ net: 0, tax: 0, discount: 200 });
    expect(receiptText(s)).not.toContain('food only');
  });

  it('10% re-worked to Rs 220 with the charge at 5%: the stored tax tells it; invoice, debit note and Reports add up to the stored bill', async () => {
    const orderId = await deliveryOrder();
    // A made-up 5% on this delivery charge (as it was sold), so the two splits tax differently.
    db.prepare(`UPDATE order_items SET tax_rate_bps_snapshot = 500 WHERE order_id = ? AND menu_item_id = ?`).run(orderId, menu.charge);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10 });
    // This till: Rs 200 off the food; tax 16% of Rs 1,800 + 5% of Rs 200.
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 20_000, tax_cents: 29_800, total_cents: 229_800 });
    const stored = await olderTillReworks(orderId, { type: 'percent', value: 10 });
    // The older till: Rs 220 over every line; tax 16% of Rs 1,800 + 5% of Rs 180.
    expect(stored).toEqual({ discount: 22_000, tax: 29_700, total: 227_700 });
    await pay(orderId);

    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: true }]);
    expect(fbrTotals(s)).toEqual({ net: 198_000, tax: 29_700, discount: 22_000 });
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toEqual({ net: 180, tax: 9, discount: 20 });
    const note = mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-2', refundedCents: stored.total, refundedAt: new Date().toISOString() });
    expect(note.items.reduce((t, i) => t + Math.round(i.salesTaxApplicable * 100), 0)).toBe(29_700);
    // Reports: the charge took its Rs 20 share, as the older till split it; food + fee = sales before tax.
    expect(await reportsSay()).toEqual({ food: 180_000, fee: 18_000, chargeSales: 18_000 });
    expect(receiptText(s)).not.toContain('food only');
  });

  it('the same order as this till stored it is read by its frozen rule (the check never fires on its own bills)', async () => {
    const orderId = await deliveryOrder();
    db.prepare(`UPDATE order_items SET tax_rate_bps_snapshot = 500 WHERE order_id = ? AND menu_item_id = ?`).run(orderId, menu.charge);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10 });
    await pay(orderId);
    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: false }]);
    expect(fbrTotals(s)).toEqual({ net: 200_000, tax: 29_800, discount: 20_000 });
    expect(await reportsSay()).toEqual({ food: 180_000, fee: 20_000, chargeSales: 20_000 });
    expect(receiptText(s)).toContain('Discount 10% (food only)');
  });
});

describe.skipIf(!Sqlite)('history never moves: the rule is the row’s', () => {
  it('a legacy discount row (no rule: an older till) keeps covering the charge on every cart change; paid, nothing moves whatever the switch says', async () => {
    // Given as a 0.7.25 (or older) till gave it: over every line, and no rule on the row.
    await setSwitch(true);
    const orderId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    db.prepare(`UPDATE order_discounts SET rule_json = NULL WHERE order_id = ?`).run(orderId);
    await setSwitch(false);
    // An open order's legacy row after the update: re-worked the old way on the next cart change.
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    // 10% of Rs 2,700 (charge included) = Rs 270; the charge's share Rs 20.
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 27_000 });
    const open = await snap(orderId);
    expect(open.discounts).toMatchObject([{ alsoOffDeliveryCharge: true }]);
    expect(fbrLines(open)['Delivery Charge (Rs 200)']).toEqual({ net: 180, tax: 28.8, discount: 20 });

    await pay(orderId);
    const paid = orderRow(orderId);
    const paidSnap = await snap(orderId);
    const fbr = mapOrderToFbrPayload(paidSnap, SELLER);
    const reports = await reportsSay();
    const paper = receiptText(paidSnap);
    expect(reports).toEqual({ food: 225_000, fee: 18_000, chargeSales: 18_000 });
    expect(paper).toContain('Discount (Staff)');
    expect(paper).not.toContain('food only');
    // The owner flips the switch both ways: the paid order, its invoice, Reports and its reprint never move.
    for (const alsoOff of [true, false]) {
      await setSwitch(alsoOff);
      expect(orderRow(orderId)).toEqual(paid);
      const again = await snap(orderId);
      expect(mapOrderToFbrPayload(again, SELLER)).toEqual(fbr);
      expect(await reportsSay()).toEqual(reports);
      expect(receiptText(again)).toBe(paper);
    }
  });

  it('turning the switch on restores the old maths for new discounts only: an open order’s discount keeps its rule, a paid one never moves', async () => {
    // Given under the default (the food only): one paid, one still open.
    const paidId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId: paidId, discountType: 'percent', value: 10 });
    await pay(paidId);
    const paidBefore = orderRow(paidId);
    const openId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId: openId, discountType: 'percent', value: 10 });
    expect(orderRow(openId)).toMatchObject({ discount_cents: 20_000, total_cents: 232_000 });

    await setSwitch(true);
    h.session = CASHIER;
    expect((await data<CheckoutRules>('checkout:getRules')).discounts.alsoOffDeliveryCharge).toBe(true);

    // A new discount: the whole bill, as before 0.7.26 (10% of Rs 2,200; tax 16% of Rs 1,980).
    const newId = await deliveryOrder();
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId: newId, discountType: 'percent', value: 10 });
    expect(orderRow(newId)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 22_000, tax_cents: 31_680, total_cents: 229_680 });
    expect(JSON.parse(String(liveDiscounts(newId)[0]?.['rule_json']))).toMatchObject({ alsoOffDeliveryCharge: true, from: 'till' });
    const newSnap = await snap(newId);
    expect(fbrLines(newSnap)['Delivery Charge (Rs 200)']).toEqual({ net: 180, tax: 28.8, discount: 20 });
    expect(receiptText(newSnap)).not.toContain('food only');

    // The open order's discount keeps the rule it was given with, through a cart change.
    h.session = CASHIER;
    await data('orders:addItem', { orderId: openId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(openId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 25_000 });
    expect(fbrLines(await snap(openId))['Delivery Charge (Rs 200)']).toEqual({ net: 200, tax: 32, discount: 0 });
    // Re-applied now, it takes the switch as it is now.
    await data('orders:applyDiscount', { orderId: openId, discountType: 'percent', value: 10 });
    expect(orderRow(openId)).toMatchObject({ discount_cents: 27_000 });

    // The paid order never moved.
    expect(orderRow(paidId)).toEqual(paidBefore);
    expect(fbrLines(await snap(paidId))['Delivery Charge (Rs 200)']).toEqual({ net: 200, tax: 32, discount: 0 });
  });
});

describe.skipIf(!Sqlite)('a web order keeps the website’s rule, never the till’s switch', () => {
  /** The website bridge's own import (web-orders-bridge importOne), the site's API stood in for. */
  async function importWebOrder(web: WebOrder): Promise<string> {
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
    await bridge.importOne({}, web);
    const row = db.prepare(`SELECT pos_order_id FROM web_order_imports WHERE web_order_id = ?`).get(web.id);
    expect(row?.['pos_order_id']).toBeTruthy();
    return String(row!['pos_order_id']);
  }
  const webOrder = (id: string, fulfilment: 'pickup' | 'delivery', lines: Array<[string, number, number]>, pct: number): WebOrder => {
    const subtotal = lines.reduce((s, [, q, p]) => s + q * p, 0);
    return {
      id,
      status: 'new',
      customerName: 'Web Customer',
      customerPhone: '03111234567',
      addressLine: fulfilment === 'pickup' ? 'Collect from the shop' : 'Flat 2, Web Road',
      area: fulfilment === 'pickup' ? null : 'Test Area',
      notes: null,
      fulfilment,
      items: lines.map(([posItemId, quantity, unitPriceCents]) => ({ posItemId, name: 'Test', quantity, unitPriceCents, modifiers: [], notes: null })),
      subtotalCents: subtotal,
      discountCents: Math.round((subtotal * pct) / 100),
      taxCents: 0,
      totalCents: 0,
      paymentMethod: 'cod',
      createdAt: new Date().toISOString(),
      posOrderId: null,
      posOrderNumber: null,
    };
  };

  it('a pick-up’s 10% is the website’s, frozen as such; the till’s total is what the customer was shown, switch on or off', async () => {
    const priceOrder = await websitePricing();
    for (const alsoOff of [false, true]) {
      await setSwitch(alsoOff);
      const orderId = await importWebOrder(webOrder(`web-pickup-${alsoOff}`, 'pickup', [[menu.pizza, 1, 100_000], [menu.side, 2, 50_000]], 10));
      const shown = priceOrder(
        [
          { lineTotalCents: 100_000, taxRateBps: 1_600 },
          { lineTotalCents: 100_000, taxRateBps: 1_600 },
        ],
        10,
      );
      expect(orderRow(orderId)).toMatchObject({ discount_cents: shown.discountCents, tax_cents: shown.taxCents, total_cents: shown.totalCents });
      const [row] = liveDiscounts(orderId);
      expect(row).toMatchObject({ source: null, value: 10 });
      expect(JSON.parse(String(row?.['rule_json']))).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'website' });
    }
  });

  it('even a pick-up that (by a site’s mistake) carried a delivery charge is taken off as the website priced it — no mismatch for staff to chase', async () => {
    const priceOrder = await websitePricing();
    await setSwitch(false);
    const orderId = await importWebOrder(webOrder('web-odd', 'pickup', [[menu.pizza, 1, 100_000], [menu.charge, 1, 20_000]], 10));
    const shown = priceOrder(
      [
        { lineTotalCents: 100_000, taxRateBps: 1_600 },
        { lineTotalCents: 20_000, taxRateBps: 1_600 },
      ],
      10,
    );
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 12_000, total_cents: shown.totalCents });
  });

  it('a web delivery with its charge has no discount at all, as the website priced it', async () => {
    await setSwitch(true);
    const orderId = await importWebOrder(webOrder('web-delivery', 'delivery', [[menu.pizza, 1, 100_000], [menu.charge, 1, 20_000]], 0));
    expect(liveDiscounts(orderId)).toEqual([]);
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 120_000, discount_cents: 0, tax_cents: 19_200, total_cents: 139_200 });
  });
});

describe.skipIf(!Sqlite)('the foodpanda deal works on the food too', () => {
  async function setDeal(deal: Record<string, unknown>): Promise<void> {
    h.session = OWNER;
    const o = await call('settings:setBusiness', {
      key: 'foodpanda.deal',
      value: { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null, ...deal },
    });
    expect(o.ok).toBe(true);
  }

  it('20% of the food only; the charge never lifts the order over the deal’s minimum', async () => {
    await setDeal({ minOrderCents: 210_000 });
    // Rs 2,000 of food + a Rs 200 charge (tapped by hand on a foodpanda order): under the Rs 2,100 minimum.
    const orderId = await deliveryOrder('foodpanda');
    const [row] = liveDiscounts(orderId);
    expect(row).toMatchObject({ source: 'foodpanda', value: 20, amount_cents: 0 });
    expect(JSON.parse(String(row?.['rule_json']))).toMatchObject({ kind: 'foodpanda_deal', alsoOffDeliveryCharge: false });
    expect((await snap(orderId)).discounts[0]?.foodpanda).toMatchObject({ dealCents: 0, minOrderCents: 210_000, baseCents: 200_000 });
    // One more side: Rs 2,500 of food, 20% = Rs 500; the charge takes none.
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(orderId)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 50_000, tax_cents: 35_200, total_cents: 255_200 });
    const s = await snap(orderId);
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toEqual({ net: 200, tax: 32, discount: 0 });
    expect(receiptText(s)).toContain('Foodpanda deal 20% off (food only)');
    // Paid through foodpanda: its terms keep the deal on the food.
    h.session = CASHIER;
    await data('orders:tender', { orderId, payments: [{ method: 'foodpanda', amountCents: 255_200 }] });
    expect(db.prepare(`SELECT shop_discount_cents, platform_funded_cents FROM order_channel_terms WHERE order_id = ?`).get(orderId)).toMatchObject({
      shop_discount_cents: 50_000,
      platform_funded_cents: 0,
    });
  });

  it('with the switch on, a deal put on from then covers the charge as before; a deal already on an order keeps its rule', async () => {
    await setDeal({ minOrderCents: 210_000 });
    const before = await deliveryOrder('foodpanda');
    await setSwitch(true);
    const after = await deliveryOrder('foodpanda');
    // Rs 2,200 with the charge reaches the minimum: 20% of Rs 2,200.
    expect(orderRow(after)).toMatchObject({ discount_cents: 44_000 });
    expect(JSON.parse(String(liveDiscounts(after)[0]?.['rule_json']))).toMatchObject({ alsoOffDeliveryCharge: true });
    // The order that became foodpanda before the change keeps its deal on the food: one more side,
    // 20% of Rs 2,500 of food (not of Rs 2,700 with the charge).
    expect(orderRow(before)).toMatchObject({ subtotal_cents: 220_000, discount_cents: 0 });
    h.session = CASHIER;
    await data('orders:addItem', { orderId: before, menuItemId: menu.side, quantity: 1 });
    expect(orderRow(before)).toMatchObject({ subtotal_cents: 270_000, discount_cents: 50_000 });
  });
});
