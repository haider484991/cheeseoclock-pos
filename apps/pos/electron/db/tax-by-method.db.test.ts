/**
 * A tax rate for each way of paying (migration 0054, v0.7.45; the owner,
 * 12 Oct 2026: "add settings to set percentage tax on jazz cash or any
 * payment method") on a real database built from every migration, through
 * the real repositories:
 *  - a tax category keeps the ways whose rate differs from its card rate
 *    (JazzCash at the cash rate, bank transfer at 10%), and none when every
 *    way pays the card rate — stored exactly as before 0054;
 *  - a line freezes them with its other rates, and the order stores its bill
 *    by each of those ways beside the bill by card;
 *  - Pay and Picked up settle each way at its own bill (pos-domain
 *    settleLegs), refuse an amount that does not fit in plain words, and
 *    store the part at a rate of its own as the card part was stored.
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
  // 15% in cash, 8% by card and EasyPaisa, JazzCash at the cash rate, a bank transfer 10%.
  const sst = r.createTaxCategory(
    db,
    { name: 'Test SST by way', rateBps: 1_500, digitalRateBps: 800, methodRatesBps: { easypaisa: 800, jazzcash: 1_500, bank_transfer: 1_000 } },
    MANAGER,
  );
  const cardOnly = r.createTaxCategory(db, { name: 'Test SST card only', rateBps: 1_500, digitalRateBps: 800 }, MANAGER);
  const cat = r.createCategory(db, { name: 'Test By Way', displayOrder: 9, colorHex: '#123456' }, MANAGER);
  const plate = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Way Plate', basePriceCents: 100_000, taxCategoryId: sst.id }, MANAGER).id;
  const cardPlate = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Card Plate', basePriceCents: 100_000, taxCategoryId: cardOnly.id }, MANAGER).id;
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const ring = (menuItemId = plate, quantity = 1) => {
    const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    r.addOrderItem(db, { orderId: o.id, menuItemId, quantity, modifierIds: [], notes: null }, CASHIER);
    return o.id;
  };
  const row = (id: string) =>
    db
      .prepare(
        `SELECT tax_cents AS tax, total_cents AS total, digital_total_cents AS byCard, method_totals_json AS byWay,
                digital_net_cents AS cardNet, digital_tax_cents AS cardTax
           FROM orders WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
  const tender = (id: string, payments: Leg[]) =>
    r.tenderOrder(db, { orderId: id, payments: payments.map((p) => ({ tenderedCents: p.method === 'cash' ? p.amountCents : null, ...p })) }, CASHIER);
  return { db, r, sst, cardOnly, plate, cardPlate, ring, row, tender };
}
type Till = Awaited<ReturnType<typeof till>>;

let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('a rate for each way of paying on a tax category', () => {
  it('keeps only the ways that differ from the card rate; absent keeps them, null clears them, a new card rate measures them again', () => {
    expect(t.r.findTaxCategory(t.db, t.sst.id)).toMatchObject({ rateBps: 1_500, digitalRateBps: 800, methodRatesBps: { jazzcash: 1_500, bank_transfer: 1_000 } });
    expect(t.db.prepare(`SELECT method_rates_json AS j FROM tax_categories WHERE id = ?`).get(t.sst.id)).toEqual({ j: '{"jazzcash":1500,"bank_transfer":1000}' });
    // Every way at the card rate: stored exactly as before 0054.
    expect(t.r.findTaxCategory(t.db, t.cardOnly.id)).toMatchObject({ methodRatesBps: null });
    expect(t.db.prepare(`SELECT method_rates_json AS j FROM tax_categories WHERE id = ?`).get(t.cardOnly.id)).toEqual({ j: null });

    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, name: 'Test renamed' }, MANAGER).methodRatesBps).toEqual({ jazzcash: 1_500, bank_transfer: 1_000 });
    // The card rate now 15%: JazzCash at 15% is the card rate, the bank's 10% still differs.
    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, digitalRateBps: 1_500 }, MANAGER)).toMatchObject({ digitalRateBps: null, methodRatesBps: { bank_transfer: 1_000 } });
    expect(t.r.updateTaxCategory(t.db, { id: t.sst.id, methodRatesBps: null }, MANAGER).methodRatesBps).toBeNull();
    expect(() => t.r.updateTaxCategory(t.db, { id: t.sst.id, methodRatesBps: { jazzcash: 10_001 } }, MANAGER)).toThrow(/basis points/);
  });

  it('a line freezes them, and the order stores its bill by each way that differs beside the bill by card', () => {
    const o = t.ring();
    expect(t.row(o)).toEqual({
      tax: 15_000,
      total: 115_000,
      byCard: 108_000,
      byWay: '{"jazzcash":115000,"bank_transfer":110000}',
      cardNet: 0,
      cardTax: 0,
    });
    const snap = t.r.getOrderSnapshot(t.db, o)!;
    expect(snap.order).toMatchObject({ totalCents: 115_000, digitalTotalCents: 108_000, methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 } });
    expect(snap.items[0]).toMatchObject({ taxRateBps: 1_500, digitalRateBps: 800, methodRatesBps: { jazzcash: 1_500, bank_transfer: 1_000 } });

    // A category with the card rate alone: no bill by way, as before 0054.
    const c = t.ring(t.cardPlate);
    expect(t.row(c)).toMatchObject({ total: 115_000, byCard: 108_000, byWay: null });
    expect(t.r.getOrderSnapshot(t.db, c)!.order).not.toHaveProperty('methodTotalsCents');
    expect(t.r.getOrderSnapshot(t.db, c)!.items[0]).not.toHaveProperty('methodRatesBps');
  });

  it('a line keeps the rates it was sold with: a later change to the category moves only the lines added after it', () => {
    const o = t.ring();
    t.r.updateTaxCategory(t.db, { id: t.sst.id, methodRatesBps: { jazzcash: 800, bank_transfer: 1_000 } }, MANAGER);
    t.r.addOrderItem(t.db, { orderId: o, menuItemId: t.plate, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    // JazzCash: the first plate at 15%, the second at the card rate now (8%).
    expect(t.row(o)).toMatchObject({ total: 230_000, byCard: 216_000, byWay: '{"jazzcash":223000,"bank_transfer":220000}' });
  });

  it('Pay by JazzCash at the cash rate: the bill in cash, nothing at a rate of its own; the card bill is refused in plain words', () => {
    const o = t.ring();
    expect(() => t.tender(o, [{ method: 'jazzcash', amountCents: 108_000 }])).toThrow(
      'Rs 1,080 by JazzCash leaves Rs 70 to pay in cash (the bill by JazzCash is Rs 1,150)',
    );
    t.tender(o, [{ method: 'jazzcash', amountCents: 115_000 }]);
    expect(t.row(o)).toMatchObject({ tax: 15_000, total: 115_000, cardNet: 0, cardTax: 0 });
  });

  it('Pay by bank transfer at 10%: its own bill, all of it at that rate; and EasyPaisa at the card rate pays the card bill', () => {
    const bank = t.ring();
    t.tender(bank, [{ method: 'bank_transfer', amountCents: 110_000 }]);
    expect(t.row(bank)).toMatchObject({ tax: 10_000, total: 110_000, cardNet: 100_000, cardTax: 10_000 });
    const ep = t.ring();
    t.tender(ep, [{ method: 'easypaisa', amountCents: 108_000 }]);
    expect(t.row(ep)).toMatchObject({ tax: 8_000, total: 108_000, cardNet: 100_000, cardTax: 8_000 });
  });

  it('half by bank transfer, half in cash: each half at its own rate', () => {
    const o = t.ring();
    expect(() => t.tender(o, [{ method: 'bank_transfer', amountCents: 55_000 }, { method: 'cash', amountCents: 57_000 }])).toThrow(
      'With Rs 550 by bank transfer the cash part is Rs 575, not Rs 570',
    );
    t.tender(o, [
      { method: 'bank_transfer', amountCents: 55_000 },
      { method: 'cash', amountCents: 57_500 },
    ]);
    expect(t.row(o)).toMatchObject({ tax: 12_500, total: 112_500, cardNet: 50_000, cardTax: 5_000 });
  });

  it('Picked up + Pay by bank transfer settles the same way', () => {
    const o = t.ring();
    t.r.sendOrderToKitchen(t.db, o, CASHIER);
    t.db.prepare(`UPDATE orders SET status = 'ready' WHERE id = ?`).run(o);
    t.r.markOrderServed(t.db, { orderId: o, payment: { method: 'bank_transfer', amountCents: 110_000, tenderedCents: null } }, CASHIER);
    expect(t.row(o)).toMatchObject({ tax: 10_000, total: 110_000, cardNet: 100_000, cardTax: 10_000 });
  });
});
