/**
 * The owner puts right how a paid order was paid (payment-method-repo.ts,
 * v0.7.42; the owner, 8 Oct 2026: "admin be able to change payment method
 * after the order have done so this issues can be resolve after at
 * closing"), on a real database built from every migration and filled
 * through the repositories:
 *   - while the shift is open, the payment's method moves and the drawer's
 *     expected cash follows by itself; the bill stays; synced and audited;
 *   - once the shift is closed, its "should be in the drawer" and difference
 *     follow (counted stays); a change that moves no cash leaves it alone;
 *   - a bill that depends on how it is paid (a card tax rate, a way of
 *     paying with a rate of its own: 0.7.45) is worked out again for the new
 *     way: the payment keeps its share of the bill at the new way's prices,
 *     the order's total and tax follow, and the cash given back or taken
 *     opens the drawer while the shift is open;
 *   - refused: a payment not on the order, foodpanda, a bill with a refund
 *     on it, one FBR already took, one that no longer comes out as it was
 *     paid; the same method again is nothing.
 *
 * node's `node:sqlite` stands in for better-sqlite3 (skipped where missing).
 * Every name, item and amount is made up (the repository is public).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { TEST_USERS, openTill } from './two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';
import { billByMethod } from '@cheeseoclock/shared-types';

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
vi.mock('../services/print-spooler.js', () => ({ printSpooler: new Proxy({}, { get: () => () => undefined }), drawerFailureText: () => '' }));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL = 'till-paymethod';
const CASHIER = { userId: TEST_USERS.cashier.userId, deviceId: TILL };
const MANAGER = { userId: TEST_USERS.manager.userId, deviceId: TILL };
const OWNER = { userId: TEST_USERS.owner.userId, deviceId: TILL };
const FLOAT = 500_000;

const orderRepo = () => import('./repositories/order-repo.js');
const shiftRepo = () => import('./repositories/shift-repo.js');
const repo = () => import('./repositories/payment-method-repo.js');

interface Shop {
  db: AppDatabase;
  burger: string;
  /** On a tax with a lower card rate (15% in cash, 5% by card): its bill depends on how it is paid. */
  cardRated: string;
  /** The same, but JazzCash pays the cash rate (0.7.45: a rate for each way of paying). */
  jazzAtCash: string;
  shiftId: string;
}

async function shop(): Promise<Shop> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { openShift } = await shiftRepo();
  const db = openTill(TILL);
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
  const cardTax = createTaxCategory(db, { name: 'Test GST card rate', rateBps: 1_500, digitalRateBps: 500 }, MANAGER);
  const jazzTax = createTaxCategory(db, { name: 'Test GST JazzCash at cash', rateBps: 1_500, digitalRateBps: 500, methodRatesBps: { jazzcash: 1_500 } }, MANAGER);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const burger = createMenuItem(db, { categoryId: food.id, name: 'Test Zinger Burger', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  const cardRated = createMenuItem(db, { categoryId: food.id, name: 'Test Card Rate Burger', basePriceCents: 100_000, taxCategoryId: cardTax.id }, MANAGER).id;
  const jazzAtCash = createMenuItem(db, { categoryId: food.id, name: 'Test JazzCash Burger', basePriceCents: 100_000, taxCategoryId: jazzTax.id }, MANAGER).id;
  const shiftId = openShift(db, { openingCashCents: FLOAT }, CASHIER).id;
  return { db, burger, cardRated, jazzAtCash, shiftId };
}

/** A paid takeaway of one item; its order id and its one payment's id. */
async function paid(s: Shop, method: 'cash' | 'card' | 'jazzcash', item = s.burger): Promise<{ orderId: string; paymentId: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
  r.addOrderItem(s.db, { orderId: o.id, menuItemId: item, quantity: 1, modifierIds: [] }, CASHIER);
  const order = r.findOrder(s.db, o.id)!;
  // A card on a card-rated bill pays the bill at the card rate; each way its own bill.
  const total = billByMethod(order, method);
  r.tenderOrder(s.db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total + 5_000 : null }] }, CASHIER);
  const p = s.db.prepare(`SELECT id FROM payments WHERE order_id = ?`).get(o.id) as { id: string };
  return { orderId: o.id, paymentId: p.id, total };
}

const expected = async (s: Shop) => (await shiftRepo()).getShiftSummary(s.db, s.shiftId).expectedCashCents;
const methodOf = (s: Shop, paymentId: string) =>
  s.db.prepare(`SELECT method, tendered_cents AS tendered FROM payments WHERE id = ?`).get(paymentId) as { method: string; tendered: number | null };
const paymentOf = (s: Shop, paymentId: string) =>
  s.db.prepare(`SELECT method, amount_cents AS amount, tendered_cents AS tendered FROM payments WHERE id = ?`).get(paymentId) as {
    method: string;
    amount: number;
    tendered: number | null;
  };
const billOf = async (s: Shop, orderId: string) => {
  const o = (await orderRepo()).findOrder(s.db, orderId)!;
  return { total: o.totalCents, tax: o.taxCents, cardNet: o.digitalNetCents ?? 0, cardTax: o.digitalTaxCents ?? 0 };
};
const drawerRow = (s: Shop, id: string | null) =>
  id === null
    ? null
    : (s.db
        .prepare(`SELECT kind, amount_cents AS amount, reason, order_id AS orderId, approved_by_user_id AS approvedBy FROM drawer_opens WHERE id = ?`)
        .get(id) as { kind: string; amount: number; reason: string; orderId: string; approvedBy: string | null });
const audits = (db: AppDatabase, entityType: string, action: string) =>
  (db.prepare(`SELECT before_json AS before, after_json AS after FROM audit_log WHERE entity_type = ? AND action = ? ORDER BY rowid`).all(entityType, action) as Array<{
    before: string;
    after: string;
  }>).map((r) => ({ before: JSON.parse(r.before) as Record<string, unknown>, after: JSON.parse(r.after) as Record<string, unknown> }));
const synced = (db: AppDatabase, entityType: string, id: string) =>
  (db.prepare(`SELECT payload_json AS payload FROM sync_queue WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`).all(entityType, id) as Array<{
    payload: string;
  }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

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

live('changing how a paid order was paid', () => {
  it('shift open: Cash that came by JazzCash — the drawer expects that much less, the bill stays, synced and audited', async () => {
    const s = await shop();
    const { orderId, paymentId, total } = await paid(s, 'cash');
    const bill = (await orderRepo()).findOrder(s.db, orderId)!;
    const before = await expected(s);
    expect(before).toBe(FLOAT + total);

    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'jazzcash' }, OWNER);
    expect(r).toEqual({ from: 'cash', to: 'jazzcash', unchanged: false, closedShift: null, rebilled: null, drawerOpenId: expect.any(String) });
    // The cash went back to the customer: the drawer opened for it.
    expect(drawerRow(s, r.drawerOpenId)).toEqual({ kind: 'refund', amount: -total, reason: 'Payment changed: Cash to JazzCash', orderId, approvedBy: null });
    expect(methodOf(s, paymentId)).toEqual({ method: 'jazzcash', tendered: null });
    expect(await expected(s)).toBe(FLOAT);
    // The bill as it was printed.
    const after = (await orderRepo()).findOrder(s.db, orderId)!;
    expect([after.totalCents, after.taxCents, after.paidAt, after.status]).toEqual([bill.totalCents, bill.taxCents, bill.paidAt, bill.status]);
    // Synced as the payment's post-image, audited with what it was.
    expect(synced(s.db, 'payments', paymentId).at(-1)).toMatchObject({ id: paymentId, method: 'jazzcash', amountCents: total, tenderedCents: null });
    expect(audits(s.db, 'payments', 'change_method')).toEqual([
      { before: { method: 'cash', tenderedCents: total + 5_000 }, after: { method: 'jazzcash', tenderedCents: null, orderId, orderNumber: bill.orderNumber, amountCents: total } },
    ]);
    expect(chainOk(s.db)).toBe(true);
  });

  it('shift closed: a card slip that was cash — the drawer that read over now matches; counted stays, the change is audited', async () => {
    const s = await shop();
    const { orderId, paymentId, total } = await paid(s, 'card');
    const { closeShift, findShift } = await shiftRepo();
    // The cash was in the drawer: counted Rs total over what the till expected.
    closeShift(s.db, { shiftId: s.shiftId, countedCashCents: FLOAT + total }, MANAGER);
    expect(findShift(s.db, s.shiftId)).toMatchObject({ expectedCashCents: FLOAT, varianceCents: total });

    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'cash' }, OWNER);
    expect(r.closedShift).toMatchObject({ shiftId: s.shiftId, expectedCashCents: FLOAT + total, varianceCents: 0, previousVarianceCents: total });
    expect(findShift(s.db, s.shiftId)).toMatchObject({ countedCashCents: FLOAT + total, expectedCashCents: FLOAT + total, varianceCents: 0 });
    // The shift's live figures agree with what is stored now.
    expect(await expected(s)).toBe(FLOAT + total);
    expect(audits(s.db, 'shifts', 'drawer_corrected')).toEqual([
      {
        before: { expectedCashCents: FLOAT, varianceCents: total },
        after: { expectedCashCents: FLOAT + total, varianceCents: 0, paymentId, orderNumber: (await orderRepo()).findOrder(s.db, orderId)!.orderNumber, from: 'card', to: 'cash' },
      },
    ]);
    expect(synced(s.db, 'shifts', s.shiftId).at(-1)).toMatchObject({ id: s.shiftId, expectedCashCents: FLOAT + total, varianceCents: 0 });
    expect(chainOk(s.db)).toBe(true);
  });

  it('shift closed: card to JazzCash moves no cash — the closed drawer is left alone', async () => {
    const s = await shop();
    const { orderId, paymentId } = await paid(s, 'card');
    const { closeShift, findShift } = await shiftRepo();
    closeShift(s.db, { shiftId: s.shiftId, countedCashCents: FLOAT }, MANAGER);
    const was = findShift(s.db, s.shiftId);
    const versionOf = () => (s.db.prepare(`SELECT version FROM shifts WHERE id = ?`).get(s.shiftId) as { version: number }).version;
    const v = versionOf();
    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'jazzcash' }, OWNER);
    expect(r).toMatchObject({ from: 'card', to: 'jazzcash', closedShift: null });
    expect(findShift(s.db, s.shiftId)).toMatchObject({ expectedCashCents: was!.expectedCashCents, varianceCents: was!.varianceCents });
    expect(versionOf()).toBe(v);
    expect(audits(s.db, 'shifts', 'drawer_corrected')).toEqual([]);
  });

  it('the same method again is nothing: no write, no audit row', async () => {
    const s = await shop();
    const { orderId, paymentId } = await paid(s, 'cash');
    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'cash' }, OWNER);
    expect(r).toEqual({ from: 'cash', to: 'cash', unchanged: true, closedShift: null, rebilled: null, drawerOpenId: null });
    expect(audits(s.db, 'payments', 'change_method')).toEqual([]);
  });

  it('refused: a payment not on the order, foodpanda, a method that is not one of the five', async () => {
    const s = await shop();
    const a = await paid(s, 'cash');
    const b = await paid(s, 'cash');
    const m = await repo();
    expect(() => m.changePaymentMethod(s.db, { orderId: a.orderId, paymentId: b.paymentId, method: 'card' }, OWNER)).toThrow(m.PAYMENT_METHOD_NOT_ON_ORDER);
    expect(() => m.changePaymentMethod(s.db, { orderId: a.orderId, paymentId: a.paymentId, method: 'foodpanda' as never }, OWNER)).toThrow(m.PAYMENT_METHOD_PICK);
    // A foodpanda payment (as foodpanda's orders are paid) stays as it is.
    s.db.prepare(`UPDATE payments SET method = 'foodpanda' WHERE id = ?`).run(a.paymentId);
    expect(() => m.changePaymentMethod(s.db, { orderId: a.orderId, paymentId: a.paymentId, method: 'cash' }, OWNER)).toThrow(m.PAYMENT_METHOD_FOODPANDA);
    expect(methodOf(s, b.paymentId).method).toBe('cash');
  });

});

live('a bill that depends on how it is paid, worked out again for the new way (0.7.45)', () => {
  it('shift open: Cash to Card — Rs 1,150 in cash becomes Rs 1,050 on the card, the tax 5%; the cash goes back through the drawer; synced and audited', async () => {
    const s = await shop();
    const { orderId, paymentId, total } = await paid(s, 'cash', s.cardRated);
    expect(total).toBe(115_000);
    const manager = TEST_USERS.manager.userId;
    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'card' }, CASHIER, { approverUserId: manager });
    expect(r).toEqual({
      from: 'cash',
      to: 'card',
      unchanged: false,
      closedShift: null,
      rebilled: { amountBeforeCents: 115_000, amountAfterCents: 105_000, totalBeforeCents: 115_000, totalAfterCents: 105_000 },
      drawerOpenId: expect.any(String),
    });
    expect(paymentOf(s, paymentId)).toEqual({ method: 'card', amount: 105_000, tendered: null });
    expect(await billOf(s, orderId)).toEqual({ total: 105_000, tax: 5_000, cardNet: 100_000, cardTax: 5_000 });
    // The Rs 1,150 went back: the drawer expects the float alone, and opened to give it back.
    expect(await expected(s)).toBe(FLOAT);
    expect(drawerRow(s, r.drawerOpenId)).toEqual({ kind: 'refund', amount: -115_000, reason: 'Payment changed: Cash to Card', orderId, approvedBy: manager });
    const order = (await orderRepo()).findOrder(s.db, orderId)!;
    expect(synced(s.db, 'payments', paymentId).at(-1)).toMatchObject({ id: paymentId, method: 'card', amountCents: 105_000, tenderedCents: null });
    expect(synced(s.db, 'orders', orderId).at(-1)).toMatchObject({ id: orderId, totalCents: 105_000, taxCents: 5_000, digitalNetCents: 100_000 });
    expect(audits(s.db, 'payments', 'change_method')).toEqual([
      {
        before: { method: 'cash', tenderedCents: 120_000, amountCents: 115_000 },
        after: { method: 'card', tenderedCents: null, orderId, orderNumber: order.orderNumber, amountCents: 105_000, approvedByUserId: manager },
      },
    ]);
    expect(audits(s.db, 'orders', 'rebill_payment_method')).toEqual([
      {
        before: { totalCents: 115_000, taxCents: 15_000, digitalNetCents: 0, digitalTaxCents: 0 },
        after: { totalCents: 105_000, taxCents: 5_000, digitalNetCents: 100_000, digitalTaxCents: 5_000, paymentId, from: 'cash', to: 'card', approvedByUserId: manager },
      },
    ]);
    expect(chainOk(s.db)).toBe(true);
  });

  it('shift open: Card to Cash — Rs 1,050 on the card becomes Rs 1,150 in cash; the drawer takes it', async () => {
    const s = await shop();
    const { orderId, paymentId, total } = await paid(s, 'card', s.cardRated);
    expect(total).toBe(105_000);
    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'cash' }, MANAGER);
    expect(r.rebilled).toEqual({ amountBeforeCents: 105_000, amountAfterCents: 115_000, totalBeforeCents: 105_000, totalAfterCents: 115_000 });
    expect(paymentOf(s, paymentId)).toEqual({ method: 'cash', amount: 115_000, tendered: null });
    expect(await billOf(s, orderId)).toEqual({ total: 115_000, tax: 15_000, cardNet: 0, cardTax: 0 });
    expect(await expected(s)).toBe(FLOAT + 115_000);
    expect(drawerRow(s, r.drawerOpenId)).toMatchObject({ kind: 'sale', amount: 115_000, reason: 'Payment changed: Card to Cash' });
    expect(chainOk(s.db)).toBe(true);
  });

  it('Card to JazzCash at the one card rate: the same bill, so the amount stays and nothing is worked out again', async () => {
    const s = await shop();
    const card = await paid(s, 'card', s.cardRated);
    const r = (await repo()).changePaymentMethod(s.db, { orderId: card.orderId, paymentId: card.paymentId, method: 'jazzcash' }, OWNER);
    expect(r).toMatchObject({ to: 'jazzcash', rebilled: null, drawerOpenId: null });
    expect(paymentOf(s, card.paymentId)).toEqual({ method: 'jazzcash', amount: 105_000, tendered: null });
    expect(await billOf(s, card.orderId)).toEqual({ total: 105_000, tax: 5_000, cardNet: 100_000, cardTax: 5_000 });
    expect(audits(s.db, 'orders', 'rebill_payment_method')).toEqual([]);
  });

  it('JazzCash with a rate of its own (the cash rate): Card Rs 1,050 to JazzCash is Rs 1,150, all of it at the cash rate', async () => {
    const s = await shop();
    const card = await paid(s, 'card', s.jazzAtCash);
    expect(card.total).toBe(105_000);
    const r = (await repo()).changePaymentMethod(s.db, { orderId: card.orderId, paymentId: card.paymentId, method: 'jazzcash' }, OWNER);
    expect(r).toMatchObject({ rebilled: { amountAfterCents: 115_000, totalAfterCents: 115_000 }, drawerOpenId: null });
    expect(await billOf(s, card.orderId)).toEqual({ total: 115_000, tax: 15_000, cardNet: 0, cardTax: 0 });
    // …and back to the card: Rs 1,050 at 5% again.
    (await repo()).changePaymentMethod(s.db, { orderId: card.orderId, paymentId: card.paymentId, method: 'card' }, OWNER);
    expect(await billOf(s, card.orderId)).toEqual({ total: 105_000, tax: 5_000, cardNet: 100_000, cardTax: 5_000 });
  });

  it('half on the card, half in cash: the cash half moved to the card pays half the bill by card — the whole bill Rs 1,050', async () => {
    const s = await shop();
    const r = await orderRepo();
    const o = r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
    r.addOrderItem(s.db, { orderId: o.id, menuItemId: s.cardRated, quantity: 1, modifierIds: [] }, CASHIER);
    r.tenderOrder(
      s.db,
      {
        orderId: o.id,
        payments: [
          { method: 'card', amountCents: 52_500, tenderedCents: null },
          { method: 'cash', amountCents: 57_500, tenderedCents: 60_000 },
        ],
      },
      CASHIER,
    );
    expect(await billOf(s, o.id)).toEqual({ total: 110_000, tax: 10_000, cardNet: 50_000, cardTax: 2_500 });
    const cashLeg = s.db.prepare(`SELECT id FROM payments WHERE order_id = ? AND method = 'cash'`).get(o.id) as { id: string };
    const done = (await repo()).changePaymentMethod(s.db, { orderId: o.id, paymentId: cashLeg.id, method: 'card' }, OWNER);
    expect(done.rebilled).toEqual({ amountBeforeCents: 57_500, amountAfterCents: 52_500, totalBeforeCents: 110_000, totalAfterCents: 105_000 });
    expect(await billOf(s, o.id)).toEqual({ total: 105_000, tax: 5_000, cardNet: 100_000, cardTax: 5_000 });
    const legs = s.db.prepare(`SELECT method, amount_cents AS amount FROM payments WHERE order_id = ? ORDER BY paid_at, id`).all(o.id);
    expect(legs).toEqual([
      { method: 'card', amount: 52_500 },
      { method: 'card', amount: 52_500 },
    ]);
  });

  it('shift closed, the owner: Card to Cash — the bill in cash, and the closed drawer expects the customer’s Rs 1,150 (counted stays)', async () => {
    const s = await shop();
    const { orderId, paymentId } = await paid(s, 'card', s.cardRated);
    const { closeShift, findShift } = await shiftRepo();
    // The customer paid Rs 1,150 in cash and the cashier pressed Card: the drawer counted Rs 1,150 over.
    closeShift(s.db, { shiftId: s.shiftId, countedCashCents: FLOAT + 115_000 }, MANAGER);
    expect(findShift(s.db, s.shiftId)).toMatchObject({ expectedCashCents: FLOAT, varianceCents: 115_000 });
    const r = (await repo()).changePaymentMethod(s.db, { orderId, paymentId, method: 'cash' }, OWNER);
    expect(r).toMatchObject({ rebilled: { amountAfterCents: 115_000 }, drawerOpenId: null });
    expect(r.closedShift).toMatchObject({ shiftId: s.shiftId, expectedCashCents: FLOAT + 115_000, varianceCents: 0, previousVarianceCents: 115_000 });
    expect(findShift(s.db, s.shiftId)).toMatchObject({ countedCashCents: FLOAT + 115_000, expectedCashCents: FLOAT + 115_000, varianceCents: 0 });
  });

  it('refused, with nothing written: a refund on the order, a bill FBR already took (production), a bill that no longer comes out as it was paid', async () => {
    const s = await shop();
    const m = await repo();
    const writes = () => s.db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };

    // A refund: its rows can't be worked out again for another way.
    const refunded = await paid(s, 'cash', s.cardRated);
    const now = new Date().toISOString();
    s.db
      .prepare(
        `INSERT INTO payments (id, order_id, method, amount_cents, tendered_cents, reference_no, received_by_user_id, paid_at, created_at, updated_at, device_id, version, shift_id)
         VALUES ('p_refund_test', ?, 'cash', -10000, NULL, NULL, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(refunded.orderId, CASHIER.userId, now, now, now, TILL, s.shiftId);
    let n = writes().n;
    expect(() => m.changePaymentMethod(s.db, { orderId: refunded.orderId, paymentId: refunded.paymentId, method: 'card' }, OWNER)).toThrow(m.PAYMENT_METHOD_HAS_REFUND);
    expect(writes().n).toBe(n);

    // FBR took the invoice in production mode: its tax never changes behind its back.
    const { enqueueFbrSubmission } = await import('./repositories/fbr-queue-repo.js');
    const filed = await paid(s, 'cash', s.cardRated);
    enqueueFbrSubmission(s.db, filed.orderId, { test: true }, 'production');
    s.db.prepare(`UPDATE fbr_submission_queue SET status = 'sent' WHERE order_id = ?`).run(filed.orderId);
    n = writes().n;
    expect(() => m.changePaymentMethod(s.db, { orderId: filed.orderId, paymentId: filed.paymentId, method: 'card' }, OWNER)).toThrow(m.PAYMENT_METHOD_FBR_SENT);
    expect(writes().n).toBe(n);
    // …but a method with the same bill (card to JazzCash) changes nothing FBR has.
    const filedCard = await paid(s, 'card', s.cardRated);
    enqueueFbrSubmission(s.db, filedCard.orderId, { test: true }, 'production');
    s.db.prepare(`UPDATE fbr_submission_queue SET status = 'sent' WHERE order_id = ?`).run(filedCard.orderId);
    expect(m.changePaymentMethod(s.db, { orderId: filedCard.orderId, paymentId: filedCard.paymentId, method: 'jazzcash' }, OWNER).rebilled).toBeNull();

    // An order whose stored bill is not what its lines and payments come to now.
    const odd = await paid(s, 'cash', s.cardRated);
    s.db.prepare(`UPDATE orders SET total_cents = total_cents + 1 WHERE id = ?`).run(odd.orderId);
    n = writes().n;
    expect(() => m.changePaymentMethod(s.db, { orderId: odd.orderId, paymentId: odd.paymentId, method: 'card' }, OWNER)).toThrow(m.PAYMENT_METHOD_CANT_REWORK);
    expect(writes().n).toBe(n);
    expect(paymentOf(s, odd.paymentId).method).toBe('cash');
  });
});
