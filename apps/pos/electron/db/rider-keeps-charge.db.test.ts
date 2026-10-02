/**
 * An outside rider's money (migration 0049; the owner, 2 Oct 2026: "Third-party
 * rider keeps the delivery charge: the drawer expects the food total from the
 * rider"; "some pay in advance some dont" -> ask at Send out; Q4: a rider who
 * pays by EasyPaisa / JazzCash sends the FOOD TOTAL and keeps his fee from the
 * customer's cash; and the shortage he reported in the v0.7.33 till), on a
 * real database built from every migration, driven through the repositories:
 *   (1) Send out, then Delivered + Pay in cash: ONE payment of the total
 *       (tendered NULL), ONE payout of the charge linked to the order
 *       (audited 'delivery_charge_to_rider'), ONE drawer 'sale' row for the
 *       FOOD TOTAL pointing at it with the reason; the shift expects the float
 *       plus the food total, and a close counting exactly that is not short;
 *   (2) Rider paid (takeRiderPayment) while he is out: the order stays out for
 *       delivery, paid at or after it left, audited 'rider_paid'; Delivered
 *       then closes it with no second payment and no second payout;
 *  (2b) Send out with "Paid now" (sendOutRiderPaid, e2e fix A): Send out and
 *       Rider paid in one transaction, paid 1 ms after it left; the shift
 *       expects the float plus the food total; any refusal (no shift, a card,
 *       a keep the box got wrong, a prepaid order, a failure part-way) writes
 *       nothing at all — the order is still Ready;
 *   (3) EasyPaisa / JazzCash: the wallet for the food total, cash for his fee,
 *       the payout, and no drawer row — the shift expects the float;
 *   (4) a prepaid order sent out (owner Q2: "pay the rider's fee AT SEND
 *       OUT, drawer opens"): the payout and a drawer 'payout' row for −his
 *       fee in the same transaction as the status change; the shift expects
 *       the float plus the total less his fee; 'orders:sendOut' opens the
 *       drawer for that row; with no shift open Send out is refused in its
 *       own words and writes nothing; he keeps 0 -> no payout, no drawer;
 *   (5) one of the shop's own riders: exactly as v0.7.33 (no payout);
 *   (6) the guards: a card is refused; a window whose riderKeepsCents is not
 *       the order's (or missing) is refused; a throw part-way rolls back the
 *       payment, the payout and the drawer row; a second Delivered never pays
 *       the rider twice; no shift, no money;
 *   (7) the settlement lock: once the drawer paid him, or he paid the shop
 *       after it left, Assign rider and Back to Ready are refused in the
 *       words and write nothing; before any money both still work;
 *   (8) a wasted trip (the owner, 2 Oct 2026: "pay the rider's fee if they
 *       went"): cancelling an unpaid order he took out must say whether he
 *       is paid for the trip; Yes = one payout linked to the order ('Trip
 *       paid to the outside rider — Order #0001 cancelled', why 'trip') and
 *       one drawer 'payout' row, the drawer opens after the commit; No =
 *       nothing; refused with no answer, with no shift open, on an order with
 *       no trip to pay, on a double tap and once he has paid the shop;
 *   (9) one trip, one fee (the owner: "If the order is refunded and sent
 *       again on the same trip, he gets one Rs 200, not two"): an order
 *       refunded in full while still on its trip, rung again for the same
 *       phone and sent out with riderAlreadyPaid -> he keeps 0, no payout at
 *       Send out (prepaid too) or Delivered; 'Charge again' pays him again;
 *       refused with no such order; the snapshot's riderPaidEarlier is null
 *       for yesterday, no payout, a wasted-trip cancel, an order delivered
 *       then refunded, and another phone;
 *   and the snapshot's deliveryChargeToRider.
 *
 * Every figure is worked out from the order and deliveryBillOf, never copied
 * in. node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryBillOf, type AuthenticatedUser, type PaymentMethod, type UUID } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { receiptDocumentFor, riderSettledWhileOut } from '@cheeseoclock/printer-core';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  /** The drawer pulses the handlers asked for (kickDrawerSoon's drawer row ids). */
  kicks: [] as string[],
  /** Manager PINs the stand-in accepts, and whose they are ((8): 'orders:void'). */
  managerPins: new Map<string, string>(),
}));

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
// The orders handlers, captured instead of registered with Electron ((4): 'orders:sendOut').
vi.mock('../ipc/registry.js', () => {
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
    defineHandler: (channel: string, _ctx: unknown, fn: (ctx: unknown, payload: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
// Who is signed in: auth-service's job, stood in for here.
vi.mock('../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    const approverUserId = h.managerPins.get(pin);
    if (approverUserId) return { approverUserId, approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
// No printer here: the drawer pulses are only noted, the papers ignored.
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          if (method === 'kickDrawerSoon') h.kicks.push(String(args[0]));
          return undefined;
        },
    },
  ),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL = 'till-a';
const CASHIER = { userId: 'u_cash', deviceId: TILL };
const MANAGER = { userId: 'u_mgr', deviceId: TILL };
/** The float: Rs 5,000. */
const FLOAT = 500_000;
const NO_CARD = "An outside rider can't take a card: choose Cash, EasyPaisa or JazzCash.";
const CHANGED = 'This order changed since this window opened — close it and open the order again.';
const NO_SHIFT = 'No shift is open on this till — open a shift before taking or returning money';
const LOCKED = "Money has already been settled with the outside rider for this order — its rider can't be changed now.";

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
  '20:30': '2026-10-02T15:30:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

type Row = Record<string, unknown>;
const repo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');

interface Shop {
  db: AppDatabase;
  shiftId: string;
  bigTwo: string;
  fries: string;
  charge: string;
  rider: string;
}

/**
 * A till: the made-up users, a 15% tax, a 'Test Big Two' (Rs 3,400) and
 * 'Test Fries' (Rs 500), the area's 'Delivery Charge (Rs 200)' at 15%, one
 * of the shop's own riders, and a shift opened at 18:00 on a Rs 5,000 float
 * (or none).
 */
async function till(opts: { shift?: boolean } = {}): Promise<Shop> {
  const db = openTill(TILL);
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createRider } = await import('./repositories/rider-repo.js');
  const { openShift } = await shiftRepo();
  at('18:00');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, MANAGER);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, MANAGER).id;
  const bigTwo = item(food.id, 'Test Big Two', 340_000);
  const fries = item(food.id, 'Test Fries', 50_000);
  const charge = item(fees.id, 'Delivery Charge (Rs 200)', 20_000);
  const rider = createRider(db, { name: 'Test Own Rider', phone: '03001112222' }, MANAGER).id;
  const shiftId = opts.shift === false ? '' : openShift(db, { openingCashCents: FLOAT }, MANAGER).id;
  return { db, shiftId, bigTwo, fries, charge, rider };
}

/**
 * A counter delivery: Big Two + Fries (+ the delivery charge unless `charge`
 * is false), sent at 19:30, ready at 19:45, and at 19:50 sent out (an
 * outside rider) or given to the shop's own rider.
 */
async function out(shop: Shop, opts: { charge?: boolean; own?: boolean } = {}) {
  const r = await repo();
  at('19:00');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.bigTwo, quantity: 1, modifierIds: [] }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.fries, quantity: 1, modifierIds: [] }, CASHIER);
  if (opts.charge !== false) r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
  at('19:30');
  r.sendOrderToKitchen(shop.db, o.id, CASHIER);
  at('19:45');
  r.markOrderReady(shop.db, o.id, CASHIER);
  at('19:50');
  const sent = opts.own ? r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER) : r.sendOutOrder(shop.db, o.id, CASHIER);
  const snap = r.getOrderSnapshot(shop.db, o.id)!;
  return {
    id: o.id,
    order: sent,
    snap,
    total: sent.totalCents as number,
    /** What the outside rider keeps, frozen at Send out (0 for the own rider). */
    keep: (sent.riderKeepsCents ?? 0) as number,
    /** The bill's FOOD TOTAL (with tax): what he hands over (the total with no charge line). */
    foodTotal: deliveryBillOf(snap)?.foodTotalCents ?? (sent.totalCents as number),
  };
}

/**
 * A counter delivery PAID at the counter in full (cash unless `method` says
 * otherwise; Pay leaves it sent to the kitchen, paid): the made-up customer,
 * Big Two + Fries (+ the delivery charge unless `charge` is false), paid at
 * 19:30, ready at 19:45. Not sent out yet.
 */
async function prepaid(shop: Shop, opts: { charge?: boolean; method?: PaymentMethod } = {}) {
  const r = await repo();
  const c = await import('./repositories/customer-repo.js');
  at('19:00');
  const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
  const customer = c.createCustomer(shop.db, { name: 'Test Prepaid Customer', phone: '03005556666' }, CASHIER);
  const address = c.createAddress(shop.db, { customerId: customer.id, addressLine: 'House 7, Test Street', area: 'Test Block' }, CASHIER);
  c.snapshotCustomerOntoOrder(shop.db, { orderId: o.id, customerId: customer.id, addressId: address.id }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.bigTwo, quantity: 1, modifierIds: [] }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.fries, quantity: 1, modifierIds: [] }, CASHIER);
  if (opts.charge !== false) r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
  const total = r.findOrder(shop.db, o.id)!.totalCents as number;
  const method = opts.method ?? 'cash';
  at('19:30');
  r.tenderOrder(
    shop.db,
    { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] },
    CASHIER,
  );
  at('19:45');
  r.markOrderReady(shop.db, o.id, CASHIER);
  return { id: o.id, orderNumber: o.orderNumber, total };
}

/** The orders handlers on this till, a cashier signed in; `call` runs one as the IPC would. */
async function ordersIpc(shop: Shop) {
  h.handlers.clear();
  h.kicks.length = 0;
  const { registerOrdersHandlers } = await import('../ipc/handlers/orders-handlers.js');
  registerOrdersHandlers({ db: shop.db, deviceId: TILL } as never);
  h.session = { id: CASHIER.userId as UUID, fullName: 'Test Cashier', role: 'cashier', sessionId: 'sess' as UUID };
  return (channel: string, payload: unknown) => {
    const fn = h.handlers.get(channel);
    if (!fn) throw new Error(`No handler for ${channel}`);
    return fn({ db: shop.db, deviceId: TILL }, payload) as Promise<{ ok: true; data: unknown }>;
  };
}

const count = (db: AppDatabase, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
/** Everything a settlement can leave behind. */
const ledger = (db: AppDatabase, orderId: string) => ({
  payments: count(db, 'payments'),
  movements: count(db, 'cash_movements'),
  drawer: count(db, 'drawer_opens'),
  sync: count(db, 'sync_queue'),
  audit: count(db, 'audit_log'),
  order: db.prepare(`SELECT status, paid_at, delivered_at, rider_keeps_cents, version FROM orders WHERE id = ?`).get(orderId) as Row,
});
const paymentsOf = (db: AppDatabase, orderId: string) =>
  db
    .prepare(`SELECT method, amount_cents, tendered_cents, reference_no, shift_id FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY rowid`)
    .all(orderId) as Row[];
const payoutsOf = (db: AppDatabase, orderId: string) =>
  db
    .prepare(`SELECT id, shift_id, type, amount_cents, reason, order_id FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL ORDER BY rowid`)
    .all(orderId) as Row[];
const drawerOf = (db: AppDatabase, id: string) =>
  db.prepare(`SELECT id, shift_id, kind, reason, order_id, cash_movement_id, amount_cents, user_id FROM drawer_opens WHERE id = ?`).get(id) as Row | undefined;
/** The audit actions written after `since` rows. */
const auditAfter = (db: AppDatabase, since: number) =>
  (db.prepare(`SELECT entity_type, action, after_json FROM audit_log ORDER BY rowid`).all() as Row[]).slice(since).map((a) => ({
    entityType: a['entity_type'],
    action: a['action'],
    after: JSON.parse(String(a['after_json'])) as Row,
  }));

function chainOk(db: AppDatabase): boolean {
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

/** A failure part-way: the order's own UPDATE (after the money is written) is refused by the database. */
function failOrderUpdates(db: AppDatabase): void {
  db.prepare(
    `CREATE TRIGGER test_fail_paid BEFORE UPDATE OF paid_at ON orders
      WHEN NEW.paid_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Test: the disk is full'); END`,
  ).run();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('(1) Delivered + Pay in cash: the drawer expects the FOOD TOTAL', () => {
  it('one payment of the total (tendered NULL), one payout of the charge linked to the order, one drawer sale row for the food total with the reason', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    // The owner's example: CUSTOMER PAYS less the Rs 200 charge.
    expect(o.keep).toBe(20_000);
    expect(o.foodTotal).toBe(o.total - o.keep);
    const before = ledger(shop.db, o.id);

    at('20:20');
    const done = r.markOrderDelivered(
      shop.db,
      // The dialog may still say what he handed over: the main process keeps the payment the total, change NULL.
      { orderId: o.id, payment: { method: 'cash', amountCents: o.total, tenderedCents: o.foodTotal }, riderKeepsCents: o.keep },
      CASHIER,
    );

    expect(done.status).toBe('paid');
    expect(done.paidAt).toBe(PK['20:20']);
    expect(done.deliveredAt).toBe(PK['20:20']);
    expect(paymentsOf(shop.db, o.id)).toEqual([
      { method: 'cash', amount_cents: o.total, tendered_cents: null, reference_no: null, shift_id: shop.shiftId },
    ]);
    const payouts = payoutsOf(shop.db, o.id);
    expect(payouts).toEqual([
      {
        id: expect.any(String),
        shift_id: shop.shiftId,
        type: 'payout',
        amount_cents: o.keep,
        reason: 'Delivery charge kept by the outside rider — Order #0001',
        order_id: o.id,
      },
    ]);
    expect(done.drawerOpenId).toEqual(expect.any(String));
    expect(drawerOf(shop.db, done.drawerOpenId!)).toEqual({
      id: done.drawerOpenId,
      shift_id: shop.shiftId,
      kind: 'sale',
      reason: `Rider kept ${formatCents(o.keep)} delivery charge`,
      order_id: o.id,
      cash_movement_id: payouts[0]!['id'],
      amount_cents: o.foodTotal,
      user_id: CASHIER.userId,
    });
    expect(drawerOf(shop.db, done.drawerOpenId!)?.['reason']).toBe('Rider kept Rs 200 delivery charge');
    // Exactly one of each, and nothing else moved money.
    expect(ledger(shop.db, o.id)).toMatchObject({
      payments: before.payments + 1,
      movements: before.movements + 1,
      drawer: before.drawer + 1,
    });
    expect(auditAfter(shop.db, before.audit).map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'payments:create',
      'cash_movements:delivery_charge_to_rider',
      'drawer_opens:drawer_sale',
      'orders:mark_delivered_with_payment',
    ]);
    expect(chainOk(shop.db)).toBe(true);
  });

  it('the shift expects the float plus the food total (Rs 200 to the rider in the cash taken out); a close counting exactly that is not short', async () => {
    const shop = await till();
    const r = await repo();
    const { closeShift, getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER);

    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({
      cashSalesCents: o.total,
      cashOutCents: o.keep,
      riderChargesCents: o.keep,
      riderChargeCount: 1,
      expectedCashCents: FLOAT + o.total - o.keep,
    });
    expect(s.expectedCashCents).toBe(FLOAT + o.foodTotal);
    // The sale stays the full total.
    expect(s.byMethod).toEqual([expect.objectContaining({ method: 'cash', salesCents: o.total, refundCents: 0 })]);

    at('20:30');
    const closed = closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: FLOAT + o.foodTotal }, MANAGER);
    expect(closed).toMatchObject({ expectedCashCents: FLOAT + o.foodTotal, varianceCents: 0 });
  });

  it("the snapshot says what the drawer paid him: deliveryChargeToRider {Rs 200, 'kept'}; null while nothing is paid; absent on other orders", async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    expect(o.snap.deliveryChargeToRider).toBeNull();

    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER);
    expect(r.getOrderSnapshot(shop.db, o.id)!.deliveryChargeToRider).toEqual({ amountCents: o.keep, at: PK['20:20'], why: 'kept' });

    // One of the shop's own riders: no such key at all, as before.
    const own = await out(shop, { own: true });
    expect(own.snap).not.toHaveProperty('deliveryChargeToRider');
  });

  it("a wasted trip's payout reads 'trip'", async () => {
    const shop = await till();
    const r = await repo();
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const o = await out(shop);
    at('20:05');
    recordDeliveryChargeToRider(shop.db, { orderId: o.id, orderNumber: o.order.orderNumber, amountCents: o.keep, why: 'trip' }, MANAGER);
    expect(r.getOrderSnapshot(shop.db, o.id)!.deliveryChargeToRider).toEqual({ amountCents: o.keep, at: PK['20:05'], why: 'trip' });
  });

  it('no delivery charge (he keeps 0): one payment and one drawer sale of the total, no reason, no payout', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop, { charge: false });
    expect(o.keep).toBe(0);
    expect(o.order.riderKeepsCents).toBe(0);
    at('20:20');
    const done = r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: 0 }, CASHIER);
    expect(paymentsOf(shop.db, o.id)).toEqual([expect.objectContaining({ method: 'cash', amount_cents: o.total, tendered_cents: null })]);
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(drawerOf(shop.db, done.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: o.total, reason: null, cash_movement_id: null, order_id: o.id });
    expect(r.getOrderSnapshot(shop.db, o.id)!.deliveryChargeToRider).toBeNull();
  });
});

live('(2) Rider paid while he is out (takeRiderPayment)', () => {
  it("stays out for delivery, paid at or after it left, audited 'rider_paid'; the paper still reads it as a bill to collect", async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);

    at('20:05');
    const paid = r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);

    expect(paid.status).toBe('out_for_delivery');
    expect(paid.paidAt).toBe(PK['20:05']);
    expect(paid.dispatchedAt).toBe(PK['19:50']);
    expect(Date.parse(paid.paidAt!)).toBeGreaterThanOrEqual(Date.parse(paid.dispatchedAt!));
    expect(paid.deliveredAt).toBeNull();
    expect(paid.riderKeepsCents).toBe(o.keep);
    expect(riderSettledWhileOut(paid)).toBe(true);

    expect(paymentsOf(shop.db, o.id)).toEqual([expect.objectContaining({ method: 'cash', amount_cents: o.total, tendered_cents: null, shift_id: shop.shiftId })]);
    const payouts = payoutsOf(shop.db, o.id);
    expect(payouts).toEqual([expect.objectContaining({ type: 'payout', amount_cents: o.keep, order_id: o.id })]);
    expect(drawerOf(shop.db, paid.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: o.foodTotal, cash_movement_id: payouts[0]!['id'], order_id: o.id });

    const audit = auditAfter(shop.db, before.audit);
    expect(audit.map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'payments:create',
      'cash_movements:delivery_charge_to_rider',
      'drawer_opens:drawer_sale',
      'orders:rider_paid',
    ]);
    expect(audit[3]?.after).toMatchObject({ id: o.id, status: 'out_for_delivery', paidAt: PK['20:05'] });
    // The order's one sync row carries the payment time.
    const orderSync = (shop.db.prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY rowid`).all(o.id) as Row[]).slice(-1);
    expect(JSON.parse(String(orderSync[0]?.['payload_json']))).toMatchObject({ status: 'out_for_delivery', paidAt: PK['20:05'] });
    expect(chainOk(shop.db)).toBe(true);
  });

  it('then Delivered closes it: paid, with no second payment, no second payout and no drawer row', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    at('20:05');
    r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);
    const before = ledger(shop.db, o.id);

    at('20:20');
    const done = r.markOrderDelivered(shop.db, { orderId: o.id, riderKeepsCents: o.keep }, CASHIER);
    expect(done).toMatchObject({ status: 'paid', paidAt: PK['20:05'], deliveredAt: PK['20:20'], drawerOpenId: null });
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: before.payments, movements: before.movements, drawer: before.drawer });
    expect(auditAfter(shop.db, before.audit).map((a) => a.action)).toEqual(['mark_delivered']);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ expectedCashCents: FLOAT + o.foodTotal, riderChargeCount: 1 });

    // A stale Delivered + Pay window can't take the money again.
    const o2 = await out(shop);
    at('20:05');
    r.takeRiderPayment(shop.db, { orderId: o2.id, method: 'cash', riderKeepsCents: o2.keep }, CASHIER);
    const before2 = ledger(shop.db, o2.id);
    expect(() =>
      r.markOrderDelivered(shop.db, { orderId: o2.id, payment: { method: 'cash', amountCents: o2.total }, riderKeepsCents: o2.keep }, CASHIER),
    ).toThrow('Order is already paid');
    expect(ledger(shop.db, o2.id)).toEqual(before2);
  });

  it('a second Rider paid (a double tap) is refused and writes nothing', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('20:05');
    r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);
    const before = ledger(shop.db, o.id);
    expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER)).toThrow('Order is already paid');
    expect(ledger(shop.db, o.id)).toEqual(before);
  });

  it('never paid before it left: with the clock set back, paid_at is the time it left', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('19:45');
    const paid = r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);
    expect(paid.paidAt).toBe(PK['19:50']);
    expect(riderSettledWhileOut(paid)).toBe(true);
  });

  it('only an outside order out for delivery: Ready, and one of the shop own riders, are refused and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('20:05');
    r.unassignRiderFromOrder(shop.db, o.id, CASHIER);
    let before = ledger(shop.db, o.id);
    expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER)).toThrow(
      'This order is ready — the rider pays the shop only while it is out for delivery',
    );
    expect(ledger(shop.db, o.id)).toEqual(before);

    const own = await out(shop, { own: true });
    before = ledger(shop.db, own.id);
    expect(() => r.takeRiderPayment(shop.db, { orderId: own.id, method: 'cash', riderKeepsCents: 20_000 }, CASHIER)).toThrow(CHANGED);
    expect(ledger(shop.db, own.id)).toEqual(before);
  });
});

live('(3) EasyPaisa / JazzCash: he sends the food total and keeps his fee from the cash', () => {
  it('Delivered + Pay by EasyPaisa: EasyPaisa for the food total + cash for his fee + the payout; no drawer row; the shift expects the float', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);

    at('20:20');
    const done = r.markOrderDelivered(
      shop.db,
      { orderId: o.id, payment: { method: 'easypaisa', amountCents: o.total, referenceNo: ' TEST-EP-0001 ' }, riderKeepsCents: o.keep },
      CASHIER,
    );

    expect(done).toMatchObject({ status: 'paid', drawerOpenId: null });
    expect(paymentsOf(shop.db, o.id)).toEqual([
      { method: 'easypaisa', amount_cents: o.foodTotal, tendered_cents: null, reference_no: 'TEST-EP-0001', shift_id: shop.shiftId },
      { method: 'cash', amount_cents: o.keep, tendered_cents: null, reference_no: null, shift_id: shop.shiftId },
    ]);
    // The sale is still the full total.
    expect(paymentsOf(shop.db, o.id).reduce((n, p) => n + Number(p['amount_cents']), 0)).toBe(o.total);
    expect(payoutsOf(shop.db, o.id)).toEqual([expect.objectContaining({ amount_cents: o.keep, order_id: o.id })]);
    expect(ledger(shop.db, o.id).drawer).toBe(before.drawer);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({
      cashSalesCents: o.keep,
      cashOutCents: o.keep,
      riderChargesCents: o.keep,
      expectedCashCents: FLOAT,
    });
    expect(chainOk(shop.db)).toBe(true);
  });

  it('Rider paid by JazzCash: the same split, still out, no drawer row', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    at('20:05');
    const paid = r.takeRiderPayment(shop.db, { orderId: o.id, method: 'jazzcash', referenceNo: 'TEST-JC-0002', riderKeepsCents: o.keep }, CASHIER);
    expect(paid).toMatchObject({ status: 'out_for_delivery', paidAt: PK['20:05'], drawerOpenId: null });
    expect(paymentsOf(shop.db, o.id).map((p) => [p['method'], p['amount_cents']])).toEqual([
      ['jazzcash', o.foodTotal],
      ['cash', o.keep],
    ]);
    expect(payoutsOf(shop.db, o.id)).toHaveLength(1);
    expect(ledger(shop.db, o.id).drawer).toBe(before.drawer);
  });

  it('a wallet with nothing kept: one wallet payment of the total, no cash, no payout', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop, { charge: false });
    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'easypaisa', amountCents: o.total }, riderKeepsCents: 0 }, CASHIER);
    expect(paymentsOf(shop.db, o.id).map((p) => [p['method'], p['amount_cents']])).toEqual([['easypaisa', o.total]]);
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
  });
});

live('(4) a prepaid order sent out: the drawer pays his fee at Send out (owner Q2)', () => {
  it("one payout and one drawer 'payout' row for −his fee, in the same transaction as the status change; the shift expects the float plus the total less his fee", async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await prepaid(shop);
    expect(r.findOrder(shop.db, o.id)).toMatchObject({ status: 'ready', paidAt: PK['19:30'] });
    const counterPayments = paymentsOf(shop.db, o.id);
    expect(counterPayments).toEqual([expect.objectContaining({ method: 'cash', amount_cents: o.total })]);
    // The counter's cash is in the drawer: the float plus the total.
    expect(getShiftSummary(shop.db, shop.shiftId).expectedCashCents).toBe(FLOAT + o.total);
    const before = ledger(shop.db, o.id);

    at('19:50');
    const sent = r.sendOutOrder(shop.db, o.id, CASHIER);

    const keep = sent.riderKeepsCents as number;
    const snap = r.getOrderSnapshot(shop.db, o.id)!;
    // The owner's example: he keeps the Rs 200 charge as sold, the bill's Delivery charge.
    expect(keep).toBe(20_000);
    expect(deliveryBillOf(snap)?.deliveryChargeCents).toBe(keep);
    expect(sent).toMatchObject({ status: 'out_for_delivery', paidAt: PK['19:30'], dispatchedAt: PK['19:50'], drawerOpenId: expect.any(String) });
    // The customer's money is as it was: one cash payment of the total.
    expect(paymentsOf(shop.db, o.id)).toEqual(counterPayments);
    const payouts = payoutsOf(shop.db, o.id);
    expect(payouts).toEqual([
      {
        id: expect.any(String),
        shift_id: shop.shiftId,
        type: 'payout',
        amount_cents: keep,
        reason: 'Delivery charge kept by the outside rider — Order #0001',
        order_id: o.id,
      },
    ]);
    expect(drawerOf(shop.db, sent.drawerOpenId!)).toEqual({
      id: sent.drawerOpenId,
      shift_id: shop.shiftId,
      kind: 'payout',
      reason: 'Delivery charge kept by the outside rider — Order #0001',
      order_id: o.id,
      cash_movement_id: payouts[0]!['id'],
      amount_cents: -keep,
      user_id: CASHIER.userId,
    });
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: before.payments, movements: before.movements + 1, drawer: before.drawer + 1 });
    expect(auditAfter(shop.db, before.audit).map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'orders:send_out',
      'cash_movements:delivery_charge_to_rider',
      'drawer_opens:drawer_payout',
    ]);
    expect(snap.deliveryChargeToRider).toEqual({ amountCents: keep, at: PK['19:50'], why: 'kept' });

    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({ cashSalesCents: o.total, cashOutCents: keep, riderChargesCents: keep, riderChargeCount: 1 });
    expect(s.expectedCashCents).toBe(FLOAT + o.total - 20_000);
    expect(chainOk(shop.db)).toBe(true);

    // Delivered later closes it: no payment, no second payout, no drawer row.
    const settled = ledger(shop.db, o.id);
    at('20:20');
    expect(r.markOrderDelivered(shop.db, { orderId: o.id, riderKeepsCents: keep }, CASHIER)).toMatchObject({ status: 'paid', drawerOpenId: null });
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: settled.payments, movements: settled.movements, drawer: settled.drawer });
  });

  it('a throw part-way rolls back the status, the payout and the drawer row together', async () => {
    const shop = await till();
    const r = await repo();
    const o = await prepaid(shop);
    shop.db.prepare(
      `CREATE TRIGGER test_fail_payout BEFORE INSERT ON drawer_opens
        WHEN NEW.kind = 'payout'
        BEGIN SELECT RAISE(ABORT, 'Test: the disk is full'); END`,
    ).run();
    const before = ledger(shop.db, o.id);
    at('19:50');
    expect(() => r.sendOutOrder(shop.db, o.id, CASHIER)).toThrow('Test: the disk is full');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'ready', rider_keeps_cents: null });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(chainOk(shop.db)).toBe(true);
  });

  it("'orders:sendOut' opens the drawer for that row after the commit; an unpaid order, or a prepaid one he keeps nothing on, opens nothing", async () => {
    const shop = await till();
    const call = await ordersIpc(shop);
    const o = await prepaid(shop);
    at('19:50');
    const snap = (await call('orders:sendOut', { orderId: o.id })).data as { order: { status: string; riderKeepsCents?: number | null } };
    expect(snap.order).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });
    const row = shop.db.prepare(`SELECT id FROM drawer_opens WHERE order_id = ? AND kind = 'payout'`).all(o.id) as Row[];
    expect(row).toHaveLength(1);
    expect(h.kicks).toEqual([row[0]!['id']]);

    // Cash on delivery: no money at Send out, no drawer.
    h.kicks.length = 0;
    const r = await repo();
    at('19:00');
    const cod = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
    r.addOrderItem(shop.db, { orderId: cod.id, menuItemId: shop.bigTwo, quantity: 1, modifierIds: [] }, CASHIER);
    r.addOrderItem(shop.db, { orderId: cod.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
    at('19:30');
    r.sendOrderToKitchen(shop.db, cod.id, CASHIER);
    at('19:50');
    await call('orders:sendOut', { orderId: cod.id });
    // Prepaid with no delivery charge: he keeps nothing, so nothing is paid out.
    const free = await prepaid(shop, { charge: false });
    at('19:50');
    await call('orders:sendOut', { orderId: free.id });
    expect(h.kicks).toEqual([]);
  });

  it('with no shift open on this till Send out is refused in the words, the order is still Ready and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    const { closeShift, getShiftSummary } = await shiftRepo();
    const o = await prepaid(shop);
    at('19:45');
    closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: getShiftSummary(shop.db, shop.shiftId).expectedCashCents }, MANAGER);
    const before = ledger(shop.db, o.id);
    const words = `No shift is open on this till — open a shift to give the rider his ${formatCents(20_000)} delivery charge`;
    expect(words).toBe('No shift is open on this till — open a shift to give the rider his Rs 200 delivery charge');

    at('19:50');
    expect(() => r.sendOutOrder(shop.db, o.id, CASHIER)).toThrow(words);
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'ready', rider_keeps_cents: null });

    // Through the IPC: the repository's words, and no drawer.
    const call = await ordersIpc(shop);
    await expect(call('orders:sendOut', { orderId: o.id })).rejects.toMatchObject({ apiError: { code: 'precondition_failed', message: words } });
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(h.kicks).toEqual([]);
  });

  it('prepaid, he keeps 0 (no delivery charge): no payout and no drawer row — even with no shift open, since no money moves', async () => {
    const shop = await till();
    const r = await repo();
    const { closeShift, getShiftSummary } = await shiftRepo();
    const o = await prepaid(shop, { charge: false });
    const before = ledger(shop.db, o.id);
    at('19:50');
    const sent = r.sendOutOrder(shop.db, o.id, CASHIER);
    expect(sent).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 0, drawerOpenId: null });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(ledger(shop.db, o.id)).toMatchObject({ movements: before.movements, drawer: before.drawer, payments: before.payments });
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ expectedCashCents: FLOAT + o.total, riderChargesCents: 0 });

    const late = await prepaid(shop, { charge: false });
    at('19:45');
    closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: getShiftSummary(shop.db, shop.shiftId).expectedCashCents }, MANAGER);
    at('19:50');
    expect(r.sendOutOrder(shop.db, late.id, CASHIER)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 0, drawerOpenId: null });
  });

  it('paid by card at the counter: his fee still comes from the drawer in cash', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await prepaid(shop, { method: 'card' });
    at('19:50');
    const sent = r.sendOutOrder(shop.db, o.id, CASHIER);
    expect(drawerOf(shop.db, sent.drawerOpenId!)).toMatchObject({ kind: 'payout', amount_cents: -20_000, order_id: o.id });
    expect(getShiftSummary(shop.db, shop.shiftId).expectedCashCents).toBe(FLOAT - 20_000);
  });
});

live('(7) the settlement lock: Assign rider and Back to Ready, once his money is settled', () => {
  it('after the drawer paid him at Send out (prepaid): both refused in the words, nothing written', async () => {
    const shop = await till();
    const r = await repo();
    const o = await prepaid(shop);
    at('19:50');
    r.sendOutOrder(shop.db, o.id, CASHIER);
    const before = ledger(shop.db, o.id);
    at('20:05');
    expect(() => r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER)).toThrow(LOCKED);
    expect(() => r.unassignRiderFromOrder(shop.db, o.id, CASHIER)).toThrow(LOCKED);
    expect(ledger(shop.db, o.id)).toEqual(before);

    // Through the IPC: the repository's words.
    const call = await ordersIpc(shop);
    await expect(call('orders:assignRider', { orderId: o.id, riderId: shop.rider })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: LOCKED },
    });
    await expect(call('orders:unassignRider', { orderId: o.id })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: LOCKED },
    });
    expect(ledger(shop.db, o.id)).toEqual(before);
  });

  it('after Rider paid (cash or wallet): both refused, nothing written; after Delivered + Pay too', async () => {
    const shop = await till();
    const r = await repo();
    for (const method of ['cash', 'easypaisa'] as PaymentMethod[]) {
      const o = await out(shop);
      at('20:05');
      r.takeRiderPayment(shop.db, { orderId: o.id, method, riderKeepsCents: o.keep }, CASHIER);
      const before = ledger(shop.db, o.id);
      at('20:10');
      expect(() => r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER)).toThrow(LOCKED);
      expect(() => r.unassignRiderFromOrder(shop.db, o.id, CASHIER)).toThrow(LOCKED);
      expect(ledger(shop.db, o.id)).toEqual(before);
    }
    const closed = await out(shop);
    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: closed.id, payment: { method: 'cash', amountCents: closed.total }, riderKeepsCents: closed.keep }, CASHIER);
    const before = ledger(shop.db, closed.id);
    expect(() => r.assignRiderToOrder(shop.db, closed.id, shop.rider, CASHIER)).toThrow(LOCKED);
    expect(() => r.unassignRiderFromOrder(shop.db, closed.id, CASHIER)).toThrow(LOCKED);
    expect(ledger(shop.db, closed.id)).toEqual(before);
  });

  it('he paid with nothing to keep (no payout written): still refused, because he paid the shop after it left', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop, { charge: false });
    at('20:05');
    r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: 0 }, CASHIER);
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(() => r.unassignRiderFromOrder(shop.db, o.id, CASHIER)).toThrow(LOCKED);
    expect(() => r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER)).toThrow(LOCKED);
  });

  it('before any money both still work: Back to Ready, Send out again, then Assign rider; a prepaid order he keeps nothing on goes back too', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('20:05');
    const back = r.unassignRiderFromOrder(shop.db, o.id, CASHIER);
    expect(back.status).toBe('ready');
    expect(back.riderKeepsCents ?? null).toBeNull();
    expect(r.sendOutOrder(shop.db, o.id, CASHIER)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: o.keep });
    expect(r.assignRiderToOrder(shop.db, o.id, shop.rider, CASHIER)).toMatchObject({ status: 'out_for_delivery', assignedRiderId: shop.rider });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);

    // Paid at the counter BEFORE it left, nothing paid out: no lock.
    const free = await prepaid(shop, { charge: false });
    at('19:50');
    r.sendOutOrder(shop.db, free.id, CASHIER);
    at('20:05');
    expect(r.unassignRiderFromOrder(shop.db, free.id, CASHIER)).toMatchObject({ status: 'ready' });
    expect(r.sendOutOrder(shop.db, free.id, CASHIER)).toMatchObject({ status: 'out_for_delivery', drawerOpenId: null });
    expect(r.assignRiderToOrder(shop.db, free.id, shop.rider, CASHIER)).toMatchObject({ assignedRiderId: shop.rider });
  });
});

live("(5) one of the shop's own riders: exactly as v0.7.33", () => {
  it('Delivered + Pay in cash: the payment with its change, one drawer sale of the full total, no payout', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await out(shop, { own: true });
    expect(o.order.riderKeepsCents).toBeUndefined();
    const before = ledger(shop.db, o.id);

    at('20:20');
    const done = r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total, tenderedCents: 500_000 } }, CASHIER);

    expect(done.status).toBe('paid');
    expect(paymentsOf(shop.db, o.id)).toEqual([
      { method: 'cash', amount_cents: o.total, tendered_cents: 500_000, reference_no: null, shift_id: shop.shiftId },
    ]);
    expect(count(shop.db, 'cash_movements')).toBe(before.movements);
    expect(drawerOf(shop.db, done.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: o.total, reason: null, cash_movement_id: null, order_id: o.id });
    expect(auditAfter(shop.db, before.audit).map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'payments:create',
      'orders:mark_delivered_with_payment',
      'drawer_opens:drawer_sale',
    ]);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ riderChargesCents: 0, expectedCashCents: FLOAT + o.total });
    // A card is his to take, as before.
    const card = await out(shop, { own: true });
    at('20:30');
    expect(r.markOrderDelivered(shop.db, { orderId: card.id, payment: { method: 'card', amountCents: card.total } }, CASHIER)).toMatchObject({
      status: 'paid',
      drawerOpenId: null,
    });
  });

  it('a window that still says an outside rider keeps something is refused (Assign rider came after it) and writes nothing', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop, { own: true });
    const before = ledger(shop.db, o.id);
    at('20:20');
    expect(() =>
      r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: 20_000 }, CASHIER),
    ).toThrow(CHANGED);
    expect(ledger(shop.db, o.id)).toEqual(before);
    // A window with nothing to keep (null) is an own rider's: as before.
    expect(r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: null }, CASHIER).status).toBe('paid');
  });
});

live('(6) the guards', () => {
  it('a card (or any method but Cash, EasyPaisa, JazzCash) is refused in the words, and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    at('20:20');
    for (const method of ['card', 'bank_transfer', 'foodpanda'] as PaymentMethod[]) {
      expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method, amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER)).toThrow(NO_CARD);
      expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method, riderKeepsCents: o.keep }, CASHIER)).toThrow(NO_CARD);
    }
    expect(ledger(shop.db, o.id)).toEqual(before);
  });

  it('a riderKeepsCents that is not the order frozen value — or missing — is refused, and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    at('20:20');
    const pay = { method: 'cash' as const, amountCents: o.total };
    expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, payment: pay, riderKeepsCents: o.keep + 5_000 }, CASHIER)).toThrow(CHANGED);
    expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, payment: pay, riderKeepsCents: 0 }, CASHIER)).toThrow(CHANGED);
    expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, payment: pay }, CASHIER)).toThrow(CHANGED);
    expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, payment: pay, riderKeepsCents: null }, CASHIER)).toThrow(CHANGED);
    expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep - 1 }, CASHIER)).toThrow(CHANGED);
    expect(ledger(shop.db, o.id)).toEqual(before);
  });

  it('a throw part-way rolls back the payment, the payout and the drawer row (Delivered + Pay and Rider paid)', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    failOrderUpdates(shop.db);
    const before = ledger(shop.db, o.id);
    at('20:20');
    expect(() =>
      r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER),
    ).toThrow('Test: the disk is full');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method: 'easypaisa', riderKeepsCents: o.keep }, CASHIER)).toThrow('Test: the disk is full');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(paymentsOf(shop.db, o.id)).toEqual([]);
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(chainOk(shop.db)).toBe(true);
  });

  it('a second Delivered never pays the rider twice', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER);
    const before = ledger(shop.db, o.id);
    at('20:30');
    expect(() =>
      r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER),
    ).toThrow("This delivery is paid and closed — it can't be marked delivered");
    expect(() => r.markOrderDelivered(shop.db, { orderId: o.id, riderKeepsCents: o.keep }, CASHIER)).toThrow('paid and closed');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(payoutsOf(shop.db, o.id)).toHaveLength(1);
  });

  it('a live payout already there for the order (a two-till race) is not written again; the drawer still takes the food total', async () => {
    const shop = await till();
    const r = await repo();
    const { recordDeliveryChargeToRider } = await shiftRepo();
    const o = await out(shop);
    at('20:05');
    const first = recordDeliveryChargeToRider(shop.db, { orderId: o.id, orderNumber: o.order.orderNumber, amountCents: o.keep, why: 'kept' }, CASHIER);
    at('20:20');
    const done = r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER);
    expect(payoutsOf(shop.db, o.id).map((p) => p['id'])).toEqual([first]);
    expect(drawerOf(shop.db, done.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: o.foodTotal, cash_movement_id: null });
  });

  it('no shift open on this till: Rider paid and Delivered + Pay are refused, and nothing is written', async () => {
    const shop = await till({ shift: false });
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    at('20:20');
    expect(() => r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER)).toThrow(NO_SHIFT);
    expect(() =>
      r.markOrderDelivered(shop.db, { orderId: o.id, payment: { method: 'cash', amountCents: o.total }, riderKeepsCents: o.keep }, CASHIER),
    ).toThrow(NO_SHIFT);
    expect(ledger(shop.db, o.id)).toEqual(before);
  });
});

live("(8) a wasted trip: the cancel says whether the outside rider is paid for it (the owner: \"pay the rider's fee if they went\")", () => {
  const TRIP_ANSWER = 'Say whether the rider is paid for the trip';
  const NO_TRIP = 'Nothing to pay the rider for on this order';
  const NO_SHIFT_TRIP = 'No shift is open on this till — open a shift to pay the rider for the trip';
  /** The manager's PIN the stand-in accepts for 'orders:void' (made up). */
  const PIN = '2468';
  /** A cancel at 20:05, the manager allowing it at the cashier's till. */
  const cancel = async (shop: Shop, orderId: string, more: { payRiderForTrip?: boolean; actor?: typeof CASHIER } = {}) => {
    const r = await repo();
    at('20:05');
    return r.voidOrder(
      shop.db,
      {
        orderId,
        reason: 'Customer refused at the door',
        approverUserId: MANAGER.userId,
        ...(more.payRiderForTrip !== undefined ? { payRiderForTrip: more.payRiderForTrip } : {}),
      },
      more.actor ?? CASHIER,
    );
  };
  const approvals = (db: AppDatabase, orderId: string) => ({
    payout: db.prepare(`SELECT approved_by_user_id AS a FROM cash_movements WHERE order_id = ?`).all(orderId) as Row[],
    drawer: db.prepare(`SELECT approved_by_user_id AS a FROM drawer_opens WHERE order_id = ?`).all(orderId) as Row[],
  });
  const voidAudit = (db: AppDatabase, orderId: string) =>
    JSON.parse(
      String(
        (db.prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'void'`).get(orderId) as Row)[
          'after_json'
        ],
      ),
    ) as Row;

  it("Yes: one payout of his Rs 200 linked to the order, audited 'delivery_charge_to_rider' why 'trip', and one drawer 'payout' row for −Rs 200; the shift expects the float less Rs 200", async () => {
    const shop = await till();
    const r = await repo();
    const { closeShift, getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    expect(o.keep).toBe(20_000);
    expect(getShiftSummary(shop.db, shop.shiftId).expectedCashCents).toBe(FLOAT);
    const before = ledger(shop.db, o.id);

    const done = await cancel(shop, o.id, { payRiderForTrip: true });

    expect(done.order).toMatchObject({ status: 'void', voidReason: 'Customer refused at the door' });
    expect(done.statusBefore).toBe('out_for_delivery');
    // What he keeps stays as it was frozen at Send out.
    expect(r.findOrder(shop.db, o.id)).toMatchObject({ status: 'void', riderKeepsCents: o.keep, paidAt: null });
    // No money from the customer.
    expect(paymentsOf(shop.db, o.id)).toEqual([]);
    const reason = 'Trip paid to the outside rider — Order #0001 cancelled';
    const payouts = payoutsOf(shop.db, o.id);
    expect(payouts).toEqual([
      { id: expect.any(String), shift_id: shop.shiftId, type: 'payout', amount_cents: o.keep, reason, order_id: o.id },
    ]);
    expect(done.drawerOpenId).toEqual(expect.any(String));
    expect(drawerOf(shop.db, done.drawerOpenId!)).toEqual({
      id: done.drawerOpenId,
      shift_id: shop.shiftId,
      kind: 'payout',
      reason,
      order_id: o.id,
      cash_movement_id: payouts[0]!['id'],
      amount_cents: -20_000,
      user_id: CASHIER.userId,
    });
    // The manager whose PIN allowed the cancel at the cashier's till.
    expect(approvals(shop.db, o.id)).toEqual({ payout: [{ a: MANAGER.userId }], drawer: [{ a: MANAGER.userId }] });
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: before.payments, movements: before.movements + 1, drawer: before.drawer + 1 });
    const money = auditAfter(shop.db, before.audit).filter(
      (a) => a.entityType === 'cash_movements' || a.entityType === 'drawer_opens' || a.entityType === 'orders',
    );
    expect(money.map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'cash_movements:delivery_charge_to_rider',
      'drawer_opens:drawer_payout',
      'orders:void',
    ]);
    expect(money[0]!.after).toMatchObject({ why: 'trip', amountCents: o.keep, orderId: o.id });
    expect(voidAudit(shop.db, o.id)).toMatchObject({ status: 'void', tripPaidCents: 20_000 });
    expect(r.getOrderSnapshot(shop.db, o.id)!.deliveryChargeToRider).toEqual({ amountCents: o.keep, at: PK['20:05'], why: 'trip' });
    expect(chainOk(shop.db)).toBe(true);

    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({ cashSalesCents: 0, cashOutCents: 20_000, riderChargesCents: 20_000, riderChargeCount: 1 });
    expect(s.expectedCashCents).toBe(FLOAT - 20_000);
    at('20:30');
    expect(closeShift(shop.db, { shiftId: shop.shiftId, countedCashCents: FLOAT - 20_000 }, MANAGER)).toMatchObject({ varianceCents: 0 });
  });

  it('a manager cancelling at the till himself: the payout and the drawer row carry no approver', async () => {
    const shop = await till();
    const o = await out(shop);
    const done = await cancel(shop, o.id, { payRiderForTrip: true, actor: MANAGER });
    expect(drawerOf(shop.db, done.drawerOpenId!)).toMatchObject({ kind: 'payout', amount_cents: -20_000, user_id: MANAGER.userId });
    expect(approvals(shop.db, o.id)).toEqual({ payout: [{ a: null }], drawer: [{ a: null }] });
  });

  it('No: cancelled with no payout and no drawer row; the shift expects the float', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    const done = await cancel(shop, o.id, { payRiderForTrip: false });
    expect(done).toMatchObject({ order: { status: 'void' }, drawerOpenId: null });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: before.payments, movements: before.movements, drawer: before.drawer });
    expect(voidAudit(shop.db, o.id)).toMatchObject({ status: 'void', tripPaidCents: 0 });
    expect(r.getOrderSnapshot(shop.db, o.id)!.deliveryChargeToRider).toBeNull();
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ expectedCashCents: FLOAT, riderChargesCents: 0, riderChargeCount: 0 });
  });

  it('no answer: refused in the words, the order is still out and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    await expect(cancel(shop, o.id)).rejects.toThrow(TRIP_ANSWER);
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(r.findOrder(shop.db, o.id)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: o.keep });
  });

  it('no shift open on this till: Yes is refused in the words, the order is still out and nothing is written; No still cancels (no money moves)', async () => {
    const shop = await till({ shift: false });
    const r = await repo();
    const o = await out(shop);
    const before = ledger(shop.db, o.id);
    await expect(cancel(shop, o.id, { payRiderForTrip: true })).rejects.toThrow(NO_SHIFT_TRIP);
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'out_for_delivery', rider_keeps_cents: 20_000, paid_at: null });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);

    expect((await cancel(shop, o.id, { payRiderForTrip: false })).drawerOpenId).toBeNull();
    expect(r.findOrder(shop.db, o.id)?.status).toBe('void');
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
  });

  it("no trip to pay: Yes is refused on one of the shop's own riders, an outside rider who keeps nothing, an order not out yet, or one he was paid for already; each cancels with no answer", async () => {
    const shop = await till();
    const r = await repo();
    const { recordDeliveryChargeToRider } = await shiftRepo();

    // One of the shop's own riders: exactly as v0.7.33, no question.
    const own = await out(shop, { own: true });
    // An outside rider with no delivery charge on the bill: he keeps 0.
    const free = await out(shop, { charge: false });
    expect(free.keep).toBe(0);
    // Ready on the pass, not sent out.
    at('19:00');
    const ready = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
    r.addOrderItem(shop.db, { orderId: ready.id, menuItemId: shop.bigTwo, quantity: 1, modifierIds: [] }, CASHIER);
    r.addOrderItem(shop.db, { orderId: ready.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
    at('19:30');
    r.sendOrderToKitchen(shop.db, ready.id, CASHIER);
    at('19:45');
    r.markOrderReady(shop.db, ready.id, CASHIER);
    // A payout for this order already there (the other till paid him): nothing more is due.
    const settled = await out(shop);
    at('20:00');
    recordDeliveryChargeToRider(shop.db, { orderId: settled.id, orderNumber: settled.order.orderNumber, amountCents: settled.keep, why: 'trip' }, MANAGER);

    for (const id of [own.id, free.id, ready.id, settled.id]) {
      const before = ledger(shop.db, id);
      await expect(cancel(shop, id, { payRiderForTrip: true })).rejects.toThrow(NO_TRIP);
      expect(ledger(shop.db, id)).toEqual(before);
    }
    for (const id of [own.id, free.id, ready.id, settled.id]) {
      const done = await cancel(shop, id);
      expect(done).toMatchObject({ order: { status: 'void' }, drawerOpenId: null });
    }
    // Only the one payout written before; none by the cancels.
    expect(payoutsOf(shop.db, settled.id)).toHaveLength(1);
    for (const id of [own.id, free.id, ready.id]) expect(payoutsOf(shop.db, id)).toEqual([]);
  });

  it("a double tap: the second cancel is refused 'Order is already voided' and writes no second payout", async () => {
    const shop = await till();
    const { getShiftSummary } = await shiftRepo();
    const o = await out(shop);
    await cancel(shop, o.id, { payRiderForTrip: true });
    const before = ledger(shop.db, o.id);
    await expect(cancel(shop, o.id, { payRiderForTrip: true })).rejects.toThrow('Order is already voided');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(payoutsOf(shop.db, o.id)).toHaveLength(1);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ expectedCashCents: FLOAT - 20_000, riderChargeCount: 1 });
  });

  it('once he has paid the shop (Rider paid): the cancel is refused by the paid-order rule, with no trip payout', async () => {
    const shop = await till();
    const r = await repo();
    const o = await out(shop);
    at('20:00');
    r.takeRiderPayment(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);
    const kept = payoutsOf(shop.db, o.id);
    expect(kept).toEqual([expect.objectContaining({ reason: 'Delivery charge kept by the outside rider — Order #0001' })]);
    const before = ledger(shop.db, o.id);
    await expect(cancel(shop, o.id, { payRiderForTrip: true })).rejects.toThrow('Paid orders must be refunded, not voided');
    await expect(cancel(shop, o.id)).rejects.toThrow('Paid orders must be refunded, not voided');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(payoutsOf(shop.db, o.id)).toEqual(kept);
  });

  it('a throw part-way rolls back the cancel, the payout and the drawer row together', async () => {
    const shop = await till();
    const o = await out(shop);
    shop.db.prepare(
      `CREATE TRIGGER test_fail_trip BEFORE INSERT ON drawer_opens
        WHEN NEW.kind = 'payout'
        BEGIN SELECT RAISE(ABORT, 'Test: the disk is full'); END`,
    ).run();
    const before = ledger(shop.db, o.id);
    await expect(cancel(shop, o.id, { payRiderForTrip: true })).rejects.toThrow('Test: the disk is full');
    expect(ledger(shop.db, o.id)).toEqual(before);
    expect(before.order).toMatchObject({ status: 'out_for_delivery' });
    expect(payoutsOf(shop.db, o.id)).toEqual([]);
    expect(chainOk(shop.db)).toBe(true);
  });

  it("'orders:void': Yes opens the drawer once for that row after the commit; No opens nothing; no answer (or not a yes / no) is refused in the words", async () => {
    const shop = await till();
    const call = await ordersIpc(shop);
    h.managerPins.clear();
    h.managerPins.set(PIN, MANAGER.userId);
    const ask = (orderId: string, more: Record<string, unknown> = {}) =>
      call('orders:void', { orderId, reason: 'Customer refused at the door', approverPin: PIN, ...more });

    const unanswered = await out(shop);
    const before = ledger(shop.db, unanswered.id);
    at('20:05');
    await expect(ask(unanswered.id)).rejects.toMatchObject({ apiError: { code: 'precondition_failed', message: TRIP_ANSWER } });
    await expect(ask(unanswered.id, { payRiderForTrip: 'yes' })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: TRIP_ANSWER },
    });
    expect(ledger(shop.db, unanswered.id)).toEqual(before);
    expect(h.kicks).toEqual([]);

    const paid = await out(shop);
    at('20:05');
    const snap = (await ask(paid.id, { payRiderForTrip: true })).data as { order: { status: string }; deliveryChargeToRider?: unknown };
    expect(snap.order.status).toBe('void');
    expect(snap.deliveryChargeToRider).toEqual({ amountCents: 20_000, at: PK['20:05'], why: 'trip' });
    const rows = shop.db.prepare(`SELECT id, approved_by_user_id AS a FROM drawer_opens WHERE order_id = ? AND kind = 'payout'`).all(paid.id) as Row[];
    expect(rows).toEqual([{ id: expect.any(String), a: MANAGER.userId }]);
    expect(h.kicks).toEqual([rows[0]!['id']]);

    // No: nothing paid, the drawer stays shut.
    const unpaid = await out(shop);
    at('20:05');
    await ask(unpaid.id, { payRiderForTrip: false });
    expect(payoutsOf(shop.db, unpaid.id)).toEqual([]);
    expect(h.kicks).toEqual([rows[0]!['id']]);

    // The double tap through the IPC: refused, no second pulse.
    await expect(ask(paid.id, { payRiderForTrip: true })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: 'Order is already voided' },
    });
    expect(h.kicks).toHaveLength(1);
    expect(payoutsOf(shop.db, paid.id)).toHaveLength(1);
    h.managerPins.clear();
  });
});

live('(9) one trip, one fee: an order refunded on the trip and rung again does not pay the rider twice', () => {
  /** The made-up customer's phone, typed two ways, and another customer's. */
  const PHONE = '03004445555';
  const PHONE_AS_TYPED_AGAIN = '+92 300 4445555';
  const OTHER_PHONE = '03007778888';
  const NOT_PAID_EARLIER = 'The rider was not paid on another order of this customer today — send it out normally';

  /** HH:MM in Pakistan (UTC+5) on 2 Oct 2026, or on 1 Oct (the trading day before). */
  const pk = (hhmm: string, day: 1 | 2 = 2): string => {
    const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
    const iso = new Date(Date.UTC(2026, 9, day, hh - 5, mm)).toISOString();
    vi.setSystemTime(new Date(iso));
    return iso;
  };
  /** Five minutes after HH:MM (never past the hour in these tests). */
  const fiveLater = (hhmm: string): string => {
    const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
    return `${hh}:${String(mm + 5).padStart(2, '0')}`;
  };

  /**
   * A counter delivery for `phone` and a made-up address (a walk-in with
   * null): Big Two + Fries (+ the
   * delivery charge unless `charge` is false), started at `start`, sent to
   * the kitchen (or paid at the counter in cash, `paid`), and Ready five
   * minutes later. Not sent out.
   */
  async function rung(
    shop: Shop,
    start: string,
    opts: { phone?: string | null; charge?: boolean; paid?: boolean; day?: 1 | 2 } = {},
  ) {
    const r = await repo();
    const c = await import('./repositories/customer-repo.js');
    pk(start, opts.day);
    const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
    if (opts.phone !== null) {
      const customer = c.createCustomer(shop.db, { name: 'Test One Trip Customer', phone: opts.phone ?? PHONE }, CASHIER);
      const address = c.createAddress(shop.db, { customerId: customer.id, addressLine: 'House 9, Test Street', area: 'Test Block' }, CASHIER);
      c.snapshotCustomerOntoOrder(shop.db, { orderId: o.id, customerId: customer.id, addressId: address.id }, CASHIER);
    }
    r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.bigTwo, quantity: 1, modifierIds: [] }, CASHIER);
    r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.fries, quantity: 1, modifierIds: [] }, CASHIER);
    if (opts.charge !== false) r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
    const total = r.findOrder(shop.db, o.id)!.totalCents as number;
    if (opts.paid) {
      r.tenderOrder(shop.db, { orderId: o.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
    } else {
      r.sendOrderToKitchen(shop.db, o.id, CASHIER);
    }
    pk(fiveLater(start), opts.day);
    r.markOrderReady(shop.db, o.id, CASHIER);
    return { id: o.id, orderNumber: o.orderNumber, total };
  }

  /** The customer refuses the whole order at the door while the rider is still out: refunded in full, on his trip. */
  async function refundedOnTheTrip(shop: Shop, orderId: string, when: string, day: 1 | 2 = 2) {
    const r = await repo();
    pk(when, day);
    return r.refundOrder(
      shop.db,
      { orderId, reason: 'Customer refused it at the door', approverUserId: MANAGER.userId, foodMade: 'made' },
      MANAGER,
    );
  }

  /**
   * The first order for PHONE: sent out at 19:10, the rider pays the shop at
   * 19:15 ('Paid now', cash; the drawer pays him his Rs 200), and the
   * customer refuses it at 19:30 while he is still out.
   */
  async function firstTripRefunded(shop: Shop) {
    const r = await repo();
    const first = await rung(shop, '19:00');
    pk('19:10');
    const sent = r.sendOutOrder(shop.db, first.id, CASHIER);
    expect(sent.riderKeepsCents).toBe(20_000);
    pk('19:15');
    r.takeRiderPayment(shop.db, { orderId: first.id, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    await refundedOnTheTrip(shop, first.id, '19:30');
    expect(r.findOrder(shop.db, first.id)).toMatchObject({ status: 'refunded', deliveredAt: null, riderKeepsCents: 20_000 });
    // A refund never takes his payout back.
    expect(payoutsOf(shop.db, first.id)).toEqual([expect.objectContaining({ amount_cents: 20_000 })]);
    return first;
  }

  const sendOutAudit = (db: AppDatabase, orderId: string) =>
    JSON.parse(
      String(
        (
          db
            .prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'send_out'`)
            .get(orderId) as Row
        )['after_json'],
      ),
    ) as Row;
  const lastOrderSync = (db: AppDatabase, orderId: string) =>
    JSON.parse(
      String(
        (
          db
            .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`)
            .get(orderId) as Row
        )['payload_json'],
      ),
    ) as Row;

  it('re-rung for the same phone and sent with riderAlreadyPaid: he keeps 0, no payout at Send out or Delivered, he gives the shop the whole bill; the shift pays him once', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const first = await firstTripRefunded(shop);

    // Rung again for the same customer (typed another way): Ready, and the snapshot says he was paid on the first.
    const again = await rung(shop, '19:35', { phone: PHONE_AS_TYPED_AGAIN });
    expect(r.getOrderSnapshot(shop.db, again.id)!.riderPaidEarlier).toEqual({
      orderId: first.id,
      orderNumber: first.orderNumber,
      amountCents: 20_000,
    });
    const before = ledger(shop.db, again.id);

    pk('19:45');
    const sent = r.sendOutOrder(shop.db, again.id, CASHIER, { riderAlreadyPaid: true });
    expect(sent).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 0, drawerOpenId: null });
    expect(payoutsOf(shop.db, again.id)).toEqual([]);
    expect(ledger(shop.db, again.id)).toMatchObject({ payments: before.payments, movements: before.movements, drawer: before.drawer });
    // The audit row names the order he was paid on; the order's sync image does not carry it.
    expect(sendOutAudit(shop.db, again.id)).toMatchObject({
      status: 'out_for_delivery',
      riderKeepsCents: 0,
      riderAlreadyPaidOn: first.orderNumber,
    });
    expect(lastOrderSync(shop.db, again.id)).toMatchObject({ riderKeepsCents: 0 });
    expect(lastOrderSync(shop.db, again.id)).not.toHaveProperty('riderAlreadyPaidOn');
    // Out now: the snapshot no longer asks.
    const out = r.getOrderSnapshot(shop.db, again.id)!;
    expect(out).not.toHaveProperty('riderPaidEarlier');
    // The bill still has its charge: the customer got the first one back with the refund.
    expect(deliveryBillOf(out)?.deliveryChargeCents).toBe(20_000);

    pk('20:00');
    const done = r.markOrderDelivered(
      shop.db,
      { orderId: again.id, payment: { method: 'cash', amountCents: again.total }, riderKeepsCents: 0 },
      CASHIER,
    );
    expect(done.status).toBe('paid');
    expect(payoutsOf(shop.db, again.id)).toEqual([]);
    // He hands over the whole bill.
    expect(drawerOf(shop.db, done.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: again.total, reason: null, cash_movement_id: null });

    // One trip, one Rs 200: the first order's cash in and back out, his Rs 200 once, the second order in full.
    const s = getShiftSummary(shop.db, shop.shiftId);
    expect(s).toMatchObject({ riderChargesCents: 20_000, riderChargeCount: 1 });
    expect(s.expectedCashCents).toBe(FLOAT + first.total - 20_000 - first.total + again.total);
    expect(chainOk(shop.db)).toBe(true);
  });

  it("'Charge again' (sent with riderAlreadyPaid false, or without it): he keeps Rs 200 again and a second payout is written when he settles", async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const first = await firstTripRefunded(shop);
    const again = await rung(shop, '19:35');
    expect(r.getOrderSnapshot(shop.db, again.id)!.riderPaidEarlier).toMatchObject({ orderId: first.id });

    pk('19:45');
    const sent = r.sendOutOrder(shop.db, again.id, CASHIER, { riderAlreadyPaid: false });
    expect(sent).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });
    expect(sendOutAudit(shop.db, again.id)).not.toHaveProperty('riderAlreadyPaidOn');
    pk('20:00');
    r.markOrderDelivered(shop.db, { orderId: again.id, payment: { method: 'cash', amountCents: again.total }, riderKeepsCents: 20_000 }, CASHIER);
    expect(payoutsOf(shop.db, again.id)).toEqual([expect.objectContaining({ amount_cents: 20_000, order_id: again.id })]);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ riderChargesCents: 40_000, riderChargeCount: 2 });

    // Left out altogether (Live Orders' one tap, an older screen): the order's own charge, as before.
    const third = await rung(shop, '20:05');
    pk('20:15');
    expect(r.getOrderSnapshot(shop.db, third.id)!.riderPaidEarlier).toMatchObject({ orderId: first.id });
    expect(r.sendOutOrder(shop.db, third.id, CASHIER).riderKeepsCents).toBe(20_000);
  });

  it('riderAlreadyPaid with no such order: refused in the words, the order is still Ready and nothing is written', async () => {
    const shop = await till();
    const r = await repo();
    // Another customer's order refunded on its trip does not count for this one.
    const other = await rung(shop, '18:30', { phone: OTHER_PHONE });
    pk('18:40');
    r.sendOutOrder(shop.db, other.id, CASHIER);
    pk('18:45');
    r.takeRiderPayment(shop.db, { orderId: other.id, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    await refundedOnTheTrip(shop, other.id, '18:50');

    const mine = await rung(shop, '19:00');
    const walkIn = await rung(shop, '19:10', { phone: null });
    for (const o of [mine, walkIn]) {
      const before = ledger(shop.db, o.id);
      pk('19:30');
      expect(() => r.sendOutOrder(shop.db, o.id, CASHIER, { riderAlreadyPaid: true })).toThrow(NOT_PAID_EARLIER);
      expect(ledger(shop.db, o.id)).toEqual(before);
      expect(before.order).toMatchObject({ status: 'ready', rider_keeps_cents: null });
    }
    // An order Send out can't take at all keeps its own words.
    pk('19:35');
    r.sendOutOrder(shop.db, mine.id, CASHIER);
    expect(() => r.sendOutOrder(shop.db, mine.id, CASHIER, { riderAlreadyPaid: true })).toThrow('This order is already out for delivery');
  });

  it('riderPaidEarlier is null for yesterday’s refund, a refund with no payout, a cancelled order paid for its trip, an order delivered earlier today then refunded, and another phone', async () => {
    const shop = await till();
    const r = await repo();

    // Yesterday evening (the trading day before): out, the rider paid, refunded on the trip.
    const yesterday = await rung(shop, '20:00', { day: 1 });
    pk('20:10', 1);
    r.sendOutOrder(shop.db, yesterday.id, CASHIER);
    pk('20:15', 1);
    r.takeRiderPayment(shop.db, { orderId: yesterday.id, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    await refundedOnTheTrip(shop, yesterday.id, '20:30', 1);
    expect(payoutsOf(shop.db, yesterday.id)).toHaveLength(1);

    // Today: no delivery charge on the bill, so he kept nothing (no payout); refunded on the trip.
    const free = await rung(shop, '18:05', { charge: false });
    pk('18:15');
    expect(r.sendOutOrder(shop.db, free.id, CASHIER).riderKeepsCents).toBe(0);
    pk('18:20');
    r.takeRiderPayment(shop.db, { orderId: free.id, method: 'cash', riderKeepsCents: 0 }, CASHIER);
    await refundedOnTheTrip(shop, free.id, '18:25');
    expect(payoutsOf(shop.db, free.id)).toEqual([]);

    // Cancelled while out, the rider paid for the wasted trip (he went and came back).
    const wasted = await rung(shop, '18:30');
    pk('18:40');
    r.sendOutOrder(shop.db, wasted.id, CASHIER);
    pk('18:45');
    r.voidOrder(
      shop.db,
      { orderId: wasted.id, reason: 'Customer refused at the door', approverUserId: MANAGER.userId, payRiderForTrip: true, foodMade: 'made' },
      CASHIER,
    );
    expect(payoutsOf(shop.db, wasted.id)).toEqual([expect.objectContaining({ amount_cents: 20_000 })]);

    // Delivered and paid (a past trip), then refunded in full later.
    const delivered = await rung(shop, '18:50');
    pk('18:56');
    r.sendOutOrder(shop.db, delivered.id, CASHIER);
    pk('19:00');
    r.markOrderDelivered(
      shop.db,
      { orderId: delivered.id, payment: { method: 'cash', amountCents: delivered.total }, riderKeepsCents: 20_000 },
      CASHIER,
    );
    await refundedOnTheTrip(shop, delivered.id, '19:05');
    expect(r.findOrder(shop.db, delivered.id)).toMatchObject({ status: 'refunded', deliveredAt: expect.any(String) });
    expect(payoutsOf(shop.db, delivered.id)).toHaveLength(1);

    // The customer orders again: none of those was this trip's fee.
    const again = await rung(shop, '19:10');
    expect(r.getOrderSnapshot(shop.db, again.id)!.riderPaidEarlier).toBeNull();
    pk('19:20');
    expect(() => r.sendOutOrder(shop.db, again.id, CASHIER, { riderAlreadyPaid: true })).toThrow(NOT_PAID_EARLIER);

    // A refund on the trip for this customer (19:00 to 19:30) is not someone else's.
    await firstTripRefunded(shop);
    const someoneElse = await rung(shop, '19:40', { phone: OTHER_PHONE });
    expect(r.getOrderSnapshot(shop.db, someoneElse.id)!.riderPaidEarlier).toBeNull();
    // ...while this customer's next order finds it.
    const mine = await rung(shop, '19:50');
    expect(r.getOrderSnapshot(shop.db, mine.id)!.riderPaidEarlier).toMatchObject({ amountCents: 20_000 });
  });

  it('the snapshot asks only for a delivery in the kitchen or Ready with a phone: a walk-in, a takeaway, an order out have no such key', async () => {
    const shop = await till();
    const r = await repo();
    const ready = await rung(shop, '19:00');
    expect(r.getOrderSnapshot(shop.db, ready.id)).toHaveProperty('riderPaidEarlier', null);
    const walkIn = await rung(shop, '19:10', { phone: null });
    expect(r.getOrderSnapshot(shop.db, walkIn.id)).not.toHaveProperty('riderPaidEarlier');
    pk('19:20');
    r.sendOutOrder(shop.db, ready.id, CASHIER);
    expect(r.getOrderSnapshot(shop.db, ready.id)).not.toHaveProperty('riderPaidEarlier');
    pk('19:25');
    const takeaway = r.createOrder(shop.db, { mode: 'takeaway' }, CASHIER);
    r.addOrderItem(shop.db, { orderId: takeaway.id, menuItemId: shop.fries, quantity: 1, modifierIds: [] }, CASHIER);
    r.sendOrderToKitchen(shop.db, takeaway.id, CASHIER);
    expect(r.getOrderSnapshot(shop.db, takeaway.id)).not.toHaveProperty('riderPaidEarlier');
  });

  it("prepaid, through 'orders:sendOut': the first trip opened the drawer for his Rs 200; the re-rung one sent with riderAlreadyPaid pays nothing and opens nothing; Delivered closes it with no payout", async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const call = await ordersIpc(shop);

    const first = await rung(shop, '19:00', { paid: true });
    pk('19:10');
    await call('orders:sendOut', { orderId: first.id });
    expect(h.kicks).toHaveLength(1);
    await refundedOnTheTrip(shop, first.id, '19:30');

    const again = await rung(shop, '19:35', { paid: true });
    h.kicks.length = 0;
    pk('19:45');
    const snap = (await call('orders:sendOut', { orderId: again.id, riderAlreadyPaid: true })).data as {
      order: { status: string; riderKeepsCents?: number | null };
    };
    expect(snap.order).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 0 });
    expect(snap).not.toHaveProperty('riderPaidEarlier');
    expect(h.kicks).toEqual([]);
    expect(payoutsOf(shop.db, again.id)).toEqual([]);
    pk('20:00');
    expect(r.markOrderDelivered(shop.db, { orderId: again.id }, CASHIER)).toMatchObject({ status: 'paid', drawerOpenId: null });
    expect(payoutsOf(shop.db, again.id)).toEqual([]);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({
      riderChargesCents: 20_000,
      riderChargeCount: 1,
      expectedCashCents: FLOAT + first.total - 20_000 - first.total + again.total,
    });

    // With no such order the IPC refuses in the repository's words and nothing is written.
    const stranger = await rung(shop, '20:05', { phone: OTHER_PHONE, paid: true });
    const before = ledger(shop.db, stranger.id);
    pk('20:15');
    await expect(call('orders:sendOut', { orderId: stranger.id, riderAlreadyPaid: true })).rejects.toMatchObject({
      apiError: { code: 'precondition_failed', message: NOT_PAID_EARLIER },
    });
    expect(ledger(shop.db, stranger.id)).toEqual(before);
    // Only a true is a yes: anything else sends it out with its own charge, the drawer paying him.
    await call('orders:sendOut', { orderId: stranger.id, riderAlreadyPaid: 'yes' });
    expect(r.findOrder(shop.db, stranger.id)!.riderKeepsCents).toBe(20_000);
    expect(h.kicks).toHaveLength(1);
  });
});

live('(2b) Send out with "Paid now" (sendOutRiderPaid, e2e fix A): sent out and paid in one transaction', () => {
  /** A counter delivery like out()'s — Big Two + Fries + the charge — ready at 19:45; at 19:50 the rider is at the counter. */
  async function ready(shop: Shop) {
    const r = await repo();
    at('19:00');
    const o = r.createOrder(shop.db, { mode: 'delivery' }, CASHIER);
    for (const menuItemId of [shop.bigTwo, shop.fries, shop.charge]) {
      r.addOrderItem(shop.db, { orderId: o.id, menuItemId, quantity: 1, modifierIds: [] }, CASHIER);
    }
    at('19:30');
    r.sendOrderToKitchen(shop.db, o.id, CASHIER);
    at('19:45');
    r.markOrderReady(shop.db, o.id, CASHIER);
    at('19:50');
    const snap = r.getOrderSnapshot(shop.db, o.id)!;
    const bill = deliveryBillOf(snap)!;
    return { id: o.id, total: snap.order.totalCents as number, keep: bill.deliveryChargeCents as number, foodTotal: bill.foodTotalCents as number };
  }
  const leftAt = (db: AppDatabase, id: string) => (db.prepare(`SELECT dispatched_at AS d FROM orders WHERE id = ?`).get(id) as Row)['d'];

  it("cash: 'send_out' then 'rider_paid', paid 1 ms after it left; the shift expects the float plus the FOOD TOTAL (Rs 4,515); Delivered adds nothing", async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await ready(shop);
    // The owner's example, from the bill itself.
    expect([o.total, o.keep, o.foodTotal]).toEqual([471_500, 20_000, 451_500]);
    const before = ledger(shop.db, o.id);

    const paid = r.sendOutRiderPaid(shop.db, { orderId: o.id, method: 'cash', riderKeepsCents: o.keep }, CASHIER);

    // The clock did not move between the two: still sent out first, paid after.
    expect(paid).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: o.keep, dispatchedAt: PK['19:50'], sentDrawerOpenId: null });
    expect(paid.paidAt).toBe(new Date(Date.parse(PK['19:50']) + 1).toISOString());
    expect(riderSettledWhileOut(paid)).toBe(true);
    const snap = r.getOrderSnapshot(shop.db, o.id)!;
    expect(receiptDocumentFor(snap)).toBe('bill');

    expect(paymentsOf(shop.db, o.id)).toEqual([expect.objectContaining({ method: 'cash', amount_cents: o.total, tendered_cents: null, shift_id: shop.shiftId })]);
    const payouts = payoutsOf(shop.db, o.id);
    expect(payouts).toEqual([expect.objectContaining({ type: 'payout', amount_cents: o.keep, order_id: o.id })]);
    expect(drawerOf(shop.db, paid.drawerOpenId!)).toMatchObject({ kind: 'sale', amount_cents: o.foodTotal, cash_movement_id: payouts[0]!['id'] });
    expect(auditAfter(shop.db, before.audit).map((a) => `${String(a.entityType)}:${String(a.action)}`)).toEqual([
      'orders:send_out',
      'payments:create',
      'cash_movements:delivery_charge_to_rider',
      'drawer_opens:drawer_sale',
      'orders:rider_paid',
    ]);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({
      cashSalesCents: o.total,
      riderChargesCents: o.keep,
      riderChargeCount: 1,
      expectedCashCents: FLOAT + o.foodTotal,
    });

    // The release checklist: a second identical delivery, Pays after delivery
    // then Delivered + Pay — the drawer expects 5,000 + 4,515 + 4,515.
    const o2 = await out(shop);
    at('20:20');
    r.markOrderDelivered(shop.db, { orderId: o2.id, payment: { method: 'cash', amountCents: o2.total }, riderKeepsCents: o2.keep }, CASHIER);
    // Delivered on the Paid now order: no second payment, payout or drawer row.
    const mid = ledger(shop.db, o.id);
    const done = r.markOrderDelivered(shop.db, { orderId: o.id, riderKeepsCents: o.keep }, CASHIER);
    expect(done).toMatchObject({ status: 'paid', drawerOpenId: null });
    expect(ledger(shop.db, o.id)).toMatchObject({ payments: mid.payments, movements: mid.movements, drawer: mid.drawer });
    expect(payoutsOf(shop.db, o.id)).toHaveLength(1);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({
      riderChargesCents: 2 * o.keep,
      riderChargeCount: 2,
      expectedCashCents: 1_403_000,
    });
    expect(FLOAT + o.foodTotal + o2.foodTotal).toBe(1_403_000);
    expect(chainOk(shop.db)).toBe(true);
  });

  it('EasyPaisa: the wallet for the food total, cash for his fee, the payout — no drawer row; the shift expects the float', async () => {
    const shop = await till();
    const r = await repo();
    const { getShiftSummary } = await shiftRepo();
    const o = await ready(shop);
    const paid = r.sendOutRiderPaid(shop.db, { orderId: o.id, method: 'easypaisa', referenceNo: ' TEST-EP-0003 ', riderKeepsCents: o.keep }, CASHIER);
    expect(paid).toMatchObject({ status: 'out_for_delivery', drawerOpenId: null, sentDrawerOpenId: null });
    expect(Date.parse(paid.paidAt!)).toBeGreaterThan(Date.parse(paid.dispatchedAt!));
    expect(paymentsOf(shop.db, o.id).map((p) => [p['method'], p['amount_cents'], p['reference_no']])).toEqual([
      ['easypaisa', o.foodTotal, 'TEST-EP-0003'],
      ['cash', o.keep, null],
    ]);
    expect(payoutsOf(shop.db, o.id)).toHaveLength(1);
    expect(getShiftSummary(shop.db, shop.shiftId)).toMatchObject({ riderChargeCount: 1, expectedCashCents: FLOAT });
  });

  it("both or nothing: no shift, a card, a keep that is not what Send out freezes, a prepaid order, a failure part-way — refused in that step's words, still Ready, nothing written", async () => {
    const r = await repo();
    const check = async (shop: Shop, id: string, input: { method: PaymentMethod; riderKeepsCents: number }, words: string) => {
      const before = ledger(shop.db, id);
      expect(() => r.sendOutRiderPaid(shop.db, { orderId: id, ...input }, CASHIER)).toThrow(words);
      expect(ledger(shop.db, id)).toEqual(before);
      expect(leftAt(shop.db, id)).toBeNull();
    };
    const shop = await till();
    const o = await ready(shop);
    await check(shop, o.id, { method: 'card', riderKeepsCents: o.keep }, NO_CARD);
    await check(shop, o.id, { method: 'cash', riderKeepsCents: o.keep + 1 }, CHANGED);
    // A prepaid order: its Send out payout (owner Q2) is rolled back with the refusal.
    const pre = await prepaid(shop);
    await check(shop, pre.id, { method: 'cash', riderKeepsCents: 20_000 }, 'Order is already paid');
    expect(payoutsOf(shop.db, pre.id)).toEqual([]);
    // The order's own paid_at UPDATE fails: the Send out goes back too.
    failOrderUpdates(shop.db);
    await check(shop, o.id, { method: 'cash', riderKeepsCents: o.keep }, 'Test: the disk is full');
    expect(chainOk(shop.db)).toBe(true);

    const closed = await till({ shift: false });
    const c = await ready(closed);
    await check(closed, c.id, { method: 'cash', riderKeepsCents: c.keep }, NO_SHIFT);
    // The box's fallback, a plain Send out, still works with no shift: he owes.
    expect(r.sendOutOrder(closed.db, c.id, CASHIER)).toMatchObject({ status: 'out_for_delivery', paidAt: null, riderKeepsCents: c.keep });
  });
});
