/**
 * Two tills and Edit order (v0.7.36). On two real databases built from every
 * migration, driven through the repositories, each till's queue applied on
 * the other exactly as the sync worker does (two-tills.fixture push):
 *   - an order taken on till A and changed on till B (an item added, one less
 *     pizza, not made): A reads it as B saved it — the same number, B's line
 *     ids, the line taken down, the totals — and the order holds the same
 *     stock on both tills;
 *   - A's change worked on the order as it was before B's arrived is refused
 *     at Save, and nothing of it is written;
 *   - a Free order made on B (the kitchen has it): A reads it paid at Rs 0
 *     with its rule (a Free order, not an ordinary 100%), and Send out on A
 *     pays the outside rider his charge from A's drawer.
 * No migration in v0.7.36: an older till reads the same rows (a Free order's
 * rule keeps the same scope, so its totals work out the same there).
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for
 * Electron); skipped where it is missing. Every name, number and amount is
 * made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { OrderEditOp } from '@cheeseoclock/shared-types';
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
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);

const TILL_A = 'till-a';
const TILL_B = 'till-b';
const on = (deviceId: string) => ({ cashier: { userId: 'u_cash', deviceId }, manager: { userId: 'u_mgr', deviceId } });
const A = on(TILL_A);
const B = on(TILL_B);
/** What an outside rider keeps: the area's Rs 200 charge as sold. */
const KEEP = 20_000;
type Row = Record<string, unknown>;

const repo = () => import('./repositories/order-repo.js');
const editRepo = () => import('./repositories/order-edit-repo.js');

interface Shop {
  a: AppDatabase;
  b: AppDatabase;
  pizza: string;
  wings: string;
  charge: string;
  cheese: string;
}

/**
 * On A: 15% tax, 'Test Pizza' (Rs 1,200, 100 g of cheese each), 'Test Wings'
 * (Rs 800) and the area's 'Delivery Charge (Rs 200)'; a shift open on each
 * till; everything sent both ways.
 */
async function shop(): Promise<Shop> {
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const { createIngredient, setRecipeForItem } = await import('./repositories/ingredient-repo.js');
  const { openShift } = await import('./repositories/shift-repo.js');
  const a = openTill(TILL_A);
  const b = openTill(TILL_B, { usersFrom: TILL_A });
  const tax = createTaxCategory(a, { name: 'Test GST', rateBps: 1_500 }, A.manager);
  const food = createCategory(a, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, A.manager);
  const fees = createCategory(a, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, A.manager);
  const item = (categoryId: string, name: string, basePriceCents: number) =>
    createMenuItem(a, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, A.manager).id;
  const pizza = item(food.id, 'Test Pizza', 120_000);
  const wings = item(food.id, 'Test Wings', 80_000);
  const charge = item(fees.id, 'Delivery Charge (Rs 200)', KEEP);
  const cheese = createIngredient(a, { name: 'Test cheese', unit: 'g', currentQty: 100_000, costPerUnitCents: 0 }, A.manager).id;
  setRecipeForItem(a, pizza, [{ ingredientId: cheese, qtyPerUnit: 100, modifierId: null }], A.manager);
  openShift(a, { openingCashCents: 500_000 }, A.manager);
  await pushOk(a, TILL_A, b);
  openShift(b, { openingCashCents: 500_000 }, B.manager);
  await pushOk(b, TILL_B, a);
  return { a, b, pizza, wings, charge, cheese };
}

async function pushOk(from: AppDatabase, fromDevice: string, to: AppDatabase): Promise<void> {
  expect(await push(from, fromDevice, to)).toMatchObject({ waiting: 0, dropped: 0 });
}

/** An order rung on A with these lines and sent to the kitchen there, then sent to B. */
async function sentOnA(s: Shop, lines: Array<[string, number]>, mode: 'takeaway' | 'delivery' = 'takeaway'): Promise<string> {
  const r = await repo();
  const o = r.createOrder(s.a, { mode }, A.cashier);
  for (const [menuItemId, quantity] of lines) r.addOrderItem(s.a, { orderId: o.id, menuItemId, quantity, modifierIds: [] }, A.cashier);
  r.sendOrderToKitchen(s.a, o.id, A.cashier);
  await pushOk(s.a, TILL_A, s.b);
  return o.id;
}

/** What the order holds of an ingredient on a till's stock rows (negative = taken). */
const held = (db: AppDatabase, orderId: string, ingredientId: string) =>
  Number(
    (db.prepare(`SELECT COALESCE(SUM(delta_qty), 0) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND deleted_at IS NULL`).get(orderId, ingredientId) as Row)[
      'n'
    ],
  );
const shelf = (db: AppDatabase, ingredientId: string) => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(ingredientId) as Row)['q']);
const lines = async (db: AppDatabase, orderId: string) =>
  (await repo()).getOrderSnapshot(db, orderId)!.items.map((i) => [i.id as string, i.menuItemName, i.quantity] as const);

live('an order taken on one till, changed on the other', () => {
  it('A reads it as B saved it: the same number, B’s lines, the totals, the same stock held', async () => {
    const s = await shop();
    const r = await repo();
    const e = await editRepo();
    const id = await sentOnA(s, [
      [s.pizza, 2],
      [s.wings, 1],
    ]);
    const pizzaLine = r.getOrderSnapshot(s.b, id)!.items.find((i) => i.menuItemId === s.pizza)!;
    const added: OrderEditOp = { op: 'add', lineId: uuidv7(), menuItemId: s.wings, quantity: 1, modifierIds: [], notes: 'Extra crispy' };
    const ops: OrderEditOp[] = [added, { op: 'qty', orderItemId: pizzaLine.id, quantity: 1 }];
    const base = e.previewOrderEdit(s.b, { orderId: id, ops: [] }, B.cashier);
    const saved = e.saveOrderEdit(
      s.b,
      { orderId: id, baseKey: base.baseKey, ops, approverUserId: B.manager.userId, reason: 'Customer changed order', foodMade: { [pizzaLine.id]: 'not_made' } },
      B.cashier,
    );
    expect(saved.snapshot.order.totalCents).toBe(Math.round((120_000 + 80_000 * 2) * 1.15));
    await pushOk(s.b, TILL_B, s.a);

    const onA = r.getOrderSnapshot(s.a, id)!;
    expect(onA.order.orderNumber).toBe(saved.snapshot.order.orderNumber);
    expect(onA.order.totalCents).toBe(saved.snapshot.order.totalCents);
    expect(onA.order.subtotalCents).toBe(saved.snapshot.order.subtotalCents);
    expect(onA.order.taxCents).toBe(saved.snapshot.order.taxCents);
    expect(await lines(s.a, id)).toEqual(await lines(s.b, id));
    expect(onA.items.find((i) => i.id === added.lineId)).toMatchObject({ quantity: 1, notes: 'Extra crispy' });
    expect(onA.items.find((i) => i.id === pizzaLine.id)?.quantity).toBe(1);
    // One pizza's cheese not made: the order holds one pizza's on both tills, and it goes back on the
    // shelf of the till that took it (A: each till keeps its own count; B's is not moved by A's sale).
    expect(held(s.b, id, s.cheese)).toBe(-100);
    expect(held(s.a, id, s.cheese)).toBe(-100);
    expect(shelf(s.a, s.cheese)).toBe(100_000 - 200 + 100);
    expect(shelf(s.b, s.cheese)).toBe(100_000);
  });

  it('A’s change worked on the order before B’s arrived is refused at Save, and nothing of it is written', async () => {
    const s = await shop();
    const r = await repo();
    const e = await editRepo();
    const id = await sentOnA(s, [[s.pizza, 1]]);
    const startedOnA = e.previewOrderEdit(s.a, { orderId: id, ops: [] }, A.cashier);
    // B adds wings and syncs first.
    const onB = e.previewOrderEdit(s.b, { orderId: id, ops: [] }, B.cashier);
    e.saveOrderEdit(
      s.b,
      { orderId: id, baseKey: onB.baseKey, ops: [{ op: 'add', lineId: uuidv7(), menuItemId: s.wings, quantity: 1, modifierIds: [], notes: null }], approverUserId: null },
      B.cashier,
    );
    await pushOk(s.b, TILL_B, s.a);
    const before = await lines(s.a, id);
    const queued = Number((s.a.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get() as Row)['n']);
    expect(() =>
      e.saveOrderEdit(
        s.a,
        {
          orderId: id,
          baseKey: startedOnA.baseKey,
          ops: [{ op: 'add', lineId: uuidv7(), menuItemId: s.pizza, quantity: 1, modifierIds: [], notes: null }],
          approverUserId: null,
        },
        A.cashier,
      ),
    ).toThrow(e.EDIT_STALE);
    expect(await lines(s.a, id)).toEqual(before);
    expect(Number((s.a.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get() as Row)['n'])).toBe(queued);
    // Started again on A, it goes.
    const again = e.previewOrderEdit(s.a, { orderId: id, ops: [] }, A.cashier);
    expect(r.getOrderSnapshot(s.a, id)!.items).toHaveLength(2);
    expect(again.baseKey).not.toBe(startedOnA.baseKey);
  });
});

live('a Free order made on the other till', () => {
  it('A reads it paid at Rs 0 with its rule, and Send out on A pays the outside rider his charge from A’s drawer', async () => {
    const s = await shop();
    const r = await repo();
    const e = await editRepo();
    const id = await sentOnA(
      s,
      [
        [s.pizza, 1],
        [s.charge, 1],
      ],
      'delivery',
    );
    const base = e.previewOrderEdit(s.b, { orderId: id, ops: [] }, B.cashier);
    const saved = e.saveOrderEdit(
      s.b,
      {
        orderId: id,
        baseKey: base.baseKey,
        ops: [{ op: 'discount', discountType: 'percent', value: 100, reason: 'Complaint', free: true }],
        approverUserId: B.manager.userId,
        reason: 'Complaint',
      },
      B.cashier,
    );
    expect(saved.completedFree).toBe(true);
    await pushOk(s.b, TILL_B, s.a);

    const onA = r.getOrderSnapshot(s.a, id)!;
    expect(onA.order.totalCents).toBe(0);
    expect(onA.order.paidAt).not.toBeNull();
    expect(onA.payments).toHaveLength(0);
    expect(onA.discounts.at(-1)).toMatchObject({ freeOrder: true, reason: 'Complaint' });
    const rule = JSON.parse(String((s.a.prepare(`SELECT rule_json FROM order_discounts WHERE order_id = ? AND deleted_at IS NULL`).get(id) as Row)['rule_json']));
    // The scope an older till reads the same way (every line, value deals and the delivery charge too), and the Free order's mark.
    expect(rule).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'till', freeOrder: true });

    const out = r.sendOutOrder(s.a, id, A.cashier);
    expect(out.riderKeepsCents).toBe(KEEP);
    expect(out.drawerOpenId).not.toBeNull();
    const payout = s.a.prepare(`SELECT amount_cents, type, device_id FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL`).get(id) as Row;
    expect(payout).toMatchObject({ type: 'payout', device_id: TILL_A });
    expect(Math.abs(Number(payout['amount_cents']))).toBe(KEEP);
  });
});
