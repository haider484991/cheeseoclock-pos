/**
 * What the owner's phone dashboard is sent (dashboard-docs.ts), read from a
 * real database built from every migration and filled through the
 * repositories, as the till fills it:
 *   - each order whole, with the till's own verdicts: counted as Reports
 *     count a sale (paid, not cancelled or refunded in full, not deleted),
 *     its net after refunds, its trading day and Karachi hour, its channel,
 *     the delivery charge marked, every payment and discount, who did what;
 *   - only what changed since a cursor, oldest change first, a payment or a
 *     refund moving its order on;
 *   - shifts, cash in and out, the drawer log, stock and its movements, the
 *     menu; the day figures are the Reports builders' own for that day;
 *   - the live block: the open shift's drawer as the close box has it.
 *
 * node's `node:sqlite` stands in for better-sqlite3 (skipped where missing).
 * Every name, item and amount is made up (the repository is public).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashKarachiHour, type ReportTabFigures } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync } from '../db/costing-shop.fixture.js';
import { TEST_USERS, openTill } from '../db/two-tills.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
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
vi.mock('./print-spooler.js', () => ({ printSpooler: new Proxy({}, { get: () => () => undefined }), drawerFailureText: () => '' }));
vi.mock('./fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('./order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL = 'till-dash';
const CASHIER = { userId: TEST_USERS.cashier.userId, deviceId: TILL };
const MANAGER = { userId: TEST_USERS.manager.userId, deviceId: TILL };
const OWNER = { userId: TEST_USERS.owner.userId, deviceId: TILL };
const FLOAT = 500_000;

const docs = () => import('./dashboard-docs.js');
const orderRepo = () => import('../db/repositories/order-repo.js');
const shiftRepo = () => import('../db/repositories/shift-repo.js');

interface Shop {
  db: AppDatabase;
  burger: string;
  charge: string;
  shiftId: string;
}

async function shop(): Promise<Shop> {
  const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../db/repositories/menu-item-repo.js');
  const { openShift } = await shiftRepo();
  const db = openTill(TILL);
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, MANAGER);
  const burger = createMenuItem(db, { categoryId: food.id, name: 'Test Zinger Burger', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  const charge = createMenuItem(db, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: tax.id }, MANAGER).id;
  const shiftId = openShift(db, { openingCashCents: FLOAT }, CASHIER).id;
  return { db, burger, charge, shiftId };
}

async function paid(s: Shop, method: 'cash' | 'card' = 'cash', qty = 1): Promise<string> {
  const r = await orderRepo();
  const o = r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
  r.addOrderItem(s.db, { orderId: o.id, menuItemId: s.burger, quantity: qty, modifierIds: [] }, CASHIER);
  const total = r.findOrder(s.db, o.id)!.totalCents;
  r.tenderOrder(s.db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total + 5_000 : null }] }, CASHIER);
  return o.id;
}

const one = async (db: AppDatabase, id: string) => {
  const d = await docs();
  const [doc] = d.buildOrderDocs(db, [id]);
  expect(doc).toBeTruthy();
  return doc!;
};

beforeEach(() => {
  vi.useRealTimers();
});

live('orders as documents', () => {
  it('a paid takeaway: counted, its net, its day and hour, the line and the payment with change, who took it', async () => {
    const s = await shop();
    const id = await paid(s, 'cash', 2);
    const doc = await one(s.db, id);
    expect(doc).toMatchObject({
      id,
      deviceId: TILL,
      status: 'sent_to_kitchen',
      mode: 'takeaway',
      source: 'pos',
      channel: 'takeaway',
      counted: true,
      deleted: null,
      subtotalCents: 200_000,
      taxCents: 30_000,
      totalCents: 230_000,
      refundedCents: 0,
      netCents: 230_000,
      cashier: TEST_USERS.cashier.name,
      shiftId: s.shiftId,
    });
    expect(doc.tradingDay).toBe(doc.createdAt.slice(0, 10));
    expect(doc.hour).toBe(dashKarachiHour(doc.createdAt));
    expect(doc.lines).toEqual([
      expect.objectContaining({ name: 'Test Zinger Burger', category: 'Test Burgers', qty: 2, unitPriceCents: 100_000, lineTotalCents: 200_000, isFee: false, costCents: null }),
    ]);
    expect(doc.payments).toEqual([expect.objectContaining({ method: 'cash', amountCents: 230_000, tenderedCents: 235_000, by: TEST_USERS.cashier.name, shiftId: s.shiftId })]);
  });

  it('a part refund lowers the net and stays counted; a full refund and a cancel are not counted; a deleted test order says so', async () => {
    const s = await shop();
    const r = await orderRepo();
    const part = await paid(s, 'card');
    r.refundOrder(s.db, { orderId: part, reason: 'Test cold fries', approverUserId: MANAGER.userId, amountCents: 10_000 }, MANAGER);
    const full = await paid(s, 'cash');
    r.refundOrder(s.db, { orderId: full, reason: 'Test wrong order', approverUserId: MANAGER.userId, foodMade: 'not_made' }, MANAGER);
    const open = r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
    r.addOrderItem(s.db, { orderId: open.id, menuItemId: s.burger, quantity: 1, modifierIds: [] }, CASHIER);
    r.sendOrderToKitchen(s.db, open.id, CASHIER);
    r.voidOrder(s.db, { orderId: open.id, reason: 'Test customer left', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    const test = await paid(s, 'card');
    r.deleteTestOrder(s.db, { orderId: test, reason: 'Test training', restock: true, expectStatus: 'sent_to_kitchen', ownerUserId: OWNER.userId }, OWNER);

    const d = await one(s.db, part);
    expect(d).toMatchObject({ counted: true, refundedCents: 10_000, netCents: 115_000 - 10_000 });
    expect(d.payments.map((p) => p.amountCents)).toEqual([115_000, -10_000]);
    expect(await one(s.db, full)).toMatchObject({ status: 'refunded', counted: false, refundedCents: 115_000, netCents: 0 });
    expect(await one(s.db, open.id)).toMatchObject({ status: 'void', counted: false, voidReason: 'Test customer left', voidedBy: TEST_USERS.manager.name });
    expect(await one(s.db, test)).toMatchObject({ deleted: 'test', counted: false, deleteReason: 'Test training', deletedBy: TEST_USERS.owner.name });
  });

  it('a delivery: the charge is marked as such, the customer travels, an outside rider keeps the charge', async () => {
    const s = await shop();
    const r = await orderRepo();
    const o = r.createOrder(s.db, { mode: 'delivery' }, CASHIER);
    r.addOrderItem(s.db, { orderId: o.id, menuItemId: s.burger, quantity: 1, modifierIds: [] }, CASHIER);
    r.addOrderItem(s.db, { orderId: o.id, menuItemId: s.charge, quantity: 1, modifierIds: [] }, CASHIER);
    s.db
      .prepare(`UPDATE orders SET customer_name_snapshot = ?, customer_phone_snapshot = ?, delivery_address_snapshot = ? WHERE id = ?`)
      .run('Test Customer', '+923001112223', JSON.stringify({ addressLine: 'House 1, Test Street', area: 'Test Phase 6', city: 'Karachi' }), o.id);
    r.sendOrderToKitchen(s.db, o.id, CASHIER);
    r.markOrderReady(s.db, o.id, CASHIER);
    r.sendOutOrder(s.db, o.id, CASHIER);
    const doc = await one(s.db, o.id);
    expect(doc.channel).toBe('delivery');
    expect(doc.lines.map((l) => [l.name, l.isFee])).toEqual([
      ['Test Zinger Burger', false],
      ['Delivery Charge (Rs 200)', true],
    ]);
    expect(doc.customer).toEqual({ name: 'Test Customer', phone: '+923001112223', address: 'House 1, Test Street', area: 'Test Phase 6' });
    expect(doc.riderKeepsCents).toBe(20_000);
    expect(doc.counted).toBe(false); // sent out, not paid yet
  });

  it('only what changed after the cursor, oldest change first; a refund moves its order on', async () => {
    const s = await shop();
    const d = await docs();
    const r = await orderRepo();
    const a = await paid(s);
    const b = await paid(s);
    const all = d.changedOrders(s.db, d.lookFrom(null), 100);
    expect(all.map((x) => x.id)).toEqual([a, b]);
    const last = all[all.length - 1]!;
    const key = { at: last.at, id: last.id };
    expect(d.changedOrders(s.db, key, 100)).toEqual([]);
    await new Promise((res) => setTimeout(res, 5));
    r.refundOrder(s.db, { orderId: a, reason: 'Test cold', approverUserId: MANAGER.userId, amountCents: 5_000 }, MANAGER);
    expect(d.changedOrders(s.db, key, 100).map((x) => x.id)).toEqual([a]);
    // After a start the look begins a little before the cursor (a late write is not missed).
    expect(d.lookFrom(last.at).at < last.at).toBe(true);
    expect(d.lookFrom(null)).toEqual({ at: '', id: '' });
  });

  it('rows sharing one updated_at go in turns, by id, never read twice (a migration that stamped them all at once)', async () => {
    const s = await shop();
    const d = await docs();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await paid(s));
    const stamp = '2026-10-01T10:00:00.000Z';
    for (const t of ['orders', 'order_items', 'order_item_modifiers', 'payments', 'order_discounts', 'order_item_costs', 'order_channel_terms']) {
      s.db.prepare(`UPDATE ${t} SET updated_at = ?`).run(stamp);
    }
    const seen: string[] = [];
    let key = d.lookFrom(null);
    for (let turn = 0; turn < 10; turn++) {
      const batch = d.changedOrders(s.db, key, 2);
      if (batch.length === 0) break;
      seen.push(...batch.map((x) => x.id));
      const last = batch[batch.length - 1]!;
      key = { at: last.at, id: last.id };
    }
    expect(seen).toEqual([...ids].sort());
  });
});

live('shifts, cash, the drawer, stock and the menu', () => {
  it('a shift with cash out, closed; its drawer log; the live block before the close has the close box’s figures', async () => {
    const s = await shop();
    const d = await docs();
    const sr = await shiftRepo();
    await paid(s, 'cash');
    sr.recordCashMovement(s.db, { type: 'payout', amountCents: 20_000, reason: 'Test gas cylinder' }, MANAGER);
    const liveBlock = d.liveBlock(s.db, TILL, new Date(), { web: { linked: true, ordersOn: true, accepting: true, pausedByShift: false }, notPrinted: 0 });
    expect(liveBlock.shift).toMatchObject({ id: s.shiftId, openingCashCents: FLOAT, cashSalesCents: 115_000, cashOutCents: 20_000, expectedCashCents: FLOAT + 115_000 - 20_000 });
    expect(liveBlock.board.kitchen).toBe(1);

    const moves = d.changedCashMoves(s.db, d.lookFrom(null), 100);
    expect(moves).toEqual([expect.objectContaining({ shiftId: s.shiftId, deviceId: TILL, type: 'payout', amountCents: 20_000, reason: 'Test gas cylinder', deleted: false })]);
    const opens = d.changedDrawerOpens(s.db, d.lookFrom(null), 100);
    expect(opens.map((o) => o.kind)).toEqual(expect.arrayContaining(['payout']));

    const shifts = d.changedShifts(s.db, d.lookFrom(null), 100);
    expect(shifts).toEqual([expect.objectContaining({ id: s.shiftId, closedAt: null, openingCashCents: FLOAT })]);
  });

  it('stock: this till’s count, its low mark, the price per thousand; a waste row; the menu with its tax and web switch', async () => {
    const s = await shop();
    const d = await docs();
    const { createIngredient } = await import('../db/repositories/ingredient-repo.js');
    const { recordStockMovement } = await import('../db/repositories/stock-movement-repo.js');
    const cheese = createIngredient(s.db, { name: 'Test Cheese', unit: 'g', lowThreshold: 1_000 }, MANAGER);
    recordStockMovement(s.db, { ingredientId: cheese.id, deltaQty: 5_000, reason: 'delivery' }, MANAGER);
    recordStockMovement(s.db, { ingredientId: cheese.id, deltaQty: -4_200, reason: 'waste', notes: 'Test dropped' }, MANAGER);
    const stock = d.stockSnapshot(s.db);
    expect(stock).toEqual([expect.objectContaining({ name: 'Test Cheese', unit: 'g', onHand: 800, lowAt: 1_000, active: true })]);
    const moves = d.changedStockMoves(s.db, d.lookFrom(null), 100, new Date());
    expect(moves.map((m) => [m.reason, m.delta, m.ingredient])).toEqual([
      ['delivery', 5_000, 'Test Cheese'],
      ['waste', -4_200, 'Test Cheese'],
    ]);
    const live = d.liveBlock(s.db, TILL, new Date(), { web: { linked: false, ordersOn: false, accepting: false, pausedByShift: false }, notPrinted: 2 });
    expect(live.lowStock).toBe(1);
    expect(live.notPrinted).toBe(2);

    s.db.prepare(`UPDATE menu_items SET web_availability = 'off' WHERE id = ?`).run(s.burger);
    const menu = d.menuSnapshot(s.db, new Date());
    expect(menu.categories.map((c) => c.name).sort()).toEqual(['Delivery Charges', 'Test Burgers']);
    expect(menu.items.find((i) => i.id === s.burger)).toMatchObject({ name: 'Test Zinger Burger', priceCents: 100_000, web: 'off', taxRateBps: 1_500, active: true });
  });

  it('a day’s figures are the Reports builders’ own for that day', async () => {
    const s = await shop();
    const d = await docs();
    const { buildReportTab } = await import('./analytics/report-tabs.js');
    await paid(s, 'cash');
    await paid(s, 'card', 2);
    const day = new Date().toISOString().slice(0, 10);
    const f = d.dayFigures(s.db, day, new Date(), false);
    const want = buildReportTab(s.db, 'foodStock', { sinceIso: `${day}T00:00:00.000Z`, untilIso: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() }) as ReportTabFigures<'foodStock'>;
    expect(f.food.foodSalesCents).toBe(want.foodCost.foodSalesCents);
    expect(f.food.foodSalesCents).toBe(300_000);
    expect(f.shopWide).toBe(false);
    expect(f.profit?.steps.find((x) => x.key === 'sales')?.cents).toBe(300_000);
    expect(d.daysWithOrders(s.db)).toEqual([day]);
  });
});
