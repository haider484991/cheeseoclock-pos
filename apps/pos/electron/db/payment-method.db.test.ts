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
 *   - refused: a payment not on the order, foodpanda, cash and card swapped
 *     on a bill with a card tax rate; the same method again is nothing.
 *
 * node's `node:sqlite` stands in for better-sqlite3 (skipped where missing).
 * Every name, item and amount is made up (the repository is public).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { DatabaseSync } from './costing-shop.fixture.js';
import { TEST_USERS, openTill } from './two-tills.fixture.js';
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
  /** On a tax with a lower card rate: its bill depends on how it is paid. */
  cardRated: string;
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
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const burger = createMenuItem(db, { categoryId: food.id, name: 'Test Zinger Burger', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  const cardRated = createMenuItem(db, { categoryId: food.id, name: 'Test Card Rate Burger', basePriceCents: 100_000, taxCategoryId: cardTax.id }, MANAGER).id;
  const shiftId = openShift(db, { openingCashCents: FLOAT }, CASHIER).id;
  return { db, burger, cardRated, shiftId };
}

/** A paid takeaway of one item; its order id and its one payment's id. */
async function paid(s: Shop, method: 'cash' | 'card' | 'jazzcash', item = s.burger): Promise<{ orderId: string; paymentId: string; total: number }> {
  const r = await orderRepo();
  const o = r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
  r.addOrderItem(s.db, { orderId: o.id, menuItemId: item, quantity: 1, modifierIds: [] }, CASHIER);
  const order = r.findOrder(s.db, o.id)!;
  // A card on a card-rated bill pays the bill at the card rate.
  const total = method !== 'cash' && typeof order.digitalTotalCents === 'number' ? order.digitalTotalCents : order.totalCents;
  r.tenderOrder(s.db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total + 5_000 : null }] }, CASHIER);
  const p = s.db.prepare(`SELECT id FROM payments WHERE order_id = ?`).get(o.id) as { id: string };
  return { orderId: o.id, paymentId: p.id, total };
}

const expected = async (s: Shop) => (await shiftRepo()).getShiftSummary(s.db, s.shiftId).expectedCashCents;
const methodOf = (s: Shop, paymentId: string) =>
  s.db.prepare(`SELECT method, tendered_cents AS tendered FROM payments WHERE id = ?`).get(paymentId) as { method: string; tendered: number | null };
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
    expect(r).toEqual({ from: 'cash', to: 'jazzcash', unchanged: false, closedShift: null });
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
    expect(r).toEqual({ from: 'cash', to: 'cash', unchanged: true, closedShift: null });
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

  it('a bill with a card tax rate: cash and card cannot be swapped (the bill would be the other one); card to JazzCash can', async () => {
    const s = await shop();
    const cash = await paid(s, 'cash', s.cardRated);
    const card = await paid(s, 'card', s.cardRated);
    const m = await repo();
    expect(() => m.changePaymentMethod(s.db, { orderId: cash.orderId, paymentId: cash.paymentId, method: 'card' }, OWNER)).toThrow(m.PAYMENT_METHOD_CARD_RATE);
    expect(() => m.changePaymentMethod(s.db, { orderId: card.orderId, paymentId: card.paymentId, method: 'cash' }, OWNER)).toThrow(m.PAYMENT_METHOD_CARD_RATE);
    expect(m.changePaymentMethod(s.db, { orderId: card.orderId, paymentId: card.paymentId, method: 'jazzcash' }, OWNER).to).toBe('jazzcash');
    expect([methodOf(s, cash.paymentId).method, methodOf(s, card.paymentId).method]).toEqual(['cash', 'jazzcash']);
  });
});
