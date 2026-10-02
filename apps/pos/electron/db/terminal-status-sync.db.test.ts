/**
 * Two tills, one order (order-edit finding #9; v0.7.34): a cancel or a
 * refund is never undone by a status tap on the other till — but money
 * taken always beats a cancel. On two real databases built from every
 * migration, driven through the repositories, each till's queue applied on
 * the other exactly as the sync worker does (two-tills.fixture push), in
 * either order:
 *   - till A sends out an order (the later tap) while till B cancels it from
 *     the same version: both read 'void' with B's who, when and why; A noted
 *     'remote_cancel_applied', B 'remote_change_kept_cancelled';
 *   - a refund on B racing Delivered on A: 'refunded' on both;
 *   - Rider paid on A (payment, the rider's kept payout, the drawer row)
 *     racing a cancel on B that paid the rider for his trip: both read out
 *     for delivery and paid, A's money untouched and its expected cash the
 *     same; A noted 'remote_cancel_refused_paid', B
 *     'remote_payment_overrode_cancel' with its trip payout and its stock
 *     answer (nothing reversed); a later Delivered on A still reaches B;
 *   - deletion still wins over all of it: a cancel and a test delete on B
 *     racing Rider paid on A leave the order deleted on both, never void
 *     over A's payment;
 *   - cancelled on both tills, and a live tap racing a live tap: plain last
 *     write wins, and none of those audit rows;
 *   - an image from a till on v0.7.33 (no sentAt / riderKeepsCents keys)
 *     still applies, nothing left waiting;
 *   - and each till's audit chain verifies whole.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncChange } from '@cheeseoclock/sync-core';
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
const REASON = 'Customer changed order';

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:40': '2026-10-02T14:40:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '19:55': '2026-10-02T14:55:00.000Z',
  '20:00': '2026-10-02T15:00:00.000Z',
  '20:05': '2026-10-02T15:05:00.000Z',
  '20:10': '2026-10-02T15:10:00.000Z',
  '20:30': '2026-10-02T15:30:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

type Row = Record<string, unknown>;
const repo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

interface Shop {
  a: AppDatabase;
  b: AppDatabase;
  shiftA: string;
  shiftB: string;
  pizza: string;
  charge: string;
}

/**
 * Two tills on the link: on A a 15% tax, a 'Test Fajita Pizza' (Rs 1,500)
 * made from 'Test dough', the area's 'Delivery Charge (Rs 200)'; a shift
 * opened at 18:00 on a Rs 5,000 float on each till; everything sent both ways.
 */
async function shop(): Promise<Shop> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createIngredient, setRecipeForItem } = await import('./repositories/ingredient-repo.js');
  const { openShift } = await shiftRepo();
  at('18:00');
  const a = openTill(TILL_A);
  const b = openTill(TILL_B, { usersFrom: TILL_A });
  const tax = createTaxCategory(a, { name: 'Test GST', rateBps: 1_500 }, A.manager);
  const food = createCategory(a, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, A.manager);
  const fees = createCategory(a, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, A.manager);
  const pizza = createMenuItem(a, { categoryId: food.id, name: 'Test Fajita Pizza', basePriceCents: 150_000, taxCategoryId: tax.id }, A.manager).id;
  const charge = createMenuItem(a, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: CHARGE, taxCategoryId: tax.id }, A.manager).id;
  const dough = createIngredient(a, { name: 'Test dough', unit: 'g', currentQty: 100_000, costPerUnitCents: 0 }, A.manager).id;
  setRecipeForItem(a, pizza, [{ ingredientId: dough, qtyPerUnit: 200 }], A.manager);
  const shiftA = openShift(a, { openingCashCents: FLOAT }, A.manager).id;
  await pushOk(a, TILL_A, b);
  const shiftB = openShift(b, { openingCashCents: FLOAT }, B.manager).id;
  await pushOk(b, TILL_B, a);
  return { a, b, shiftA, shiftB, pizza, charge };
}

async function pushOk(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
  const res = await push(from, fromDevice, to);
  expect(res).toMatchObject({ waiting: 0, dropped: 0 });
}

/** Each till's queue applied on the other: A's first, or B's first. */
async function exchange(s: Shop, first: 'A' | 'B'): Promise<void> {
  if (first === 'A') {
    await pushOk(s.a, TILL_A, s.b);
    await pushOk(s.b, TILL_B, s.a);
  } else {
    await pushOk(s.b, TILL_B, s.a);
    await pushOk(s.a, TILL_A, s.b);
  }
}

/**
 * A counter delivery rung on till A at 19:00 — the pizza and the delivery
 * charge — sent to the kitchen at 19:30 (its dough leaves A's stock) and
 * Ready at 19:45; prepaid in cash at 19:30 when asked; then sent to till B.
 */
async function readyDelivery(s: Shop, opts: { prepaid?: boolean } = {}): Promise<{ id: string; total: number }> {
  const r = await repo();
  at('19:00');
  const id = r.createOrder(s.a, { mode: 'delivery' }, A.cashier).id;
  if (opts.prepaid) {
    // Pay needs a delivery's customer: a made-up one.
    const c = await import('./repositories/customer-repo.js');
    const customer = c.createCustomer(s.a, { name: 'Test Customer', phone: '03001234567' }, A.cashier);
    const address = c.createAddress(s.a, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Block' }, A.cashier);
    c.snapshotCustomerOntoOrder(s.a, { orderId: id, customerId: customer.id, addressId: address.id }, A.cashier);
  }
  r.addOrderItem(s.a, { orderId: id, menuItemId: s.pizza, quantity: 1, modifierIds: [] }, A.cashier);
  r.addOrderItem(s.a, { orderId: id, menuItemId: s.charge, quantity: 1, modifierIds: [] }, A.cashier);
  const total = r.findOrder(s.a, id)!.totalCents as number;
  at('19:30');
  if (opts.prepaid) {
    r.tenderOrder(s.a, { orderId: id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, A.cashier);
  } else {
    r.sendOrderToKitchen(s.a, id, A.cashier);
  }
  at('19:45');
  r.markOrderReady(s.a, id, A.cashier);
  await pushOk(s.a, TILL_A, s.b);
  return { id, total };
}

const ROW = `status, paid_at, voided_at, voided_by, void_reason, dispatched_at, delivered_at, rider_keeps_cents,
             sent_at, version, updated_at, deleted_at`;
const rowOf = (db: AppDatabase, id: string) => db.prepare(`SELECT ${ROW} FROM orders WHERE id = ?`).get(id) as Row | undefined;

const RACE_ACTIONS = ['remote_cancel_refused_paid', 'remote_payment_overrode_cancel', 'remote_cancel_applied', 'remote_change_kept_cancelled'];
/** The race's audit rows on this till for the order, in order. */
const raceActions = (db: AppDatabase, id: string): string[] =>
  (
    db
      .prepare(
        `SELECT action FROM audit_log WHERE entity_type = 'orders' AND entity_id = ?
            AND action IN (${RACE_ACTIONS.map(() => '?').join(', ')}) ORDER BY rowid`,
      )
      .all(id, ...RACE_ACTIONS) as Row[]
  ).map((x) => String(x['action']));
const auditsOf = (db: AppDatabase, id: string, action: string) =>
  (
    db
      .prepare(
        `SELECT actor_user_id AS actor, before_json AS b, after_json AS a FROM audit_log
          WHERE entity_type = 'orders' AND entity_id = ? AND action = ? ORDER BY rowid`,
      )
      .all(id, action) as Row[]
  ).map((x) => ({ actor: x['actor'], before: JSON.parse(String(x['b'])), after: JSON.parse(String(x['a'])) }));

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

const expectedCash = async (db: AppDatabase, shiftId: string) => (await shiftRepo()).getShiftSummary(db, shiftId).expectedCashCents as number;
const liveMoves = (db: AppDatabase, id: string) =>
  db
    .prepare(
      `SELECT id, type, amount_cents, device_id, shift_id, reason FROM cash_movements
        WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all(id) as Row[];
const livePayments = (db: AppDatabase, id: string) =>
  db
    .prepare(`SELECT method, amount_cents, device_id FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`)
    .all(id) as Row[];
const onBoard = async (db: AppDatabase, id: string) => (await repo()).listActiveOrders(db).some((x) => x.order.id === id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('two tills: a cancel or refund is never undone by a status tap on the other till', () => {
  it.each(['A', 'B'] as const)(
    "till A sends out the order (the later tap) while till B cancels it from the same version: 'void' on both with B's who, when and why (%s's queue first)",
    async (first) => {
      const s = await shop();
      const r = await repo();
      const { id } = await readyDelivery(s);
      at('19:50');
      r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_mgr', foodMade: 'made' }, B.cashier);
      at('19:55');
      expect(r.sendOutOrder(s.a, id, A.cashier).riderKeepsCents).toBe(CHARGE);
      // The same version on both; A's tap is the later one, so plain last
      // write wins would bring the order back on B and drop B's cancel on A.
      expect(rowOf(s.a, id)!['version']).toBe(rowOf(s.b, id)!['version']);
      const version = rowOf(s.a, id)!['version'];

      await exchange(s, first);

      for (const db of [s.a, s.b]) {
        expect(rowOf(db, id)).toMatchObject({ status: 'void', voided_at: PK['19:50'], voided_by: 'u_mgr', void_reason: REASON });
        expect(await onBoard(db, id)).toBe(false);
      }
      // The two tills hold the same row: A's version and time, and the Send
      // out's racing columns kept on a cancelled order (every reader skips it).
      expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
      expect(rowOf(s.a, id)).toMatchObject({ version, updated_at: PK['19:55'], dispatched_at: PK['19:55'], rider_keeps_cents: CHARGE });

      expect(auditsOf(s.a, id, 'remote_cancel_applied')).toEqual([
        { actor: null, before: { status: 'out_for_delivery' }, after: { status: 'void', fromDeviceId: TILL_B } },
      ]);
      expect(auditsOf(s.b, id, 'remote_change_kept_cancelled')).toEqual([
        {
          actor: null,
          before: { status: 'void' },
          after: { status: 'void', remoteStatus: 'out_for_delivery', version, updatedAt: PK['19:55'], fromDeviceId: TILL_A },
        },
      ]);
      expect(raceActions(s.a, id)).toEqual(['remote_cancel_applied']);
      expect(raceActions(s.b, id)).toEqual(['remote_change_kept_cancelled']);
      // No money moved anywhere: the rider was never paid.
      expect(liveMoves(s.a, id)).toEqual([]);
      expect(liveMoves(s.b, id)).toEqual([]);
      expect(chainWhole(s.a)).toBe(true);
      expect(chainWhole(s.b)).toBe(true);
    },
  );

  it.each([
    ['A', 'Delivered later'],
    ['B', 'Delivered later'],
    ['A', 'refund later'],
    ['B', 'refund later'],
  ] as const)("a refund on B racing Delivered on A: 'refunded' on both (%s's queue first, %s)", async (first, timing) => {
    const s = await shop();
    const r = await repo();
    const { id, total } = await readyDelivery(s, { prepaid: true });
    const refund = () =>
      r.refundOrder(s.b, { orderId: id, reason: 'Customer refused the order', approverUserId: 'u_mgr', foodMade: 'made' }, B.cashier);
    const deliver = () => r.markOrderDelivered(s.a, { orderId: id }, A.cashier);
    at('19:50');
    if (timing === 'Delivered later') refund();
    else deliver();
    at('19:55');
    if (timing === 'Delivered later') deliver();
    else refund();
    const refundAt = timing === 'Delivered later' ? PK['19:50'] : PK['19:55'];

    await exchange(s, first);

    for (const db of [s.a, s.b]) {
      expect(rowOf(db, id)).toMatchObject({
        status: 'refunded',
        paid_at: PK['19:30'],
        voided_at: refundAt,
        voided_by: 'u_mgr',
        void_reason: 'Customer refused the order',
      });
      // The sale and its refund, on both.
      expect(livePayments(db, id).map((p) => p['amount_cents'])).toEqual([total, -total]);
      expect(await onBoard(db, id)).toBe(false);
    }
    expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
    if (timing === 'Delivered later') {
      // The refund arrived older on A: only its status and who, when, why.
      expect(raceActions(s.a, id)).toEqual(['remote_cancel_applied']);
      expect(auditsOf(s.a, id, 'remote_cancel_applied')[0]).toMatchObject({
        before: { status: 'paid' },
        after: { status: 'refunded', fromDeviceId: TILL_B },
      });
      expect(raceActions(s.b, id)).toEqual(['remote_change_kept_cancelled']);
      expect(rowOf(s.a, id)).toMatchObject({ delivered_at: PK['19:55'], updated_at: PK['19:55'] });
    } else {
      // The refund is the later write: plain last write wins on both.
      expect(raceActions(s.a, id)).toEqual([]);
      expect(raceActions(s.b, id)).toEqual([]);
      expect(rowOf(s.a, id)).toMatchObject({ delivered_at: null, updated_at: PK['19:55'] });
    }
    expect(chainWhole(s.a)).toBe(true);
    expect(chainWhole(s.b)).toBe(true);
  });
});

live('two tills: money taken beats a cancel', () => {
  it.each([
    ['A', 'Rider paid later'],
    ['B', 'Rider paid later'],
    ['A', 'cancel later'],
    ['B', 'cancel later'],
  ] as const)(
    "Rider paid on A racing a cancel that paid the rider's trip on B: out for delivery and paid on both, A's money untouched (%s's queue first, %s)",
    async (first, timing) => {
      const s = await shop();
      const r = await repo();
      const { id, total } = await readyDelivery(s);
      at('19:50');
      expect(r.sendOutOrder(s.a, id, A.cashier).riderKeepsCents).toBe(CHARGE);
      await pushOk(s.a, TILL_A, s.b);

      // A: the rider pays the shop the food total in cash and keeps his Rs 200.
      const riderPaid = () => r.takeRiderPayment(s.a, { orderId: id, method: 'cash', riderKeepsCents: CHARGE }, A.cashier);
      // B: cancelled at the door, the rider paid Rs 200 from B's drawer for the trip.
      const cancel = () =>
        r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_mgr', payRiderForTrip: true }, B.cashier);
      at('20:00');
      if (timing === 'Rider paid later') cancel();
      else riderPaid();
      at('20:05');
      if (timing === 'Rider paid later') riderPaid();
      else cancel();
      const paidAt = timing === 'Rider paid later' ? PK['20:05'] : PK['20:00'];
      const cancelAt = timing === 'Rider paid later' ? PK['20:00'] : PK['20:05'];

      const aPayment = livePayments(s.a, id);
      expect(aPayment).toEqual([{ method: 'cash', amount_cents: total, device_id: TILL_A }]);
      const [aPayout] = liveMoves(s.a, id);
      expect(aPayout).toMatchObject({ type: 'payout', amount_cents: CHARGE, device_id: TILL_A, shift_id: s.shiftA });
      const [bTrip] = liveMoves(s.b, id);
      expect(bTrip).toMatchObject({ type: 'payout', amount_cents: CHARGE, device_id: TILL_B, shift_id: s.shiftB });
      expect(String(bTrip!['reason'])).toMatch(/^Trip paid to the outside rider/);
      const aExpected = await expectedCash(s.a, s.shiftA);
      expect(aExpected).toBe(FLOAT + total - CHARGE);
      expect(await expectedCash(s.b, s.shiftB)).toBe(FLOAT - CHARGE);

      await exchange(s, first);

      for (const db of [s.a, s.b]) {
        expect(rowOf(db, id)).toMatchObject({
          status: 'out_for_delivery',
          paid_at: paidAt,
          voided_at: null,
          voided_by: null,
          void_reason: null,
          rider_keeps_cents: CHARGE,
        });
        expect(await onBoard(db, id)).toBe(true);
        // A's payment and its kept payout on both; B's trip payout stays (nothing is reversed).
        expect(livePayments(db, id)).toEqual(aPayment);
        expect(liveMoves(db, id).map((m) => m['id']).sort()).toEqual([aPayout!['id'], bTrip!['id']].sort());
      }
      expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
      // Each drawer is as it was: A expects the food total, B is out the trip.
      expect(await expectedCash(s.a, s.shiftA)).toBe(aExpected);
      expect(await expectedCash(s.b, s.shiftB)).toBe(FLOAT - CHARGE);

      // A refused the cancel, and says so.
      expect(raceActions(s.a, id)).toEqual(['remote_cancel_refused_paid']);
      expect(auditsOf(s.a, id, 'remote_cancel_refused_paid')).toEqual([
        {
          actor: null,
          before: { status: 'out_for_delivery', paidAt },
          after: { voidedAt: cancelAt, voidedBy: 'u_mgr', voidReason: REASON, fromDeviceId: TILL_B },
        },
      ]);
      // B took the payment over its cancel, and names what the cancel left: the trip payout, the stock booked as made.
      expect(raceActions(s.b, id)).toEqual(['remote_payment_overrode_cancel']);
      expect(auditsOf(s.b, id, 'remote_payment_overrode_cancel')).toEqual([
        {
          actor: null,
          before: { status: 'void', voidedAt: cancelAt, voidedBy: 'u_mgr', voidReason: REASON },
          after: {
            status: 'out_for_delivery',
            paidAt,
            fromDeviceId: TILL_A,
            cashMovementIds: [bTrip!['id']],
            stockAnswer: 'made',
          },
        },
      ]);
      expect(chainWhole(s.a)).toBe(true);
      expect(chainWhole(s.b)).toBe(true);
    },
  );

  it.each(['A', 'B'] as const)(
    "deletion still wins: B cancels its own order and the owner deletes it as a test while A takes Rider paid — deleted on both, A's payment never cancelled (%s first)",
    async (first) => {
      const s = await shop();
      const r = await repo();
      // An order taken and sent out on B, sent to A.
      at('19:00');
      const id = r.createOrder(s.b, { mode: 'delivery' }, B.cashier).id;
      r.addOrderItem(s.b, { orderId: id, menuItemId: s.pizza, quantity: 1, modifierIds: [] }, B.cashier);
      r.addOrderItem(s.b, { orderId: id, menuItemId: s.charge, quantity: 1, modifierIds: [] }, B.cashier);
      at('19:30');
      r.sendOrderToKitchen(s.b, id, B.cashier);
      at('19:45');
      r.markOrderReady(s.b, id, B.cashier);
      at('19:50');
      r.sendOutOrder(s.b, id, B.cashier);
      await pushOk(s.b, TILL_B, s.a);

      at('20:00');
      r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_mgr', payRiderForTrip: false }, B.cashier);
      at('20:05');
      r.takeRiderPayment(s.a, { orderId: id, method: 'cash', riderKeepsCents: CHARGE }, A.cashier);
      at('20:10');
      r.deleteTestOrder(
        s.b,
        { orderId: id, reason: 'Printer test', restock: null, expectStatus: 'void', ownerUserId: 'u_admin' },
        { userId: 'u_admin', deviceId: TILL_B },
      );

      await exchange(s, first);

      for (const db of [s.a, s.b]) {
        expect(rowOf(db, id)).toMatchObject({ status: 'out_for_delivery', paid_at: PK['20:05'], voided_at: null, deleted_at: PK['20:10'] });
        expect(r.getOrderSnapshot(db, id)).toBeNull();
      }
      expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
      // A: the cancel refused, the delete applied (only its delete columns).
      expect(raceActions(s.a, id)).toEqual(['remote_cancel_refused_paid']);
      expect(auditsOf(s.a, id, 'remote_delete_applied')).toHaveLength(1);
      // B: the payment over its cancel, and the order stays deleted.
      expect(raceActions(s.b, id)).toEqual(['remote_payment_overrode_cancel']);
      expect(chainWhole(s.a)).toBe(true);
      expect(chainWhole(s.b)).toBe(true);
    },
  );

  it('a later Delivered on A closes the order on B too, after B took the payment over its cancel', async () => {
    const s = await shop();
    const r = await repo();
    const { id } = await readyDelivery(s);
    at('19:50');
    r.sendOutOrder(s.a, id, A.cashier);
    await pushOk(s.a, TILL_A, s.b);
    at('20:00');
    r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_mgr', payRiderForTrip: false }, B.cashier);
    at('20:05');
    r.takeRiderPayment(s.a, { orderId: id, method: 'cash', riderKeepsCents: CHARGE }, A.cashier);
    await exchange(s, 'B');
    at('20:30');
    r.markOrderDelivered(s.a, { orderId: id }, A.cashier);
    await pushOk(s.a, TILL_A, s.b);
    expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
    expect(rowOf(s.b, id)).toMatchObject({ status: 'paid', paid_at: PK['20:05'] });
    // Told No for the trip: the cancel paid nothing, so the audit lists nothing.
    expect(auditsOf(s.b, id, 'remote_payment_overrode_cancel')[0]?.after).toMatchObject({ cashMovementIds: [], stockAnswer: 'made' });
    expect(raceActions(s.b, id)).toEqual(['remote_payment_overrode_cancel']);
    expect(chainWhole(s.b)).toBe(true);
  });
});

live('two tills: everything else is plain last write wins', () => {
  it.each(['A', 'B'] as const)('cancelled on both tills: the later cancel stands on both, no race rows (%s first)', async (first) => {
    const s = await shop();
    const r = await repo();
    const { id } = await readyDelivery(s);
    at('19:50');
    r.voidOrder(s.a, { orderId: id, reason: 'Wrong address', approverUserId: 'u_mgr', foodMade: 'made' }, A.cashier);
    at('19:55');
    r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_admin', foodMade: 'made' }, B.cashier);

    await exchange(s, first);

    for (const db of [s.a, s.b]) {
      expect(rowOf(db, id)).toMatchObject({ status: 'void', voided_at: PK['19:55'], voided_by: 'u_admin', void_reason: REASON });
      expect(raceActions(db, id)).toEqual([]);
      expect(chainWhole(db)).toBe(true);
    }
    expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
  });

  it.each([
    ['A', 'Ready later', 'ready'],
    ['B', 'Ready later', 'ready'],
    ['A', 'Preparing later', 'preparing'],
    ['B', 'Preparing later', 'preparing'],
  ] as const)('a live tap racing a live tap: the later one stands on both, no race rows (%s first, %s)', async (first, timing, wins) => {
    const s = await shop();
    const r = await repo();
    at('19:00');
    const id = r.createOrder(s.a, { mode: 'delivery' }, A.cashier).id;
    r.addOrderItem(s.a, { orderId: id, menuItemId: s.pizza, quantity: 1, modifierIds: [] }, A.cashier);
    at('19:30');
    r.sendOrderToKitchen(s.a, id, A.cashier);
    await pushOk(s.a, TILL_A, s.b);
    const preparing = () => r.markOrderPreparing(s.a, id, A.cashier);
    const ready = () => r.markOrderReady(s.b, id, B.cashier);
    at('19:40');
    if (timing === 'Ready later') preparing();
    else ready();
    at('19:45');
    if (timing === 'Ready later') ready();
    else preparing();

    await exchange(s, first);

    for (const db of [s.a, s.b]) {
      expect(rowOf(db, id)).toMatchObject({ status: wins, updated_at: PK['19:45'], sent_at: PK['19:30'] });
      expect(raceActions(db, id)).toEqual([]);
      expect(chainWhole(db)).toBe(true);
    }
    expect(rowOf(s.b, id)).toEqual(rowOf(s.a, id));
  });
});

live('two tills: a till still on v0.7.33', () => {
  /** Everything `from` queued, sent as a v0.7.33 till sends it: no sentAt or riderKeepsCents key in an order's image. */
  async function pushAsOldTill(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
    const sync = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const pending = sync.listPendingSync(from, 1_000_000);
    const changes: SyncChange[] = pending.map((p) => {
      const c = sync.pendingToChange(p, fromDevice);
      if (c.entityType !== 'orders') return c;
      const image = Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => k !== 'sentAt' && k !== 'riderKeepsCents'));
      return { ...c, payload: image };
    });
    const res = await applyRemoteBatch(to, changes, { pause: async () => {} });
    expect(res).toMatchObject({ waiting: 0, dropped: 0 });
    sync.markSyncedIds(
      from,
      pending.map((p) => p.id),
    );
  }

  it("its images apply with nothing left waiting: a live tap moves the order, an older cancel still wins over this till's Send out", async () => {
    const s = await shop();
    const r = await repo();
    const { id } = await readyDelivery(s);

    // An order B takes and moves on: its images carry neither key.
    at('19:00');
    const other = r.createOrder(s.b, { mode: 'delivery' }, B.cashier).id;
    r.addOrderItem(s.b, { orderId: other, menuItemId: s.pizza, quantity: 1, modifierIds: [] }, B.cashier);
    at('19:30');
    r.sendOrderToKitchen(s.b, other, B.cashier);
    await pushAsOldTill(s.b, TILL_B, s.a);
    expect(rowOf(s.a, other)).toMatchObject({ status: 'sent_to_kitchen', sent_at: null, rider_keeps_cents: null });
    at('19:40');
    r.markOrderPreparing(s.b, other, B.cashier);
    await pushAsOldTill(s.b, TILL_B, s.a);
    expect(rowOf(s.a, other)).toMatchObject({ status: 'preparing', updated_at: PK['19:40'], sent_at: null, rider_keeps_cents: null });

    // B cancels the delivery; A sends it out later, from the same version.
    at('19:50');
    r.voidOrder(s.b, { orderId: id, reason: REASON, approverUserId: 'u_mgr', foodMade: 'made' }, B.cashier);
    at('19:55');
    r.sendOutOrder(s.a, id, A.cashier);
    await pushAsOldTill(s.b, TILL_B, s.a);
    await pushOk(s.a, TILL_A, s.b);
    for (const db of [s.a, s.b]) {
      expect(rowOf(db, id)).toMatchObject({ status: 'void', voided_at: PK['19:50'], void_reason: REASON, rider_keeps_cents: CHARGE });
    }
    expect(raceActions(s.a, id)).toEqual(['remote_cancel_applied']);
    expect(raceActions(s.b, id)).toEqual(['remote_change_kept_cancelled']);
    expect(chainWhole(s.a)).toBe(true);
    expect(chainWhole(s.b)).toBe(true);
  });
});
