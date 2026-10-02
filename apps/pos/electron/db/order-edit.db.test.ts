/**
 * Edit order (v0.7.36) on a real database built from every migration, driven
 * through the repositories as the IPC handlers call them:
 *   - only an order the kitchen has, unpaid and not out, can be changed;
 *   - the preview writes nothing (no line, no sync row, no audit row);
 *   - adding (any cashier) takes stock for what was added only, keeps the
 *     screen's line id, and writes one 'order_edit' audit row;
 *   - taking off needs a manager and a reason, and settles that item's stock
 *     only ("Was the food made?" for it): not made → back on the shelf, made
 *     → waste; the order still holds the rest, and a cancel later asks about
 *     the rest and settles it;
 *   - a line that goes down keeps the cost of what is left;
 *   - an edit that would leave no food is refused, as is one worked on an
 *     order that changed since (Preparing / Ready do not count);
 *   - a discount on a sent order, until it is paid: over the limit only with
 *     a manager;
 *   - a Free order: 100% off every line, value deals and delivery charge
 *     included, only with a manager and a reason; completed at Rs 0 (paid,
 *     no payment rows); Send out then pays an outside rider his charge from
 *     the drawer, linked to the order.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron);
 * skipped where it is missing. Every name, price and amount is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { OrderEditOp, OrderMode } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Choice, type Ing, type Item } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
type Row = Record<string, unknown>;

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const edit = await import('./repositories/order-edit-repo.js');
  const stockRepo = await import('./repositories/order-stock-repo.js');
  const shifts = await import('./repositories/shift-repo.js');
  shifts.openShift(db, { openingCashCents: 0 }, MANAGER);
  /** A counter order with these lines, sent to the kitchen (its stock taken). */
  const sent = (lines: Array<[Item, number, Choice[]?]>, mode: OrderMode = 'takeaway'): string => {
    const o = s.r.createOrder(db, { mode }, CASHIER);
    for (const [it, quantity, picks = []] of lines) {
      s.r.addOrderItem(db, { orderId: o.id, menuItemId: s.item[it], quantity, modifierIds: picks.map((p) => s.choice[p]), notes: null }, CASHIER);
    }
    s.r.sendOrderToKitchen(db, o.id, CASHIER);
    return o.id;
  };
  const snap = (id: string) => s.r.getOrderSnapshot(db, id)!;
  const lineOf = (id: string, it: Item) => snap(id).items.find((i) => i.menuItemId === s.item[it])!;
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row)['n']);
  const start = (id: string) => edit.previewOrderEdit(db, { orderId: id, ops: [] }, CASHIER);
  const preview = (id: string, ops: OrderEditOp[], actor = CASHIER) => edit.previewOrderEdit(db, { orderId: id, ops }, actor);
  const save = (
    id: string,
    ops: OrderEditOp[],
    o: { approverUserId?: string | null; reason?: string | null; foodMade?: Record<string, 'made' | 'not_made'>; baseKey?: string } = {},
  ) =>
    edit.saveOrderEdit(
      db,
      {
        orderId: id,
        baseKey: o.baseKey ?? start(id).baseKey,
        ops,
        approverUserId: o.approverUserId ?? null,
        ...(o.reason !== undefined ? { reason: o.reason } : {}),
        ...(o.foodMade ? { foodMade: o.foodMade } : {}),
      },
      CASHIER,
    );
  /** What the order holds of an ingredient on its stock rows (negative = taken). */
  const net = (id: string, k: Ing) =>
    Number(
      (
        db
          .prepare(`SELECT COALESCE(SUM(delta_qty), 0) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND reason = 'sale'`)
          .get(id, s.ing[k]) as Row
      )['n'],
    );
  const wasted = (id: string, k: Ing) =>
    -Number(
      (
        db
          .prepare(`SELECT COALESCE(SUM(delta_qty), 0) AS n FROM stock_movements WHERE ref_order_id = ? AND ingredient_id = ? AND reason = 'waste'`)
          .get(id, s.ing[k]) as Row
      )['n'],
    );
  return { db, s, edit, stockRepo, sent, snap, lineOf, count, start, preview, save, net, wasted };
}

const add = (menuItemId: string, quantity = 1, modifierIds: string[] = []): OrderEditOp & { op: 'add' } => ({
  op: 'add',
  lineId: uuidv7(),
  menuItemId,
  quantity,
  modifierIds,
});

live('which orders an edit may change', () => {
  it('a cart still being rung up, a paid order and one out for delivery are refused in words; the kitchen states are not', async () => {
    const { db, s, sent, start } = await shop();
    const cart = s.r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    s.r.addOrderItem(db, { orderId: cart.id, menuItemId: s.item.cola, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    expect(() => start(cart.id)).toThrow(/not gone to the kitchen yet/);

    const id = sent([['fajitaM', 1]]);
    expect(start(id).snapshot.order.id).toBe(id);
    s.r.markOrderPreparing(db, id, CASHIER);
    expect(() => start(id)).not.toThrow();
    s.r.markOrderReady(db, id, CASHIER);
    expect(() => start(id)).not.toThrow();

    const paid = s.r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    s.r.addOrderItem(db, { orderId: paid.id, menuItemId: s.item.cola, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    s.r.tenderOrder(db, { orderId: paid.id, payments: [{ method: 'cash', amountCents: 15_000, tenderedCents: 15_000 }] }, CASHIER);
    expect(() => start(paid.id)).toThrow(/is paid/);

    const out = sent([['fajitaM', 1]], 'delivery');
    s.r.sendOutOrder(db, out, CASHIER);
    expect(() => start(out)).toThrow(/left the shop/);
  });
});

live('the preview', () => {
  it('shows the order as Save would leave it and writes nothing', async () => {
    const { s, sent, count, start, preview } = await shop();
    const id = sent([['fajitaM', 1]]);
    const base = start(id);
    expect(base.baseKey).toMatch(/^[0-9a-f]{40}$/);
    expect(base.diff.added).toEqual([]);
    const rows = { items: count('order_items'), sync: count('sync_queue'), audit: count('audit_log'), moves: count('stock_movements') };
    const op = add(s.item.cola, 2);
    const p = preview(id, [op]);
    expect(p.snapshot.items.map((i) => [i.menuItemId, i.quantity])).toEqual([
      [s.item.fajitaM, 1],
      [s.item.cola, 2],
    ]);
    expect(p.snapshot.items[1]!.id).toBe(op.lineId);
    expect(p.diff.added.map((l) => [l.lineId, l.quantity])).toEqual([[op.lineId, 2]]);
    expect(p.needs).toEqual({ pin: false, why: [], reason: false });
    expect(p.baseKey).toBe(base.baseKey);
    // Nothing written.
    expect(count('order_items')).toBe(rows.items);
    expect(count('sync_queue')).toBe(rows.sync);
    expect(count('audit_log')).toBe(rows.audit);
    expect(count('stock_movements')).toBe(rows.moves);
    // The same line id can be previewed again (it was never kept).
    expect(preview(id, [op]).snapshot.items[1]!.id).toBe(op.lineId);
  });

  it('says what Save will ask for', async () => {
    const { s, sent, preview, lineOf } = await shop();
    const id = sent([['fajitaM', 2], ['cola', 1]]);
    const pizza = lineOf(id, 'fajitaM');
    expect(preview(id, [{ op: 'qty', orderItemId: pizza.id, quantity: 1 }]).needs).toEqual({
      pin: true,
      why: ['An item the kitchen has comes off'],
      reason: true,
    });
    expect(preview(id, [{ op: 'discount', discountType: 'percent', value: 10, reason: 'Regular' }]).needs.pin).toBe(false);
    expect(preview(id, [{ op: 'discount', discountType: 'percent', value: 50, reason: 'Friend' }]).needs).toEqual({
      pin: true,
      why: ['The discount is over the limit'],
      reason: false,
    });
    expect(preview(id, [{ op: 'discount', discountType: 'percent', value: 100, reason: 'Staff meal', free: true }]).needs).toEqual({
      pin: true,
      why: ['A Free order'],
      reason: true,
    });
    void s;
  });
});

live('adding to an order the kitchen has', () => {
  it('any cashier, no PIN: the line keeps its id, only what was added leaves stock, one audit row', async () => {
    const { db, s, sent, save, snap, net } = await shop();
    const id = sent([['fajitaM', 1]]);
    expect(net(id, 'chicken')).toBe(-40);
    const op = add(s.item.fajitaM, 1, [s.choice.extraCheese]);
    const r = save(id, [op]);
    expect(r.diff.added.map((l) => [l.lineId, l.quantity, l.modifiers])).toEqual([[op.lineId, 1, ['Extra cheese']]]);
    expect(r.completedFree).toBe(false);
    expect(snap(id).items.map((i) => i.id)).toContain(op.lineId);
    expect(snap(id).order.subtotalCents).toBe(120_000 + 135_000);
    // The second pizza's stock, with its extra cheese, and nothing more.
    expect(net(id, 'chicken')).toBe(-80);
    expect(net(id, 'cheese')).toBe(-(60 + 60 + 40));
    expect(net(id, 'box')).toBe(-2);
    const audits = db.prepare(`SELECT action, after_json FROM audit_log WHERE entity_id = ? AND action = 'order_edit'`).all(id) as Row[];
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0]!['after_json'])).added).toHaveLength(1);
    // Its cost is kept, for the line as it is.
    const cost = db.prepare(`SELECT line_qty FROM order_item_costs WHERE order_item_id = ? AND part = 'base' AND deleted_at IS NULL`).get(op.lineId) as Row;
    expect(Number(cost['line_qty'])).toBe(1);
  });

  it('a line that goes up takes the difference', async () => {
    const { s, sent, save, lineOf, net } = await shop();
    const id = sent([['cola', 1]]);
    const cola = lineOf(id, 'cola');
    expect(net(id, 'bottle')).toBe(-1);
    save(id, [{ op: 'qty', orderItemId: cola.id, quantity: 3 }]);
    expect(net(id, 'bottle')).toBe(-3);
    expect(lineOf(id, 'cola').quantity).toBe(3);
    void s;
  });

  it('Customize is for a line added in this edit only', async () => {
    const { s, sent, preview, lineOf } = await shop();
    const id = sent([['fajitaM', 1]]);
    const pizza = lineOf(id, 'fajitaM');
    expect(() => preview(id, [{ op: 'options', orderItemId: pizza.id, modifierIds: [s.choice.noOnion], notes: null }])).toThrow(
      /added in this edit/,
    );
    const op = add(s.item.fajitaM);
    const p = preview(id, [op, { op: 'options', orderItemId: op.lineId, modifierIds: [s.choice.noOnion], notes: 'well done' }]);
    expect(p.snapshot.items.find((i) => i.id === op.lineId)?.notes).toBe('well done');
  });
});

live('taking off an order the kitchen has', () => {
  it('needs a manager, a reason and "Was the food made?" for that item', async () => {
    const { s, sent, save, lineOf } = await shop();
    const id = sent([['fajitaM', 1], ['cola', 1]]);
    const cola = lineOf(id, 'cola');
    const ops: OrderEditOp[] = [{ op: 'remove', orderItemId: cola.id }];
    expect(() => save(id, ops)).toThrow(/manager's PIN or password is needed/);
    expect(() => save(id, ops, { approverUserId: MANAGER.userId })).toThrow(/Say why/);
    expect(() => save(id, ops, { approverUserId: MANAGER.userId, reason: 'Customer changed order' })).toThrow(/Say whether the food was made/);
    // Each refusal wrote nothing: the cola is still there.
    expect(lineOf(id, 'cola')).toBeDefined();
    void s;
  });

  it('not made: that item only goes back on the shelf; the order still holds the rest, and a cancel asks about it', async () => {
    const { db, s, stockRepo, sent, save, lineOf, net, snap } = await shop();
    const id = sent([['fajitaM', 2], ['cola', 1]]);
    const pizza = lineOf(id, 'fajitaM');
    const before = s.stockOf('chicken');
    const r = save(id, [{ op: 'qty', orderItemId: pizza.id, quantity: 1 }], {
      approverUserId: MANAGER.userId,
      reason: 'Customer changed order',
      foodMade: { [pizza.id]: 'not_made' },
    });
    expect(r.diff.removed.map((l) => [l.lineId, l.quantity])).toEqual([[pizza.id, 1]]);
    expect(s.stockOf('chicken')).toBe(before + 40);
    expect(net(id, 'chicken')).toBe(-40);
    expect(net(id, 'bottle')).toBe(-1);
    // The line keeps the cost of the one pizza left.
    const cost = db.prepare(`SELECT line_qty FROM order_item_costs WHERE order_item_id = ? AND part = 'base' AND deleted_at IS NULL`).get(pizza.id) as Row;
    expect(Number(cost['line_qty'])).toBe(1);
    // Not settled: a cancel still asks, and settles what is left.
    const status = stockRepo.getOrderStockStatus(db, id, CASHIER.deviceId, Date.now())!;
    expect(status.state).toBe('out');
    expect(status.question).not.toBeNull();
    s.r.voidOrder(db, { orderId: id, reason: 'Customer left', approverUserId: MANAGER.userId, foodMade: 'not_made' }, CASHIER);
    expect(net(id, 'chicken')).toBe(0);
    expect(net(id, 'bottle')).toBe(0);
    expect(snap(id).order.status).toBe('void');
  });

  it('made: that item is booked as waste, nothing more', async () => {
    const { s, sent, save, lineOf, net, wasted } = await shop();
    const id = sent([['fajitaM', 1], ['crispyWings', 1]]);
    const wings = lineOf(id, 'crispyWings');
    const before = s.stockOf('chicken');
    save(id, [{ op: 'remove', orderItemId: wings.id }], {
      approverUserId: MANAGER.userId,
      reason: 'Burnt',
      foodMade: { [wings.id]: 'made' },
    });
    // The wings' 150 g of chicken: off the order's sale, onto waste; the shelf does not move.
    expect(s.stockOf('chicken')).toBe(before);
    expect(net(id, 'chicken')).toBe(-40);
    expect(wasted(id, 'chicken')).toBe(150);
    expect(wasted(id, 'breading')).toBe(50);
    expect(lineOf(id, 'crispyWings')).toBeUndefined();
  });

  it('an edit that would leave no food is a cancel, not an edit', async () => {
    const { sent, preview, lineOf } = await shop();
    const id = sent([['fajitaM', 1]]);
    expect(() => preview(id, [{ op: 'remove', orderItemId: lineOf(id, 'fajitaM').id }])).toThrow(/cancel it on Live Orders/);
  });
});

live('an edit worked on an order that changed since', () => {
  it('is refused; the kitchen moving it to Preparing or Ready is not a change', async () => {
    const { db, s, sent, start, save, lineOf } = await shop();
    const id = sent([['fajitaM', 1]]);
    const key = start(id).baseKey;
    s.r.markOrderPreparing(db, id, CASHIER);
    s.r.markOrderReady(db, id, CASHIER);
    expect(() => save(id, [add(s.item.cola)], { baseKey: key })).not.toThrow();
    // Now the order has the cola: an edit worked on before it is stale.
    expect(() => save(id, [add(s.item.cola)], { baseKey: key })).toThrow(/changed while you were editing/);
    expect(lineOf(id, 'cola').quantity).toBe(1);
  });

  it('nothing changed: nothing to save', async () => {
    const { s, sent, save, lineOf } = await shop();
    const id = sent([['fajitaM', 1]]);
    expect(() => save(id, [{ op: 'qty', orderItemId: lineOf(id, 'fajitaM').id, quantity: 1 }])).toThrow(/Nothing has changed/);
    void s;
  });
});

live('a discount on a sent order, until it is paid', () => {
  it('within the limit: any cashier; over it: only with a manager', async () => {
    const { s, sent, save, snap } = await shop();
    const id = sent([['fajitaM', 1]]);
    save(id, [{ op: 'discount', discountType: 'percent', value: 10, reason: 'Forgot at the counter' }]);
    expect(snap(id).order.discountCents).toBe(12_000);
    const id2 = sent([['fajitaM', 1]]);
    expect(() => save(id2, [{ op: 'discount', discountType: 'percent', value: 50, reason: 'Friend' }])).toThrow(/manager's PIN/);
    save(id2, [{ op: 'discount', discountType: 'percent', value: 50, reason: 'Friend' }], { approverUserId: MANAGER.userId });
    expect(snap(id2).order.discountCents).toBe(60_000);
    expect(snap(id2).discounts.at(-1)?.approvedByUserId).toBe(MANAGER.userId);
    void s;
  });

  it('never on a value deal (the normal rule stands)', async () => {
    const { sent, save, snap } = await shop();
    const id = sent([['deal', 1, ['d1Fajita', 'd2Veggie']], ['cola', 1]]);
    save(id, [{ op: 'discount', discountType: 'percent', value: 10, reason: 'Regular' }]);
    // 10% of the cola only.
    expect(snap(id).order.discountCents).toBe(1_500);
  });
});

live('an order with nothing to pay, handed over', () => {
  it('Picked up + Pay and Delivered + Pay close it with no payment row (was: "Payment amount must be positive")', async () => {
    const { db, s, sent, save, snap } = await shop();
    const off100 = (id: string) =>
      save(id, [{ op: 'discount', discountType: 'percent', value: 100, reason: 'Make-good' }], { approverUserId: MANAGER.userId });

    const pickUp = sent([['fajitaM', 1]]);
    off100(pickUp);
    expect(snap(pickUp).order.totalCents).toBe(0);
    s.r.markOrderReady(db, pickUp, CASHIER);
    s.r.markOrderServed(db, { orderId: pickUp, payment: { method: 'cash', amountCents: 0, tenderedCents: 0 } }, CASHIER);
    expect(snap(pickUp).order.status).toBe('paid');
    expect(snap(pickUp).payments).toHaveLength(0);

    const door = sent([['fajitaM', 1]], 'delivery');
    off100(door);
    s.r.markOrderReady(db, door, CASHIER);
    s.r.markOrderDelivered(db, { orderId: door, payment: { method: 'cash', amountCents: 0, tenderedCents: 0 } }, CASHIER);
    expect(snap(door).order.status).toBe('paid');
    expect(snap(door).payments).toHaveLength(0);

    // Something to pay still needs the money.
    const owes = sent([['cola', 1]]);
    s.r.markOrderReady(db, owes, CASHIER);
    expect(() => s.r.markOrderServed(db, { orderId: owes, payment: { method: 'cash', amountCents: 0, tenderedCents: 0 } }, CASHIER)).toThrow(
      /must be positive/,
    );
  });
});

live('a Free order', () => {
  it('only with a manager and a reason; then 100% off every line, the value deal and the delivery charge too, paid at Rs 0', async () => {
    const { db, s, sent, save, snap } = await shop();
    const id = sent([['deal', 1, ['d1Fajita', 'd2Veggie']], ['cola', 1], ['delivery', 1]], 'delivery');
    expect(snap(id).items.find((i) => i.menuItemId === s.item.deal)?.noDiscount).toBe(true);
    const free: OrderEditOp = { op: 'discount', discountType: 'percent', value: 100, reason: 'Staff meal', free: true };
    expect(() => save(id, [free])).toThrow(/manager's PIN/);
    expect(() => save(id, [{ ...free, reason: '' }], { approverUserId: MANAGER.userId, reason: 'Staff meal' })).toThrow(/Say why this order is free/);
    const r = save(id, [free], { approverUserId: MANAGER.userId, reason: 'Staff meal' });
    expect(r.diff.freeOrder).toBe(true);
    expect(r.completedFree).toBe(true);
    const after = snap(id);
    expect(after.order.totalCents).toBe(0);
    expect(after.order.discountCents).toBe(after.order.subtotalCents);
    expect(after.order.paidAt).not.toBeNull();
    expect(after.payments).toHaveLength(0);
    expect(after.discounts.at(-1)?.freeOrder).toBe(true);
    expect(after.discounts.at(-1)?.reason).toBe('Staff meal');

    // Send out with an outside rider: he keeps the delivery charge as sold,
    // and as the order is paid the drawer pays it to him now, linked to it.
    const out = s.r.sendOutOrder(db, id, CASHIER);
    expect(out.riderKeepsCents).toBe(10_000);
    expect(out.drawerOpenId).not.toBeNull();
    const payout = db
      .prepare(`SELECT amount_cents, type FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL`)
      .get(id) as Row;
    expect(payout['type']).toBe('payout');
    expect(Math.abs(Number(payout['amount_cents']))).toBe(10_000);
  });

  it('on a cart: the same rule, and Pay completes it with nothing to pay', async () => {
    const { db, s, snap } = await shop();
    const o = s.r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    s.r.addOrderItem(db, { orderId: o.id, menuItemId: s.item.deal, quantity: 1, modifierIds: [s.choice.d1Fajita, s.choice.d2Fajita], notes: null }, CASHIER);
    expect(() =>
      s.r.applyDiscount(db, { orderId: o.id, discountType: 'percent', value: 100, reason: 'Owner guest', free: true }, CASHIER),
    ).toThrow(/manager's PIN/);
    expect(() =>
      s.r.applyDiscount(db, { orderId: o.id, discountType: 'percent', value: 90, reason: 'Owner guest', approverUserId: MANAGER.userId, free: true }, CASHIER),
    ).toThrow(/100% off the whole order/);
    s.r.applyDiscount(db, { orderId: o.id, discountType: 'percent', value: 100, reason: 'Owner guest', approverUserId: MANAGER.userId, free: true }, CASHIER);
    expect(snap(o.id).order.totalCents).toBe(0);
    s.r.tenderOrder(db, { orderId: o.id, payments: [] }, CASHIER);
    expect(snap(o.id).order.paidAt).not.toBeNull();
  });

  it('on a cart sent with Send, not Pay: paid at Rs 0 as it goes, so Send out pays the rider from the drawer', async () => {
    const { db, s, snap } = await shop();
    const o = s.r.createOrder(db, { mode: 'delivery' }, CASHIER);
    s.r.addOrderItem(db, { orderId: o.id, menuItemId: s.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    s.r.addOrderItem(db, { orderId: o.id, menuItemId: s.item.delivery, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    s.r.applyDiscount(db, { orderId: o.id, discountType: 'percent', value: 100, reason: 'Owner guest', approverUserId: MANAGER.userId, free: true }, CASHIER);
    const sent = s.r.sendOrderToKitchen(db, o.id, CASHIER);
    expect(sent.status).toBe('sent_to_kitchen');
    expect(sent.paidAt).not.toBeNull();
    expect(snap(o.id).payments).toHaveLength(0);
    const out = s.r.sendOutOrder(db, o.id, CASHIER);
    expect(out.riderKeepsCents).toBe(10_000);
    expect(out.drawerOpenId).not.toBeNull();

    // An ordinary 100% discount is not a Free order: it goes unpaid, as before.
    const plain = s.r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    s.r.addOrderItem(db, { orderId: plain.id, menuItemId: s.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    s.r.applyDiscount(db, { orderId: plain.id, discountType: 'percent', value: 100, reason: 'Make-good', approverUserId: MANAGER.userId }, CASHIER);
    expect(snap(plain.id).order.totalCents).toBe(0);
    expect(s.r.sendOrderToKitchen(db, plain.id, CASHIER).paidAt).toBeNull();
  });
});
