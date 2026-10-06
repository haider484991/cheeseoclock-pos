/**
 * Tax by how the customer pays (migration 0052; the owner, 6 Oct 2026: "how
 * to set the card percentage and cash percentage thing", "what if anyone
 * pays half card, half cash", "open the drawer anyway, card or cash") on a
 * real database built from every migration, through the real repositories:
 *  - a tax category with a card rate (15% in cash, 8% by card) puts the bill
 *    by card beside every order's total; one without leaves the order
 *    exactly as before 0052;
 *  - Pay settles the bill from the legs (pos-domain splitTender): all cash
 *    the stored total to the paisa, all card the bill by card, half and half
 *    the card half at 8% and the cash half at 15% — and refuses legs that do
 *    not fit, in plain words;
 *  - the settled totals are what the row, the snapshot, the sync image and
 *    the audit row carry;
 *  - Served at the counter by card settles the same way;
 *  - the drawer opens for a card sale under the default (every sale) and
 *    stays shut when the till is set to cash sales only.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentMethod } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, openCostingShop, openMigrated } from './costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '' } }));

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/tax-category-repo.js')),
  ...(await import('./repositories/category-repo.js')),
  ...(await import('./repositories/menu-item-repo.js')),
});

type Leg = { method: PaymentMethod; amountCents: number; tenderedCents?: number | null };

async function till() {
  const db = openMigrated();
  await openCostingShop(db);
  const r = await repos();
  // The shop's rate: 15% in cash, 8% by card / wallet / bank — and a plain 15% beside it.
  const sst = r.createTaxCategory(db, { name: 'Test SST', rateBps: 1_500, digitalRateBps: 800 }, MANAGER);
  const plain = r.createTaxCategory(db, { name: 'Test plain 15%', rateBps: 1_500 }, MANAGER);
  const cat = r.createCategory(db, { name: 'Test Card Rate', displayOrder: 9, colorHex: '#123456' }, MANAGER);
  const plate = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Plate', basePriceCents: 100_000, taxCategoryId: sst.id }, MANAGER).id;
  const plainPlate = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Plain Plate', basePriceCents: 100_000, taxCategoryId: plain.id }, MANAGER).id;
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const ring = (menuItemId = plate, quantity = 1) => {
    const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    r.addOrderItem(db, { orderId: o.id, menuItemId, quantity, modifierIds: [], notes: null }, CASHIER);
    return o.id;
  };
  const row = (id: string) =>
    db
      .prepare(
        `SELECT subtotal_cents AS subtotal, tax_cents AS tax, total_cents AS total, digital_total_cents AS byCard,
                digital_net_cents AS cardNet, digital_tax_cents AS cardTax, status, paid_at AS paidAt
           FROM orders WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
  const legs = (id: string) =>
    db.prepare(`SELECT method, amount_cents AS amount FROM payments WHERE order_id = ? ORDER BY created_at, rowid`).all(id) as Array<Record<string, unknown>>;
  const drawer = (id: string) =>
    db.prepare(`SELECT kind, amount_cents AS amount, reason FROM drawer_opens WHERE order_id = ?`).all(id) as Array<Record<string, unknown>>;
  const tender = (id: string, payments: Leg[], drawerOpensOn: 'cash' | 'every_sale' | null = null) =>
    r.tenderOrder(db, { orderId: id, payments: payments.map((p) => ({ tenderedCents: p.method === 'cash' ? p.amountCents : null, ...p })), drawerOpensOn }, CASHIER);
  return { db, r, sst, plain, plate, plainPlate, ring, row, legs, drawer, tender };
}
type Till = Awaited<ReturnType<typeof till>>;

let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('the card rate on a tax category (Menu → Tax)', () => {
  it('is stored, read back, and none when it equals the rate; a bad one is refused', () => {
    expect(t.r.findTaxCategory(t.db, t.sst.id)).toMatchObject({ rateBps: 1_500, digitalRateBps: 800 });
    expect(t.r.findTaxCategory(t.db, t.plain.id)).toMatchObject({ rateBps: 1_500, digitalRateBps: null });
    // "8% by card" on an 8% category is no card rate.
    const same = t.r.createTaxCategory(t.db, { name: 'Test same', rateBps: 800, digitalRateBps: 800 }, MANAGER);
    expect(same.digitalRateBps).toBeNull();
    // Taken off again: null clears it; absent keeps it.
    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, name: 'Test SST renamed' }, MANAGER).digitalRateBps).toBe(800);
    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, digitalRateBps: null }, MANAGER).digitalRateBps).toBeNull();
    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, digitalRateBps: 800 }, MANAGER).digitalRateBps).toBe(800);
    expect(() => t.r.createTaxCategory(t.db, { name: 'Test bad', rateBps: 1_500, digitalRateBps: 12.5 }, MANAGER)).toThrow(/basis points/);
    expect(() => t.r.createTaxCategory(t.db, { name: 'Test bad', rateBps: 1_500, digitalRateBps: 10_001 }, MANAGER)).toThrow(/basis points/);
  });

  it('puts the bill by card beside the order total; an order without one reads exactly as before 0052', () => {
    const o = t.ring();
    expect(t.row(o)).toMatchObject({ subtotal: 100_000, tax: 15_000, total: 115_000, byCard: 108_000, cardNet: 0, cardTax: 0 });
    const snap = t.r.getOrderSnapshot(t.db, o)!;
    expect(snap.order).toMatchObject({ totalCents: 115_000, digitalTotalCents: 108_000 });
    expect(snap.order).not.toHaveProperty('digitalNetCents');
    expect(snap.items[0]).toMatchObject({ taxRateBps: 1_500, digitalRateBps: 800 });

    const p = t.ring(t.plainPlate);
    expect(t.row(p)).toMatchObject({ total: 115_000, byCard: null });
    const plainSnap = t.r.getOrderSnapshot(t.db, p)!;
    expect(plainSnap.order).not.toHaveProperty('digitalTotalCents');
    expect(plainSnap.items[0]).not.toHaveProperty('digitalRateBps');
  });

  it('a line keeps the card rate it was sold with: changing the category later does not move an open order', () => {
    const o = t.ring();
    t.r.updateTaxCategory(t.db, { id: t.sst.id, digitalRateBps: 500 }, MANAGER);
    expect(t.r.getOrderSnapshot(t.db, o)!.items[0]).toMatchObject({ digitalRateBps: 800 });
    expect(t.row(o)).toMatchObject({ byCard: 108_000 });
    // A line added now carries the new rate, and the bill by card follows the lines.
    t.r.addOrderItem(t.db, { orderId: o, menuItemId: t.plate, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    expect(t.r.getOrderSnapshot(t.db, o)!.items.map((i) => i.digitalRateBps)).toEqual([800, 500]);
    expect(t.row(o)).toMatchObject({ subtotal: 200_000, total: 230_000, byCard: 100_000 + 8_000 + 100_000 + 5_000 });
  });
});

describe.skipIf(!DatabaseSync)('Pay settles the bill from the legs (pos-domain splitTender)', () => {
  it('all cash: the stored total to the paisa, nothing at the card rate, the drawer open for the cash', () => {
    const o = t.ring();
    const paid = t.tender(o, [{ method: 'cash', amountCents: 115_000, tenderedCents: 120_000 }]);
    expect(paid).toMatchObject({ totalCents: 115_000, taxCents: 15_000 });
    expect(paid).not.toHaveProperty('digitalNetCents');
    expect(t.row(o)).toMatchObject({ tax: 15_000, total: 115_000, cardNet: 0, cardTax: 0, status: 'sent_to_kitchen' });
    expect(t.legs(o)).toEqual([{ method: 'cash', amount: 115_000 }]);
    expect(t.drawer(o)).toEqual([{ kind: 'sale', amount: 115_000, reason: null }]);
  });

  it('all card: the bill by card — 8% on every rupee — and the drawer opens for the slip (every sale, the default)', () => {
    const o = t.ring();
    const paid = t.tender(o, [{ method: 'card', amountCents: 108_000 }]);
    expect(paid).toMatchObject({ totalCents: 108_000, taxCents: 8_000, digitalNetCents: 100_000, digitalTaxCents: 8_000, drawerOpenId: expect.any(String) });
    expect(t.row(o)).toMatchObject({ tax: 8_000, total: 108_000, byCard: 108_000, cardNet: 100_000, cardTax: 8_000 });
    expect(t.legs(o)).toEqual([{ method: 'card', amount: 108_000 }]);
    expect(t.drawer(o)).toEqual([{ kind: 'sale', amount: null, reason: t.r.CARD_SALE_DRAWER_REASON }]);
    // What the snapshot, the sync image and the audit row carry: the settled bill.
    expect(t.r.getOrderSnapshot(t.db, o)!.order).toMatchObject({ totalCents: 108_000, taxCents: 8_000, digitalNetCents: 100_000, digitalTaxCents: 8_000 });
    const image = t.db
      .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(o) as { payload_json: string };
    expect(JSON.parse(image.payload_json)).toMatchObject({ totalCents: 108_000, taxCents: 8_000, digitalNetCents: 100_000, digitalTaxCents: 8_000 });
    const audit = t.db
      .prepare(`SELECT after_json FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'tender'`)
      .get(o) as { after_json: string };
    expect(JSON.parse(audit.after_json)).toMatchObject({ totalCents: 108_000, taxCents: 8_000, digitalNetCents: 100_000, digitalTaxCents: 8_000 });
  });

  it('a wallet or a bank transfer is paid at the card rate too; the card part with cash of its own leg', () => {
    for (const method of ['easypaisa', 'jazzcash', 'bank_transfer'] as const) {
      const o = t.ring();
      expect(t.tender(o, [{ method, amountCents: 108_000 }])).toMatchObject({ totalCents: 108_000, taxCents: 8_000 });
    }
  });

  it('half on the card: the card half at 8%, the cash half at 15%, Rs 1,115 in all; the drawer opens for the cash', () => {
    const o = t.ring();
    const paid = t.tender(o, [
      { method: 'card', amountCents: 54_000 },
      { method: 'cash', amountCents: 57_500, tenderedCents: 60_000 },
    ]);
    expect(paid).toMatchObject({ totalCents: 111_500, taxCents: 11_500, digitalNetCents: 50_000, digitalTaxCents: 4_000 });
    expect(t.row(o)).toMatchObject({ tax: 11_500, total: 111_500, cardNet: 50_000, cardTax: 4_000 });
    expect(t.legs(o)).toEqual([
      { method: 'card', amount: 54_000 },
      { method: 'cash', amount: 57_500 },
    ]);
    expect(t.drawer(o)).toEqual([{ kind: 'sale', amount: 57_500, reason: null }]);
  });

  it('refuses legs that do not fit, in plain words, and writes nothing', () => {
    const o = t.ring();
    const untouched = t.row(o);
    // The old total by card: Rs 70 too much.
    expect(() => t.tender(o, [{ method: 'card', amountCents: 115_000 }])).toThrow('Rs 1,150 on the card is more than the bill by card (Rs 1,080)');
    // Less than the bill by card, with no cash to make it up: Rs 1,000 buys 1000/1080 of the bill, the rest is cash at 15%.
    expect(() => t.tender(o, [{ method: 'card', amountCents: 100_000 }])).toThrow(
      'Rs 1,000 on the card leaves Rs 85.19 to pay in cash (the bill by card is Rs 1,080)',
    );
    // The card total in cash: Rs 70 short.
    expect(() => t.tender(o, [{ method: 'cash', amountCents: 108_000 }])).toThrow('Payments (Rs 1080) must equal the order total (Rs 1150)');
    // Half on the card and the wrong cash.
    expect(() =>
      t.tender(o, [
        { method: 'card', amountCents: 54_000 },
        { method: 'cash', amountCents: 57_000 },
      ]),
    ).toThrow('With Rs 540 on the card the cash part is Rs 575, not Rs 570');
    // More on the card than the bill by card.
    expect(() => t.tender(o, [{ method: 'card', amountCents: 108_001 }])).toThrow('more than the bill by card');
    expect(t.row(o)).toEqual(untouched);
    expect(t.legs(o)).toEqual([]);
    expect(t.drawer(o)).toEqual([]);
  });

  it('an order without a card rate pays its total however it is paid, exactly as before 0052', () => {
    const card = t.ring(t.plainPlate);
    expect(t.tender(card, [{ method: 'card', amountCents: 115_000 }])).toMatchObject({ totalCents: 115_000, taxCents: 15_000 });
    expect(t.row(card)).toMatchObject({ total: 115_000, byCard: null, cardNet: 0, cardTax: 0 });
    const half = t.ring(t.plainPlate);
    expect(
      t.tender(half, [
        { method: 'card', amountCents: 60_000 },
        { method: 'cash', amountCents: 55_000 },
      ]),
    ).toMatchObject({ totalCents: 115_000 });
    const wrong = t.ring(t.plainPlate);
    expect(() => t.tender(wrong, [{ method: 'card', amountCents: 108_000 }])).toThrow('Payments (Rs 1080) must equal the order total (Rs 1150)');
  });

  it('the drawer stays shut on a card sale when the till is set to cash sales only; a wallet sale opens it under every sale', () => {
    const shut = t.ring();
    expect(t.tender(shut, [{ method: 'card', amountCents: 108_000 }], 'cash').drawerOpenId).toBeNull();
    expect(t.drawer(shut)).toEqual([]);
    const open = t.ring();
    expect(t.tender(open, [{ method: 'jazzcash', amountCents: 108_000 }], 'every_sale').drawerOpenId).toEqual(expect.any(String));
  });

  it('Served at the counter by card settles the bill the same way', () => {
    const o = t.ring();
    t.r.sendOrderToKitchen(t.db, o, CASHIER);
    t.r.markOrderPreparing(t.db, o, CASHIER);
    t.r.markOrderReady(t.db, o, CASHIER);
    expect(() => t.r.markOrderServed(t.db, { orderId: o, payment: { method: 'card', amountCents: 115_000, tenderedCents: null } }, CASHIER)).toThrow(
      'Rs 1,150 on the card is more than the bill by card (Rs 1,080)',
    );
    expect(() => t.r.markOrderServed(t.db, { orderId: o, payment: { method: 'card', amountCents: 100_000, tenderedCents: null } }, CASHIER)).toThrow(
      'Rs 1,000 on the card leaves Rs 85.19 to pay in cash',
    );
    const served = t.r.markOrderServed(t.db, { orderId: o, payment: { method: 'card', amountCents: 108_000, tenderedCents: null } }, CASHIER);
    expect(served).toMatchObject({ status: 'paid', totalCents: 108_000, taxCents: 8_000, digitalNetCents: 100_000, digitalTaxCents: 8_000, drawerOpenId: expect.any(String) });
    expect(t.row(o)).toMatchObject({ tax: 8_000, total: 108_000, cardNet: 100_000, cardTax: 8_000, status: 'paid' });
    // In cash at the counter: the stored total, as ever.
    const c = t.ring();
    t.r.sendOrderToKitchen(t.db, c, CASHIER);
    t.r.markOrderPreparing(t.db, c, CASHIER);
    t.r.markOrderReady(t.db, c, CASHIER);
    expect(t.r.markOrderServed(t.db, { orderId: c, payment: { method: 'cash', amountCents: 115_000, tenderedCents: 115_000 } }, CASHIER)).toMatchObject({
      totalCents: 115_000,
      taxCents: 15_000,
    });
  });
});
