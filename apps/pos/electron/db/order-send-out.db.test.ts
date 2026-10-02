/**
 * Send out (migration 0049 orders.rider_keeps_cents; the owner, 2 Oct 2026:
 * "Ready delivery -> Send out"; "Third-party rider keeps the delivery charge:
 * the drawer expects the food total from the rider"; Q3: "Assign rider" is
 * one of the shop's own riders, who brings back the full bill), on a real
 * database built from every migration, driven through the repositories:
 *   - Send out moves a delivery the kitchen has to out for delivery with no
 *     rider, stamps dispatched_at and freezes what the outside rider keeps:
 *     the delivery charge as sold (Rs 200, not Rs 230 with its 15% tax),
 *     never more than the total, 0 with no charge line; one sync row whose
 *     image carries it, one audit row 'send_out';
 *   - it refuses, writing nothing: a takeaway, a foodpanda order, a cart not
 *     sent, an order already out, and a status that moved under it;
 *   - Assign rider after Send out makes it an own rider's order (nothing
 *     kept) and keeps the time it left; from Ready, and own rider to own
 *     rider, exactly as v0.7.33;
 *   - Back to Ready brings a sent-out order back with nothing kept, audited
 *     'undo_send_out' ('unassign_rider' for an own rider, as before);
 *   - the lock Send out relies on (order-edit finding #1): a sent order's
 *     discount, lines and type can't change, and nothing moves an order back
 *     to 'open';
 *   - on two tills the frozen value travels with the order, and so does its
 *     clearing.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryBillOf, isOutsideRiderOrder } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill, push } from './two-tills.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

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

const live = describe.skipIf(!DatabaseSync);

const TILL_A = 'till-a';
const TILL_B = 'till-b';
const CASHIER = { userId: 'u_cash', deviceId: TILL_A };
const MANAGER = { userId: 'u_mgr', deviceId: TILL_A };
const OWNER = { userId: 'u_admin', deviceId: TILL_A };

/** Evening times in Pakistan (UTC+5), as instants. */
const PK = {
  '19:00': '2026-10-02T14:00:00.000Z',
  '19:30': '2026-10-02T14:30:00.000Z',
  '19:45': '2026-10-02T14:45:00.000Z',
  '19:50': '2026-10-02T14:50:00.000Z',
  '20:00': '2026-10-02T15:00:00.000Z',
  '20:05': '2026-10-02T15:05:00.000Z',
  '20:10': '2026-10-02T15:10:00.000Z',
} as const;
type Clock = keyof typeof PK;
const at = (t: Clock) => vi.setSystemTime(new Date(PK[t]));

const repo = () => import('./repositories/order-repo.js');
type Row = Record<string, unknown>;
interface Shop {
  db: AppDatabase;
  pizza: string;
  charge: string;
  riderA: string;
  riderB: string;
}

/**
 * A till: the made-up users, a 15% tax, a Rs 3,900 pizza, the area's
 * 'Delivery Charge (Rs 200)' at 15% (the owner's example: FOOD TOTAL
 * Rs 4,515, CUSTOMER PAYS Rs 4,715), two of the shop's own riders and a
 * shift opened at 18:00.
 */
async function till(deviceId: string = TILL_A): Promise<Shop> {
  const db = openTill(deviceId);
  const actor = { userId: 'u_mgr', deviceId };
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createRider } = await import('./repositories/rider-repo.js');
  const { openShift } = await import('./repositories/shift-repo.js');
  vi.setSystemTime(new Date('2026-10-02T13:00:00.000Z'));
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, actor);
  const food = createCategory(db, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, actor);
  const fees = createCategory(db, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, actor);
  const pizza = createMenuItem(db, { categoryId: food.id, name: 'Test Family Pizza', basePriceCents: 390_000, taxCategoryId: tax.id }, actor).id;
  const charge = createMenuItem(db, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: tax.id }, actor).id;
  const riderA = createRider(db, { name: 'Test Rider One', phone: '03001112222' }, actor).id;
  const riderB = createRider(db, { name: 'Test Rider Two', phone: '03003334444' }, actor).id;
  openShift(db, { openingCashCents: 0 }, actor);
  return { db, pizza, charge, riderA, riderB };
}

/** A counter order started at 19:00: the pizza, and the delivery charge unless `charge` is false. */
async function cart(shop: Shop, mode: 'delivery' | 'takeaway' | 'foodpanda' = 'delivery', charge = mode === 'delivery'): Promise<string> {
  const r = await repo();
  at('19:00');
  const o = r.createOrder(shop.db, { mode }, CASHIER);
  r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] }, CASHIER);
  if (charge) r.addOrderItem(shop.db, { orderId: o.id, menuItemId: shop.charge, quantity: 1, modifierIds: [] }, CASHIER);
  return o.id;
}

/** The order sent at 19:30 and made ready at 19:45 (foodpanda: paid and sent in one step). */
async function ready(shop: Shop, orderId: string): Promise<void> {
  const r = await repo();
  at('19:30');
  const order = r.findOrder(shop.db, orderId)!;
  if (order.mode === 'foodpanda') {
    r.tenderOrder(shop.db, { orderId, payments: [{ method: 'foodpanda', amountCents: order.totalCents, referenceNo: 'FP-TEST-42' }] }, CASHIER);
  } else {
    r.sendOrderToKitchen(shop.db, orderId, CASHIER);
  }
  at('19:45');
  r.markOrderReady(shop.db, orderId, CASHIER);
}

const rowOf = (db: AppDatabase, orderId: string) =>
  db
    .prepare(
      `SELECT status, assigned_rider_id, dispatched_at, rider_keeps_cents, sent_at, subtotal_cents, tax_cents, total_cents, version
         FROM orders WHERE id = ?`,
    )
    .get(orderId) as Row | undefined;
const count = (db: AppDatabase, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Everything a write leaves behind: the order row, its lines and discounts, the sync queue and the audit trail. */
const ledger = (db: AppDatabase, orderId: string) => ({
  order: rowOf(db, orderId),
  lines: count(db, 'order_items'),
  discounts: db.prepare(`SELECT id, amount_cents, deleted_at FROM order_discounts WHERE order_id = ? ORDER BY id`).all(orderId),
  sync: count(db, 'sync_queue'),
  audit: count(db, 'audit_log'),
});
/** The sync images and audit rows written after `sinceSync` / `sinceAudit` rows. */
function writtenAfter(db: AppDatabase, sinceSync: number, sinceAudit: number) {
  const sync = (db.prepare(`SELECT entity_type, entity_id, payload_json FROM sync_queue ORDER BY rowid`).all() as Row[]).slice(sinceSync).map((q) => ({
    entityType: q['entity_type'],
    entityId: q['entity_id'],
    image: JSON.parse(String(q['payload_json'])) as Row,
  }));
  const audit = (db.prepare(`SELECT entity_type, entity_id, action, before_json, after_json FROM audit_log ORDER BY rowid`).all() as Row[])
    .slice(sinceAudit)
    .map((a) => ({
      entityType: a['entity_type'],
      entityId: a['entity_id'],
      action: a['action'],
      before: JSON.parse(String(a['before_json'])) as Row,
      after: JSON.parse(String(a['after_json'])) as Row,
    }));
  return { sync, audit };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

live('Send out: what the outside rider keeps is frozen when the order leaves', () => {
  it('a Ready delivery with Delivery Charge (Rs 200) at 15%: out for delivery, no rider, dispatched now, keeps 20000 (the charge as sold, not 23000 with its tax); one sync row whose image carries it, one audit row send_out', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    // The owner's example: Rs 3,900 + Rs 200, 15% on both: Rs 4,715.
    expect(rowOf(shop.db, id)).toMatchObject({ status: 'ready', subtotal_cents: 410_000, tax_cents: 61_500, total_cents: 471_500, rider_keeps_cents: null });
    expect(isOutsideRiderOrder(r.findOrder(shop.db, id)!)).toBe(false);
    const sync0 = count(shop.db, 'sync_queue');
    const audit0 = count(shop.db, 'audit_log');

    at('19:50');
    const out = r.sendOutOrder(shop.db, id, CASHIER);

    expect(out).toMatchObject({ status: 'out_for_delivery', assignedRiderId: null, dispatchedAt: PK['19:50'], riderKeepsCents: 20_000, sentAt: PK['19:30'] });
    expect(isOutsideRiderOrder(out)).toBe(true);
    expect(rowOf(shop.db, id)).toMatchObject({
      status: 'out_for_delivery',
      assigned_rider_id: null,
      dispatched_at: PK['19:50'],
      rider_keeps_cents: 20_000,
      // Nothing about the bill moved: no money in this step.
      subtotal_cents: 410_000,
      tax_cents: 61_500,
      total_cents: 471_500,
    });
    // The same figure the bill prints as its Delivery charge; the rider hands over the FOOD TOTAL.
    const snap = r.getOrderSnapshot(shop.db, id)!;
    expect(snap.order.riderKeepsCents).toBe(20_000);
    expect(deliveryBillOf(snap)).toMatchObject({ deliveryChargeCents: 20_000, deliveryTaxCents: 3_000, foodTotalCents: 451_500, customerPaysCents: 471_500 });

    const written = writtenAfter(shop.db, sync0, audit0);
    expect(written.sync).toHaveLength(1);
    expect(written.sync[0]).toMatchObject({
      entityType: 'orders',
      entityId: id,
      image: { status: 'out_for_delivery', assignedRiderId: null, dispatchedAt: PK['19:50'], riderKeepsCents: 20_000 },
    });
    expect(written.audit).toHaveLength(1);
    expect(written.audit[0]).toMatchObject({
      entityType: 'orders',
      entityId: id,
      action: 'send_out',
      before: { status: 'ready', dispatchedAt: null },
      after: { status: 'out_for_delivery', assignedRiderId: null, dispatchedAt: PK['19:50'], riderKeepsCents: 20_000 },
    });
    expect(written.audit[0]?.before).not.toHaveProperty('riderKeepsCents');
  });

  it('straight from the kitchen too (sent, or being cooked), as Assign rider allows', async () => {
    const shop = await till();
    const r = await repo();
    const sent = await cart(shop);
    at('19:30');
    r.sendOrderToKitchen(shop.db, sent, CASHIER);
    at('19:50');
    expect(r.sendOutOrder(shop.db, sent, CASHIER)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });

    const cooking = await cart(shop);
    at('19:30');
    r.sendOrderToKitchen(shop.db, cooking, CASHIER);
    r.markOrderPreparing(shop.db, cooking, CASHIER);
    at('19:50');
    expect(r.sendOutOrder(shop.db, cooking, CASHIER)).toMatchObject({ status: 'out_for_delivery', riderKeepsCents: 20_000 });
  });

  it('a delivery with no charge line keeps 0: still an outside rider, with nothing to keep', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop, 'delivery', false);
    await ready(shop, id);
    at('19:50');
    const out = r.sendOutOrder(shop.db, id, CASHIER);
    expect(out.riderKeepsCents).toBe(0);
    expect(isOutsideRiderOrder(out)).toBe(true);
    expect(rowOf(shop.db, id)).toMatchObject({ status: 'out_for_delivery', rider_keeps_cents: 0, total_cents: 448_500 });
  });

  it('never more than the customer pays: a discount that also came off the charge (the owner’s switch on) leaves a total below Rs 200, and that total is what he keeps', async () => {
    const shop = await till();
    const r = await repo();
    const { setBusinessSetting } = await import('./repositories/business-settings-repo.js');
    setBusinessSetting(shop.db, 'discounts.delivery', { v: 1, alsoOffDeliveryCharge: true }, OWNER);
    const id = await cart(shop);
    r.applyDiscount(shop.db, { orderId: id, discountType: 'flat', value: 400_000, reason: 'Test complaint', approverUserId: 'u_mgr' }, CASHIER);
    await ready(shop, id);
    const total = Number(rowOf(shop.db, id)?.['total_cents']);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(20_000);
    // The bill keeps Subtotal / Tax / TOTAL here (no negative FOOD TOTAL)…
    expect(deliveryBillOf(r.getOrderSnapshot(shop.db, id)!)).toBeNull();
    at('19:50');
    // …and the rider keeps what the customer pays, not the Rs 200 charge.
    expect(r.sendOutOrder(shop.db, id, CASHIER).riderKeepsCents).toBe(total);
    expect(rowOf(shop.db, id)).toMatchObject({ rider_keeps_cents: total });
  });
});

live('Send out refuses, and writes nothing', () => {
  it('a takeaway and a foodpanda order: only delivery orders can be sent out', async () => {
    const shop = await till();
    const r = await repo();
    const takeaway = await cart(shop, 'takeaway');
    await ready(shop, takeaway);
    const fp = await cart(shop, 'foodpanda');
    await ready(shop, fp);
    for (const id of [takeaway, fp]) {
      const before = ledger(shop.db, id);
      at('19:50');
      expect(() => r.sendOutOrder(shop.db, id, CASHIER)).toThrow('Only delivery orders can be sent out');
      expect(ledger(shop.db, id)).toEqual(before);
    }
  });

  it('a delivery cart not sent yet (it would skip the stock), a cancelled one, and one that is not there', async () => {
    const shop = await till();
    const r = await repo();
    const open = await cart(shop);
    const before = ledger(shop.db, open);
    at('19:50');
    expect(() => r.sendOutOrder(shop.db, open, CASHIER)).toThrow("This order is still open — it can't be marked out for delivery from there");
    expect(ledger(shop.db, open)).toEqual(before);

    const cancelled = await cart(shop);
    await ready(shop, cancelled);
    r.voidOrder(shop.db, { orderId: cancelled, reason: 'Customer changed order', approverUserId: 'u_mgr', foodMade: 'not_made' }, MANAGER);
    const beforeVoid = ledger(shop.db, cancelled);
    expect(() => r.sendOutOrder(shop.db, cancelled, CASHIER)).toThrow(/This order is cancelled/);
    expect(ledger(shop.db, cancelled)).toEqual(beforeVoid);

    expect(() => r.sendOutOrder(shop.db, 'no-such-order', CASHIER)).toThrow('Order not found');
  });

  it('an order already out: sent out, or with one of the shop’s own riders', async () => {
    const shop = await till();
    const r = await repo();
    const sentOut = await cart(shop);
    await ready(shop, sentOut);
    at('19:50');
    r.sendOutOrder(shop.db, sentOut, CASHIER);
    const own = await cart(shop);
    await ready(shop, own);
    at('19:50');
    r.assignRiderToOrder(shop.db, own, shop.riderA, CASHIER);
    for (const id of [sentOut, own]) {
      const before = ledger(shop.db, id);
      at('20:00');
      expect(() => r.sendOutOrder(shop.db, id, CASHIER)).toThrow('This order is already out for delivery');
      expect(ledger(shop.db, id)).toEqual(before);
    }
  });

  it('a status that moved after it was read (the other tap won): "Order changed state…", and nothing of this call is kept', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    const before = ledger(shop.db, id);
    // The guarded UPDATE finds the order already out: another dispatcher's tap landed between the read and the write.
    let armed = true;
    const racing = {
      ...(shop.db as unknown as Record<string, unknown>),
      prepare: (sql: string) => {
        if (armed && sql.startsWith('UPDATE orders SET status = ?')) {
          armed = false;
          shop.db.prepare(`UPDATE orders SET status = 'out_for_delivery' WHERE id = ?`).run(id);
        }
        return shop.db.prepare(sql);
      },
    } as unknown as AppDatabase;
    at('19:50');
    expect(() => r.sendOutOrder(racing, id, CASHIER)).toThrow('Order changed state before this action could complete. Refresh and try again.');
    expect(armed).toBe(false);
    // Rolled back whole: the order as it was (Ready, nothing kept), no sync row, no audit row.
    expect(ledger(shop.db, id)).toEqual(before);
    expect(rowOf(shop.db, id)).toMatchObject({ status: 'ready', rider_keeps_cents: null, dispatched_at: null });
  });
});

live('Assign rider and Back to Ready around Send out', () => {
  it('Assign rider after Send out: one of the shop’s own riders now (nothing kept), and the time it left is kept', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    at('19:50');
    r.sendOutOrder(shop.db, id, CASHIER);
    const sync0 = count(shop.db, 'sync_queue');
    const audit0 = count(shop.db, 'audit_log');

    at('20:00');
    const assigned = r.assignRiderToOrder(shop.db, id, shop.riderA, CASHIER);
    expect(assigned).toMatchObject({ status: 'out_for_delivery', assignedRiderId: shop.riderA, dispatchedAt: PK['19:50'] });
    expect(assigned).not.toHaveProperty('riderKeepsCents');
    expect(isOutsideRiderOrder(assigned)).toBe(false);
    expect(rowOf(shop.db, id)).toMatchObject({ assigned_rider_id: shop.riderA, dispatched_at: PK['19:50'], rider_keeps_cents: null });

    const written = writtenAfter(shop.db, sync0, audit0);
    expect(written.sync).toHaveLength(1);
    // The image says it in so many words, so the other till clears it too.
    expect(written.sync[0]?.image).toMatchObject({ assignedRiderId: shop.riderA, dispatchedAt: PK['19:50'], riderKeepsCents: null });
    expect(written.audit.map((a) => a.action)).toEqual(['assign_rider']);
    expect(written.audit[0]?.before).toMatchObject({ riderKeepsCents: 20_000, assignedRiderId: null });
    expect(written.audit[0]?.after).not.toHaveProperty('riderKeepsCents');
  });

  it('Assign rider from Ready, and from one own rider to another, exactly as v0.7.33: stamped each time, nothing kept', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    at('19:50');
    expect(r.assignRiderToOrder(shop.db, id, shop.riderA, CASHIER)).toMatchObject({ status: 'out_for_delivery', assignedRiderId: shop.riderA, dispatchedAt: PK['19:50'] });
    expect(rowOf(shop.db, id)).toMatchObject({ rider_keeps_cents: null });
    at('20:05');
    expect(r.assignRiderToOrder(shop.db, id, shop.riderB, CASHIER)).toMatchObject({ assignedRiderId: shop.riderB, dispatchedAt: PK['20:05'] });
    expect(rowOf(shop.db, id)).toMatchObject({ rider_keeps_cents: null });
    expect(r.findOrder(shop.db, id)).not.toHaveProperty('riderKeepsCents');
  });

  it('Back to Ready on a sent-out order: Ready, no rider, nothing kept, audited undo_send_out; sent out again, it is frozen again', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    at('19:50');
    r.sendOutOrder(shop.db, id, CASHIER);
    const audit0 = count(shop.db, 'audit_log');
    const sync0 = count(shop.db, 'sync_queue');

    at('20:00');
    const back = r.unassignRiderFromOrder(shop.db, id, CASHIER);
    expect(back).toMatchObject({ status: 'ready', assignedRiderId: null });
    expect(back).not.toHaveProperty('riderKeepsCents');
    // When it left stays on record (a historical fact), as Back to Ready always did.
    expect(rowOf(shop.db, id)).toMatchObject({ status: 'ready', assigned_rider_id: null, rider_keeps_cents: null, dispatched_at: PK['19:50'] });
    const written = writtenAfter(shop.db, sync0, audit0);
    expect(written.audit.map((a) => a.action)).toEqual(['undo_send_out']);
    expect(written.sync.map((s) => s.image['riderKeepsCents'])).toEqual([null]);

    at('20:10');
    expect(r.sendOutOrder(shop.db, id, CASHIER)).toMatchObject({ status: 'out_for_delivery', dispatchedAt: PK['20:10'], riderKeepsCents: 20_000 });
  });

  it('Back to Ready on an own rider’s order is audited unassign_rider, as before; on an order not out it says what it does', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    await ready(shop, id);
    const before = ledger(shop.db, id);
    expect(() => r.unassignRiderFromOrder(shop.db, id, CASHIER)).toThrow('Only out-for-delivery orders can be taken off a rider or brought back');
    expect(ledger(shop.db, id)).toEqual(before);

    at('19:50');
    r.assignRiderToOrder(shop.db, id, shop.riderA, CASHIER);
    const audit0 = count(shop.db, 'audit_log');
    at('20:00');
    expect(r.unassignRiderFromOrder(shop.db, id, CASHIER)).toMatchObject({ status: 'ready', assignedRiderId: null });
    expect(writtenAfter(shop.db, count(shop.db, 'sync_queue'), audit0).audit.map((a) => a.action)).toEqual(['unassign_rider']);
  });
});

live('the lock Send out relies on (order-edit finding #1)', () => {
  it('a sent-out order’s discount, lines and type can’t change: each refused with nothing written, and it never reads open again', async () => {
    const shop = await till();
    const r = await repo();
    const id = await cart(shop);
    r.applyDiscount(shop.db, { orderId: id, discountType: 'percent', value: 10, reason: 'Test staff', approverUserId: 'u_mgr' }, CASHIER);
    await ready(shop, id);
    at('19:50');
    r.sendOutOrder(shop.db, id, CASHIER);
    const before = ledger(shop.db, id);
    expect(before.discounts).toHaveLength(1);

    const tries: Array<[string, () => unknown, string | RegExp]> = [
      ['a new discount', () => r.applyDiscount(shop.db, { orderId: id, discountType: 'percent', value: 20, reason: 'Test', approverUserId: 'u_mgr' }, MANAGER), "This order is out for delivery — a discount can't be added now"],
      ['taking the discount off', () => r.clearDiscount(shop.db, id, MANAGER, { approverUserId: 'u_mgr' }), "This order is out for delivery — its discount can't be changed now"],
      ['a line added', () => r.addOrderItem(shop.db, { orderId: id, menuItemId: shop.pizza, quantity: 1, modifierIds: [] }, CASHIER), /items can't be added now/],
      ['the type changed', () => r.setOrderMode(shop.db, id, 'takeaway', CASHIER), /its type can't be changed now/],
      ['dropped as a cart', () => r.discardDraft(shop.db, id, CASHIER), /.+/],
      ['sent to the kitchen again', () => r.sendOrderToKitchen(shop.db, id, CASHIER), /out for delivery/],
      ['paid as a new order', () => r.tenderOrder(shop.db, { orderId: id, payments: [{ method: 'cash', amountCents: 1, tenderedCents: 1 }] }, CASHIER), /can't be paid again here/],
    ];
    for (const [what, attempt, refusal] of tries) {
      expect(attempt, what).toThrow(refusal);
      expect(ledger(shop.db, id), what).toEqual(before);
    }
    // Back to Ready is the only way back, and it stops at Ready.
    expect(r.unassignRiderFromOrder(shop.db, id, CASHIER).status).toBe('ready');
    expect(() => r.applyDiscount(shop.db, { orderId: id, discountType: 'percent', value: 20, reason: 'Test', approverUserId: 'u_mgr' }, MANAGER)).toThrow(
      "This order is ready — a discount can't be added now",
    );
  });

  it('no status change in order-repo ever leads back to open', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'repositories', 'order-repo.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Every setOrderStatus call names where it goes: never 'open'.
    const calls = source.match(/\bsetOrderStatus\(/g) ?? [];
    const targets = [...source.matchAll(/\bsetOrderStatus\(\s*db,\s*[\w.]+,\s*'(\w+)'/g)].map((m) => m[1]);
    expect(targets.length).toBe(calls.length - 1); // all but the definition
    expect(targets).toContain('out_for_delivery');
    expect(targets).not.toContain('open');
    // No statement writes 'open' as a status (only createOrder's INSERT starts an order there).
    expect(source).not.toMatch(/SET\s+status\s*=\s*'open'/i);
    expect(source.match(/VALUES \(\?, \?, \?, 'open'/g) ?? []).toHaveLength(1);
  });
});

live('two tills: what the rider keeps travels with the order', () => {
  it('sent out on till A: till B reads 20000; assigned to an own rider on A: B reads nothing kept, the rider and the time it left', async () => {
    const a = await till(TILL_A);
    const b = openTill(TILL_B, { usersFrom: TILL_A });
    const r = await repo();
    const id = await cart(a);
    await ready(a, id);
    at('19:50');
    r.sendOutOrder(a.db, id, CASHIER);
    await push(a.db, TILL_A, b);
    expect(rowOf(b, id)).toMatchObject({ status: 'out_for_delivery', assigned_rider_id: null, dispatched_at: PK['19:50'], rider_keeps_cents: 20_000 });
    expect(isOutsideRiderOrder(r.findOrder(b, id)!)).toBe(true);

    at('20:00');
    r.assignRiderToOrder(a.db, id, a.riderA, CASHIER);
    await push(a.db, TILL_A, b);
    expect(rowOf(b, id)).toMatchObject({ status: 'out_for_delivery', assigned_rider_id: a.riderA, dispatched_at: PK['19:50'], rider_keeps_cents: null });
    expect(r.findOrder(b, id)).not.toHaveProperty('riderKeepsCents');
  });
});
