/**
 * Send out after a payment is always later than it (papers note #2, case 1;
 * v0.7.34 review fixes D). Whether a customer paid before the food left or
 * an outside rider paid the shop while out is decided from two stamps alone
 * (shared-types paidAfterItLeft: paid_at >= dispatched_at), and those stamps
 * can come from two tills whose clocks disagree. On real databases built
 * from every migration, driven through the repositories:
 *   - the customer prepays on till B, whose clock is a minute ahead, and till
 *     A sends the order out by its own clock: dispatched_at is paid_at + 1 ms
 *     (A's clock read earlier), so the order stays prepaid — the customer's
 *     paper says PAID - CASH / PREPAID - RIDER COLLECTS NOTHING (never BILL -
 *     NOT PAID / TO COLLECT, so the rider can't collect twice), the SHOP COPY
 *     says the drawer paid him and he gives the shop nothing, the drawer pays
 *     his Rs 200 once, and each till's expected cash is right; the same after
 *     the two tills exchange, in either order, and after Delivered, even on a
 *     till whose clock reads earlier than the time it left;
 *   - one database with paid_at a minute in the future: the same at Send out
 *     and at Assign rider (one of the shop's own riders);
 *   - an unpaid order, and one paid well before it left, are stamped exactly
 *     as before (dispatched_at = now);
 *   - both ways, at every clock gap: a prepaid order never reads as paid
 *     while out, and a rider who pays while out (Rider paid) or at the door
 *     (Delivered + Pay) never reads as a customer who paid before it left.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paidAfterItLeft, type OrderSnapshot } from '@cheeseoclock/shared-types';
import { decodeEscPos, receiptDocumentFor, renderReceipt, riderSettledWhileOut } from '@cheeseoclock/printer-core';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

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
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
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
/** Each till's float: Rs 5,000. */
const FLOAT = 500_000;
/** The area's delivery charge, as sold: what an outside rider keeps. */
const CHARGE = 20_000;
/** Till B's clock reads one minute ahead of till A's. */
const B_AHEAD_MS = 60_000;

/** Evening times in Pakistan (UTC+5) by till A's clock (the right one), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:20': '2026-10-02T15:20:00.000Z',
} as const;
type Clock = keyof typeof PK;
const ms = (t: Clock) => Date.parse(PK[t]);
const iso = (t: number) => new Date(t).toISOString();
/** Till A's clock (or one database's): `t`, plus `plusMs`. */
const at = (t: Clock, plusMs = 0) => vi.setSystemTime(new Date(ms(t) + plusMs));
/** Till B's clock at the same moment: a minute ahead. */
const onB = (t: Clock, plusMs = 0) => at(t, plusMs + B_AHEAD_MS);

type Row = Record<string, unknown>;
const repo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

const BRANDING = { branding: { storeName: 'Test Shop' } };
/** The paper as the printer would print it: each row's words. */
const paperRows = (snap: OrderSnapshot, copy: 'customer' | 'shop' = 'customer') =>
  decodeEscPos(renderReceipt(snap, { ...BRANDING, copy })).map((l) => l.text.replace(/\s+/g, ' ').trim());
const paperText = (snap: OrderSnapshot, copy: 'customer' | 'shop' = 'customer') => paperRows(snap, copy).join(' | ');

const rowOf = (db: AppDatabase, id: string) =>
  db
    .prepare(`SELECT status, paid_at, dispatched_at, delivered_at, rider_keeps_cents, assigned_rider_id, version FROM orders WHERE id = ?`)
    .get(id) as Row;
const payoutsOf = (db: AppDatabase, id: string) =>
  db
    .prepare(`SELECT id, type, amount_cents, shift_id, device_id FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`)
    .all(id) as Row[];
const paymentsOf = (db: AppDatabase, id: string) =>
  db.prepare(`SELECT method, amount_cents, paid_at FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`).all(id) as Row[];
const expectedCash = async (db: AppDatabase, shiftId: string) => (await shiftRepo()).getShiftSummary(db, shiftId).expectedCashCents as number;

function chainWhole(db: AppDatabase): boolean {
  const rows = db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
  return verifyAuditChain(rows).ok;
}

interface Menu {
  pizza: string;
  charge: string;
  rider: string;
}

/** On `db`: a 15% tax, 'Test Fajita Pizza' (Rs 3,900), the area's 'Delivery Charge (Rs 200)' and one of the shop's own riders. */
async function menuOn(db: AppDatabase, manager: { userId: string; deviceId: string }): Promise<Menu> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createRider } = await import('./repositories/rider-repo.js');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, manager);
  const food = createCategory(db, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, manager);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, manager);
  const pizza = createMenuItem(db, { categoryId: food.id, name: 'Test Fajita Pizza', basePriceCents: 390_000, taxCategoryId: tax.id }, manager).id;
  const charge = createMenuItem(db, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: CHARGE, taxCategoryId: tax.id }, manager).id;
  const rider = createRider(db, { name: 'Test Own Rider', phone: '03001112222' }, manager).id;
  return { pizza, charge, rider };
}

/**
 * A delivery rung on `db` for a made-up customer — the pizza and the delivery
 * charge (CUSTOMER PAYS Rs 4,715) — paid in full in cash at the counter at
 * whatever time the caller's clock reads (Pay sends it to the kitchen).
 */
async function ringAndPay(db: AppDatabase, menu: Menu, cashier: { userId: string; deviceId: string }): Promise<{ id: string; total: number }> {
  const r = await repo();
  const c = await import('./repositories/customer-repo.js');
  const id = r.createOrder(db, { mode: 'delivery' }, cashier).id;
  const customer = c.createCustomer(db, { name: 'Test Prepaid Customer', phone: '03005556666' }, cashier);
  const address = c.createAddress(db, { customerId: customer.id, addressLine: 'House 7, Test Street', area: 'Test Block' }, cashier);
  c.snapshotCustomerOntoOrder(db, { orderId: id, customerId: customer.id, addressId: address.id }, cashier);
  r.addOrderItem(db, { orderId: id, menuItemId: menu.pizza, quantity: 1, modifierIds: [] }, cashier);
  r.addOrderItem(db, { orderId: id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, cashier);
  const total = r.findOrder(db, id)!.totalCents as number;
  r.tenderOrder(db, { orderId: id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, cashier);
  return { id, total };
}

/** The same order, unpaid: sent to the kitchen at whatever time the caller's clock reads. */
async function ringUnpaid(db: AppDatabase, menu: Menu, cashier: { userId: string; deviceId: string }): Promise<{ id: string; total: number }> {
  const r = await repo();
  const id = r.createOrder(db, { mode: 'delivery' }, cashier).id;
  r.addOrderItem(db, { orderId: id, menuItemId: menu.pizza, quantity: 1, modifierIds: [] }, cashier);
  r.addOrderItem(db, { orderId: id, menuItemId: menu.charge, quantity: 1, modifierIds: [] }, cashier);
  r.sendOrderToKitchen(db, id, cashier);
  return { id, total: r.findOrder(db, id)!.totalCents as number };
}

/** The prepaid papers: the customer's says prepaid and nothing to collect; the SHOP COPY says the drawer paid him. */
function expectPrepaidPapers(snap: OrderSnapshot): void {
  expect(paidAfterItLeft(snap.order)).toBe(false);
  expect(riderSettledWhileOut(snap.order)).toBe(false);
  expect(receiptDocumentFor(snap)).toBe('receipt');
  const customer = paperRows(snap);
  expect(customer).toContain('PAID - CASH');
  expect(customer).toContain('PREPAID - RIDER COLLECTS NOTHING');
  const words = paperText(snap);
  for (const never of ['NOT PAID', 'TO COLLECT', 'Pay the rider']) expect(words).not.toContain(never);
  const shop = paperText(snap, 'shop');
  expect(shop).toContain('Paid to him from the drawer');
  expect(shop).toContain('RIDER GIVES THE SHOP NOTHING');
  expect(shop).not.toContain('RIDER PAID THE SHOP');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('two tills: the customer prepays on till B (its clock a minute ahead), till A sends the order out by its own clock', () => {
  /**
   * Two tills on the link, the menu made on A and sent to B, a shift on each
   * (Rs 5,000 float). B rings the order and takes the customer's cash when
   * the real time is 19:50 (B's clock reads 19:51); it reaches A; A marks it
   * Ready at 19:50:10 and sends it out at 19:50:20, both by A's clock.
   */
  async function scene() {
    const r = await repo();
    const { openShift } = await shiftRepo();
    at('18:00');
    const a = openTill(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const menu = await menuOn(a, A.manager);
    const shiftA = openShift(a, { openingCashCents: FLOAT }, A.manager).id;
    await push(a, TILL_A, b);
    onB('18:00');
    const shiftB = openShift(b, { openingCashCents: FLOAT }, B.manager).id;
    await push(b, TILL_B, a);

    onB('19:50');
    const { id, total } = await ringAndPay(b, menu, B.cashier);
    expect(r.findOrder(b, id)!.paidAt).toBe(iso(ms('19:50') + B_AHEAD_MS));
    await push(b, TILL_B, a);

    at('19:50', 10_000);
    r.markOrderReady(a, id, A.cashier);
    at('19:50', 20_000);
    const sent = r.sendOutOrder(a, id, A.cashier);
    return { a, b, menu, shiftA, shiftB, id, total, sent };
  }

  it('dispatched_at is paid_at + 1 ms, so the papers say PREPAID - RIDER COLLECTS NOTHING; the drawer pays his Rs 200 once', async () => {
    const r = await repo();
    const s = await scene();
    const paidAt = iso(ms('19:50') + B_AHEAD_MS);

    // A's clock read 19:50:20, earlier than B's stamp: the food left just after the payment.
    expect(s.sent).toMatchObject({ status: 'out_for_delivery', paidAt, riderKeepsCents: CHARGE, drawerOpenId: expect.any(String) });
    expect(s.sent.dispatchedAt).toBe(iso(Date.parse(paidAt) + 1));
    expect(Date.parse(s.sent.dispatchedAt!)).toBeGreaterThan(Date.parse(s.sent.paidAt!));
    expect(rowOf(s.a, s.id)).toMatchObject({ status: 'out_for_delivery', paid_at: paidAt, dispatched_at: iso(Date.parse(paidAt) + 1) });

    expectPrepaidPapers(r.getOrderSnapshot(s.a, s.id)!);

    // His fee from A's drawer, once; the customer's cash is in B's.
    expect(payoutsOf(s.a, s.id)).toEqual([expect.objectContaining({ type: 'payout', amount_cents: CHARGE, shift_id: s.shiftA, device_id: TILL_A })]);
    expect(paymentsOf(s.a, s.id)).toEqual([expect.objectContaining({ method: 'cash', amount_cents: s.total, paid_at: paidAt })]);
    expect(await expectedCash(s.a, s.shiftA)).toBe(FLOAT - CHARGE);
    expect(await expectedCash(s.b, s.shiftB)).toBe(FLOAT + s.total);

    // Settled with him: Assign rider and Back to Ready refuse, as for any prepaid order sent out.
    expect(() => r.unassignRiderFromOrder(s.a, s.id, A.cashier)).toThrow(r.RIDER_MONEY_SETTLED);
    expect(() => r.assignRiderToOrder(s.a, s.id, s.menu.rider, A.cashier)).toThrow(r.RIDER_MONEY_SETTLED);
    expect(chainWhole(s.a)).toBe(true);
  });

  it.each(['A', 'B'] as const)(
    "after the tills exchange (%s's queue first): the same row and papers on both, one payout, each till's cash as before",
    async (first) => {
      const r = await repo();
      const s = await scene();
      if (first === 'A') {
        await push(s.a, TILL_A, s.b);
        await push(s.b, TILL_B, s.a);
      } else {
        await push(s.b, TILL_B, s.a);
        await push(s.a, TILL_A, s.b);
      }
      expect(rowOf(s.b, s.id)).toEqual(rowOf(s.a, s.id));
      for (const db of [s.a, s.b]) {
        expectPrepaidPapers(r.getOrderSnapshot(db, s.id)!);
        expect(payoutsOf(db, s.id)).toEqual([expect.objectContaining({ amount_cents: CHARGE, device_id: TILL_A })]);
        expect(paymentsOf(db, s.id)).toHaveLength(1);
      }
      expect(payoutsOf(s.b, s.id)[0]!['id']).toBe(payoutsOf(s.a, s.id)[0]!['id']);
      expect(await expectedCash(s.a, s.shiftA)).toBe(FLOAT - CHARGE);
      expect(await expectedCash(s.b, s.shiftB)).toBe(FLOAT + s.total);
      expect(chainWhole(s.a)).toBe(true);
      expect(chainWhole(s.b)).toBe(true);
    },
  );

  it('Delivered closes it with no payment and no second payout, and the receipt still says PREPAID — even on a clock that reads before it left', async () => {
    const r = await repo();
    const s = await scene();
    const left = s.sent.dispatchedAt!;
    // A's clock at 19:50:40 still reads earlier than the time it left (B's 19:51 + 1 ms).
    at('19:50', 40_000);
    const done = r.markOrderDelivered(s.a, { orderId: s.id, riderKeepsCents: CHARGE }, A.cashier);
    expect(done).toMatchObject({ status: 'paid', paidAt: s.sent.paidAt, deliveredAt: left, drawerOpenId: null });
    const snap = r.getOrderSnapshot(s.a, s.id)!;
    expect(paperRows(snap)).toContain('PREPAID - RIDER COLLECTS NOTHING');
    expect(paperText(snap)).not.toContain('PAID ON DELIVERY');
    expect(paperText(snap, 'shop')).toContain('RIDER GIVES THE SHOP NOTHING');
    expect(payoutsOf(s.a, s.id)).toHaveLength(1);
    expect(paymentsOf(s.a, s.id)).toHaveLength(1);
    expect(await expectedCash(s.a, s.shiftA)).toBe(FLOAT - CHARGE);

    // Later, by a clock past it: delivered now, as before.
    const s2 = await scene();
    at('20:20');
    expect(r.markOrderDelivered(s2.a, { orderId: s2.id, riderKeepsCents: CHARGE }, A.cashier)).toMatchObject({ status: 'paid', deliveredAt: PK['20:20'] });
    expect(paperRows(r.getOrderSnapshot(s2.a, s2.id)!)).toContain('PREPAID - RIDER COLLECTS NOTHING');
  });
});

live('one till, paid_at a minute in the future (a clock set back after the payment)', () => {
  async function till() {
    const { openShift } = await shiftRepo();
    at('18:00');
    const db = openTill(TILL_A);
    const menu = await menuOn(db, A.manager);
    const shiftId = openShift(db, { openingCashCents: FLOAT }, A.manager).id;
    return { db, menu, shiftId };
  }

  it('Send out: dispatched_at is paid_at + 1 ms; prepaid papers; one payout; the drawer expects the float plus the total less his fee', async () => {
    const r = await repo();
    const t = await till();
    at('19:50', 60_000);
    const o = await ringAndPay(t.db, t.menu, A.cashier);
    at('19:45');
    r.markOrderReady(t.db, o.id, A.cashier);
    at('19:50');
    const sent = r.sendOutOrder(t.db, o.id, A.cashier);
    expect(sent.paidAt).toBe(iso(ms('19:50') + 60_000));
    expect(sent.dispatchedAt).toBe(iso(ms('19:50') + 60_001));
    expectPrepaidPapers(r.getOrderSnapshot(t.db, o.id)!);
    expect(payoutsOf(t.db, o.id)).toEqual([expect.objectContaining({ type: 'payout', amount_cents: CHARGE, shift_id: t.shiftId })]);
    expect(await expectedCash(t.db, t.shiftId)).toBe(FLOAT + o.total - CHARGE);
    // The order's sync row and its 'send_out' audit row carry the same stamp.
    const sync = t.db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(o.id) as Row;
    expect(JSON.parse(String(sync['payload_json']))).toMatchObject({ status: 'out_for_delivery', dispatchedAt: sent.dispatchedAt });
    const audit = t.db
      .prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'send_out'`)
      .all(o.id) as Row[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]!['after_json']))).toMatchObject({ dispatchedAt: sent.dispatchedAt });
    expect(chainWhole(t.db)).toBe(true);
  });

  it("Assign rider (one of the shop's own): dispatched_at is paid_at + 1 ms, and the receipt says PREPAID - RIDER COLLECTS NOTHING", async () => {
    const r = await repo();
    const t = await till();
    at('19:50', 60_000);
    const o = await ringAndPay(t.db, t.menu, A.cashier);
    at('19:50');
    const assigned = r.assignRiderToOrder(t.db, o.id, t.menu.rider, A.cashier);
    expect(assigned.dispatchedAt).toBe(iso(ms('19:50') + 60_001));
    const snap = r.getOrderSnapshot(t.db, o.id)!;
    expect(paidAfterItLeft(snap.order)).toBe(false);
    expect(paperRows(snap)).toContain('PREPAID - RIDER COLLECTS NOTHING');
    expect(payoutsOf(t.db, o.id)).toEqual([]);
  });

  it('an unpaid order, and one paid well before it left, are stamped exactly as before: dispatched_at = now', async () => {
    const r = await repo();
    const t = await till();
    at('19:30');
    const cod = await ringUnpaid(t.db, t.menu, A.cashier);
    at('19:50');
    expect(r.sendOutOrder(t.db, cod.id, A.cashier).dispatchedAt).toBe(PK['19:50']);
    // Back to Ready and out again later: the new time, as before.
    at('19:50', 5 * 60_000);
    r.unassignRiderFromOrder(t.db, cod.id, A.cashier);
    expect(r.sendOutOrder(t.db, cod.id, A.cashier).dispatchedAt).toBe(iso(ms('19:50') + 5 * 60_000));
    // One of the shop's own riders on an unpaid order.
    at('19:30');
    const own = await ringUnpaid(t.db, t.menu, A.cashier);
    at('19:50');
    expect(r.assignRiderToOrder(t.db, own.id, t.menu.rider, A.cashier).dispatchedAt).toBe(PK['19:50']);
    // Paid at 19:30, out at 19:50: now.
    at('19:30');
    const early = await ringAndPay(t.db, t.menu, A.cashier);
    at('19:50');
    expect(r.sendOutOrder(t.db, early.id, A.cashier)).toMatchObject({ paidAt: PK['19:30'], dispatchedAt: PK['19:50'] });
  });
});

live('both ways, at every clock gap: prepaid stays prepaid, and a rider who pays after it left stays the rider', () => {
  /** How much later (or earlier, below 0) the second action's clock reads than the first's. */
  const GAPS = [-5 * 60_000, -60_000, -1, 0, 1, 60_000];

  async function till() {
    const { openShift } = await shiftRepo();
    at('18:00');
    const db = openTill(TILL_A);
    const menu = await menuOn(db, A.manager);
    openShift(db, { openingCashCents: FLOAT }, A.manager);
    return { db, menu };
  }

  it.each(GAPS)('paid, then Send out %i ms later by the clock: the order left after it was paid, and the papers say prepaid', async (gap) => {
    const r = await repo();
    const t = await till();
    at('19:50');
    const o = await ringAndPay(t.db, t.menu, A.cashier);
    at('19:50', gap);
    const sent = r.sendOutOrder(t.db, o.id, A.cashier);
    expect(Date.parse(sent.dispatchedAt!)).toBeGreaterThan(Date.parse(sent.paidAt!));
    expect(sent.dispatchedAt).toBe(gap > 0 ? iso(ms('19:50') + gap) : iso(ms('19:50') + 1));
    expectPrepaidPapers(r.getOrderSnapshot(t.db, o.id)!);
    expect(payoutsOf(t.db, o.id)).toHaveLength(1);
  });

  it.each(GAPS)('Send out, then Rider paid %i ms later by the clock: paid at or after it left — a bill to collect, the rider paid the shop', async (gap) => {
    const r = await repo();
    const t = await till();
    at('19:30');
    const o = await ringUnpaid(t.db, t.menu, A.cashier);
    at('19:50');
    r.sendOutOrder(t.db, o.id, A.cashier);
    at('19:50', gap);
    const paid = r.takeRiderPayment(t.db, { orderId: o.id, method: 'cash', riderKeepsCents: CHARGE }, A.cashier);
    expect(Date.parse(paid.paidAt!)).toBeGreaterThanOrEqual(Date.parse(paid.dispatchedAt!));
    const snap = r.getOrderSnapshot(t.db, o.id)!;
    expect(paidAfterItLeft(snap.order)).toBe(true);
    expect(riderSettledWhileOut(snap.order)).toBe(true);
    expect(receiptDocumentFor(snap)).toBe('bill');
    expect(paperText(snap)).toContain('TO COLLECT');
    expect(paperText(snap)).not.toContain('PREPAID');
    expect(paperText(snap, 'shop')).toContain('RIDER PAID THE SHOP');
    expect(payoutsOf(t.db, o.id)).toHaveLength(1);
  });

  it.each(GAPS)('Send out, then Delivered + Pay %i ms later by the clock: paid when it was delivered, the rider paid the shop', async (gap) => {
    const r = await repo();
    const t = await till();
    at('19:30');
    const o = await ringUnpaid(t.db, t.menu, A.cashier);
    at('19:50');
    r.sendOutOrder(t.db, o.id, A.cashier);
    at('19:50', gap);
    const done = r.markOrderDelivered(t.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: CHARGE }, A.cashier);
    const when = gap > 0 ? iso(ms('19:50') + gap) : PK['19:50'];
    expect(done).toMatchObject({ status: 'paid', paidAt: when, deliveredAt: when });
    const snap = r.getOrderSnapshot(t.db, o.id)!;
    expect(paidAfterItLeft(snap.order)).toBe(true);
    expect(paperRows(snap)).toContain('PAID ON DELIVERY');
    expect(paperText(snap)).not.toContain('PREPAID');
    const shop = paperText(snap, 'shop');
    expect(shop).toContain('RIDER PAID THE SHOP');
    expect(shop).not.toContain('RIDER GIVES THE SHOP NOTHING');
    expect(payoutsOf(t.db, o.id)).toHaveLength(1);
  });
});
