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
import { riderSettledWhileOut } from '@cheeseoclock/printer-core';
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
  verifyManagerPin: async () => {
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
