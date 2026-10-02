/**
 * Deleting a TEST order — the owner only (owner, 27 Sep 2026: "the test
 * order delete option only for admin and restock back option"; migration
 * 0043) — on a real database built from every migration, foreign keys on,
 * through the real repositories in the order the IPC handlers call them:
 *  - every status but a cart still being rung up, each with its effect on
 *    stock ("Put the stock back?" — yes: as if never made, even after a
 *    hand-over that never really happened; no: ALWAYS waste), on the shift's
 *    cash, and on the payments;
 *  - every refusal, in its exact words, and a refusal writes nothing;
 *  - the repository contract: row + sync_queue + audit in one transaction,
 *    and the audit chain still verifies;
 *  - a closed shift's saved figures are never rewritten; Reports notes the
 *    deleted cash on it instead;
 *  - the order is gone from sales, Order History, customers, Recent Orders,
 *    the Live Orders board and the void / refund lists — and its waste shows
 *    as "Test orders (deleted)";
 *  - FBR rows still waiting are skipped, never sent;
 *  - what the drawer paid an outside rider for it (v0.7.34) goes with it:
 *    the preview's cash is net of it, and a payout made on the other till's
 *    shift refuses the delete there.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name, price and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderStatus, PaymentMethod } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/stock-movement-repo.js')),
  ...(await import('./repositories/order-stock-repo.js')),
  ...(await import('./repositories/fbr-queue-repo.js')),
  ...(await import('./repositories/customer-repo.js')),
  ...(await import('./repositories/rider-repo.js')),
  ...(await import('./repositories/counter-orders-repo.js')),
  ...(await import('./repositories/document-print-repo.js')),
  ...(await import('./repositories/stock-movement-search.js')),
});

type Row = Record<string, unknown>;

/** A till with the made-up shop, a shift open with a Rs 5,000 float, and the calls the handlers make. */
async function till() {
  const db = openMigrated();
  const shop = await openCostingShop(db);
  const r = await repos();
  let shift = r.openShift(db, { openingCashCents: 500_000 }, MANAGER);

  const status = (o: string): OrderStatus => r.findOrder(db, o)!.status;
  const total = (o: string) => r.findOrder(db, o)!.totalCents;
  const ring = (lines: Line[]) => shop.ring(lines);
  /** orders:sendToKitchen: the stock leaves here. */
  const send = (o: string) => r.sendOrderToKitchen(db, o, CASHIER);
  /** orders:tender, paid in full, then the stock. */
  const pay = (o: string, method: PaymentMethod = 'cash') => {
    const t = total(o);
    r.tenderOrder(db, { orderId: o, payments: [{ method, amountCents: t, tenderedCents: method === 'cash' ? t : null }] }, CASHIER);
    r.decrementForOrder(db, o, CASHIER);
  };
  const preparing = (o: string) => r.markOrderPreparing(db, o, CASHIER);
  const ready = (o: string) => r.markOrderReady(db, o, CASHIER);
  /** orders:markServed, collecting the bill in cash when asked. */
  const served = (o: string, collect = false) =>
    r.markOrderServed(db, { orderId: o, ...(collect ? { payment: { method: 'cash' as const, amountCents: total(o), tenderedCents: total(o) } } : {}) }, CASHIER);
  /** orders:deleteTest (after the owner's secret was checked). */
  const del = (o: string, restock: boolean | null, more: { reason?: string; expectStatus?: OrderStatus } = {}) =>
    r.deleteTestOrder(
      db,
      { orderId: o, reason: more.reason ?? 'Printer test', restock, expectStatus: more.expectStatus ?? status(o), ownerUserId: OWNER.userId },
      OWNER,
    );
  const expected = () => r.getShiftSummary(db, shift.id).expectedCashCents;
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Row[];
  const n = (sql: string, ...p: unknown[]) => Number(one(sql, ...p)?.['n'] ?? 0);
  /** The ledger of one order: net per reason. */
  const ledger = (o: string) =>
    Object.fromEntries(
      all(`SELECT reason, SUM(delta_qty) AS net FROM stock_movements WHERE ref_order_id = ? AND deleted_at IS NULL GROUP BY reason`, o).map(
        (x) => [String(x['reason']), Number(x['net'])],
      ),
    );
  const auditRows = () =>
    db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
                actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
                ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[];
  const newShift = (openingCashCents = 0) => {
    shift = r.openShift(db, { openingCashCents }, MANAGER);
    return shift;
  };
  return { db, shop, r, shift: () => shift, newShift, status, total, ring, send, pay, preparing, ready, served, del, expected, one, all, n, ledger, auditRows };
}

type Till = Awaited<ReturnType<typeof till>>;

const REFUSED = {
  gone: "This order is already deleted or can't be found.",
  open: 'This order is still being rung up. Use Discard at Checkout instead.',
  changed: 'This order changed while the window was open. Close it and check the order again.',
  otherTillOrder: 'This order was taken on the other till. Delete it on that till.',
  otherTillPayment: "Part of this order was paid on the other till, so it can't be deleted here. Cancel or refund it instead.",
  fbr: "This sale was sent to FBR, so it can't be deleted. Refund it instead.",
  restock: 'Choose whether to put the stock back.',
  reason: 'Write why this was a test order.',
};

let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('deleting a test order: stock, per status', () => {
  it('sent to the kitchen, unpaid — "put it back": every gram returns; the order is gone, its lines untouched', async () => {
    const o = t.ring([['fajitaM', 1]]);
    const before = { cheese: t.shop.stockOf('cheese'), dough: t.shop.stockOf('dough'), box: t.shop.stockOf('box') };
    t.send(o);
    expect(t.shop.stockOf('cheese')).toBe(before.cheese - 60);
    const lines = t.all(`SELECT * FROM order_items WHERE order_id = ?`, o);
    const done = t.del(o, true);
    expect(done).toMatchObject({ statusBefore: 'sent_to_kitchen', deleteStock: 'put_back' });
    expect(done.stock).toMatchObject({ outcome: 'not_made', answered: 'owner', how: 'test_deleted' });
    expect({ cheese: t.shop.stockOf('cheese'), dough: t.shop.stockOf('dough'), box: t.shop.stockOf('box') }).toEqual(before);
    // Nothing of it counts as food sold, and the notes say why.
    expect(t.ledger(o)['sale'] ?? 0).toBe(0);
    const notes = t.all(`SELECT DISTINCT notes FROM stock_movements WHERE ref_order_id = ? AND notes IS NOT NULL`, o).map((x) => x['notes']);
    expect(notes).toEqual(['Test order deleted, not made — put back']);
    // The order: soft-deleted with who, why and how — its status and lines as they were.
    expect(t.one(`SELECT status, deleted_by, delete_reason, delete_kind, delete_stock, deleted_at IS NOT NULL AS gone FROM orders WHERE id = ?`, o)).toEqual({
      status: 'sent_to_kitchen',
      deleted_by: OWNER.userId,
      delete_reason: 'Printer test',
      delete_kind: 'test',
      delete_stock: 'put_back',
      gone: 1,
    });
    expect(t.all(`SELECT * FROM order_items WHERE order_id = ?`, o)).toEqual(lines);
    expect(t.r.getOrderSnapshot(t.db, o)).toBeNull();
    expect(t.r.getOrderSnapshot(t.db, o, { includeDeleted: true })?.order).toMatchObject({ deleteKind: 'test', deleteStock: 'put_back' });
  });

  it('sent to the kitchen, unpaid — "don\'t put it back": always booked as WASTE, never left as a sale', async () => {
    const o = t.ring([['fajitaM', 1]]);
    const cheese = t.shop.stockOf('cheese');
    t.send(o);
    const done = t.del(o, false);
    expect(done).toMatchObject({ deleteStock: 'waste' });
    expect(done.stock).toMatchObject({ outcome: 'made', answered: 'owner' });
    expect(t.shop.stockOf('cheese')).toBe(cheese - 60);
    const l = t.ledger(o);
    expect(l['sale'] ?? 0).toBe(0);
    expect(l['waste']).toBeLessThan(0);
    const notes = t.all(`SELECT DISTINCT notes FROM stock_movements WHERE ref_order_id = ? AND reason = 'waste'`, o).map((x) => x['notes']);
    expect(notes).toEqual(['Test order deleted after cooking — counted as waste']);
  });

  it('preparing, prepaid in cash in the open shift: payments deleted, the shift\'s expected cash goes down by the cash', async () => {
    const o = t.ring([['fajitaM', 2]]);
    const start = t.expected();
    t.pay(o);
    t.preparing(o);
    expect(t.expected()).toBe(start + t.total(o));
    const done = t.del(o, true);
    expect(done.cash).toEqual([{ shiftId: t.shift().id, open: true, netCents: 240_000 }]);
    expect(t.expected()).toBe(start);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`, o)).toBe(0);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NOT NULL`, o)).toBe(1);
    // The shift closes on the float alone.
    const closed = t.r.closeShift(t.db, { shiftId: t.shift().id, countedCashCents: 500_000 }, MANAGER);
    expect(closed.varianceCents).toBe(0);
  });

  it("defense in depth: an order deleted with its payments still live leaves the shift's cash and methods too", async () => {
    // Deleting a test order deletes its payments, so the cash queries' own
    // p.deleted_at filter already drops them. This pins the SECOND filter
    // (o.deleted_at IS NULL in closeShift / getShiftSummary): an order row
    // deleted by itself — a row image from another till, a hand fix — must
    // never leave its money in the drawer. Keep both filters when merging.
    const o = t.ring([['fajitaM', 1]]);
    const start = t.expected();
    t.pay(o);
    t.preparing(o);
    t.ready(o);
    t.served(o);
    expect(t.expected()).toBe(start + t.total(o));
    t.db.prepare(`UPDATE orders SET deleted_at = ? WHERE id = ?`).run('2026-09-27T12:00:00.000Z', o);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`, o)).toBe(1);
    const summary = t.r.getShiftSummary(t.db, t.shift().id);
    expect(summary.expectedCashCents).toBe(start);
    expect(summary.cashSalesCents).toBe(0);
    expect(summary.byMethod).toEqual([]);
    const closed = t.r.closeShift(t.db, { shiftId: t.shift().id, countedCashCents: 500_000 }, MANAGER);
    expect(closed).toMatchObject({ expectedCashCents: 500_000, varianceCents: 0 });
  });

  it('served, paid, and delivered: "put it back" is allowed after a hand-over that never really happened', async () => {
    const o = t.ring([['fajitaM', 1]]);
    const cheese = t.shop.stockOf('cheese');
    t.pay(o);
    t.preparing(o);
    t.ready(o);
    t.served(o);
    // Prepaid and picked up: 'paid' (served, closed).
    expect(t.status(o)).toBe('paid');
    // A counter cancel would refuse "not made" now; the owner deleting a test may say so.
    expect(t.del(o, true)).toMatchObject({ statusBefore: 'paid', deleteStock: 'put_back' });
    expect(t.shop.stockOf('cheese')).toBe(cheese);

    // Served at the table, the bill not collected yet: 'served'.
    const table = t.ring([['fajitaM', 1]]);
    t.send(table);
    t.preparing(table);
    t.ready(table);
    t.served(table);
    expect(t.status(table)).toBe('served');
    expect(t.del(table, true)).toMatchObject({ statusBefore: 'served', deleteStock: 'put_back', cash: [] });
    expect(t.shop.stockOf('cheese')).toBe(cheese);

    // Served, then the bill collected at the table in cash: 'paid', and the cash comes off again.
    const collected = t.ring([['fajitaM', 1]]);
    t.send(collected);
    t.preparing(collected);
    t.ready(collected);
    const beforeServe = t.expected();
    t.served(collected, true);
    expect(t.status(collected)).toBe('paid');
    expect(t.expected()).toBe(beforeServe + 120_000);
    expect(t.del(collected, false)).toMatchObject({ statusBefore: 'paid', deleteStock: 'waste' });
    expect(t.expected()).toBe(beforeServe);
    // Not put back: counted as waste.
    expect(t.shop.stockOf('cheese')).toBe(cheese - 60);

    // Cash on delivery: sent, out with the rider, delivered and the cash collected.
    const customer = t.r.createCustomer(t.db, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
    const address = t.r.createAddress(t.db, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
    const rider = t.r.createRider(t.db, { name: 'Test Rider', phone: '03009876543' }, MANAGER);
    const d = t.r.createOrder(t.db, { mode: 'delivery' }, CASHIER).id;
    t.r.snapshotCustomerOntoOrder(t.db, { orderId: d, customerId: customer.id, addressId: address.id }, CASHIER);
    t.r.addOrderItem(t.db, { orderId: d, menuItemId: t.shop.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    t.send(d);
    t.ready(d);
    t.r.assignRiderToOrder(t.db, d, rider.id, CASHIER);
    const start = t.expected();
    const cod = t.total(d);
    t.r.markOrderDelivered(t.db, { orderId: d, payment: { method: 'cash', amountCents: cod, tenderedCents: cod } }, CASHIER);
    // The rider brought the cash back: 'paid'.
    expect(t.status(d)).toBe('paid');
    expect(t.expected()).toBe(start + cod);
    expect(t.del(d, false)).toMatchObject({ statusBefore: 'paid', deleteStock: 'waste' });
    expect(t.expected()).toBe(start);

    // Delivered, the cash not brought back yet: 'delivered'.
    const d2 = t.r.createOrder(t.db, { mode: 'delivery' }, CASHIER).id;
    t.r.snapshotCustomerOntoOrder(t.db, { orderId: d2, customerId: customer.id, addressId: address.id }, CASHIER);
    t.r.addOrderItem(t.db, { orderId: d2, menuItemId: t.shop.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    t.send(d2);
    t.ready(d2);
    t.r.assignRiderToOrder(t.db, d2, rider.id, CASHIER);
    t.r.markOrderDelivered(t.db, { orderId: d2 }, CASHIER);
    expect(t.status(d2)).toBe('delivered');
    const cheeseBefore = t.shop.stockOf('cheese');
    expect(t.del(d2, true)).toMatchObject({ statusBefore: 'delivered', deleteStock: 'put_back' });
    expect(t.shop.stockOf('cheese')).toBe(cheeseBefore + 60);
  });

  it('cancelled or refunded before: that answer stands — "settled_before", no stock row added', async () => {
    const v = t.ring([['fajitaM', 1]]);
    t.send(v);
    t.r.voidOrder(t.db, { orderId: v, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    const rows = t.n(`SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, v);
    expect(t.r.testDeletePreview(t.db, v, DEV).stock.state).toBe('returned_before');
    expect(t.del(v, null)).toMatchObject({ statusBefore: 'void', deleteStock: 'settled_before', stock: null });
    expect(t.n(`SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, v)).toBe(rows);

    const f = t.ring([['fajitaM', 1]]);
    t.pay(f);
    t.r.refundOrder(t.db, { orderId: f, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    expect(t.status(f)).toBe('refunded');
    expect(t.r.testDeletePreview(t.db, f, DEV).stock.state).toBe('wasted_before');
    // A restock answer sent anyway changes nothing: the cancel's answer stands.
    expect(t.del(f, true)).toMatchObject({ deleteStock: 'settled_before', stock: null });
    expect(t.ledger(f)['waste']).toBeLessThan(0);
  });

  it('a full refund across two shifts, and a part refund: every payment row (sales and refunds) is deleted', async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    t.preparing(o);
    t.ready(o);
    t.served(o);
    const firstShift = t.shift().id;
    t.r.closeShift(t.db, { shiftId: firstShift, countedCashCents: 500_000 + t.total(o) }, MANAGER);
    const second = t.newShift();
    t.r.refundOrder(t.db, { orderId: o, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    const preview = t.r.testDeletePreview(t.db, o, DEV);
    // Sold in the first shift (closed), handed back in the second (open).
    expect(preview.cash).toEqual([
      { shiftId: firstShift, open: false, netCents: 120_000 },
      { shiftId: second.id, open: true, netCents: -120_000 },
    ]);
    t.del(o, null);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`, o)).toBe(0);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`, o)).toBe(2);

    const p = t.ring([['fajitaM', 1]]);
    t.pay(p);
    t.r.refundOrder(t.db, { orderId: p, reason: 'Test refund', approverUserId: MANAGER.userId, amountCents: 20_000 }, CASHIER);
    expect(t.r.testDeletePreview(t.db, p, DEV).paid).toEqual([{ method: 'cash', netCents: 100_000 }]);
    t.del(p, true);
    expect(t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`, p)).toBe(0);
  });

  it('an order with no recipe took no stock: "none", no question asked', async () => {
    const o = t.ring([['bakedWings', 1]]);
    t.pay(o);
    expect(t.r.testDeletePreview(t.db, o, DEV).stock).toEqual({ state: 'none', lines: [] });
    expect(t.del(o, null)).toMatchObject({ deleteStock: 'none', stock: null });
  });

  it('a stock take since it was sent: that ingredient is already in the count and is not added twice', async () => {
    const o = t.ring([['fajitaM', 1]]);
    const start = t.shop.stockOf('cheese');
    t.send(o);
    t.r.recordStockMovement(t.db, { ingredientId: t.shop.ing.cheese, deltaQty: start - t.shop.stockOf('cheese'), reason: 'count' }, MANAGER);
    const preview = t.r.testDeletePreview(t.db, o, DEV);
    expect(preview.stock.lines.find((l) => l.ingredientId === t.shop.ing.cheese)).toMatchObject({ note: 'counted_since' });
    const done = t.del(o, true);
    expect(done.stock?.lines.find((l) => l.ingredientId === t.shop.ing.cheese)).toMatchObject({ alreadyCounted: 60, putBack: 0 });
    expect(t.shop.stockOf('cheese')).toBe(start);
    const notes = t.all(`SELECT notes FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND notes IS NOT NULL`, o, t.shop.ing.cheese);
    expect(notes.map((x) => x['notes'])).toContain('Test order deleted, not made — already in the stock take');
  });
});

describe.skipIf(!DatabaseSync)('deleting a test order: refusals, in the words the owner reads', () => {
  it('each refusal, and a refusal writes nothing', async () => {
    const count = () => ({
      sync: t.n(`SELECT COUNT(*) AS n FROM sync_queue`),
      audit: t.n(`SELECT COUNT(*) AS n FROM audit_log`),
      stock: t.n(`SELECT COUNT(*) AS n FROM stock_movements`),
    });

    // Still a cart.
    const cart = t.ring([['fajitaM', 1]]);
    let before = count();
    expect(() => t.del(cart, null)).toThrow(REFUSED.open);
    expect(count()).toEqual(before);

    // The status moved on while the dialog was open.
    const o = t.ring([['fajitaM', 1]]);
    t.send(o);
    before = count();
    expect(() => t.del(o, true, { expectStatus: 'preparing' })).toThrow(REFUSED.changed);
    // The stock question unanswered, and no reason.
    expect(() => t.del(o, null)).toThrow(REFUSED.restock);
    expect(() => t.del(o, true, { reason: '   ' })).toThrow(REFUSED.reason);
    expect(count()).toEqual(before);

    // FBR in production: a sale row (any status), or a paper that printed a production number.
    const sent = t.ring([['fajitaM', 1]]);
    t.pay(sent);
    t.r.enqueueFbrSubmission(t.db, sent, { made: 'up' } as never, 'production');
    expect(() => t.del(sent, true)).toThrow(REFUSED.fbr);
    t.db.prepare(`UPDATE fbr_submission_queue SET status = 'sent', irn = 'TEST-IRN-1' WHERE order_id = ?`).run(sent);
    expect(t.r.testDeletePreview(t.db, sent, DEV).refusal).toBe(REFUSED.fbr);
    const printed = t.ring([['fajitaM', 1]]);
    t.pay(printed);
    t.r.recordDocumentPrint(
      t.db,
      {
        orderId: printed,
        orderNumber: t.r.findOrder(t.db, printed)!.orderNumber,
        document: 'receipt',
        docKey: 'receipt',
        copy: 'customer',
        printNo: 0,
        outcome: 'printed',
        reason: 'payment',
        requestedByUserId: CASHIER.userId,
        approvedByUserId: null,
        printJobId: null,
        fbrIrn: 'TEST-IRN-2',
        fbrMode: 'production',
      },
      DEV,
    );
    expect(() => t.del(printed, true)).toThrow(REFUSED.fbr);

    // Taken on the other till; paid in part on the other till.
    const other = t.r.createOrder(t.db, { mode: 'takeaway' }, { userId: CASHIER.userId, deviceId: 'till-2' }).id;
    t.r.addOrderItem(t.db, { orderId: other, menuItemId: t.shop.item.bakedWings, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    t.send(other);
    expect(() => t.del(other, null)).toThrow(REFUSED.otherTillOrder);
    const split = t.ring([['bakedWings', 1]]);
    t.pay(split);
    t.db.prepare(`UPDATE payments SET device_id = 'till-2' WHERE order_id = ?`).run(split);
    expect(() => t.del(split, null)).toThrow(REFUSED.otherTillPayment);

    // Deleted already; never there.
    const twice = t.ring([['bakedWings', 1]]);
    t.pay(twice);
    t.del(twice, null);
    expect(() => t.del(twice, null, { expectStatus: 'sent_to_kitchen' })).toThrow(REFUSED.gone);
    expect(() => t.del('no-such-order', null, { expectStatus: 'paid' })).toThrow(REFUSED.gone);
  });

  it('the preview shows a refusal instead of throwing, and says what deleting would do', async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    const p = t.r.testDeletePreview(t.db, o, DEV);
    expect(p).toMatchObject({
      refusal: null,
      status: 'sent_to_kitchen',
      totalCents: 120_000,
      takenBy: 'Test Cashier',
      items: [{ name: 'Fajita Pizza — Medium', quantity: 1 }],
      paid: [{ method: 'cash', netCents: 120_000 }],
      stock: { state: 'holds' },
      cash: [{ open: true, netCents: 120_000 }],
      kitchenSlip: false,
      web: false,
    });
    expect(p.stock.lines.length).toBeGreaterThan(0);
    const cart = t.ring([['fajitaM', 1]]);
    expect(t.r.testDeletePreview(t.db, cart, DEV).refusal).toBe(REFUSED.open);
    expect(() => t.r.testDeletePreview(t.db, 'no-such-order', DEV)).toThrow(REFUSED.gone);
  });
});

describe.skipIf(!DatabaseSync)('deleting a test order: the repository contract', () => {
  it('orders, payments and stock rows each with their sync_queue and audit rows; the audit chain verifies', async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    const payment = String(t.one(`SELECT id FROM payments WHERE order_id = ?`, o)!['id']);
    const syncBefore = t.n(`SELECT COUNT(*) AS n FROM sync_queue`);
    t.del(o, false);
    // The order's delete travels as its row image, with who and why.
    const orderSync = t.one(`SELECT op, payload_json AS p FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`, o)!;
    expect(orderSync['op']).toBe('delete');
    expect(JSON.parse(String(orderSync['p']))).toMatchObject({ id: o, deletedBy: OWNER.userId, deleteKind: 'test', deleteReason: 'Printer test', deleteStock: 'waste' });
    const paySync = t.one(`SELECT op, payload_json AS p FROM sync_queue WHERE entity_type = 'payments' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`, payment)!;
    expect(paySync['op']).toBe('delete');
    expect(JSON.parse(String(paySync['p']))['deletedAt']).toBeTruthy();
    // The waste rows are new rows, each synced.
    const waste = t.all(`SELECT id FROM stock_movements WHERE ref_order_id = ? AND reason = 'waste'`, o).map((x) => String(x['id']));
    expect(waste.length).toBeGreaterThan(0);
    for (const id of waste) expect(t.n(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, id)).toBe(1);
    expect(t.n(`SELECT COUNT(*) AS n FROM sync_queue`)).toBeGreaterThan(syncBefore + waste.length);

    // Audit: the payment, the stock decision, and the order with its full before-image.
    const audit = t.all(`SELECT entity_type AS e, entity_id AS id, action, actor_user_id AS actor, before_json AS b, after_json AS a FROM audit_log WHERE entity_id IN (?, ?) AND action IN ('delete_test_order', 'stock_to_waste') ORDER BY rowid`, o, payment);
    expect(audit.map((x) => [x['e'], x['action'], x['actor']])).toEqual([
      ['orders', 'stock_to_waste', OWNER.userId],
      ['payments', 'delete_test_order', OWNER.userId],
      ['orders', 'delete_test_order', OWNER.userId],
    ]);
    const last = audit.at(-1)!;
    expect(JSON.parse(String(last['b']))).toMatchObject({ order: { id: o, status: 'sent_to_kitchen' }, items: [{ menuItemName: 'Fajita Pizza — Medium' }] });
    expect(JSON.parse(String(last['a']))).toMatchObject({
      deletedBy: OWNER.userId,
      reason: 'Printer test',
      restock: false,
      statusBefore: 'sent_to_kitchen',
      deleteStock: 'waste',
      paymentIds: [payment],
      web: false,
    });
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);
  });
});

describe.skipIf(!DatabaseSync)('deleting a test order: the shift, Reports and every list', () => {
  it("a closed shift's saved figures are never rewritten; Reports notes the deleted cash on it", async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    t.preparing(o);
    t.ready(o);
    t.served(o);
    const first = t.shift().id;
    t.r.closeShift(t.db, { shiftId: first, countedCashCents: 500_000 + t.total(o) }, MANAGER);
    const saved = t.one(`SELECT * FROM shifts WHERE id = ?`, first);
    t.newShift();
    const preview = t.r.testDeletePreview(t.db, o, DEV);
    expect(preview.cash).toEqual([{ shiftId: first, open: false, netCents: 120_000 }]);
    t.del(o, false);
    expect(t.one(`SELECT * FROM shifts WHERE id = ?`, first)).toEqual(saved);
    const { getBusinessReport } = await import('../services/business-report.js');
    const report = getBusinessReport(t.db, { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' });
    expect(report.shifts.find((s) => s.id === first)).toMatchObject({ testDeletedCashCents: 120_000, expectedCashCents: 620_000, varianceCents: 0 });
  });

  it('sold on one closed shift, refunded in cash on another: the note is signed, + where the cash came in, − where it went out', async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    t.preparing(o);
    t.ready(o);
    t.served(o);
    const sold = t.shift().id;
    t.r.closeShift(t.db, { shiftId: sold, countedCashCents: 500_000 + t.total(o) }, MANAGER);
    const refunded = t.newShift().id;
    t.r.refundOrder(t.db, { orderId: o, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    t.r.closeShift(t.db, { shiftId: refunded, countedCashCents: 0 }, MANAGER);
    const savedRefundShift = t.one(`SELECT * FROM shifts WHERE id = ?`, refunded);
    t.newShift();
    t.del(o, null);
    expect(t.one(`SELECT * FROM shifts WHERE id = ?`, refunded)).toEqual(savedRefundShift);
    const { getBusinessReport } = await import('../services/business-report.js');
    const report = getBusinessReport(t.db, { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' });
    expect(report.shifts.find((s) => s.id === sold)?.testDeletedCashCents).toBe(120_000);
    expect(report.shifts.find((s) => s.id === refunded)).toMatchObject({ testDeletedCashCents: -120_000, expectedCashCents: -120_000 });
  });

  it('gone from sales, Order History, the customer, Recent Orders, the board and the cancel / refund lists; its waste is "Test orders (deleted)"', async () => {
    const { getBusinessReport } = await import('../services/business-report.js');
    const range = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
    const customer = t.r.createCustomer(t.db, { name: 'Test Regular', phone: '03001112222' }, CASHIER);
    const keep = t.ring([['fajitaM', 1]]);
    t.pay(keep);
    const test = t.ring([['fajitaM', 1]]);
    t.r.snapshotCustomerOntoOrder(t.db, { orderId: test, customerId: customer.id, addressId: null }, CASHIER);
    t.pay(test);
    t.preparing(test);
    const cancelled = t.ring([['fajitaM', 1]]);
    t.send(cancelled);
    t.r.voidOrder(t.db, { orderId: cancelled, reason: 'Test cancel', approverUserId: MANAGER.userId, foodMade: 'made' }, CASHIER);
    const refunded = t.ring([['fajitaM', 1]]);
    t.pay(refunded);
    t.r.refundOrder(t.db, { orderId: refunded, reason: 'Test refund', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);

    const before = getBusinessReport(t.db, range);
    expect(t.r.getCustomerOrderHistory(t.db, customer.id).map((x) => x.orderId)).toEqual([test]);
    expect(t.r.listActiveOrders(t.db).map((x) => x.order.id)).toContain(test);

    t.del(test, false);
    t.del(cancelled, null);
    t.del(refunded, null);

    const after = getBusinessReport(t.db, range);
    expect(after.kpis.orderCount).toBe(before.kpis.orderCount - 1);
    expect(after.kpis.netSalesCents).toBe(before.kpis.netSalesCents - 120_000);
    expect(after.voids.map((v) => v.orderId)).not.toContain(cancelled);
    expect(after.refunds.map((x) => x.orderId)).not.toContain(refunded);
    const history = t.r.listOrderHistory(t.db, { limit: 50, offset: 0 });
    expect(history.rows.map((x) => x.id)).toEqual([keep]);
    expect(history.total).toBe(1);
    expect(t.r.getCustomerOrderHistory(t.db, customer.id)).toEqual([]);
    expect(t.r.listRecentCounterOrders(t.db, DEV).map((x) => x.id)).toEqual([keep]);
    expect(t.r.listActiveOrders(t.db).map((x) => x.order.id)).not.toContain(test);

    // Waste: the deleted test's food on its own line; the cancelled order's own
    // waste (booked when it was cancelled) moves there too — never counted twice.
    const reasons = after.foodCost!.wasteByReason.map((w) => [w.reason, w.times]);
    expect(reasons).toContainEqual(['test_order', expect.any(Number)]);
    expect(reasons.find(([r]) => r === 'cancelled_made')).toBeUndefined();
    expect(after.foodCost!.wasteCents).toBe(before.foodCost!.wasteCents + (after.foodCost!.wasteByReason.find((w) => w.reason === 'test_order')!.cents - before.foodCost!.cancelledWasteCents));

    // The owner's list: all three, newest deletion first, with the stock words' facts.
    const list = t.r.listDeletedTests(t.db, range);
    expect(list.total).toBe(3);
    expect(list.totalCents).toBe(360_000);
    expect(list.rows.map((x) => [x.orderId, x.deleteStock])).toEqual([
      [refunded, 'settled_before'],
      [cancelled, 'settled_before'],
      [test, 'waste'],
    ]);
    expect(list.rows[2]).toMatchObject({ reason: 'Printer test', takenBy: 'Test Cashier', deletedBy: 'Test Owner', paidCents: 120_000, paidMethods: ['cash'], itemsSummary: '1× Fajita Pizza — Medium' });
    expect(list.rows[2]!.wasteCents).toBeGreaterThan(0);

    // Stock history names the order as a deleted test.
    const moves = t.r.searchMovements(t.db, { ingredientId: t.shop.ing.cheese });
    expect(moves.rows.filter((m) => m.refOrderId === test).every((m) => m.orderDeletedAsTest === true)).toBe(true);
    expect(moves.rows.filter((m) => m.refOrderId === keep).some((m) => m.orderDeletedAsTest)).toBe(false);
  });

  it("staff reprint counts leave out deleted test orders", async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    const receipt = (printNo: number, reason: 'payment' | 'reprint', printJobId: string) =>
      t.r.recordDocumentPrint(
        t.db,
        {
          orderId: o,
          orderNumber: t.r.findOrder(t.db, o)!.orderNumber,
          document: 'receipt',
          docKey: 'receipt',
          copy: 'customer',
          printNo,
          outcome: 'printed',
          reason,
          requestedByUserId: CASHIER.userId,
          approvedByUserId: null,
          printJobId,
        },
        DEV,
      );
    // The receipt at payment, then the cashier prints it again.
    receipt(0, 'payment', 'job-paid');
    receipt(1, 'reprint', 'job-again');
    expect(t.r.reprintCounts(t.db, [o])).toEqual({ [o]: 1 });
    const { handPrintsByUser } = await import('../services/print-report.js');
    const range = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
    expect(handPrintsByUser(t.db, range).get(CASHIER.userId)).toBe(1);
    t.del(o, true);
    expect(t.r.reprintCounts(t.db, [o])).toEqual({});
    expect(handPrintsByUser(t.db, range).get(CASHIER.userId)).toBeUndefined();
  });
});

describe.skipIf(!DatabaseSync)('deleting a test order: FBR', () => {
  it('noop and sandbox rows still waiting become "skipped"; the queue never sends a deleted order', async () => {
    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    t.r.enqueueFbrSubmission(t.db, o, { made: 'up' } as never, 'sandbox');
    const done = t.del(o, true);
    expect(done.orderId).toBe(o);
    expect(t.all(`SELECT status, last_error AS why FROM fbr_submission_queue WHERE order_id = ?`, o)).toEqual([
      { status: 'skipped', why: 'Deleted as a test order' },
    ]);
    const audit = JSON.parse(String(t.one(`SELECT after_json AS a FROM audit_log WHERE entity_id = ? AND action = 'delete_test_order' AND entity_type = 'orders'`, o)!['a']));
    expect(audit.fbrSkippedIds).toHaveLength(1);

    // A row that was queued anyway (another path) is skipped when claimed, never submitted.
    const late = t.ring([['bakedWings', 1]]);
    t.pay(late);
    t.del(late, null);
    t.r.enqueueFbrSubmission(t.db, late, { made: 'up' } as never, 'noop');
    const keep = t.ring([['bakedWings', 1]]);
    t.pay(keep);
    t.r.enqueueFbrSubmission(t.db, keep, { made: 'up' } as never, 'noop');
    const claimed = t.r.claimNextPendingJob(t.db);
    expect(claimed?.orderId).toBe(keep);
    expect(t.one(`SELECT status FROM fbr_submission_queue WHERE order_id = ?`, late)).toEqual({ status: 'skipped' });
  });
});

describe.skipIf(!DatabaseSync)('deleting a test order: the two tills agree (deletion wins, both ways)', () => {
  it('a delete that arrives after the other till changed the order still lands; the later change never brings it back', async () => {
    const { listPendingSync, pendingToChange, markSyncedIds } = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');
    const TILL_2 = 'till-2';
    const db2 = openMigrated();
    const user = db2.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
    );
    user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
    user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
    user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
    const iAm = (db: AppDatabase, id: string) =>
      db.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, `Test ${id}`, new Date().toISOString());
    iAm(t.db, DEV);
    iAm(db2, TILL_2);
    const push = async (from: AppDatabase, fromDevice: string, to: AppDatabase) => {
      const pending = listPendingSync(from, 1_000_000);
      const r = await applyRemoteBatch(to, pending.map((p) => pendingToChange(p, fromDevice)), { pause: async () => {} });
      markSyncedIds(from, pending.map((p) => p.id));
      expect(r.waiting).toBe(0);
    };

    const o = t.ring([['fajitaM', 1]]);
    t.pay(o);
    await push(t.db, DEV, db2);
    // Till 2 moves the order on twice (its copy is now newer than till 1's)…
    t.r.markOrderPreparing(db2, o, { userId: CASHIER.userId, deviceId: TILL_2 });
    t.r.markOrderReady(db2, o, { userId: CASHIER.userId, deviceId: TILL_2 });
    // …while till 1, where it was taken, deletes it as a test.
    t.del(o, true);
    await push(t.db, DEV, db2);
    const row = (db: AppDatabase) =>
      db.prepare(`SELECT status, deleted_at IS NOT NULL AS gone, delete_kind AS kind, deleted_by AS by, delete_reason AS why FROM orders WHERE id = ?`).get(o);
    expect(row(db2)).toEqual({ status: 'ready', gone: 1, kind: 'test', by: OWNER.userId, why: 'Printer test' });
    expect(db2.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`).get(o)).toEqual({ n: 0 });
    expect(db2.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'remote_delete_applied'`).all(o)).toHaveLength(1);

    // Till 2's newer change reaches till 1: applied, but the order stays deleted.
    await push(db2, TILL_2, t.db);
    expect(row(t.db)).toEqual({ status: 'ready', gone: 1, kind: 'test', by: OWNER.userId, why: 'Printer test' });
    expect(t.db.prepare(`SELECT action FROM audit_log WHERE entity_id = ? AND action = 'remote_change_kept_deleted'`).all(o).length).toBeGreaterThan(0);
    // Both tills agree, and neither lists it.
    expect(t.r.getOrderSnapshot(t.db, o)).toBeNull();
    expect(t.r.getOrderSnapshot(db2, o)).toBeNull();
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);
  });
});

describe.skipIf(!DatabaseSync)("deleting a test order: what the drawer paid its outside rider goes with it (v0.7.34)", () => {
  /**
   * The area's 'Delivery Charge (Rs 200)' (no tax, like the shop here) and a
   * delivery with a Fajita and that charge, the made-up customer on it, not
   * sent yet.
   */
  const outsideDelivery = async (): Promise<string> => {
    const { createMenuItem } = await import('./repositories/menu-item-repo.js');
    const tax = String(t.one(`SELECT tax_category_id AS id FROM menu_items WHERE id = ?`, t.shop.item.delivery)!['id']);
    const charge = createMenuItem(
      t.db,
      { categoryId: t.shop.cat.fees, name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, taxCategoryId: tax },
      MANAGER,
    ).id;
    const customer = t.r.createCustomer(t.db, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
    const address = t.r.createAddress(t.db, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
    const d = t.r.createOrder(t.db, { mode: 'delivery' }, CASHIER).id;
    t.r.snapshotCustomerOntoOrder(t.db, { orderId: d, customerId: customer.id, addressId: address.id }, CASHIER);
    t.r.addOrderItem(t.db, { orderId: d, menuItemId: t.shop.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    t.r.addOrderItem(t.db, { orderId: d, menuItemId: charge, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    return d;
  };
  const livePayouts = (o: string) => t.all(`SELECT * FROM cash_movements WHERE order_id = ? AND type = 'payout' AND deleted_at IS NULL`, o);

  it("sent out, then Delivered + Pay in cash: the payout is soft-deleted (sync 'delete', audit 'delete_test_order'), the preview's cash is net of it, and the shift expects the float again", async () => {
    const start = t.expected();
    const d = await outsideDelivery();
    t.send(d);
    t.ready(d);
    const keep = t.r.sendOutOrder(t.db, d, CASHIER).riderKeepsCents as number;
    expect(keep).toBe(20_000);
    const total = t.total(d);
    t.r.markOrderDelivered(t.db, { orderId: d, payment: { method: 'cash', amountCents: total }, riderKeepsCents: keep }, CASHIER);
    // The rider handed in the total less his Rs 200.
    expect(t.expected()).toBe(start + total - 20_000);
    const [payout] = livePayouts(d);
    expect(payout).toMatchObject({ amount_cents: 20_000, shift_id: t.shift().id });
    const payoutId = String(payout!['id']);

    const preview = t.r.testDeletePreview(t.db, d, DEV);
    expect(preview.refusal).toBeNull();
    expect(preview.cash).toEqual([{ shiftId: t.shift().id, open: true, netCents: total - 20_000 }]);
    const done = t.del(d, false);
    expect(done.cash).toEqual([{ shiftId: t.shift().id, open: true, netCents: total - 20_000 }]);

    // The payout: soft-deleted, its delete synced and audited with the row as it was.
    expect(livePayouts(d)).toEqual([]);
    expect(t.one(`SELECT deleted_at IS NOT NULL AS gone, order_id FROM cash_movements WHERE id = ?`, payoutId)).toEqual({ gone: 1, order_id: d });
    const sync = t.one(`SELECT op, payload_json AS p FROM sync_queue WHERE entity_type = 'cash_movements' AND entity_id = ? ORDER BY rowid DESC LIMIT 1`, payoutId)!;
    expect(sync['op']).toBe('delete');
    expect(JSON.parse(String(sync['p']))).toMatchObject({ id: payoutId, deletedAt: expect.any(String) });
    const audit = t.one(
      `SELECT actor_user_id AS actor, before_json AS b, after_json AS a FROM audit_log WHERE entity_type = 'cash_movements' AND entity_id = ? AND action = 'delete_test_order'`,
      payoutId,
    )!;
    expect(audit['actor']).toBe(OWNER.userId);
    expect(JSON.parse(String(audit['b']))).toMatchObject({ id: payoutId, type: 'payout', amount_cents: 20_000, order_id: d, deleted_at: null });
    expect(JSON.parse(String(audit['a']))['deletedAt']).toBeTruthy();
    const orderAudit = t.one(`SELECT after_json AS a FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delete_test_order'`, d)!;
    expect(JSON.parse(String(orderAudit['a']))).toMatchObject({ cashMovementIds: [payoutId] });
    expect(verifyAuditChain(t.auditRows()).ok).toBe(true);

    // The drawer expects the float again: no payment, no payout.
    expect(t.expected()).toBe(start);
    expect(t.r.getShiftSummary(t.db, t.shift().id)).toMatchObject({ riderChargesCents: 0, riderChargeCount: 0, cashOutCents: 0 });
    const closed = t.r.closeShift(t.db, { shiftId: t.shift().id, countedCashCents: start }, MANAGER);
    expect(closed.varianceCents).toBe(0);
  });

  it('prepaid at the counter and sent out (the drawer paid him then): net in the preview, the float again after', async () => {
    const start = t.expected();
    const d = await outsideDelivery();
    t.pay(d);
    t.ready(d);
    const total = t.total(d);
    t.r.sendOutOrder(t.db, d, CASHIER);
    expect(t.expected()).toBe(start + total - 20_000);
    expect(t.r.testDeletePreview(t.db, d, DEV).cash).toEqual([{ shiftId: t.shift().id, open: true, netCents: total - 20_000 }]);
    t.del(d, false);
    expect(livePayouts(d)).toEqual([]);
    expect(t.expected()).toBe(start);
  });

  it('paid by EasyPaisa (the wallet for the food total, cash for his fee, the payout): no cash net in the drawer, so none in the preview', async () => {
    const d = await outsideDelivery();
    t.send(d);
    t.ready(d);
    const keep = t.r.sendOutOrder(t.db, d, CASHIER).riderKeepsCents as number;
    t.r.markOrderDelivered(t.db, { orderId: d, payment: { method: 'easypaisa', amountCents: t.total(d) }, riderKeepsCents: keep }, CASHIER);
    expect(t.r.testDeletePreview(t.db, d, DEV).cash).toEqual([]);
    t.del(d, false);
    expect(livePayouts(d)).toEqual([]);
  });

  it("a payout in the other till's shift (sent out there) -> otherTillPayment, and nothing is written", async () => {
    const TILL_2 = 'till-2';
    const d = await outsideDelivery();
    t.pay(d);
    t.ready(d);
    // The other till sends it out, its own shift open: its drawer pays the rider.
    const otherShift = t.r.openShift(t.db, { openingCashCents: 0 }, { userId: MANAGER.userId, deviceId: TILL_2 });
    t.r.sendOutOrder(t.db, d, { userId: CASHIER.userId, deviceId: TILL_2 });
    expect(livePayouts(d)).toEqual([expect.objectContaining({ shift_id: otherShift.id, amount_cents: 20_000 })]);
    // Taken and paid on this till: only the payout is the other till's.
    expect(t.all(`SELECT DISTINCT device_id FROM payments WHERE order_id = ?`, d)).toEqual([{ device_id: DEV }]);

    const counts = () => ({
      sync: t.n(`SELECT COUNT(*) AS n FROM sync_queue`),
      audit: t.n(`SELECT COUNT(*) AS n FROM audit_log`),
      payouts: livePayouts(d).length,
      payments: t.n(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`, d),
    });
    const before = counts();
    expect(t.r.testDeletePreview(t.db, d, DEV).refusal).toBe(REFUSED.otherTillPayment);
    expect(() => t.del(d, false)).toThrow(REFUSED.otherTillPayment);
    expect(counts()).toEqual(before);
    expect(t.status(d)).toBe('out_for_delivery');
  });
});
