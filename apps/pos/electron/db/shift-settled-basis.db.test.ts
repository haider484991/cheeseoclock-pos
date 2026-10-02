/**
 * Which orders a shift counts as paid, and its drawer's breakdown (final
 * plan step 19d-1: "the paper, the close box and the result count the same
 * orders"), on real databases built from every migration, driven through
 * the repositories:
 *   - SETTLED_IN_SHIFT_SQL: an order counts in the shift whose till took its
 *     money (the shift of its last payment in), not the shift it was started
 *     in — carried over unpaid and paid in the next shift, taken on the other
 *     till and paid on this one, or an outside rider who paid while out and
 *     was marked delivered in a later shift. A paid Rs 0 order counts in its
 *     own shift; a cancelled order, an empty cart and a deleted test order
 *     never. It reads by index, never a scan of payments or orders;
 *   - getShiftSummary: paidOrderCount is that set, refunded orders included;
 *     refundedOrderCount is the orders money was handed back for in the
 *     shift, in full or in part, each once;
 *   - cashMovementTotals: cash in, the payouts typed by hand, the rider tips
 *     and the riders' payouts (kept charges and trips), each on its own, and
 *     all the cash out still their sum.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';

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
// No printer, no FBR and no alert window here.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL_A = 'till-a';
const TILL_B = 'till-b';
const on = (deviceId: string) => ({
  cashier: { userId: 'u_cash', deviceId },
  manager: { userId: 'u_mgr', deviceId },
});
const A = on(TILL_A);
const B = on(TILL_B);
/** The float: Rs 5,000. */
const FLOAT = 500_000;
/** Rs 200, the area's delivery charge as sold (before its tax): what an outside rider keeps. */
const KEEP = 20_000;

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:00': '2026-10-02T15:00:00.000Z',
  '20:05': '2026-10-02T15:05:00.000Z',
  '20:10': '2026-10-02T15:10:00.000Z',
  '20:20': '2026-10-02T15:20:00.000Z',
  '20:25': '2026-10-02T15:25:00.000Z',
  '20:30': '2026-10-02T15:30:00.000Z',
  '21:00': '2026-10-02T16:00:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

type Row = Record<string, unknown>;
const orderRepo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

interface Menu {
  /** 'Test Zinger Burger', Rs 1,000 at 15%. */
  burger: string;
  /** 'Delivery Charge (Rs 200)' at 15%. */
  charge: string;
}

/** The made-up menu on `db`: a 15% tax, a burger and the area's delivery charge. */
async function menuOn(db: AppDatabase, actor: { userId: string; deviceId: string }): Promise<Menu> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, actor);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, actor);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, actor).id;
  return {
    burger: item(food.id, 'Test Zinger Burger', 100_000),
    charge: item(fees.id, 'Delivery Charge (Rs 200)', KEEP),
  };
}

/** One till: the users, the menu, and a shift opened at 18:00 on the float. */
async function till(): Promise<{ db: AppDatabase; menu: Menu; shiftId: string }> {
  const { openShift } = await shiftRepo();
  at('18:00');
  const db = openTill(TILL_A);
  const menu = await menuOn(db, A.manager);
  const shiftId = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
  return { db, menu, shiftId };
}

/** The ids SETTLED_IN_SHIFT_SQL gives for a shift, sorted. */
async function settled(db: AppDatabase, shiftId: string): Promise<string[]> {
  const { SETTLED_IN_SHIFT_SQL } = await shiftRepo();
  return (db.prepare(SETTLED_IN_SHIFT_SQL).all({ shiftId }) as Row[]).map((r) => String(r['id'])).sort();
}

/** The shift's order counts as the close box shows them. */
async function counts(db: AppDatabase, shiftId: string) {
  const { getShiftSummary } = await shiftRepo();
  const s = getShiftSummary(db, shiftId);
  return { orderCount: s.orderCount, paidOrderCount: s.paidOrderCount, refundedOrderCount: s.refundedOrderCount, voidedOrderCount: s.voidedOrderCount };
}

/** A counter takeaway with `qty` burgers, sent to the kitchen and ready, not paid. */
async function readyTakeaway(
  db: AppDatabase,
  menu: Menu,
  actor: { userId: string; deviceId: string },
  qty = 1,
): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, actor);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: qty, modifierIds: [] }, actor);
  r.sendOrderToKitchen(db, o.id, actor);
  r.markOrderReady(db, o.id, actor);
  return { id: o.id, total: r.findOrder(db, o.id)!.totalCents };
}

/** A counter takeaway with one burger, paid up front (Pay now) by `method`. */
async function paidTakeaway(db: AppDatabase, menu: Menu, method: 'cash' | 'card', actor = A.cashier): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'takeaway' }, actor);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, actor);
  const total = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] }, actor);
  return { id: o.id, total };
}

/** A counter delivery with a burger and the Rs 200 charge, sent out with an outside rider. */
async function sentOut(db: AppDatabase, menu: Menu): Promise<{ id: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(db, { mode: 'delivery' }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
  r.addOrderItem(db, { orderId: o.id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, A.cashier);
  r.sendOrderToKitchen(db, o.id, A.cashier);
  r.markOrderReady(db, o.id, A.cashier);
  const out = r.sendOutOrder(db, o.id, A.cashier);
  expect(out.riderKeepsCents).toBe(KEEP);
  return { id: o.id, total: out.totalCents };
}

/** Close `shiftId` counting exactly the expected cash (and carrying over what is unpaid, with a reason). */
async function closeEven(db: AppDatabase, shiftId: string, actor = A.manager): Promise<void> {
  const { closeShift, getShiftSummary } = await shiftRepo();
  const expected = getShiftSummary(db, shiftId).expectedCashCents;
  closeShift(db, { shiftId, countedCashCents: expected, carryOverReason: 'Test customer pays later' }, actor);
}

live('the orders settled in a shift: counted where the money was taken', () => {
  it('an order started in shift A, carried over unpaid and paid in shift B counts in B, not A', async () => {
    const { db, menu, shiftId: first } = await till();
    const r = await orderRepo();
    const { openShift, findShift } = await shiftRepo();
    at('19:00');
    const o = await readyTakeaway(db, menu, A.cashier, 2);
    at('20:00');
    await closeEven(db, first);
    expect(findShift(db, first)).toMatchObject({ carriedUnpaidCount: 1 });
    at('20:05');
    const second = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    at('20:10');
    r.markOrderServed(db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total, tenderedCents: o.total } }, A.cashier);

    expect(await settled(db, first)).toEqual([]);
    expect(await settled(db, second)).toEqual([o.id]);
    // Started in the first shift, paid in the second: the close box of each
    // says so (it used to count it paid in the first, and none in the second).
    expect(await counts(db, first)).toEqual({ orderCount: 1, paidOrderCount: 0, refundedOrderCount: 0, voidedOrderCount: 0 });
    expect(await counts(db, second)).toEqual({ orderCount: 0, paidOrderCount: 1, refundedOrderCount: 0, voidedOrderCount: 0 });
  });

  it('an order taken on till 2 and paid on till 1 counts on till 1 only, read the same on both tills', async () => {
    const { openShift } = await shiftRepo();
    const r = await orderRepo();
    at('18:00');
    const a = openTill(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const menu = await menuOn(a, A.manager);
    const shiftA = openShift(a, { openingCashCents: FLOAT }, A.manager).id;
    expect(await push(a, TILL_A, b)).toMatchObject({ waiting: 0, dropped: 0 });
    const shiftB = openShift(b, { openingCashCents: FLOAT }, B.manager).id;
    at('19:00');
    const o = await readyTakeaway(b, menu, B.cashier);
    expect(await push(b, TILL_B, a)).toMatchObject({ waiting: 0, dropped: 0 });
    at('19:30');
    r.markOrderServed(a, { orderId: o.id, payment: { method: 'card', amountCents: o.total, tenderedCents: null } }, A.cashier);
    expect(await push(a, TILL_A, b)).toMatchObject({ waiting: 0, dropped: 0 });

    for (const db of [a, b]) {
      expect(await settled(db, shiftA)).toEqual([o.id]);
      expect(await settled(db, shiftB)).toEqual([]);
      expect(await counts(db, shiftA)).toMatchObject({ orderCount: 0, paidOrderCount: 1 });
      expect(await counts(db, shiftB)).toMatchObject({ orderCount: 1, paidOrderCount: 0 });
    }
  });

  it('an outside order settled by Rider paid counts in the shift that took the money; Delivered in a later shift moves nothing', async () => {
    const { db, menu, shiftId: sent } = await till();
    const r = await orderRepo();
    const { openShift, cashMovementTotals } = await shiftRepo();
    at('19:00');
    const o = await sentOut(db, menu);
    at('20:00');
    await closeEven(db, sent); // the rider is still out: carried over
    at('20:05');
    const tookMoney = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    at('20:10');
    r.takeRiderPayment(db, { orderId: o.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    at('20:20');
    await closeEven(db, tookMoney);
    at('20:25');
    const delivered = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    at('20:30');
    r.markOrderDelivered(db, { orderId: o.id, riderKeepsCents: KEEP }, A.cashier);

    expect(await settled(db, sent)).toEqual([]);
    expect(await settled(db, tookMoney)).toEqual([o.id]);
    expect(await settled(db, delivered)).toEqual([]);
    expect(await counts(db, sent)).toMatchObject({ orderCount: 1, paidOrderCount: 0 });
    expect(await counts(db, tookMoney)).toMatchObject({ paidOrderCount: 1 });
    expect(await counts(db, delivered)).toMatchObject({ paidOrderCount: 0 });
    // His kept charge is paid out in the shift that took the money, too.
    expect(cashMovementTotals(db, tookMoney)).toMatchObject({ riderCents: KEEP, riderCount: 1, riderTripCount: 0 });
    expect(cashMovementTotals(db, delivered)).toMatchObject({ riderCents: 0, riderCount: 0 });
  });

  it('a part and a full refund count in refundedOrderCount and both orders stay paid; a refund in a later shift counts there', async () => {
    const { db, menu, shiftId: first } = await till();
    const r = await orderRepo();
    const { openShift } = await shiftRepo();
    at('19:00');
    const part = await paidTakeaway(db, menu, 'cash');
    const full = await paidTakeaway(db, menu, 'card');
    const kept = await paidTakeaway(db, menu, 'cash');
    at('19:30');
    // Two part refunds of one order: one order.
    r.refundOrder(db, { orderId: part.id, reason: 'Test cold fries', approverUserId: A.manager.userId, amountCents: 10_000 }, A.manager);
    r.refundOrder(db, { orderId: part.id, reason: 'Test missing sauce', approverUserId: A.manager.userId, amountCents: 5_000 }, A.manager);
    r.refundOrder(db, { orderId: full.id, reason: 'Test wrong order', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    expect(r.findOrder(db, full.id)?.status).toBe('refunded');

    expect(await settled(db, first)).toEqual([part.id, full.id, kept.id].sort());
    expect(await counts(db, first)).toEqual({ orderCount: 3, paidOrderCount: 3, refundedOrderCount: 2, voidedOrderCount: 0 });

    at('20:00');
    await closeEven(db, first);
    at('20:05');
    const second = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    at('20:10');
    r.refundOrder(db, { orderId: kept.id, reason: 'Test came back next shift', approverUserId: A.manager.userId, foodMade: 'made' }, A.manager);

    // Its money came in in the first shift and went back in the second.
    expect(await settled(db, second)).toEqual([]);
    expect(await counts(db, second)).toEqual({ orderCount: 0, paidOrderCount: 0, refundedOrderCount: 1, voidedOrderCount: 0 });
    expect(await counts(db, first)).toEqual({ orderCount: 3, paidOrderCount: 3, refundedOrderCount: 2, voidedOrderCount: 0 });
  });

  it('a paid Rs 0 order counts in its own shift; a cancelled order, an empty cart and a deleted test order never', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    at('19:00');
    const paid = await paidTakeaway(db, menu, 'card');
    // Rs 0 (a staff meal, 100% off; Pay now with nothing to collect): paid, with no payment row at all.
    const free = r.createOrder(db, { mode: 'takeaway' }, A.cashier);
    r.addOrderItem(db, { orderId: free.id, menuItemId: menu.burger, quantity: 1, modifierIds: [] }, A.cashier);
    r.applyDiscount(db, { orderId: free.id, discountType: 'percent', value: 100, approverUserId: A.manager.userId, reason: 'Test staff meal' }, A.manager);
    expect(r.findOrder(db, free.id)?.totalCents).toBe(0);
    r.tenderOrder(db, { orderId: free.id, payments: [] }, A.cashier);
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`).get(free.id) as Row)['n'])).toBe(0);
    const cancelled = await readyTakeaway(db, menu, A.cashier);
    r.voidOrder(db, { orderId: cancelled.id, reason: 'Test customer left', approverUserId: A.manager.userId, foodMade: 'not_made' }, A.manager);
    r.createOrder(db, { mode: 'takeaway' }, A.cashier); // an empty cart
    const test = await paidTakeaway(db, menu, 'cash');
    // A test order deleted (Order History → Delete test order): the order and its payments soft-deleted.
    at('19:30');
    db.prepare(`UPDATE orders SET deleted_at = ?, delete_kind = 'test' WHERE id = ?`).run(PK['19:30'], test.id);
    db.prepare(`UPDATE payments SET deleted_at = ? WHERE order_id = ?`).run(PK['19:30'], test.id);

    expect(r.findOrder(db, free.id)?.paidAt).not.toBeNull();
    expect(await settled(db, shiftId)).toEqual([paid.id, free.id].sort());
    expect(await counts(db, shiftId)).toEqual({ orderCount: 4, paidOrderCount: 2, refundedOrderCount: 0, voidedOrderCount: 1 });
  });

  it('reads by index — payments by their shift, the order’s own shift, each order’s payments — never a scan of payments or orders', async () => {
    const { db } = await till();
    const { SETTLED_IN_SHIFT_SQL } = await shiftRepo();
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ shiftId: 's_any' }) as Row[]).map((r) => String(r['detail'])).join(' | ');
    for (const p of [plan(SETTLED_IN_SHIFT_SQL), plan(`SELECT COUNT(*) AS n FROM (${SETTLED_IN_SHIFT_SQL})`)]) {
      // The payments taken in the shift; the order's own shift for payments with none (and for Rs 0 orders).
      expect(p).toMatch(/SEARCH p USING (COVERING )?INDEX idx_payments_shift \(shift_id=\?\)/);
      expect(p).toMatch(/SEARCH so USING (COVERING )?INDEX idx_orders_shift \(shift_id=\?\)/);
      expect(p).toMatch(/SEARCH z USING (COVERING )?INDEX idx_orders_shift \(shift_id=\?\)/);
      // Then each order by id, and its payments by order.
      expect(p).toMatch(/SEARCH o USING (COVERING )?INDEX sqlite_autoindex_orders_1 \(id=\?\)/);
      for (const alias of ['sp', 'lp', 'zp']) expect(p).toMatch(new RegExp(`SEARCH ${alias} USING (COVERING )?INDEX idx_payments_order \\(order_id=\\?\\)`));
      // Never every payment with no shift, never a whole table.
      expect(p).not.toMatch(/SEARCH sp USING (COVERING )?INDEX idx_payments_shift/);
      expect(p).not.toMatch(/SCAN (o|p|so|sp|lp|z|zp|orders|payments)( |$)/);
    }
  });
});

live("cashMovementTotals: the drawer's breakdown", () => {
  it('cash in, a payout typed by hand, a rider tip, a kept payout and a trip payout each count on their own; all the cash out is their sum', async () => {
    const { db, menu, shiftId } = await till();
    const r = await orderRepo();
    const { cashMovementTotals, recordCashMovement, getShiftSummary } = await shiftRepo();
    at('19:00');
    recordCashMovement(db, { type: 'payin', amountCents: 100_000, reason: 'Test change from the bank' }, A.manager);
    recordCashMovement(db, { type: 'payin', amountCents: 50_000, reason: 'Test more change' }, A.manager);
    recordCashMovement(db, { type: 'payout', amountCents: 30_000, reason: 'Test gas cylinder' }, A.manager);
    recordCashMovement(db, { type: 'tip_out', amountCents: 5_000, reason: 'Test rider tip' }, A.manager);
    // A kept payout: the outside rider paid the shop while out, keeping his charge.
    const kept = await sentOut(db, menu);
    at('19:30');
    r.takeRiderPayment(db, { orderId: kept.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    // A trip payout: sent out, then cancelled at the door, the rider paid for his trip.
    const wasted = await sentOut(db, menu);
    at('19:45');
    r.voidOrder(db, { orderId: wasted.id, reason: 'Test customer refused at the door', approverUserId: A.manager.userId, payRiderForTrip: true }, A.manager);

    const t = cashMovementTotals(db, shiftId);
    expect(t).toEqual({
      inCents: 150_000,
      inCount: 2,
      outCents: 30_000 + 5_000 + 2 * KEEP,
      payoutCents: 30_000,
      payoutCount: 1,
      tipCents: 5_000,
      tipCount: 1,
      riderCents: 2 * KEEP,
      riderCount: 2,
      riderTripCount: 1,
    });
    expect(t.outCents).toBe(t.payoutCents + t.tipCents + t.riderCents);
    // The close result's "Cash taken out" (and Shift history's "Taken out") is the hand-typed payouts and the tips.
    const s = getShiftSummary(db, shiftId);
    expect(s.cashOutCents - s.riderChargesCents).toBe(t.payoutCents + t.tipCents);
    expect(s).toMatchObject({ cashInCents: t.inCents, cashOutCents: t.outCents, riderChargesCents: t.riderCents, riderChargeCount: 2, riderTripCount: 1 });
    // The expected-cash formula is unchanged: the float, the rider's cash sale, in less out (his charge is in out).
    expect(s.cashSalesCents).toBe(kept.total);
    expect(s.expectedCashCents).toBe(FLOAT + kept.total + t.inCents - t.outCents);
  });
});
