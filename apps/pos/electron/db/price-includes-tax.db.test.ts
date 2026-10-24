/**
 * Prices that include their tax (migration 0057; the owner's yellow deal menu, 24 Oct 2026: "THE PRICE YOU SEE IS
 * THE PRICE YOU PAY · TAX INCLUDED · delivery charges not included") on a real database built from every
 * migration, through the real repositories:
 *  - a marked item's line adds no tax: the bill is its price, in cash and by card, to the paisa, one or many of it
 *    (the ÷ 1.15 way left a paisa over or under);
 *  - the tax inside it is stored apart (orders.included_tax_cents): 15/115 in cash, 8/108 by card, split by the
 *    legs on a half-and-half sale; tax_cents stays the tax ADDED, so total = subtotal − discount + tax holds;
 *  - beside an unmarked item the unmarked one still has its tax added, as before;
 *  - the shift report's tax is the order's whole tax (added + inside), and its food before tax still adds up;
 *  - the receipt prints "Tax included (15%)" under the total and no "Tax 0.00"; the kitchen ticket says what a
 *    deal is made of (its description, "Includes: …");
 *  - the mark is the owner's: a manager's save that changes it is refused.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron here); skipped where it is missing.
 * Every name and amount is made up but the deal prices, which are the printed menu's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentMethod } from '@cheeseoclock/shared-types';
import { escPosToText, renderKitchenTicket, renderReceipt } from '@cheeseoclock/printer-core';
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

type Leg = { method: PaymentMethod; amountCents: number };

async function till() {
  const db = openMigrated();
  await openCostingShop(db);
  const r = await repos();
  // The shop's rate: 15% in cash, 8% by card / wallet / bank.
  const sst = r.createTaxCategory(db, { name: 'Test SST', rateBps: 1_500, digitalRateBps: 800 }, MANAGER);
  const deals = r.createCategory(db, { name: 'Test Value Deals', displayOrder: 9, colorHex: '#123456' }, MANAGER);
  const food = r.createCategory(db, { name: 'Test Pizza', displayOrder: 10, colorHex: '#654321' }, MANAGER);
  const mega = r.createMenuItem(
    db,
    {
      categoryId: deals.id,
      name: 'Test Mega Box',
      description: 'Large + Medium regular pizza, Signature Crispy burger, fries.',
      basePriceCents: 480_000,
      taxCategoryId: sst.id,
      priceIncludesTax: true,
    },
    MANAGER,
  );
  const partners = r.createMenuItem(
    db,
    { categoryId: deals.id, name: 'Test Partners', basePriceCents: 130_000, taxCategoryId: sst.id, priceIncludesTax: true },
    MANAGER,
  );
  const pizza = r.createMenuItem(db, { categoryId: food.id, name: 'Test Pizza — Large', basePriceCents: 200_000, taxCategoryId: sst.id }, MANAGER);
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const ring = (lines: Array<[string, number]>) => {
    const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
    for (const [menuItemId, quantity] of lines) r.addOrderItem(db, { orderId: o.id, menuItemId, quantity, modifierIds: [], notes: null }, CASHIER);
    return o.id;
  };
  const row = (id: string) =>
    db
      .prepare(
        `SELECT subtotal_cents AS subtotal, tax_cents AS tax, total_cents AS total, digital_total_cents AS byCard,
                digital_net_cents AS cardNet, digital_tax_cents AS cardTax,
                included_tax_cents AS included, digital_included_tax_cents AS cardIncluded
           FROM orders WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>;
  const tender = (id: string, payments: Leg[]) =>
    r.tenderOrder(db, { orderId: id, payments: payments.map((p) => ({ tenderedCents: p.method === 'cash' ? p.amountCents : null, ...p })) }, CASHIER);
  return { db, r, mega: mega.id, partners: partners.id, pizza: pizza.id, ring, row, tender };
}
type Till = Awaited<ReturnType<typeof till>>;

let t: Till;
beforeEach(async () => {
  if (!DatabaseSync) return;
  t = await till();
});

describe.skipIf(!DatabaseSync)('a price that includes its tax (0057)', () => {
  it('the bill is the printed price, the tax inside it stored apart, the line marked', () => {
    const o = t.ring([[t.mega, 1]]);
    expect(t.row(o)).toMatchObject({ subtotal: 480_000, tax: 0, total: 480_000, byCard: 480_000, included: 62_609, cardIncluded: 0 });
    const snap = t.r.getOrderSnapshot(t.db, o)!;
    expect(snap.items[0]).toMatchObject({ taxIncluded: true, taxRateBps: 1_500, digitalRateBps: 800 });
    expect(snap.order).toMatchObject({ includedTaxCents: 62_609 });
    // A line's mark is its own: the item changed later leaves it.
    t.r.updateMenuItem(t.db, { id: t.mega, priceIncludesTax: false }, MANAGER);
    expect(t.r.getOrderSnapshot(t.db, o)!.items[0]).toMatchObject({ taxIncluded: true });
  });

  it('one or many of it, the bill is the price times the quantity, to the paisa', () => {
    for (const qty of [1, 2, 3]) {
      expect(t.row(t.ring([[t.partners, qty]]))).toMatchObject({ total: 130_000 * qty, tax: 0 });
    }
  });

  it('in cash: Rs 4,800 and 15/115 of it; by card: Rs 4,800 and 8/108 of it; half and half: each half its own', () => {
    const cash = t.ring([[t.mega, 1]]);
    t.tender(cash, [{ method: 'cash', amountCents: 480_000 }]);
    expect(t.row(cash)).toMatchObject({ total: 480_000, tax: 0, included: 62_609, cardIncluded: 0 });

    const card = t.ring([[t.mega, 1]]);
    t.tender(card, [{ method: 'card', amountCents: 480_000 }]);
    expect(t.row(card)).toMatchObject({ total: 480_000, tax: 0, included: 35_556, cardIncluded: 35_556 });

    const half = t.ring([[t.mega, 1]]);
    t.tender(half, [
      { method: 'card', amountCents: 240_000 },
      { method: 'cash', amountCents: 240_000 },
    ]);
    expect(t.row(half)).toMatchObject({ total: 480_000, tax: 0, included: 31_305 + 17_778, cardIncluded: 17_778 });
  });

  it('beside a regular pizza: the pizza has its 15% added, the deal holds its own', () => {
    const o = t.ring([[t.mega, 1], [t.pizza, 1]]);
    expect(t.row(o)).toMatchObject({ subtotal: 680_000, tax: 30_000, total: 710_000, included: 62_609 });
    t.tender(o, [{ method: 'card', amountCents: 480_000 + 216_000 }]);
    // By card: the deal still Rs 4,800 (8/108 inside), the pizza Rs 2,000 + 8%.
    expect(t.row(o)).toMatchObject({ total: 696_000, tax: 16_000, included: 35_556, cardIncluded: 35_556 });
  });

  it('the receipt says the tax is included, under the total, and the kitchen ticket says what the deal holds', () => {
    const o = t.ring([[t.mega, 1]]);
    t.tender(o, [{ method: 'cash', amountCents: 480_000 }]);
    const snap = t.r.getOrderSnapshot(t.db, o)!;
    const receipt = escPosToText(renderReceipt(snap, { branding: { storeName: 'Test Shop' } }));
    expect(receipt).toMatch(/Tax included \(15%\)\s+626\.09/);
    expect(receipt).not.toMatch(/^Tax \(15%\)/m);
    expect(receipt).toMatch(/TOTAL\s+Rs 4,800/);
    // A deal category's line: what it is made of, under it.
    const kitchen = escPosToText(renderKitchenTicket(snap, {}));
    expect(kitchen).toContain('Includes: Large + Medium regular pizza,');
    expect(kitchen).toContain('Signature Crispy burger, fries.');
    // A line outside a deal category prints nothing more.
    const p = t.ring([[t.pizza, 1]]);
    expect(escPosToText(renderKitchenTicket(t.r.getOrderSnapshot(t.db, p)!, {}))).not.toContain('Includes:');
  });

  it('an order without a marked line reads exactly as before', () => {
    const o = t.ring([[t.pizza, 1]]);
    expect(t.row(o)).toMatchObject({ subtotal: 200_000, tax: 30_000, total: 230_000, included: 0, cardIncluded: 0 });
    const snap = t.r.getOrderSnapshot(t.db, o)!;
    expect(snap.order).not.toHaveProperty('includedTaxCents');
    expect(snap.items[0]).not.toHaveProperty('taxIncluded');
  });
});
