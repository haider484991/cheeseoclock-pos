/**
 * Two tills on v0.7.34 (final plan step 20-1): what migrations 0048 and 0049
 * added travels with its rows, and the money comes out right on each till.
 * On two real databases built from every migration, driven through the
 * repositories, each till's queue applied on the other exactly as the sync
 * worker does (two-tills.fixture push):
 *   - an order sent and sent out on till A, the outside rider paying on A:
 *     till B reads its sent_at, its rider_keeps_cents and the kept payout
 *     linked to the order (cash_movements.order_id); B's Delivered later
 *     leaves A's values as they were on both tills, and each drawer expects
 *     its own cash;
 *   - a wasted trip paid on A: the trip payout reaches B linked to the order,
 *     and B reads A's shift as A does;
 *   - an image without the keys (a till still on v0.7.33: no sentAt or
 *     riderKeepsCents on an order, no orderId on a cash movement) applies
 *     with nothing left waiting and leaves those values alone;
 *   - a website delivery taken on B, sent out on B with an outside rider and
 *     paid on A: A's drawer expects the float plus the FOOD TOTAL, B's the
 *     float, each read the same on both tills, and both close even;
 *   - an add-on rung on A while the first delivery for that phone (taken on
 *     B at the counter, or from the website) is in B's kitchen: no delivery
 *     charge.
 * And v0.7.35's two shift columns (migrations 0050 counted_notes_json and
 * 0051 close_report_json), the shift closed the way 'shifts:close' closes it
 * (this till's makeShiftReport):
 *   - A's close counted by note, its report made: B gets both as A saved
 *     them and reads A's count, A's report under A's till name and A's line
 *     in Shift history; B's own close travels back and leaves A's values;
 *   - an image without the keys (a till still on v0.7.34 writes neither)
 *     leaves B's values alone; a till that hears of the shift only that way
 *     reads no count and no report, the rest as closed;
 *   - the website delivery taken on B, sent out with an outside rider on B
 *     and paid on A is on A's paper under 'Website delivery' / 'outside
 *     riders (1)' and in A's ORDERS, and on nothing of B's.
 * The orders are the owner's whole-rupee example: Big Two + Fries + DHA
 * Phase 6's Rs 200 charge, all at 15% — the customer pays Rs 4,715, the
 * rider hands over Rs 4,515.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CASH_NOTE_FACE_CENTS,
  SHIFT_REPORT_SECTIONS,
  deliveryBillOf,
  isOutsideRiderOrder,
  shortOrderNumber,
  type CashCount,
  type ShiftReport,
  type ShiftReportSection,
  type WebOrder,
} from '@cheeseoclock/shared-types';
import { parseShiftReportJson } from '@cheeseoclock/shared-schemas';
import { escPosToText, renderShiftReport } from '@cheeseoclock/printer-core';
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
/** Each till's float: Rs 5,000. */
const FLOAT = 500_000;
/** DHA Phase 6's delivery charge as sold (before its tax): what an outside rider keeps. */
const KEEP = 20_000;
/** Big Two Rs 3,400 + Fries Rs 500 + the Rs 200 charge, all at 15%: CUSTOMER PAYS. */
const CUSTOMER_PAYS = 471_500;
/** …and the bill's FOOD TOTAL (with tax): what the outside rider hands over. */
const FOOD_TOTAL = 451_500;
const AREA = 'DHA Phase 6';
/** The made-up customer, as the first order's cashier typed it. */
const PHONE = '0300 1234567';

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '18:00': '2026-10-02T13:00:00.000Z',
  '18:59': '2026-10-02T13:59:00.000Z',
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:40': '2026-10-02T14:40:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:05': '2026-10-02T15:05:00.000Z',
  '20:10': '2026-10-02T15:10:00.000Z',
  '20:20': '2026-10-02T15:20:00.000Z',
  '20:30': '2026-10-02T15:30:00.000Z',
  '23:00': '2026-10-02T18:00:00.000Z',
  '23:30': '2026-10-02T18:30:00.000Z',
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
  bigTwo: string;
  fries: string;
  charge: string;
}

/**
 * Two tills on the link: on A a 15% tax, 'Test Big Two' (Rs 3,400), 'Test
 * Fries' (Rs 500) and the area's 'Delivery Charge (Rs 200)'; a shift opened
 * at 18:00 on a Rs 5,000 float on each till; everything sent both ways.
 * `names`: each till's device name (its id when not given).
 */
async function shop(names: { a?: string; b?: string } = {}): Promise<Shop> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { openShift } = await shiftRepo();
  at('18:00');
  const a = openTill(TILL_A, names.a === undefined ? {} : { displayName: names.a });
  const b = openTill(TILL_B, names.b === undefined ? { usersFrom: TILL_A } : { usersFrom: TILL_A, displayName: names.b });
  const tax = createTaxCategory(a, { name: 'Test GST', rateBps: 1_500 }, A.manager);
  const food = createCategory(a, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, A.manager);
  const fees = createCategory(a, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, A.manager);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(a, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, A.manager).id;
  const bigTwo = item(food.id, 'Test Big Two', 340_000);
  const fries = item(food.id, 'Test Fries', 50_000);
  const charge = item(fees.id, 'Delivery Charge (Rs 200)', KEEP);
  const shiftA = openShift(a, { openingCashCents: FLOAT }, A.manager).id;
  await pushOk(a, TILL_A, b);
  const shiftB = openShift(b, { openingCashCents: FLOAT }, B.manager).id;
  await pushOk(b, TILL_B, a);
  return { a, b, shiftA, shiftB, bigTwo, fries, charge };
}

async function pushOk(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
  const res = await push(from, fromDevice, to);
  expect(res).toMatchObject({ waiting: 0, dropped: 0 });
}

/** The keys v0.7.34 added to an image, by table: a till still on v0.7.33 sends none of them. */
const NEW_KEYS: Readonly<Record<string, readonly string[]>> = {
  orders: ['sentAt', 'riderKeepsCents'],
  cash_movements: ['orderId'],
};
const withoutNewKeys = (c: SyncChange): SyncChange => {
  const drop = NEW_KEYS[c.entityType];
  if (!drop) return c;
  return { ...c, payload: Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => !drop.includes(k))) } as SyncChange;
};

/** Everything `from` queued, applied on `to` as a till on v0.7.33 sends it (no v0.7.34 keys), then marked sent. */
async function pushAsOlderTill(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
  const sync = await import('./repositories/sync-repo.js');
  const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
  const pending = sync.listPendingSync(from, 1_000_000);
  const changes = pending.map((p) => withoutNewKeys(sync.pendingToChange(p, fromDevice)));
  for (const c of changes) for (const k of NEW_KEYS[c.entityType] ?? []) expect(c.payload).not.toHaveProperty(k);
  const res = await applyRemoteBatch(to, changes, { pause: async () => {} });
  expect(res).toMatchObject({ waiting: 0, dropped: 0 });
  sync.markSyncedIds(
    from,
    pending.map((p) => p.id),
  );
}

/**
 * A counter delivery on till A: Big Two + Fries + the Rs 200 charge, started
 * 19:00, sent to the kitchen 19:30, Ready 19:45, sent out with an outside
 * rider 19:50.
 */
async function sentOutOnA(s: Shop): Promise<{ id: string; orderNumber: string }> {
  const r = await repo();
  at('19:00');
  const o = r.createOrder(s.a, { mode: 'delivery' }, A.cashier);
  for (const menuItemId of [s.bigTwo, s.fries, s.charge]) {
    r.addOrderItem(s.a, { orderId: o.id, menuItemId, quantity: 1, modifierIds: [] }, A.cashier);
  }
  at('19:30');
  r.sendOrderToKitchen(s.a, o.id, A.cashier);
  at('19:45');
  r.markOrderReady(s.a, o.id, A.cashier);
  at('19:50');
  const out = r.sendOutOrder(s.a, o.id, A.cashier);
  expect(out).toMatchObject({ status: 'out_for_delivery', totalCents: CUSTOMER_PAYS, riderKeepsCents: KEEP });
  expect(deliveryBillOf(r.getOrderSnapshot(s.a, o.id)!)).toMatchObject({ foodTotalCents: FOOD_TOTAL, deliveryChargeCents: KEEP, customerPaysCents: CUSTOMER_PAYS });
  return { id: o.id, orderNumber: String(o.orderNumber) };
}

/** A website order for the made-up customer: Big Two + Fries (+ the area's charge on a delivery), cash on delivery. */
function webDelivery(s: Shop, id: string, phone = '03001234567'): WebOrder {
  return {
    id,
    status: 'new',
    customerName: 'Test Web Customer',
    customerPhone: phone,
    addressLine: 'House 12, Test Lane',
    area: AREA,
    notes: null,
    fulfilment: 'delivery',
    items: [
      { posItemId: s.bigTwo, name: 'Test Big Two', quantity: 1, unitPriceCents: 340_000, modifiers: [], notes: null },
      { posItemId: s.fries, name: 'Test Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [], notes: null },
      { posItemId: s.charge, name: 'Delivery Charge (Rs 200)', quantity: 1, unitPriceCents: KEEP, modifiers: [], notes: null },
    ],
    subtotalCents: 410_000,
    discountCents: 0,
    taxCents: 61_500,
    totalCents: CUSTOMER_PAYS,
    paymentMethod: 'cod',
    // Placed on the website a minute before the till took it in.
    createdAt: PK['18:59'],
    posOrderId: null,
    posOrderNumber: null,
  } as WebOrder;
}

/** The website bridge's own import on till B at 19:00 (the website stood in for): the order's id there. */
async function importOnB(s: Shop, web: WebOrder): Promise<{ id: string; orderNumber: string }> {
  at('19:00');
  const { webOrdersBridge } = await import('../services/web-orders-bridge.js');
  const bridge = webOrdersBridge as unknown as {
    db: unknown;
    deviceId: string;
    systemUserId: string | null;
    api: (...a: unknown[]) => Promise<Response>;
    importOne: (cfg: unknown, web: WebOrder) => Promise<void>;
  };
  bridge.db = s.b;
  bridge.deviceId = TILL_B;
  bridge.systemUserId = null;
  bridge.api = async () => new Response(JSON.stringify({ ok: true, data: { acked: true } }), { status: 200 });
  await bridge.importOne({}, web);
  const imported = s.b.prepare(`SELECT pos_order_id, status FROM web_order_imports WHERE web_order_id = ?`).get(web.id) as Row | undefined;
  expect(imported).toMatchObject({ status: 'imported' });
  const id = String(imported?.['pos_order_id']);
  const order = (await repo()).findOrder(s.b, id)!;
  expect(order).toMatchObject({ source: 'web', mode: 'delivery', status: 'sent_to_kitchen', sentAt: PK['19:00'] });
  return { id, orderNumber: String(order.orderNumber) };
}

const ROW = `status, paid_at, delivered_at, voided_at, dispatched_at, assigned_rider_id, rider_keeps_cents,
             created_at, sent_at, total_cents, deleted_at`;
const rowOf = (db: AppDatabase, id: string) => db.prepare(`SELECT ${ROW} FROM orders WHERE id = ?`).get(id) as Row | undefined;
const payoutsOf = (db: AppDatabase, orderId: string) =>
  db
    .prepare(
      `SELECT id, shift_id, type, amount_cents, reason, order_id, device_id, version FROM cash_movements
        WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all(orderId) as Row[];
const paymentsOf = (db: AppDatabase, orderId: string) =>
  db
    .prepare(`SELECT method, amount_cents, shift_id, device_id FROM payments WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`)
    .all(orderId) as Row[];
/** The order's live delivery charge lines: [name, price, quantity]. */
const charges = (db: AppDatabase, orderId: string): Array<[string, number, number]> =>
  (
    db
      .prepare(
        `SELECT menu_item_name, unit_price_cents, quantity FROM order_items
          WHERE order_id = ? AND deleted_at IS NULL AND menu_item_name LIKE 'Delivery Charge%' ORDER BY created_at, id`,
      )
      .all(orderId) as Row[]
  ).map((l) => [String(l['menu_item_name']), Number(l['unit_price_cents']), Number(l['quantity'])]);

/** A shift as both tills' Close shift box and Shift history read it. */
async function shiftFigures(db: AppDatabase, shiftId: string) {
  const { getShiftSummary } = await shiftRepo();
  const s = getShiftSummary(db, shiftId);
  return {
    cashSalesCents: s.cashSalesCents,
    cashOutCents: s.cashOutCents,
    riderChargesCents: s.riderChargesCents,
    riderChargeCount: s.riderChargeCount,
    expectedCashCents: s.expectedCashCents,
  };
}

function chainWhole(db: AppDatabase): boolean {
  const rows = (
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
                actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
                ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('two tills: sent_at, rider_keeps_cents and cash_movements.order_id travel with their rows', () => {
  it("sent out and paid by the rider on A: B reads all three; B's Delivered later leaves A's values on both tills, and each drawer expects its own", async () => {
    const s = await shop();
    const r = await repo();
    const { listCashMovements } = await shiftRepo();
    const o = await sentOutOnA(s);

    await pushOk(s.a, TILL_A, s.b);
    expect(rowOf(s.b, o.id)).toMatchObject({
      status: 'out_for_delivery',
      created_at: PK['19:00'],
      sent_at: PK['19:30'],
      dispatched_at: PK['19:50'],
      assigned_rider_id: null,
      rider_keeps_cents: KEEP,
    });
    expect(r.findOrder(s.b, o.id)).toMatchObject({ sentAt: PK['19:30'], riderKeepsCents: KEEP });
    expect(isOutsideRiderOrder(r.findOrder(s.b, o.id)!)).toBe(true);

    // The rider hands A the food total and keeps his Rs 200: the kept payout is linked to the order.
    at('20:10');
    r.takeRiderPayment(s.a, { orderId: o.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const payouts = payoutsOf(s.a, o.id);
    expect(payouts).toEqual([
      {
        id: expect.any(String),
        shift_id: s.shiftA,
        type: 'payout',
        amount_cents: KEEP,
        reason: `Delivery charge kept by the outside rider — Order #${o.orderNumber.slice(-4)}`,
        order_id: o.id,
        device_id: TILL_A,
        version: 1,
      },
    ]);
    await pushOk(s.a, TILL_A, s.b);
    expect(payoutsOf(s.b, o.id)).toEqual(payouts);
    // B's cash list for A's shift says which order it was for, as A's does.
    expect(listCashMovements(s.b, s.shiftA)).toEqual(listCashMovements(s.a, s.shiftA));
    expect(listCashMovements(s.b, s.shiftA)).toEqual([
      expect.objectContaining({ id: payouts[0]!['id'], type: 'payout', amountCents: KEEP, orderId: o.id, orderNumber: o.orderNumber }),
    ]);

    // B's later update: Delivered tapped on B. Its image carries B's copy of the values — A's.
    at('20:20');
    expect(r.markOrderDelivered(s.b, { orderId: o.id, riderKeepsCents: KEEP }, B.cashier)).toMatchObject({ status: 'paid', drawerOpenId: null });
    await pushOk(s.b, TILL_B, s.a);
    for (const db of [s.a, s.b]) {
      expect(rowOf(db, o.id)).toMatchObject({
        status: 'paid',
        paid_at: PK['20:10'],
        delivered_at: PK['20:20'],
        sent_at: PK['19:30'],
        dispatched_at: PK['19:50'],
        rider_keeps_cents: KEEP,
      });
      expect(payoutsOf(db, o.id)).toEqual(payouts);
      expect(paymentsOf(db, o.id)).toEqual([{ method: 'cash', amount_cents: CUSTOMER_PAYS, shift_id: s.shiftA, device_id: TILL_A }]);
      // A's drawer expects the float plus the FOOD TOTAL; B's, untouched, the float — read the same on either till.
      expect(await shiftFigures(db, s.shiftA)).toEqual({
        cashSalesCents: CUSTOMER_PAYS,
        cashOutCents: KEEP,
        riderChargesCents: KEEP,
        riderChargeCount: 1,
        expectedCashCents: FLOAT + FOOD_TOTAL,
      });
      expect(await shiftFigures(db, s.shiftB)).toEqual({
        cashSalesCents: 0,
        cashOutCents: 0,
        riderChargesCents: 0,
        riderChargeCount: 0,
        expectedCashCents: FLOAT,
      });
      expect(chainWhole(db)).toBe(true);
    }
    expect(rowOf(s.a, o.id)).toEqual(rowOf(s.b, o.id));
  });

  it("a wasted trip paid on A: the trip payout reaches B linked to the order, and B reads A's shift as A does", async () => {
    const s = await shop();
    const r = await repo();
    const { listCashMovements } = await shiftRepo();
    const o = await sentOutOnA(s);
    at('20:05');
    r.voidOrder(s.a, { orderId: o.id, reason: 'Customer refused at the door', approverUserId: 'u_mgr', payRiderForTrip: true }, A.cashier);
    const payouts = payoutsOf(s.a, o.id);
    expect(payouts).toEqual([
      expect.objectContaining({
        shift_id: s.shiftA,
        type: 'payout',
        amount_cents: KEEP,
        reason: `Trip paid to the outside rider — Order #${o.orderNumber.slice(-4)} cancelled`,
        order_id: o.id,
        device_id: TILL_A,
      }),
    ]);

    await pushOk(s.a, TILL_A, s.b);

    for (const db of [s.a, s.b]) {
      expect(rowOf(db, o.id)).toMatchObject({ status: 'void', paid_at: null, sent_at: PK['19:30'], dispatched_at: PK['19:50'], rider_keeps_cents: KEEP });
      expect(payoutsOf(db, o.id)).toEqual(payouts);
      expect(paymentsOf(db, o.id)).toEqual([]);
      expect(await shiftFigures(db, s.shiftA)).toEqual({
        cashSalesCents: 0,
        cashOutCents: KEEP,
        riderChargesCents: KEEP,
        riderChargeCount: 1,
        expectedCashCents: FLOAT - KEEP,
      });
      expect((await shiftFigures(db, s.shiftB)).expectedCashCents).toBe(FLOAT);
      expect(chainWhole(db)).toBe(true);
    }
    expect(listCashMovements(s.b, s.shiftA)).toEqual(listCashMovements(s.a, s.shiftA));
    expect(listCashMovements(s.b, s.shiftA)).toEqual([expect.objectContaining({ orderId: o.id, orderNumber: o.orderNumber, amountCents: KEEP })]);
  });

  it('an image without the keys (a till still on v0.7.33) applies with nothing waiting and leaves sent_at, rider_keeps_cents and the payout’s order_id alone', async () => {
    const s = await shop();
    const r = await repo();
    const sync = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const { readRowImage } = await import('./replicable-schema.js');
    const { recordCashMovement } = await shiftRepo();
    const o = await sentOutOnA(s);
    at('20:10');
    r.takeRiderPayment(s.a, { orderId: o.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    const [payout] = payoutsOf(s.a, o.id);
    await pushOk(s.a, TILL_A, s.b);

    // B taps Delivered and pays the gas man from its own drawer; its images reach A without the new keys.
    at('20:20');
    r.markOrderDelivered(s.b, { orderId: o.id, riderKeepsCents: KEEP }, B.cashier);
    const gas = recordCashMovement(s.b, { type: 'payout', amountCents: 30_000, reason: 'Test gas cylinder' }, B.manager);
    await pushAsOlderTill(s.b, TILL_B, s.a);
    expect(rowOf(s.a, o.id)).toMatchObject({
      status: 'paid',
      paid_at: PK['20:10'],
      delivered_at: PK['20:20'],
      sent_at: PK['19:30'],
      rider_keeps_cents: KEEP,
    });
    expect(r.findOrder(s.a, o.id)).toMatchObject({ sentAt: PK['19:30'], riderKeepsCents: KEEP });
    // Cash out typed by hand on B arrives as it is everywhere: no order.
    expect(s.a.prepare(`SELECT shift_id, type, amount_cents, order_id FROM cash_movements WHERE id = ?`).get(gas.id)).toEqual({
      shift_id: s.shiftB,
      type: 'payout',
      amount_cents: 30_000,
      order_id: null,
    });

    // A later image of the rider's payout from a till with no order_id column (every column it has, a version on).
    const image = withoutNewKeys({
      entityType: 'cash_movements',
      entityId: String(payout!['id']),
      op: 'upsert',
      payload: { ...readRowImage(s.b, 'cash_movements', String(payout!['id']))!, version: 2, updatedAt: PK['20:30'] },
      updatedAt: PK['20:30'],
      deviceId: TILL_B,
      version: 2,
    } as SyncChange);
    expect(image.payload).not.toHaveProperty('orderId');
    at('20:30');
    expect(await applyRemoteBatch(s.a, [image], { pause: async () => {} })).toMatchObject({ applied: 1, waiting: 0, dropped: 0 });
    expect(payoutsOf(s.a, o.id)).toEqual([{ ...payout, version: 2 }]);
    expect(sync.readParked(s.a)).toEqual([]);

    // A's drawer is as it was: the float plus the FOOD TOTAL, the Rs 200 still read as the rider's.
    expect(await shiftFigures(s.a, s.shiftA)).toEqual({
      cashSalesCents: CUSTOMER_PAYS,
      cashOutCents: KEEP,
      riderChargesCents: KEEP,
      riderChargeCount: 1,
      expectedCashCents: FLOAT + FOOD_TOTAL,
    });
    expect((await shiftFigures(s.a, s.shiftB)).expectedCashCents).toBe(FLOAT - 30_000);
    expect(chainWhole(s.a)).toBe(true);
  });
});

live('two tills: a website delivery taken on B, sent out with an outside rider on B and paid on A', () => {
  it('A’s drawer expects the float plus the FOOD TOTAL and B’s the float, read the same on both tills, and both close even', async () => {
    const s = await shop();
    const r = await repo();
    const { closeShift, findShift } = await shiftRepo();
    const web = await importOnB(s, webDelivery(s, 'web-v0734-1'));
    expect(r.findOrder(s.b, web.id)).toMatchObject({ totalCents: CUSTOMER_PAYS, shiftId: s.shiftB });
    await pushOk(s.b, TILL_B, s.a);

    at('19:45');
    r.markOrderReady(s.b, web.id, B.cashier);
    at('19:50');
    expect(r.sendOutOrder(s.b, web.id, B.cashier)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: KEEP });
    expect(deliveryBillOf(r.getOrderSnapshot(s.b, web.id)!)).toMatchObject({ foodTotalCents: FOOD_TOTAL, customerPaysCents: CUSTOMER_PAYS });
    await pushOk(s.b, TILL_B, s.a);
    expect(rowOf(s.a, web.id)).toMatchObject({ status: 'out_for_delivery', sent_at: PK['19:00'], dispatched_at: PK['19:50'], rider_keeps_cents: KEEP });

    // The rider comes back to A: Delivered + Pay in cash, he keeps his Rs 200.
    at('20:20');
    const done = r.markOrderDelivered(
      s.a,
      { orderId: web.id, payment: { method: 'cash', amountCents: CUSTOMER_PAYS }, riderKeepsCents: KEEP },
      A.cashier,
    );
    expect(done).toMatchObject({ status: 'paid', paidAt: PK['20:20'], deliveredAt: PK['20:20'], drawerOpenId: expect.any(String) });
    expect(s.a.prepare(`SELECT kind, amount_cents, shift_id, order_id FROM drawer_opens WHERE id = ?`).get(done.drawerOpenId!)).toEqual({
      kind: 'sale',
      amount_cents: FOOD_TOTAL,
      shift_id: s.shiftA,
      order_id: web.id,
    });
    await pushOk(s.a, TILL_A, s.b);

    const aShift = {
      cashSalesCents: CUSTOMER_PAYS,
      cashOutCents: KEEP,
      riderChargesCents: KEEP,
      riderChargeCount: 1,
      expectedCashCents: FLOAT + FOOD_TOTAL,
    };
    const bShift = { cashSalesCents: 0, cashOutCents: 0, riderChargesCents: 0, riderChargeCount: 0, expectedCashCents: FLOAT };
    for (const db of [s.a, s.b]) {
      expect(rowOf(db, web.id)).toMatchObject({ status: 'paid', sent_at: PK['19:00'], rider_keeps_cents: KEEP, total_cents: CUSTOMER_PAYS });
      expect(paymentsOf(db, web.id)).toEqual([{ method: 'cash', amount_cents: CUSTOMER_PAYS, shift_id: s.shiftA, device_id: TILL_A }]);
      expect(payoutsOf(db, web.id)).toEqual([expect.objectContaining({ shift_id: s.shiftA, amount_cents: KEEP, order_id: web.id, device_id: TILL_A })]);
      expect(await shiftFigures(db, s.shiftA)).toEqual(aShift);
      expect(await shiftFigures(db, s.shiftB)).toEqual(bShift);
    }

    // Each till closes its own shift counting exactly that: not short, not over — and the other till reads it so.
    at('23:00');
    expect(closeShift(s.a, { shiftId: s.shiftA, countedCashCents: FLOAT + FOOD_TOTAL }, A.manager)).toMatchObject({
      expectedCashCents: FLOAT + FOOD_TOTAL,
      varianceCents: 0,
    });
    expect(closeShift(s.b, { shiftId: s.shiftB, countedCashCents: FLOAT }, B.manager)).toMatchObject({ expectedCashCents: FLOAT, varianceCents: 0 });
    await pushOk(s.a, TILL_A, s.b);
    await pushOk(s.b, TILL_B, s.a);
    for (const db of [s.a, s.b]) {
      expect(findShift(db, s.shiftA)).toMatchObject({ expectedCashCents: FLOAT + FOOD_TOTAL, varianceCents: 0 });
      expect(findShift(db, s.shiftB)).toMatchObject({ expectedCashCents: FLOAT, varianceCents: 0 });
      expect(chainWhole(db)).toBe(true);
    }
  });
});

live('two tills: an add-on rung on A while the first delivery (taken on B) is in B’s kitchen', () => {
  /** The first delivery for PHONE in DHA Phase 6, taken on B and sent to B's kitchen: at B's counter, or from the website. */
  async function firstOnB(s: Shop, how: 'at the counter' | 'from the website'): Promise<{ id: string; orderNumber: string }> {
    if (how === 'from the website') return importOnB(s, webDelivery(s, 'web-v0734-first'));
    const r = await repo();
    const c = await import('./repositories/customer-repo.js');
    at('19:00');
    const o = r.createOrder(s.b, { mode: 'delivery' }, B.cashier);
    const customer = c.createCustomer(s.b, { name: 'Test Add-on Customer', phone: PHONE }, B.cashier);
    const address = c.createAddress(s.b, { customerId: customer.id, addressLine: 'House 12, Test Lane', area: AREA }, B.cashier);
    c.snapshotCustomerOntoOrder(s.b, { orderId: o.id, customerId: customer.id, addressId: address.id }, B.cashier);
    r.addOrderItem(s.b, { orderId: o.id, menuItemId: s.bigTwo, quantity: 1, modifierIds: [] }, B.cashier);
    at('19:30');
    r.sendOrderToKitchen(s.b, o.id, B.cashier);
    return { id: o.id, orderNumber: String(o.orderNumber) };
  }

  it.each(['at the counter', 'from the website'] as const)('the first taken %s: the add-on on A gets no Delivery Charge (Rs 200) and goes with it', async (how) => {
    const s = await shop();
    const r = await repo();
    const first = await firstOnB(s, how);
    // The first delivery carries its own charge.
    expect(charges(s.b, first.id)).toEqual([['Delivery Charge (Rs 200)', KEEP, 1]]);
    expect(r.findOrder(s.b, first.id)?.status).toBe('sent_to_kitchen');
    await pushOk(s.b, TILL_B, s.a);

    // A new Delivery cart on A: Fries, the area told by the panel with the phone typed another way.
    at('19:40');
    const addOn = r.createOrder(s.a, { mode: 'delivery' }, A.cashier).id;
    r.addOrderItem(s.a, { orderId: addOn, menuItemId: s.fries, quantity: 1, modifierIds: [] }, A.cashier);
    r.syncOrderDeliveryCharge(s.a, addOn, AREA, A.cashier, { phone: '+92 300 1234567' });

    expect(charges(s.a, addOn)).toEqual([]);
    // Fries Rs 500 + 15%: no charge on the add-on's bill.
    expect(r.findOrder(s.a, addOn)?.totalCents).toBe(57_500);
    expect(r.getOrderSnapshot(s.a, addOn)?.addOnTo).toEqual({ orderId: first.id, orderNumber: first.orderNumber });
    const area = s.a
      .prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delivery_area' ORDER BY rowid DESC LIMIT 1`)
      .get(addOn) as Row | undefined;
    expect(JSON.parse(String(area?.['after_json']))).toMatchObject({
      goesWith: { orderId: first.id, orderNumber: first.orderNumber },
      charged: 'add_on_off',
    });
    // B reads the add-on as A left it; the first delivery keeps its charge on both.
    await pushOk(s.a, TILL_A, s.b);
    expect(charges(s.b, addOn)).toEqual([]);
    expect(charges(s.a, first.id)).toEqual([['Delivery Charge (Rs 200)', KEEP, 1]]);
    expect(chainWhole(s.a)).toBe(true);
    expect(chainWhole(s.b)).toBe(true);
  });
});

// ---- v0.7.35: the note count (0050) and the shift report (0051) travel with the shift ----

const NAMES = { a: 'TEST-TILL-A (win32)', b: 'TEST-TILL-B (win32)' } as const;
/** Every section of the paper on (the owner's default). */
const ALL_SECTIONS_ON = Object.fromEntries(SHIFT_REPORT_SECTIONS.map((x) => [x.key, true])) as Record<ShiftReportSection, boolean>;
/** Every shift there is: Shift history's period here. */
const ALL_TIME = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };

/** A drawer counted by note: `rupees` notes by face (in rupees), every other row 0, and `otherCents` in coins. */
const countOf = (rupees: Readonly<Record<number, number>>, otherCents = 0): CashCount => ({
  notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: rupees[faceCents / 100] ?? 0 })),
  otherCents,
});
/** A's drawer with the rider's FOOD TOTAL in it, Rs 9,515: 5,000 × 1, 1,000 × 4, 500 × 1, 10 × 1 and a Rs 5 coin. */
const COUNT_A = countOf({ 5_000: 1, 1_000: 4, 500: 1, 10: 1 }, 500);
/** The float alone, Rs 5,000: 5,000 × 1. */
const COUNT_FLOAT = countOf({ 5_000: 1 });

/** The keys v0.7.35 added to a shift's image: a till still on v0.7.34 writes neither. */
const V0735_SHIFT_KEYS: readonly string[] = ['countedNotesJson', 'closeReportJson'];
const withoutV0735Keys = (c: SyncChange): SyncChange =>
  c.entityType === 'shifts'
    ? ({ ...c, payload: Object.fromEntries(Object.entries(c.payload as Row).filter(([k]) => !V0735_SHIFT_KEYS.includes(k))) } as SyncChange)
    : c;

const shiftRow = (db: AppDatabase, shiftId: string) => db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId) as Row | undefined;

/**
 * Closed by the till's manager as 'shifts:close' closes it on `deviceId`
 * (that till's makeShiftReport handed to closeShift), counted by note; the
 * saved text and the report it holds.
 */
async function closeReported(
  db: AppDatabase,
  deviceId: string,
  shiftId: string,
  countedCashCents: number,
  countedNotes: CashCount,
): Promise<{ json: string; report: ShiftReport }> {
  const { closeShift, getShiftCloseReport } = await shiftRepo();
  const { makeShiftReport } = await import('../services/shift-report-service.js');
  closeShift(db, { shiftId, countedCashCents, countedNotes }, on(deviceId).manager, null, { makeReport: makeShiftReport(db, deviceId) });
  const json = getShiftCloseReport(db, shiftId)?.json;
  const parsed = parseShiftReportJson(json);
  if (json === undefined || parsed === null || !('report' in parsed)) throw new Error(`No report was saved: ${String(json)}`);
  return { json, report: parsed.report };
}

/** The shift's line in Shift history (Reports → Team & leakage). */
async function historyLine(db: AppDatabase, shiftId: string) {
  const { buildTeamTab } = await import('../services/business-report.js');
  return buildTeamTab(db, ALL_TIME).shifts.find((x) => x.id === shiftId);
}

/** The saved report as the 80 mm paper prints it (48 columns, every section on), line by line. */
const paperOf = (report: ShiftReport): string[] =>
  escPosToText(
    renderShiftReport(report, { width: 48, sections: ALL_SECTIONS_ON, items: 'items', printedAt: report.closedAt, printedByName: 'Test Manager' }),
  ).split('\n');
/** A row as the 80 mm paper prints it: the label, and the amount right-aligned at 48 columns. */
const paperRow = (label: string, amount: string) => label + ' '.repeat(48 - label.length - amount.length) + amount;

live('two tills on v0.7.35: the note count and the shift report travel with the shift', () => {
  it("A's close counted by note, its report made: B gets both as A saved them and reads A's count, A's report under A's name and A's Shift history line; B's own close travels back and leaves A's values", async () => {
    const s = await shop(NAMES);
    const r = await repo();
    const { findShift, getShiftCloseReport } = await shiftRepo();
    const o = await sentOutOnA(s);
    at('20:10');
    r.takeRiderPayment(s.a, { orderId: o.id, method: 'cash', riderKeepsCents: KEEP }, A.cashier);
    at('23:00');
    const onA = await closeReported(s.a, TILL_A, s.shiftA, FLOAT + FOOD_TOTAL, COUNT_A);
    expect(onA.report).toMatchObject({ shiftId: s.shiftA, deviceId: TILL_A, tillName: 'TEST-TILL-A' });
    expect(onA.report.drawer).toMatchObject({ expectedCents: FLOAT + FOOD_TOTAL, countedCents: FLOAT + FOOD_TOTAL, varianceCents: 0, countedNotes: COUNT_A });
    const asOnA = shiftRow(s.a, s.shiftA);
    expect(asOnA).toMatchObject({ counted_notes_json: expect.any(String), close_report_json: onA.json });

    await pushOk(s.a, TILL_A, s.b);
    // B holds A's close as A saved it, both new columns included, and reads it as A does.
    expect(shiftRow(s.b, s.shiftA)).toEqual(asOnA);
    expect(findShift(s.b, s.shiftA)).toMatchObject({
      closedAt: PK['23:00'],
      countedCashCents: FLOAT + FOOD_TOTAL,
      expectedCashCents: FLOAT + FOOD_TOTAL,
      varianceCents: 0,
      countedNotes: COUNT_A,
    });
    expect(getShiftCloseReport(s.b, s.shiftA)).toEqual({ json: onA.json, deviceId: TILL_A, closedAt: PK['23:00'] });
    expect(await historyLine(s.b, s.shiftA)).toMatchObject({ countedNotes: COUNT_A, hasCloseReport: true });
    // B's own shift, still open, has neither.
    expect(shiftRow(s.b, s.shiftB)).toMatchObject({ closed_at: null, counted_notes_json: null, close_report_json: null });

    // B closes its own shift the same way, under B's name; it travels back, and A's close stays as A saved it on both tills.
    const onB = await closeReported(s.b, TILL_B, s.shiftB, FLOAT, COUNT_FLOAT);
    expect(onB.report).toMatchObject({ shiftId: s.shiftB, deviceId: TILL_B, tillName: 'TEST-TILL-B' });
    await pushOk(s.b, TILL_B, s.a);
    for (const db of [s.a, s.b]) {
      expect(shiftRow(db, s.shiftA)).toEqual(asOnA);
      expect(getShiftCloseReport(db, s.shiftA)?.json).toBe(onA.json);
      expect(findShift(db, s.shiftB)).toMatchObject({ countedCashCents: FLOAT, varianceCents: 0, countedNotes: COUNT_FLOAT });
      expect(getShiftCloseReport(db, s.shiftB)).toEqual({ json: onB.json, deviceId: TILL_B, closedAt: PK['23:00'] });
      expect(await historyLine(db, s.shiftB)).toMatchObject({ countedNotes: COUNT_FLOAT, hasCloseReport: true });
      expect(chainWhole(db)).toBe(true);
    }
    expect(shiftRow(s.a, s.shiftB)).toEqual(shiftRow(s.b, s.shiftB));
  });

  it('an image without the keys (a till still on v0.7.34 writes neither) leaves B’s values alone; a till that hears of the shift only that way reads no count and no report, the rest as closed', async () => {
    const s = await shop(NAMES);
    const sync = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const { readRowImage } = await import('./replicable-schema.js');
    const { findShift, getShiftCloseReport } = await shiftRepo();
    at('23:00');
    const onA = await closeReported(s.a, TILL_A, s.shiftA, FLOAT, COUNT_FLOAT);
    // What A sends of its close (left queued: it goes to more than one till here), both new keys in it.
    const changes = sync.listPendingSync(s.a, 1_000_000).map((p) => sync.pendingToChange(p, TILL_A));
    expect(changes.filter((c) => c.entityType === 'shifts').at(-1)?.payload).toMatchObject({
      countedNotesJson: expect.any(String),
      closeReportJson: onA.json,
    });
    await pushOk(s.a, TILL_A, s.b);
    const onB = s.b.prepare(`SELECT counted_notes_json, close_report_json FROM shifts WHERE id = ?`).get(s.shiftA) as Row;
    expect(onB).toEqual({ counted_notes_json: expect.any(String), close_report_json: onA.json });

    // A later image of A's shift as a till still on v0.7.34 writes it: every column it has, a version on — neither key.
    at('23:30');
    const later = withoutV0735Keys({
      entityType: 'shifts',
      entityId: s.shiftA,
      op: 'upsert',
      payload: { ...readRowImage(s.a, 'shifts', s.shiftA)!, version: 9, updatedAt: PK['23:30'], closeNotes: 'Test close, checked' },
      updatedAt: PK['23:30'],
      deviceId: TILL_A,
      version: 9,
    } as SyncChange);
    for (const k of V0735_SHIFT_KEYS) expect(later.payload).not.toHaveProperty(k);
    expect(await applyRemoteBatch(s.b, [later], { pause: async () => {} })).toMatchObject({ applied: 1, waiting: 0, dropped: 0 });
    expect(sync.readParked(s.b)).toEqual([]);
    expect(s.b.prepare(`SELECT version, close_notes, counted_notes_json, close_report_json FROM shifts WHERE id = ?`).get(s.shiftA)).toEqual({
      version: 9,
      close_notes: 'Test close, checked',
      ...onB,
    });
    expect(findShift(s.b, s.shiftA)?.countedNotes).toEqual(COUNT_FLOAT);
    expect(getShiftCloseReport(s.b, s.shiftA)?.json).toBe(onA.json);
    expect(await historyLine(s.b, s.shiftA)).toMatchObject({ countedNotes: COUNT_FLOAT, hasCloseReport: true });

    // Till C, on this version, hears of A's shift only from a till still on v0.7.34: no count, no report; the rest as closed.
    const c = openTill('till-c', { usersFrom: TILL_A });
    const older = changes.map(withoutV0735Keys);
    for (const ch of older.filter((x) => x.entityType === 'shifts')) for (const k of V0735_SHIFT_KEYS) expect(ch.payload).not.toHaveProperty(k);
    expect(await applyRemoteBatch(c, older, { pause: async () => {} })).toMatchObject({ applied: older.length, waiting: 0, dropped: 0 });
    expect(sync.readParked(c)).toEqual([]);
    expect(c.prepare(`SELECT counted_notes_json, close_report_json FROM shifts WHERE id = ?`).get(s.shiftA)).toEqual({
      counted_notes_json: null,
      close_report_json: null,
    });
    expect(findShift(c, s.shiftA)).toMatchObject({
      closedAt: PK['23:00'],
      countedCashCents: FLOAT,
      expectedCashCents: FLOAT,
      varianceCents: 0,
      countedNotes: null,
    });
    expect(getShiftCloseReport(c, s.shiftA)).toBeNull();
    expect(await historyLine(c, s.shiftA)).toMatchObject({ countedNotes: null, hasCloseReport: false });
  });

  it('the website delivery taken on B, sent out with an outside rider on B and paid on A: on A’s paper under Website delivery, outside riders (1), and in A’s ORDERS; nothing of it on B’s', async () => {
    const s = await shop(NAMES);
    const r = await repo();
    const { getShiftCloseReport } = await shiftRepo();
    const web = await importOnB(s, webDelivery(s, 'web-v0735-1'));
    await pushOk(s.b, TILL_B, s.a);
    at('19:45');
    r.markOrderReady(s.b, web.id, B.cashier);
    at('19:50');
    expect(r.sendOutOrder(s.b, web.id, B.cashier)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: KEEP });
    await pushOk(s.b, TILL_B, s.a);
    // The rider comes back to A: Delivered + Pay in cash, he keeps his Rs 200.
    at('20:20');
    r.markOrderDelivered(s.a, { orderId: web.id, payment: { method: 'cash', amountCents: CUSTOMER_PAYS }, riderKeepsCents: KEEP }, A.cashier);
    await pushOk(s.a, TILL_A, s.b);

    // Each till closes its own shift, counted by note, its report made there.
    at('23:00');
    const onA = await closeReported(s.a, TILL_A, s.shiftA, FLOAT + FOOD_TOTAL, COUNT_A);
    const onB = await closeReported(s.b, TILL_B, s.shiftB, FLOAT, COUNT_FLOAT);
    await pushOk(s.a, TILL_A, s.b);
    await pushOk(s.b, TILL_B, s.a);

    // A's report: the order under Website delivery with an outside rider, in its ORDERS paid in cash; his Rs 200 out of A's drawer.
    expect(onA.report.channels).toEqual([
      { channel: 'web_delivery', orderCount: 1, billedCents: CUSTOMER_PAYS, outside: { orderCount: 1, billedCents: CUSTOMER_PAYS } },
    ]);
    expect(onA.report.orders).toEqual([
      expect.objectContaining({ orderNumber: web.orderNumber, channel: 'web_delivery', outside: true, methods: ['cash'], totalCents: CUSTOMER_PAYS }),
    ]);
    expect(onA.report.drawer).toMatchObject({
      cashSalesCents: CUSTOMER_PAYS,
      riderKept: { count: 1, cents: KEEP, tripCount: 0 },
      expectedCents: FLOAT + FOOD_TOTAL,
      varianceCents: 0,
      countedNotes: COUNT_A,
    });
    // …and A's paper says so, under A's name.
    const paper = paperOf(onA.report);
    expect(paper).toContain('Till: TEST-TILL-A');
    const byChannel = paper.indexOf('BY CHANNEL');
    expect(byChannel).toBeGreaterThan(0);
    expect(paper.slice(byChannel, byChannel + 3)).toEqual([
      'BY CHANNEL',
      paperRow('Website delivery (1)', '4,715.00'),
      paperRow('  outside riders (1)', '4,715.00'),
    ]);
    expect(paper).toContain(paperRow('ORDERS (1)', '4,715.00'));
    expect(paper).toContain(paperRow(`${shortOrderNumber(web.orderNumber)} 20:20 Website delivery, Cash`, '4,715.00'));

    // B's report: the order was taken on B but settled on A — nothing of it there.
    expect(onB.report).toMatchObject({ deviceId: TILL_B, tillName: 'TEST-TILL-B', channels: [], orders: [] });
    expect(onB.report.drawer).toMatchObject({ cashSalesCents: 0, riderKept: { count: 0, cents: 0, tripCount: 0 }, expectedCents: FLOAT, varianceCents: 0 });
    const paperB = paperOf(onB.report);
    expect(paperB).toContain('Till: TEST-TILL-B');
    expect(paperB).toContain('ORDERS: none');
    expect(paperB.some((l) => l.startsWith('Website delivery'))).toBe(false);

    // Each report reaches the other till as it was saved.
    for (const db of [s.a, s.b]) {
      expect(getShiftCloseReport(db, s.shiftA)?.json).toBe(onA.json);
      expect(getShiftCloseReport(db, s.shiftB)?.json).toBe(onB.json);
      expect(chainWhole(db)).toBe(true);
    }
  });
});
