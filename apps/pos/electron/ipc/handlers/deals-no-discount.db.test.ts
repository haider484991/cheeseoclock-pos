/**
 * Value deals never get any discount (the owner, 2 Oct 2026), in the main
 * process: through the real orders IPC handlers, repositories, FBR mapper and
 * Reports readers, on a real SQLite database built from every migration:
 *   - an F3 discount is worked on, and split over, the food without the value
 *     deals; the approval limit is checked on the same amount in the IPC
 *     handler and the repository, and the refusal says so;
 *   - an order of value deals only is refused before any manager's PIN is
 *     checked (the handler and the repository); the website's pick-up % on
 *     one writes nothing and never throws;
 *   - a staff discount whose food is taken off stays on at Rs 0 and works
 *     again when food comes back;
 *   - the owner's automatic offers are worked on, and their minimum measured
 *     on, the food without the deals;
 *   - a foodpanda order still covers the deals (the deal, and a manager's
 *     discount matching the tablet);
 *   - after payment the snapshot, the FBR invoice, food cost and profit split
 *     it the same way, part refunds by each line's net; a discount a v0.7.33
 *     till re-worked over the deals is read back from the stored bill.
 *
 * Only `defineHandler` (captured), the signed-in session and the manager
 * check (auth-service, counted), the printer spooler and the FBR worker are
 * stood in for. node's own `node:sqlite` stands in for better-sqlite3 (built
 * for Electron); skipped where it is missing. Every name, id and amount is
 * made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ChannelOffer, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { mapOrderToFbrPayload, mapRefundToFbrDebitNote, type FbrSellerInfo } from '@cheeseoclock/fbr-core';
import { DatabaseSync, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

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
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
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
    h.pinChecks += 1;
    if (pin === 'Test-manager-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({
  fbrWorker: { kick: () => {}, resetAdapter: () => {} },
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
const CASH_ACTOR = { userId: 'u_cash', deviceId: DEV };
const MGR_ACTOR = { userId: 'u_mgr', deviceId: DEV };
const OWNER_ACTOR = { userId: 'u_admin', deviceId: DEV };
const SELLER: FbrSellerInfo = { sellerNTNCNIC: '0000000', sellerBusinessName: 'Test Shop', sellerProvince: 'Sindh', sellerAddress: 'Test Road' };

type Db = ReturnType<typeof openMigrated>;
let db: Db;
let menu: { pizza: string; smallPizza: string; fries: string; bigTwo: string; charge: string };

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

/** Users, a 15% tax, pizzas and fries, the value deals (Big Two, by the category's name), a delivery charge and a shift. */
async function seedTill(d: Db): Promise<typeof menu> {
  const user = d.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  const x = d as never;
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_500 }, MGR_ACTOR);
  const food = createCategory(x, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, MGR_ACTOR);
  const deals = createCategory(x, { name: 'Value Deals', displayOrder: 2, colorHex: '#aa0055' }, MGR_ACTOR);
  const fees = createCategory(x, { name: 'Delivery Charges', displayOrder: 3, colorHex: '#555555' }, MGR_ACTOR);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, MGR_ACTOR).id;
  const menuIds = {
    pizza: item(food.id, 'Test Fajita Pizza', 150_000),
    smallPizza: item(food.id, 'Test Small Pizza', 60_000),
    fries: item(food.id, 'Test Fries', 50_000),
    bigTwo: item(deals.id, 'Big Two', 360_000),
    charge: item(fees.id, 'Delivery Charge (Rs 200)', 20_000),
  };
  openShift(x, { openingCashCents: 0 }, MGR_ACTOR);
  return menuIds;
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.pinChecks = 0;
  db = openMigrated({});
  menu = await seedTill(db);
  (await import('./orders-handlers.js')).registerOrdersHandlers({ db, deviceId: DEV } as never);
});

const repo = () => import('../../db/repositories/order-repo.js');

/** A counter order rung up by the cashier through orders:create / orders:addItem: [item, quantity] per line. */
async function counterOrder(mode: 'takeaway' | 'delivery' | 'foodpanda', lines: Array<[keyof typeof menu, number]>): Promise<string> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode });
  for (const [key, quantity] of lines) await data('orders:addItem', { orderId: order.id, menuItemId: menu[key], quantity });
  return order.id;
}
type Row = Record<string, unknown>;
const orderRow = (orderId: string) =>
  db.prepare(`SELECT subtotal_cents, discount_cents, tax_cents, total_cents FROM orders WHERE id = ?`).get(orderId) as Row | undefined;
const liveDiscounts = (orderId: string) =>
  db
    .prepare(`SELECT source, value, amount_cents, approved_by_user_id, rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`)
    .all(orderId) as Row[];
const ruleOf = (row: Row | undefined) => JSON.parse(String(row?.['rule_json'])) as Record<string, unknown>;
const lineOf = (orderId: string, menuItemId: string) =>
  String((db.prepare(`SELECT id FROM order_items WHERE order_id = ? AND menu_item_id = ? AND deleted_at IS NULL`).get(orderId, menuItemId) as Row | undefined)?.['id']);
const counts = () =>
  ['order_discounts', 'audit_log', 'sync_queue'].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row | undefined)?.['n']]);
async function snap(orderId: string): Promise<OrderSnapshot> {
  return (await repo()).getOrderSnapshot(db as never, orderId)!;
}
async function pay(orderId: string): Promise<void> {
  const total = Number(orderRow(orderId)?.['total_cents']);
  h.session = CASHIER;
  await data('orders:tender', { orderId, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] });
}
/** The FBR sale invoice's lines, by name: before tax, tax and the discount key (rupees; undefined = none). */
const fbrLines = (s: OrderSnapshot) =>
  Object.fromEntries(
    mapOrderToFbrPayload(s, SELLER).items.map((i) => [i.productDescription, { net: i.valueSalesExcludingST, tax: i.salesTaxApplicable, discount: i.discount }]),
  );
const fbrTax = (s: OrderSnapshot) => mapOrderToFbrPayload(s, SELLER).items.reduce((t, i) => t + Math.round(i.salesTaxApplicable * 100), 0);
const NOW_RANGE = () => ({ sinceIso: new Date(Date.now() - 3_600_000).toISOString(), untilIso: new Date(Date.now() + 3_600_000).toISOString() });
/** What Reports say each item sold for, before tax, after discounts and part refunds: Profit's items and Food cost's no-cost list. */
async function reportsSay(): Promise<{ profit: Record<string, number>; foodCost: Record<string, number>; foodSales: number }> {
  const { getFoodCost } = await import('../../services/business-report.js');
  const { readSales } = await import('../../services/analytics/profit.js');
  const f = getFoodCost(db as never, NOW_RANGE());
  const sales = readSales(db as never, NOW_RANGE(), { estimates: false });
  return {
    profit: Object.fromEntries([...sales.items.values()].map((i) => [i.name, i.salesCents])),
    foodCost: Object.fromEntries(f.missingSales.map((m) => [m.name, m.salesCents])),
    foodSales: f.foodSalesCents,
  };
}

live('a till discount leaves the value deals alone', () => {
  it('F3 10% on a pizza and Big Two: Rs 150 off the pizza only — the right tax and total, frozen on the row, on the snapshot and the invoice', async () => {
    const orderId = await counterOrder('takeaway', [
      ['pizza', 1],
      ['bigTwo', 1],
    ]);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    // 10% of the Rs 1,500 pizza (not of Rs 5,100); tax 15% of (Rs 1,350 + Rs 3,600).
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 510_000, discount_cents: 15_000, tax_cents: 74_250, total_cents: 569_250 });
    const [row] = liveDiscounts(orderId);
    expect(row).toMatchObject({ source: null, value: 10, amount_cents: 15_000 });
    expect(ruleOf(row)).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till', skipsNoDiscountLines: true });
    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: false, skipsNoDiscountLines: true }]);
    expect(fbrLines(s)).toEqual({
      'Test Fajita Pizza': { net: 1_350, tax: 202.5, discount: 150 },
      'Big Two': { net: 3_600, tax: 540, discount: undefined },
    });
    expect(fbrTax(s)).toBe(74_250);
  });

  it('a delivery: the Rs 200 charge and the deal both pay in full', async () => {
    const orderId = await counterOrder('delivery', [
      ['pizza', 1],
      ['bigTwo', 1],
      ['charge', 1],
    ]);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    // Rs 150 off; tax 15% of (Rs 1,350 + Rs 3,600 + Rs 200).
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 530_000, discount_cents: 15_000, tax_cents: 77_250, total_cents: 592_250 });
    const s = await snap(orderId);
    expect(fbrLines(s)['Delivery Charge (Rs 200)']).toEqual({ net: 200, tax: 30, discount: undefined });
    expect(fbrLines(s)['Big Two']).toEqual({ net: 3_600, tax: 540, discount: undefined });
  });

  it('Rs 499 off Rs 600 of pizza and two Big Twos needs a manager in the IPC handler and the repository (the deals do not count towards the limit), and the refusal says so', async () => {
    const lines: Array<[keyof typeof menu, number]> = [
      ['smallPizza', 1],
      ['bigTwo', 2],
    ];
    // Without the deals left out, 10% of Rs 7,800 (Rs 780) would let Rs 499 through.
    const ipcOrder = await counterOrder('takeaway', lines);
    h.session = CASHIER;
    const refused = await call('orders:applyDiscount', { orderId: ipcOrder, discountType: 'flat', value: 49_900, reason: 'Staff' });
    expect(refused).toEqual({
      ok: false,
      code: 'precondition_failed',
      message:
        "Manager approval required for this discount. Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food (value deals not counted), without a manager. More needs a manager's PIN or password.",
    });
    const { applyDiscount } = await repo();
    const repoOrder = await counterOrder('takeaway', lines);
    expect(() =>
      applyDiscount(db as never, { orderId: repoOrder, discountType: 'flat', value: 49_900, reason: 'Staff', approverUserId: null }, CASH_ACTOR),
    ).toThrow(/Manager approval is required/);
    expect(liveDiscounts(repoOrder)).toEqual([]);
    // With a manager: Rs 499 off the pizza alone; the deals pay in full. Tax 15% of (Rs 101 + Rs 7,200).
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId: ipcOrder, discountType: 'flat', value: 49_900, reason: 'Staff', approverPin: MANAGER_SECRET });
    expect(liveDiscounts(ipcOrder)).toMatchObject([{ amount_cents: 49_900, approved_by_user_id: 'u_mgr' }]);
    expect(orderRow(ipcOrder)).toEqual({ subtotal_cents: 780_000, discount_cents: 49_900, tax_cents: 109_515, total_cents: 839_615 });
  });

  it('an order of deals only: refused before any manager’s PIN is checked, in the IPC handler and the repository, and nothing is written', async () => {
    const takeaway = await counterOrder('takeaway', [['bigTwo', 2]]);
    // A delivery: the charge is left alone by the owner's switch, so nothing is left either.
    const delivery = await counterOrder('delivery', [
      ['bigTwo', 1],
      ['charge', 1],
    ]);
    const before = counts();
    for (const orderId of [takeaway, delivery]) {
      for (const payload of [
        { orderId, discountType: 'percent', value: 10, reason: 'Staff' },
        { orderId, discountType: 'percent', value: 50, reason: 'Staff', approverPin: MANAGER_SECRET },
        { orderId, discountType: 'flat', value: 10_000, reason: 'Staff', approverPin: 'not-a-pin' },
      ]) {
        h.session = CASHIER;
        expect(await call('orders:applyDiscount', payload)).toEqual({
          ok: false,
          code: 'precondition_failed',
          message: 'Nothing on this order can be discounted: value deals never get a discount.',
        });
      }
    }
    expect(h.pinChecks).toBe(0);
    const { applyDiscount } = await repo();
    expect(() =>
      applyDiscount(db as never, { orderId: takeaway, discountType: 'percent', value: 10, reason: 'Staff', approverUserId: 'u_mgr' }, CASH_ACTOR),
    ).toThrow('Nothing on this order can be discounted: value deals never get a discount.');
    expect(counts()).toEqual(before);
    expect(orderRow(takeaway)).toMatchObject({ discount_cents: 0, total_cents: 828_000 });
  });

  it('the website’s pick-up % on deals only writes nothing and never throws; an older website’s (every line) still covers them', async () => {
    const { applyDiscount } = await repo();
    const { websiteDiscountRule } = await import('@cheeseoclock/pos-domain');
    const flagged = await counterOrder('takeaway', [['bigTwo', 1]]);
    const before = counts();
    expect(() =>
      applyDiscount(
        db as never,
        { orderId: flagged, discountType: 'percent', value: 10, reason: 'Website pick-up 10% off', approverUserId: 'u_admin' },
        OWNER_ACTOR,
        { rule: websiteDiscountRule(true) },
      ),
    ).not.toThrow();
    expect(counts()).toEqual(before);
    expect(orderRow(flagged)).toMatchObject({ discount_cents: 0, total_cents: 414_000 });
    // A website that priced every line (no flags): the till takes off what the customer was shown.
    const older = await counterOrder('takeaway', [['bigTwo', 1]]);
    applyDiscount(
      db as never,
      { orderId: older, discountType: 'percent', value: 10, reason: 'Website pick-up 10% off', approverUserId: 'u_admin' },
      OWNER_ACTOR,
      { rule: websiteDiscountRule(false) },
    );
    expect(liveDiscounts(older)).toMatchObject([{ amount_cents: 36_000 }]);
    expect(ruleOf(liveDiscounts(older)[0])).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'website' });
  });

  it('taking the pizza off leaves the discount on at Rs 0 (no "- 0.00" maths, no PIN); putting it back gives Rs 150 again', async () => {
    const orderId = await counterOrder('takeaway', [
      ['pizza', 1],
      ['bigTwo', 1],
    ]);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    const pizzaLine = lineOf(orderId, menu.pizza);
    await data('orders:removeItem', { orderId, orderItemId: pizzaLine });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 10, amount_cents: 0 }]);
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 360_000, discount_cents: 0, tax_cents: 54_000, total_cents: 414_000 });
    await data('orders:addItem', { orderId, menuItemId: menu.pizza, quantity: 1 });
    expect(liveDiscounts(orderId)).toMatchObject([{ value: 10, amount_cents: 15_000 }]);
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 510_000, discount_cents: 15_000, tax_cents: 74_250, total_cents: 569_250 });
  });
});

live('the owner’s automatic offers', () => {
  async function saveOffers(offers: Array<Partial<ChannelOffer>>): Promise<void> {
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    setBusinessSetting(
      db as never,
      'discounts.offers',
      {
        v: 1,
        askCameBy: false,
        offers: offers.map((o, i) => ({
          id: `test-offer-${i}`,
          name: `Test offer ${i}`,
          on: true,
          cameBy: 'any',
          orderTypes: ['takeaway', 'delivery'],
          type: 'percent',
          value: 10,
          minOrderCents: null,
          maxOffCents: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          hours: null,
          startsOn: null,
          endsOn: null,
          oncePerCustomerPerDay: false,
          ...o,
        })),
      },
      OWNER_ACTOR,
    );
  }
  const applyOfferAudits = (orderId: string) =>
    db.prepare(`SELECT after_json FROM audit_log WHERE action = 'apply_offer' AND after_json LIKE ?`).all(`%${orderId}%`) as Row[];

  it('an order of deals only gets no offer; adding fries brings it on, on the fries alone, with an apply_offer audit', async () => {
    await saveOffers([{}]);
    const orderId = await counterOrder('takeaway', [['bigTwo', 1]]);
    expect(liveDiscounts(orderId)).toEqual([]);
    expect(applyOfferAudits(orderId)).toEqual([]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.fries, quantity: 1 });
    const [row] = liveDiscounts(orderId);
    // 10% of the Rs 500 of fries; tax 15% of (Rs 450 + Rs 3,600).
    expect(row).toMatchObject({ source: 'offer', amount_cents: 5_000 });
    expect(ruleOf(row)).toMatchObject({ skipsNoDiscountLines: true, offer: { id: 'test-offer-0' } });
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 410_000, discount_cents: 5_000, tax_cents: 60_750, total_cents: 465_750 });
    expect(applyOfferAudits(orderId)).toHaveLength(1);
    expect((await snap(orderId)).discounts).toMatchObject([{ source: 'offer', skipsNoDiscountLines: true }]);
  });

  it('a "from Rs 2,000" offer: Big Two and Rs 500 of fries is Rs 500 towards it — no offer; Rs 2,000 of pizza reaches it', async () => {
    await saveOffers([{ minOrderCents: 200_000 }]);
    const orderId = await counterOrder('takeaway', [
      ['bigTwo', 1],
      ['fries', 1],
    ]);
    expect(liveDiscounts(orderId)).toEqual([]);
    h.session = CASHIER;
    await data('orders:addItem', { orderId, menuItemId: menu.pizza, quantity: 1 });
    // Rs 2,000 of food without the deal: 10% of it.
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'offer', amount_cents: 20_000 }]);
    // Fries off again: Rs 1,500 is under the minimum, the offer comes off.
    await data('orders:removeItem', { orderId, orderItemId: lineOf(orderId, menu.fries) });
    expect(orderRow(orderId)).toMatchObject({ discount_cents: 0 });
  });
});

live('a foodpanda order still covers the deals (it must match the tablet)', () => {
  it('the deal is 20% of everything, Big Two included; a manager’s discount replacing it covers Big Two too', async () => {
    const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
    setBusinessSetting(
      db as never,
      'foodpanda.deal',
      { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null },
      OWNER_ACTOR,
    );
    const orderId = await counterOrder('foodpanda', [
      ['pizza', 1],
      ['bigTwo', 1],
    ]);
    // 20% of Rs 5,100.
    expect(liveDiscounts(orderId)).toMatchObject([{ source: 'foodpanda', amount_cents: 102_000 }]);
    let s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ source: 'foodpanda', skipsNoDiscountLines: false }]);
    expect(fbrLines(s)['Big Two']).toEqual({ net: 2_880, tax: 432, discount: 720 });

    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Match the tablet', approverPin: MANAGER_SECRET });
    const [row] = liveDiscounts(orderId);
    expect(row).toMatchObject({ source: null, amount_cents: 51_000, approved_by_user_id: 'u_mgr' });
    expect(ruleOf(row)).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' });
    s = await snap(orderId);
    expect(fbrLines(s)['Big Two']).toEqual({ net: 3_240, tax: 486, discount: 360 });
  });
});

live('after payment: Reports, FBR and refunds split it as the till did', () => {
  it('profit and food cost: the deal line takes none of the discount; a part refund is spread by each line’s net', async () => {
    const orderId = await counterOrder('takeaway', [
      ['pizza', 1],
      ['bigTwo', 1],
    ]);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    await pay(orderId);
    expect(await reportsSay()).toEqual({
      profit: { 'Test Fajita Pizza': 135_000, 'Big Two': 360_000 },
      foodCost: { 'Test Fajita Pizza': 135_000, 'Big Two': 360_000 },
      foodSales: 495_000,
    });
    // A fifth of the bill back (Rs 1,138.50): Rs 990 before tax, over each line's net (Rs 1,350 and Rs 3,600).
    h.session = CASHIER;
    await data('orders:refund', { orderId, reason: 'Cold pizza', approverPin: MANAGER_SECRET, amountCents: 113_850, method: 'cash' });
    expect(await reportsSay()).toEqual({
      profit: { 'Test Fajita Pizza': 108_000, 'Big Two': 288_000 },
      foodCost: { 'Test Fajita Pizza': 108_000, 'Big Two': 288_000 },
      foodSales: 396_000,
    });
    // The debit note for it: a fifth of each line, Big Two still with no discount key.
    const s = await snap(orderId);
    const note = mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-1', refundedCents: 113_850, refundedAt: new Date().toISOString() });
    expect(note.items.map((i) => [i.productDescription, i.valueSalesExcludingST, i.discount])).toEqual([
      ['Refund: Test Fajita Pizza', 270, 30],
      ['Refund: Big Two', 720, undefined],
    ]);
  });

  it('a discount a v0.7.33 till re-worked over the deals (its rule left as found) is read back from the stored bill: snapshot, FBR and profit add up to it', async () => {
    const orderId = await counterOrder('takeaway', [
      ['pizza', 1],
      ['bigTwo', 1],
    ]);
    // A made-up 5% on Big Two as it was sold, so the two splits tax differently.
    db.prepare(`UPDATE order_items SET tax_rate_bps_snapshot = 500 WHERE order_id = ? AND menu_item_id = ?`).run(orderId, menu.bigTwo);
    h.session = CASHIER;
    await data('orders:applyDiscount', { orderId, discountType: 'percent', value: 10, reason: 'Staff' });
    // This till: Rs 150 off the pizza; tax 15% of Rs 1,350 + 5% of Rs 3,600.
    expect(orderRow(orderId)).toEqual({ subtotal_cents: 510_000, discount_cents: 15_000, tax_cents: 38_250, total_cents: 533_250 });
    // The v0.7.33 till changes the cart and re-works it by the rule it knows (every line but the
    // charge): Rs 510, split Rs 150 / Rs 360; tax 15% of Rs 1,350 + 5% of Rs 3,240. The row's rule stays.
    db.prepare(`UPDATE order_discounts SET amount_cents = 51000, version = version + 1 WHERE order_id = ? AND deleted_at IS NULL`).run(orderId);
    db.prepare(`UPDATE orders SET discount_cents = 51000, tax_cents = 36450, total_cents = 495450, version = version + 1 WHERE id = ?`).run(orderId);
    expect(ruleOf(liveDiscounts(orderId)[0])).toMatchObject({ skipsNoDiscountLines: true });
    await pay(orderId);

    const s = await snap(orderId);
    expect(s.discounts).toMatchObject([{ alsoOffDeliveryCharge: false, skipsNoDiscountLines: false }]);
    expect(fbrLines(s)).toEqual({
      'Test Fajita Pizza': { net: 1_350, tax: 202.5, discount: 150 },
      'Big Two': { net: 3_240, tax: 162, discount: 360 },
    });
    expect(fbrTax(s)).toBe(36_450);
    expect(await reportsSay()).toEqual({
      profit: { 'Test Fajita Pizza': 135_000, 'Big Two': 324_000 },
      foodCost: { 'Test Fajita Pizza': 135_000, 'Big Two': 324_000 },
      foodSales: 510_000 - 51_000,
    });
  });
});
