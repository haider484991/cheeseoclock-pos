/**
 * Profit, food cost and costing for a price that includes its tax (0057; the owner's yellow deal
 * menu, 24 Oct 2026: every deal price includes the 15% GST) against a real database built from every
 * migration and the made-up costing shop:
 *   - Reports → Food cost & stock and the Profit tab count a tax-included line's price less the tax
 *     the order stored inside it — 15/115 in cash, 8/108 by card — so their sales before tax are the
 *     shift report's and Reports Overview's (stored subtotal − discount − tax inside);
 *   - Menu's per-item sales and profit do the same, at menu price before tax too;
 *   - beside it an unmarked line (tax added on top) counts its price, as before, discounted or not;
 *   - Costing → Menu costs works the deal's profit and food cost on its price before tax, and the
 *     price to hit its target is the price to type, tax included.
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE AND QUANTITY IS MADE UP (costing spec D11).
 */
import { describe, expect, it, vi } from 'vitest';
import type { PaymentMethod, ReportProfitTab } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => false } }));

const live = describe.skipIf(!DatabaseSync);

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...s.r,
    ...(await import('../../db/repositories/shift-repo.js')),
    ...(await import('../business-report.js')),
    ...(await import('./report-tabs.js')),
    ...(await import('../costing-service.js')),
  };
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  // The shop's rate: 15% in cash, 8% by card. The deal's price includes it; the pizza's has it added.
  const sst = r.createTaxCategory(db, { name: 'Test SST', rateBps: 1_500, digitalRateBps: 800 }, MANAGER);
  r.updateMenuItem(db, { id: s.item.deal, taxCategoryId: sst.id, priceIncludesTax: true }, MANAGER);
  r.updateMenuItem(db, { id: s.item.fajitaM, taxCategoryId: sst.id }, MANAGER);
  const at = new Date();
  const period = { sinceIso: new Date(at.getTime() - 3_600_000).toISOString(), untilIso: new Date(at.getTime() + 3_600_000).toISOString() };
  /**
   * A counted sale. In cash as the Profit tests ring one: sent to the kitchen (stock taken, cost kept),
   * then marked paid — its tax inside stored at the cash rates. By card: paid at its card bill by the
   * till's own Pay, which settles the tax inside at the card rate.
   */
  const sale = (lines: Line[], how: 'cash' | 'card' = 'cash', o: { discountPct?: number } = {}) => {
    const id = s.ring(lines);
    if (o.discountPct) r.applyDiscount(db, { orderId: id, discountType: 'percent', value: o.discountPct, reason: 'Test' }, CASHIER);
    if (how === 'cash') {
      r.sendOrderToKitchen(db, id, CASHIER);
      s.markPaid(id, at);
      return id;
    }
    const bill = r.orderBillQuote(db, id)!;
    const amountCents = bill.methodTotalsCents?.card ?? bill.digitalTotalCents ?? bill.totalCents;
    r.tenderOrder(db, { orderId: id, payments: [{ method: 'card' as PaymentMethod, amountCents, tenderedCents: null }] }, CASHIER);
    return id;
  };
  const stored = (id: string) =>
    db.prepare(`SELECT subtotal_cents AS sub, discount_cents AS disc, included_tax_cents AS incl FROM orders WHERE id = ?`).get(id) as {
      sub: number;
      disc: number;
      incl: number;
    };
  /** The shift report's and Overview's sales before tax for these orders: stored subtotal − discount − tax inside. */
  const beforeTax = (...ids: string[]) =>
    ids.reduce((n, id) => {
      const o = stored(id);
      return n + Number(o.sub) - Number(o.disc) - Number(o.incl);
    }, 0);
  const profit = () => r.buildReportTab(db, 'profit', period) as Omit<ReportProfitTab, 'engine'>;
  const sales = (t: Omit<ReportProfitTab, 'engine'>) => t.steps.find((x) => x.key === 'sales')?.cents;
  const deal: Line = ['deal', 1, ['d1Fajita', 'd2Veggie']];
  return { ...s, db, r, period, sale, stored, beforeTax, profit, sales, deal };
}

live('a price that includes its tax in Reports (0057)', () => {
  it('in cash: the Rs 3,000 deal counts Rs 2,608.70 of sales, as the shift report does; its cost is its own', async () => {
    const s = await shop();
    const id = s.sale([s.deal]);
    expect(s.stored(id)).toMatchObject({ sub: 300_000, incl: 39_130 });
    const food = s.r.getFoodCost(s.db, s.period);
    expect(food.foodSalesCents).toBe(260_870);
    expect(food.foodSalesCents).toBe(s.beforeTax(id));
    expect(food.knownSalesCents).toBe(260_870);
    expect(food.knownMenuSalesCents).toBe(260_870);
    expect(s.sales(s.profit())).toBe(260_870);
    const item = s.r.buildReportTab(s.db, 'menu', s.period).costs!.items[s.item.deal]!;
    expect(item).toMatchObject({ units: 1, salesCents: 260_870, knownSalesCents: 260_870 });
    expect(item.profitCents).toBe(260_870 - item.costCents);
  });

  it('by card: what the order stored inside it at 8%, not the cash rate', async () => {
    const s = await shop();
    const id = s.sale([s.deal], 'card');
    expect(s.stored(id)).toMatchObject({ sub: 300_000, incl: 22_222 });
    expect(s.r.getFoodCost(s.db, s.period).foodSalesCents).toBe(277_778);
    expect(s.sales(s.profit())).toBe(277_778);
    expect(s.r.buildReportTab(s.db, 'menu', s.period).costs!.items[s.item.deal]!.salesCents).toBe(277_778);
  });

  it('beside a pizza with its tax added, with a discount: the two still add up to the bill before tax', async () => {
    const s = await shop();
    const a = s.sale([s.deal, ['fajitaM', 1]], 'cash', { discountPct: 10 });
    const b = s.sale([['fajitaM', 2]]);
    const food = s.r.getFoodCost(s.db, s.period);
    expect(food.foodSalesCents).toBe(s.beforeTax(a, b));
    expect(s.sales(s.profit())).toBe(s.beforeTax(a, b));
    // The pizza on the plain order counts its price, as before.
    const items = s.r.buildReportTab(s.db, 'menu', s.period).costs!.items;
    expect(items[s.item.fajitaM]!.units).toBe(3);
    expect(items[s.item.deal]!.salesCents + items[s.item.fajitaM]!.salesCents).toBe(s.beforeTax(a, b));
  });

  it('an order without a marked line reads exactly as before', async () => {
    const s = await shop();
    const id = s.sale([['fajitaM', 2]]);
    expect(s.stored(id).incl).toBe(0);
    expect(s.r.getFoodCost(s.db, s.period)).toMatchObject({ foodSalesCents: 240_000, knownMenuSalesCents: 240_000 });
    expect(s.sales(s.profit())).toBe(240_000);
  });
});

live('a price that includes its tax in Costing (0057)', () => {
  it('Menu costs: the deal’s profit and food cost on its price before tax; the price to hit its target holds the tax', async () => {
    const s = await shop();
    const row = s.r.getMenuCosts(s.db).rows.find((x) => x.menuItemId === s.item.deal)!;
    expect(row).toMatchObject({ basePriceCents: 300_000, priceCents: 260_870, priceIncludesTax: true });
    expect(row.costCents).toBeGreaterThan(0);
    expect(row.profitCents).toBe(260_870 - row.costCents);
    // Cost ÷ the price before tax (worked in millicents: within a point of the paisa figures).
    expect(Math.abs(row.foodCostBps! - Math.round((row.costCents * 10_000) / 260_870))).toBeLessThanOrEqual(1);
    // The pizza beside it: its price is before tax already, unmarked.
    const pizza = s.r.getMenuCosts(s.db).rows.find((x) => x.menuItemId === s.item.fajitaM)!;
    expect(pizza).toMatchObject({ basePriceCents: 120_000, priceCents: 120_000 });
    expect(pizza).not.toHaveProperty('priceIncludesTax');
    expect(s.r.getItemCostSheet(s.db, s.item.deal)!.row).toMatchObject({ priceCents: 260_870, priceIncludesTax: true });
  });
});
