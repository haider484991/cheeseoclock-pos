/**
 * Profit (costing spec 4.4, 4.7, 4.8 and 4.11, Phase 9) against a real
 * database built from every migration and the made-up costing shop:
 *   - the waterfall's steps add up to profit before overheads, and its sales
 *     and food cost ARE Food cost & stock's (one allocation, one set of rules);
 *   - sales whose cost is unknown are their own bar, never costed at Rs 0;
 *   - foodpanda's commission on the order before tax, its price uplift as its
 *     own line — the stored order totals never change;
 *   - rider cost: the zone's rate even with the delivery charge discounted,
 *     the charge at menu price with no area, neither: Rs 0 and listed;
 *   - a foodpanda order against the same food delivered by the shop;
 *   - the stock-loss step only between two FULL stock takes;
 *   - Menu's cost and profit per item and per category, on fully costed sales;
 *   - orders whose food cost is only partly known: their commission, rider,
 *     charges and fees go with the food in the same share — what goes with
 *     the unknown part is set aside with it, never charged to the rest;
 *   - delivery areas: the zone recognised, charges collected, customers back
 *     (2 or more orders of any kind in 90 days);
 *   - the menu map: "not enough sales yet", then placed, with the dishes not
 *     sold and the ones that can't be placed yet listed apart;
 *   - estimates kept between asks (the Reports worker): reused, worked out
 *     again for an order with a new stock row, all dropped on a price change;
 *   - test orders the owner deleted (0043) are in no profit figure — sales,
 *     food cost, sent-not-paid, channels, categories, Menu, the menu map,
 *     delivery areas, What-if — as the main process and the Reports worker
 *     work them out; the food booked as waste is Waste's own line, "Test
 *     orders (deleted)", as on Food cost & stock.
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE AND QUANTITY IS MADE UP (costing spec D11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportProfitTab, TillLinkState } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => false } }));

const live = describe.skipIf(!DatabaseSync);
const OFF: TillLinkState = { on: false, stale: false, lastHeardAt: null };

afterEach(() => {
  vi.useRealTimers();
});

type Mode = 'takeaway' | 'delivery' | 'foodpanda';

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...s.r,
    ...(await import('../../db/repositories/business-settings-repo.js')),
    ...(await import('../../db/repositories/shift-repo.js')),
    ...(await import('../../db/repositories/stock-count-repo.js')),
    ...(await import('../business-report.js')),
    ...(await import('../../db/repositories/ingredient-cost-repo.js')),
    ...(await import('./report-tabs.js')),
    ...(await import('./profit.js')),
    ...(await import('./menu-engineering.js')),
  };
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const at = new Date();
  /** A period around now: every sale below is in it. */
  const period = { sinceIso: new Date(at.getTime() - 3_600_000).toISOString(), untilIso: new Date(at.getTime() + 3_600_000).toISOString() };
  /**
   * A counted sale: rung, sent to the kitchen (stock taken, cost kept), paid.
   * The order type and the address are the till's own columns, set here as a
   * delivery or foodpanda order would have them.
   */
  const sale = (lines: Line[], o: { mode?: Mode; area?: string | null; phone?: string; discountPct?: number; when?: Date } = {}) => {
    const id = s.ring(lines);
    if (o.discountPct) r.applyDiscount(db, { orderId: id, discountType: 'percent', value: o.discountPct, reason: 'Test' }, CASHIER);
    r.sendOrderToKitchen(db, id, CASHIER);
    s.markPaid(id, o.when ?? at);
    if (o.mode && o.mode !== 'takeaway') {
      const address = o.area === undefined ? null : JSON.stringify({ label: 'Home', addressLine: 'House 1', area: o.area, city: 'Karachi', notes: null });
      db.prepare(`UPDATE orders SET mode = ?, delivery_address_snapshot = ?, customer_phone_snapshot = ? WHERE id = ?`).run(o.mode, address, o.phone ?? null, id);
    }
    return id;
  };
  const tab = (req: Parameters<typeof r.buildReportTab>[2] = period) => r.buildReportTab(db, 'profit', req) as Omit<ReportProfitTab, 'engine'>;
  const step = (t: Omit<ReportProfitTab, 'engine'>, key: string) => t.steps.find((x) => x.key === key)?.cents;
  /** What an order's lines kept as their cost (order_item_costs). */
  const keptCost = (orderId: string) =>
    Number((db.prepare(`SELECT COALESCE(SUM(cost_cents), 0) AS c FROM order_item_costs WHERE order_id = ?`).get(orderId) as { c: number }).c);
  const setFees = (fees: Record<string, unknown>) =>
    r.setBusinessSetting(
      db,
      'channels.fees',
      {
        foodpanda: { commissionBps: 2500, base: 'sales_ex_tax', fixedFeeCents: 0, upliftBps: 0, ...fees },
        paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 },
      },
      MANAGER,
    );
  return { ...s, db, r, at, period, sale, tab, step, keptCost, setFees };
}

live('the profit waterfall (costing spec 4.7)', () => {
  it('adds up to profit before overheads; its sales and food cost are Food cost & stock’s', async () => {
    const s = await shop();
    s.sale([['fajitaM', 2]]);
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6', discountPct: 10 });
    s.sale([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']], ['cola', 2]]);
    s.sale([['bakedWings', 1]], { mode: 'foodpanda' });
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -200, reason: 'waste', wasteReason: 'burnt' }, MANAGER);

    const t = s.tab();
    expect(t.steps.reduce((a, x) => a + x.cents, 0)).toBe(t.profitCents);
    expect(t.steps.map((x) => x.key)).toEqual(['sales', 'food_cost', 'unknown_cost', 'waste', 'sent_not_paid', 'commission', 'payment_fees', 'rider']);
    const food = s.r.getFoodCost(s.db, s.period);
    expect(s.step(t, 'sales')).toBe(food.foodSalesCents + food.feeSalesCents);
    expect(s.step(t, 'food_cost')).toBe(-food.knownCostCents);
    expect(t.unknownSalesCents).toBe(food.foodSalesCents - food.knownSalesCents);
    // The foodpanda Baked Wings (no recipe): its Rs 200 of commission goes with its Rs 800 of unknown-cost food, set aside with it.
    expect(s.step(t, 'unknown_cost')).toBe(-(food.foodSalesCents - food.knownSalesCents - 20_000));
    expect(s.step(t, 'commission')).toBe(-20_000);
    expect(s.step(t, 'waste')).toBe(-food.wasteCents);
    expect(food.wasteCents).toBe(24_000); // 200 g of cheese at Rs 1,200 a kilo
    // The channels add up to the same sales, and every counted order is in one.
    expect(t.channels.reduce((a, c) => a + c.salesCents, 0)).toBe(s.step(t, 'sales'));
    expect(t.channels.reduce((a, c) => a + c.orderCount, 0)).toBe(4);
    // …and to the same contribution, before waste and unpaid food.
    const contribution = t.channels.reduce((a, c) => a + c.contributionCents, 0);
    expect(contribution - food.wasteCents - food.sentNotPaid.costCents).toBe(t.profitCents);
    expect(t.coverageBps).toBe(food.coverageBps);
  });

  it('sales with an unknown cost are their own bar, set aside — never costed at Rs 0', async () => {
    const s = await shop();
    const fajita = s.sale([['fajitaM', 1]]);
    // The 345 ml bottle has no price (partial), Baked Wings no recipe (none).
    s.sale([['cola', 2], ['bakedWings', 1]]);
    const t = s.tab();
    expect(t.unknownSalesCents).toBe(2 * 15_000 + 80_000);
    expect(s.step(t, 'unknown_cost')).toBe(-(2 * 15_000 + 80_000));
    // What is left is the fajita alone: its price less what it kept as its cost.
    expect(t.profitCents).toBe(120_000 - s.keptCost(fajita));
    const drinks = t.categories.find((c) => c.name === 'Drinks')!;
    expect(drinks).toMatchObject({ salesCents: 30_000, knownSalesCents: 0, profitCents: null, coverageBps: 0 });
  });

  it('foodpanda: 25% of the order before tax by default; its price uplift is its own line; stored totals never change', async () => {
    const s = await shop();
    const o = s.sale([['fajitaM', 1]], { mode: 'foodpanda' });
    const stored = () => s.db.prepare(`SELECT subtotal_cents, discount_cents, tax_cents, total_cents FROM orders WHERE id = ?`).get(o);
    const before = stored();
    const t = s.tab();
    expect(s.step(t, 'commission')).toBe(-30_000);
    expect(t.steps.some((x) => x.key === 'uplift')).toBe(false);
    expect(t.fees.foodpanda.upliftBps).toBe(0);
    // foodpanda 10% dearer: + Rs 120 of uplift, and the commission on the dearer price.
    s.setFees({ upliftBps: 1000 });
    const up = s.tab();
    expect(s.step(up, 'uplift')).toBe(12_000);
    expect(s.step(up, 'commission')).toBe(-33_000);
    expect(up.steps.reduce((a, x) => a + x.cents, 0)).toBe(up.profitCents);
    // On what the customer paid, with a fixed fee on top.
    s.setFees({ base: 'paid_incl_tax', fixedFeeCents: 5_000 });
    expect(s.step(s.tab(), 'commission')).toBe(-(30_000 + 5_000)); // no tax in the test shop: paid = Rs 1,200
    expect(stored()).toEqual(before);
  });
});

live('rider cost and deliveries with no rate (costing spec 4.7, 4.14)', () => {
  it('the zone’s rate even with the charge discounted; the charge at menu price with no area; neither: Rs 0 and listed', async () => {
    const s = await shop();
    // DHA Phase 8 is a Rs 250 zone; the Rs 100 delivery charge was rung with 10% off.
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 8', discountPct: 10 });
    // No area on the address, a delivery charge on the bill.
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: null });
    // An area that is none of our zones, and no delivery charge.
    const none = s.sale([['fajitaM', 1]], { mode: 'delivery', area: 'Gulshan Block 5' });
    const t = s.tab();
    expect(s.step(t, 'rider')).toBe(-(25_000 + 10_000 + 0));
    expect(t.noRateCount).toBe(1);
    const ch = s.r.buildReportTab(s.db, 'channels', s.period);
    expect(ch.noRateDeliveries.map((d) => d.orderId)).toEqual([none]);
    expect(ch.noRateDeliveries[0]).toMatchObject({ area: 'Gulshan Block 5', channel: 'delivery' });
    expect(ch.areas.map((a) => [a.area, a.zoneId, a.riderCents])).toEqual(
      expect.arrayContaining([
        ['DHA Phase 8', 'dha-8', 25_000],
        ['Area not recorded', null, 10_000],
        ['Gulshan Block 5', null, 0],
      ]),
    );
    // A fixed rate per trip, or salaried riders.
    s.r.setBusinessSetting(s.db, 'delivery.riderCost', { mode: 'fixed', fixedCents: 15_000 }, MANAGER);
    expect(s.step(s.tab(), 'rider')).toBe(-45_000);
    s.r.setBusinessSetting(s.db, 'delivery.riderCost', { mode: 'none', fixedCents: 15_000 }, MANAGER);
    expect(s.step(s.tab(), 'rider')).toBe(0);
  });

  it('a foodpanda order earns less than the same food delivered by the shop', async () => {
    const s = await shop();
    const own = s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6' }); // a Rs 200 zone
    const fp = s.sale([['fajitaM', 1]], { mode: 'foodpanda' });
    const t = s.tab();
    const channel = (c: string) => t.channels.find((x) => x.channel === c)!;
    // Own delivery: food 1,200 − its cost + the Rs 100 charge − the Rs 200 rider.
    expect(channel('delivery')).toMatchObject({ orderCount: 1, riderCents: 20_000, commissionCents: 0, feeSalesCents: 10_000 });
    expect(channel('delivery').contributionCents).toBe(120_000 - s.keptCost(own) + 10_000 - 20_000);
    // foodpanda: food 1,200 − its cost − 25% commission; no rider, no charge.
    expect(channel('foodpanda')).toMatchObject({ orderCount: 1, riderCents: 0, commissionCents: 30_000, feeSalesCents: 0 });
    expect(channel('foodpanda').contributionCents).toBe(120_000 - s.keptCost(fp) - 30_000);
    expect(channel('delivery').contributionCents - channel('foodpanda').contributionCents).toBe(20_000);
  });
});

live('orders whose food cost is only partly known (costing spec 4.7)', () => {
  it('foodpanda: the commission on food of unknown cost is set aside with it; what the channel earns, and per order, are on the known part', async () => {
    const s = await shop();
    const known = s.sale([['fajitaM', 1]], { mode: 'foodpanda' });
    // Baked Wings have no recipe: Rs 800 of food whose cost is not known, Rs 200 of commission on it.
    s.sale([['bakedWings', 1]], { mode: 'foodpanda' });
    // A fajita and Baked Wings on one order (60% of its food known): Rs 500 commission, Rs 300 of it on the fajita…
    const mixed = s.sale([['fajitaM', 1], ['bakedWings', 1]], { mode: 'foodpanda' });
    // …and the same with 10% off (shared out: Rs 1,080 and Rs 720): Rs 450, Rs 270 of it on the fajita.
    const mixedOff = s.sale([['fajitaM', 1], ['bakedWings', 1]], { mode: 'foodpanda', discountPct: 10 });
    const t = s.tab();
    const fp = t.channels.find((c) => c.channel === 'foodpanda')!;
    // Commission as paid: all of it.
    expect(fp).toMatchObject({ orderCount: 4, commissionCents: 30_000 + 20_000 + 50_000 + 45_000, unknownSalesCents: 80_000 + 80_000 + 72_000 });
    expect(fp.setAsideCents).toBe(-(20_000 + 20_000 + 18_000));
    // What it earns: each order's known food less its cost and its share of the commission — the Baked Wings order not at all.
    const earns = 120_000 - s.keptCost(known) - 30_000 + (120_000 - s.keptCost(mixed) - 30_000) + (108_000 - s.keptCost(mixedOff) - 27_000);
    expect(fp.contributionCents).toBe(earns);
    // Per order over the known part: 1 + 0 + 0.6 + 0.6 orders.
    expect(fp.contributionPerOrderCents).toBe(Math.round((earns * 1_000) / 2_200));
    // The waterfall: the commission paid in full; the unknown-cost bar is that food less the commission that went with it.
    expect(s.step(t, 'commission')).toBe(-145_000);
    expect(t.unknownSalesCents).toBe(232_000);
    expect(s.step(t, 'unknown_cost')).toBe(-(232_000 - 58_000));
    expect(t.steps.reduce((a, x) => a + x.cents, 0)).toBe(t.profitCents);
    expect(t.profitCents).toBe(earns);
  });

  it('own delivery: an order of unknown-cost food leaves its charge and rider out of what the area’s orders earn', async () => {
    const s = await shop();
    // DHA Phase 6 is a Rs 200 zone; the delivery charge on the bill is Rs 100.
    const known = s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6' });
    s.sale([['bakedWings', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6' });
    const ch = s.r.buildReportTab(s.db, 'channels', s.period);
    const earns = 120_000 - s.keptCost(known) + 10_000 - 20_000;
    expect(ch.areas).toHaveLength(1);
    // Charges collected and the rider paid stay what they were…
    expect(ch.areas[0]).toMatchObject({ orderCount: 2, riderCents: 40_000, feesCollectedCents: 20_000 });
    // …and what an order earns is the fully known order's (the other is not known at all), not halved by it.
    expect(ch.areas[0]!.contributionPerOrderCents).toBe(earns);
    const d = ch.profit!.channels.find((c) => c.channel === 'delivery')!;
    expect(d.setAsideCents).toBe(10_000 - 20_000);
    expect(d.contributionCents).toBe(earns);
    expect(d.contributionPerOrderCents).toBe(earns);
    // Nothing known at all: no "per order".
    const only = await shop();
    only.sale([['bakedWings', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6' });
    const none = only.r.buildReportTab(only.db, 'channels', only.period);
    expect(none.areas[0]!.contributionPerOrderCents).toBeNull();
    expect(none.profit!.channels[0]).toMatchObject({ contributionCents: 0, contributionPerOrderCents: null });
  });
});

live('the stock-loss step (costing spec 4.7)', () => {
  it('only between two FULL stock takes: what went unexplained comes off; key-items counts and other periods say why not', async () => {
    const s = await shop();
    const clock = (iso: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(iso));
    };
    const tillCount = (id: string) => Number((s.db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { q: number }).q);
    const count = (scope: 'full' | 'key_items', short = 0) => {
      const c = s.r.startStockCount(s.db, { scope }, MANAGER);
      s.r.saveStockCountLines(
        s.db,
        { countId: c.id, lines: c.lines.map((l) => ({ ingredientId: l.ingredientId, countedQty: tillCount(l.ingredientId) - (l.ingredientId === s.ing.cheese ? short : 0) })) },
        MANAGER,
      );
      return s.r.finishStockCount(s.db, c.id, MANAGER).count;
    };
    clock('2026-09-21T06:00:00.000Z');
    const s0 = count('full');
    clock('2026-09-21T09:00:00.000Z');
    s.sale([['fajitaM', 2]], { when: new Date('2026-09-21T09:00:00.000Z') });
    clock('2026-09-21T12:00:00.000Z');
    // 150 g of cheese went that nothing explains: Rs 180 at Rs 1,200 a kilo.
    const s1 = count('full', 150);
    const between = (a: { finishedAt: string | null; id: string }, b: { finishedAt: string | null; id: string }) => ({
      sinceIso: new Date(Date.parse(a.finishedAt!) + 1).toISOString(),
      untilIso: new Date(Date.parse(b.finishedAt!) + 1).toISOString(),
      stockTakes: { fromCountId: a.id, toCountId: b.id },
      link: OFF,
    });
    const t = s.tab(between(s0, s1));
    expect(t.stockLoss).toMatchObject({ state: 'counted', cents: 18_000, scopes: { from: 'full', to: 'full' } });
    expect(s.step(t, 'stock_loss')).toBe(-18_000);
    expect(t.steps.reduce((a, x) => a + x.cents, 0)).toBe(t.profitCents);

    // A key-items count at either end: no stock-loss step, and why.
    clock('2026-09-22T12:00:00.000Z');
    const k = count('key_items', 100);
    const keyed = s.tab(between(s1, k));
    expect(keyed.stockLoss.state).toBe('not_full');
    expect(keyed.steps.some((x) => x.key === 'stock_loss')).toBe(false);
    // Any other period: a note, no step.
    const plain = s.tab({ sinceIso: '2026-09-21T00:00:00.000Z', untilIso: '2026-09-22T00:00:00.000Z' });
    expect(plain.stockLoss.state).toBe('not_between');
    expect(plain.steps.some((x) => x.key === 'stock_loss')).toBe(false);
    // The two stock takes, but a period that is not the window between them: no step either.
    expect(s.tab({ ...between(s0, s1), sinceIso: '2026-09-21T00:00:00.000Z' }).stockLoss.state).toBe('not_between');
  });
});

live('Menu: cost and profit per item and category (costing spec 4.7)', () => {
  it('on the sales whose cost is fully known, at what customers paid; profit only when asked for', async () => {
    const s = await shop();
    const a = s.sale([['fajitaM', 2]]);
    const b = s.sale([['fajitaM', 1], ['cola', 1]], { discountPct: 10 });
    const menu = s.r.buildReportTab(s.db, 'menu', s.period);
    const fajita = menu.costs!.items[s.item.fajitaM]!;
    // 3 fajitas: 2 at Rs 1,200 and 1 at Rs 1,200 less its share of 10% off Rs 1,350 (Rs 120 of Rs 135).
    const bLine = (s.db.prepare(`SELECT cost_cents AS c FROM order_item_costs WHERE order_id = ? AND part = 'base' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ? AND menu_item_id = ?)`).get(b, b, s.item.fajitaM) as { c: number }).c;
    expect(fajita).toMatchObject({ units: 3, knownUnits: 3, salesCents: 240_000 + 108_000, knownSalesCents: 348_000, costCents: s.keptCost(a) + Number(bLine) });
    expect(fajita.profitCents).toBe(fajita.knownSalesCents - fajita.costCents);
    expect(fajita.profitPerSaleCents).toBe(Math.round(fajita.profitCents! / 3));
    // The cola's bottle has no price: nothing known, no profit shown.
    expect(menu.costs!.items[s.item.cola]).toMatchObject({ units: 1, knownUnits: 0, foodCostBps: null, profitCents: null, coverageBps: 0 });
    // Delivery charges are not food: no cost line.
    expect(menu.costs!.categories[s.cat.pizza]).toMatchObject({ units: 3, knownUnits: 3 });
    expect(menu.costs!.categories[s.cat.fees]).toBeUndefined();
    // A login without profit: the same costs, no profit; without costs: nothing.
    const lean = s.r.buildReportTab(s.db, 'menu', { ...s.period, withProfit: false } as never);
    expect(lean.costs!.items[s.item.fajitaM]).toMatchObject({ costCents: fajita.costCents, profitCents: null, profitPerSaleCents: null });
    expect(s.r.buildReportTab(s.db, 'menu', { ...s.period, withCosts: false } as never).costs).toBeNull();
  });
});

live('delivery areas (costing spec 4.11)', () => {
  it('the zone recognised however it was typed; charges collected; customers who came back', async () => {
    const s = await shop();
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'phase 6', phone: '0300-1234567' });
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6', phone: '+923001234567' });
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'Rahat Commercial, DHA Phase 6', phone: '0321-7654321' });
    const ch = s.r.buildReportTab(s.db, 'channels', s.period);
    expect(ch.areas).toHaveLength(1);
    expect(ch.areas[0]).toMatchObject({
      key: 'zone:dha-6',
      area: 'DHA Phase 6',
      zoneId: 'dha-6',
      orderCount: 3,
      netSalesCents: 3 * 130_000,
      avgOrderCents: 130_000,
      feesCollectedCents: 30_000,
      customers: 2,
      repeatCustomers: 1,
      repeatRateBps: 5_000,
      riderCents: 3 * 20_000,
    });
    // A login without profit: no rider cost, no profit per order.
    const plain = s.r.reportTabForLogin('channels', { ...ch, engine: 'worker' }, true, false);
    expect(plain.areas[0]).toMatchObject({ riderCents: null, contributionPerOrderCents: null, feesCollectedCents: 30_000 });
    expect(plain.profit).toBeNull();
  });

  it('came back: 2 or more orders of ANY kind in the 90 days — a takeaway, or a delivery to another area, counts', async () => {
    const s = await shop();
    const setOrder = (id: string, o: { phone: string; createdAt?: Date }) =>
      s.db.prepare(`UPDATE orders SET customer_phone_snapshot = ?, created_at = COALESCE(?, created_at) WHERE id = ?`).run(o.phone, o.createdAt?.toISOString() ?? null, id);
    // A regular: a takeaway 20 days ago (outside the period, inside the 90 days), a delivery to DHA Phase 6 now.
    setOrder(s.sale([['fajitaM', 1]]), { phone: '0300-1111111', createdAt: new Date(s.at.getTime() - 20 * 86_400_000) });
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6', phone: '0300-1111111' });
    // Another: one delivery to DHA Phase 6 and one to Gulshan Block 5, both now.
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'phase 6', phone: '0321-2222222' });
    s.sale([['fajitaM', 1]], { mode: 'delivery', area: 'Gulshan Block 5', phone: '0321-2222222' });
    // A first-timer.
    s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6', phone: '0333-3333333' });
    // Over 90 days ago does not count.
    setOrder(s.sale([['fajitaM', 1]]), { phone: '0333-3333333', createdAt: new Date(s.at.getTime() - 100 * 86_400_000) });
    const ch = s.r.buildReportTab(s.db, 'channels', s.period);
    const area = (key: string) => ch.areas.find((a) => a.key === key)!;
    expect(area('zone:dha-6')).toMatchObject({ orderCount: 3, customers: 3, repeatCustomers: 2, repeatRateBps: 6_667 });
    expect(area('text:gulshan block 5')).toMatchObject({ orderCount: 1, customers: 1, repeatCustomers: 1 });
  });
});

live('estimates kept between asks (the Reports worker)', () => {
  it('reused while nothing changes; worked out again for an order with a new stock row; all dropped when a price changes', async () => {
    const s = await shop();
    // An order from before costing started: no cost kept, its stock rows with no value.
    const old = s.sale([['fajitaM', 1]]);
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(old);
    s.db.prepare(`UPDATE stock_movements SET value_cents = NULL, unit_cost_mc = NULL, cost_basis = NULL WHERE ref_order_id = ?`).run(old);
    const estimate = () => s.r.estimateOrders(s.db, [old], s.r.lazyPricing(s.db)).get(old)!;
    const first = estimate();
    expect(first.tookStock).toBe(true);
    // Without keeping them, every ask reads the ledger again (the till's own connection).
    s.db.prepare(`UPDATE stock_movements SET delta_qty = delta_qty * 2 WHERE ref_order_id = ?`).run(old);
    expect(estimate().costCents).toBeGreaterThan(first.costCents);
    const doubled = estimate().costCents;

    s.r.keepEstimates(s.db);
    expect(estimate().costCents).toBe(doubled);
    expect(s.r.keptEstimateCount(s.db)).toBe(1);
    // A change the ledger never makes (a row rewritten in place) is not seen: the kept estimate is used.
    s.db.prepare(`UPDATE stock_movements SET delta_qty = delta_qty * 3 WHERE ref_order_id = ?`).run(old);
    expect(estimate().costCents).toBe(doubled);
    // The Profit tab uses the same kept estimate.
    expect(s.tab().estimatedOrders).toBe(1);

    // A new stock row for the order (a take, put back, …): worked out again from all of its rows.
    const cols = (s.db.prepare(`PRAGMA table_info(stock_movements)`).all() as Array<{ name: string }>).map((c) => c.name);
    s.db.exec(
      `INSERT INTO stock_movements (${cols.join(', ')})
       SELECT ${cols.map((c) => (c === 'id' ? `id || '~again'` : c === 'delta_qty' ? '1' : c)).join(', ')}
         FROM stock_movements WHERE ref_order_id = '${old}' AND ingredient_id = '${s.ing.box}'`,
    );
    const again = estimate().costCents;
    expect(again).not.toBe(doubled);

    // A price change (a history row, the ingredient's price) drops every kept estimate.
    s.db.prepare(`UPDATE stock_movements SET delta_qty = delta_qty * 5 WHERE ref_order_id = ? AND ingredient_id <> ?`).run(old, s.ing.box);
    expect(estimate().costCents).toBe(again);
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.olive, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    expect(estimate().costCents).toBeGreaterThan(again);
  });

  it('between asks the worker works the last year’s estimates out a step at a time, so the first long report finds them kept', async () => {
    const s = await shop();
    const old = [s.sale([['fajitaM', 1]]), s.sale([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]])];
    s.sale([['fajitaM', 2]]); // kept its cost: nothing to estimate
    for (const id of old) s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(id);
    expect(s.r.ordersWithoutCost(s.db, s.period).sort()).toEqual([...old].sort());
    const before = s.tab();
    s.r.keepEstimates(s.db);
    const { estimateWarmSteps } = await import('./worker.js');
    let steps = 0;
    for (const _ of estimateWarmSteps(s.db, s.at)) steps += 1;
    expect(steps).toBeGreaterThan(12); // a read per month, then its slices
    expect(s.r.keptEstimateCount(s.db)).toBe(2);
    // The same figures, from the kept estimates.
    expect(s.tab()).toEqual(before);
  });
});

live('the menu map (costing spec 4.8)', () => {
  it('not enough sales yet, then each dish placed in plain words; dishes not sold and ones that can’t be placed listed apart', async () => {
    const s = await shop();
    const tax = (s.db.prepare(`SELECT id FROM tax_categories LIMIT 1`).get() as { id: string }).id;
    const addPizza = (name: string, price: number, cheese: number) => {
      const id = s.r.createMenuItem(s.db, { categoryId: s.cat.pizza, name, basePriceCents: price, taxCategoryId: tax }, MANAGER).id;
      s.r.setRecipeForItem(s.db, id, [{ ingredientId: s.ing.dough, qtyPerUnit: 200, modifierId: null }, { ingredientId: s.ing.cheese, qtyPerUnit: cheese, modifierId: null }], MANAGER);
      return id;
    };
    const marg = addPizza('Test Margherita', 100_000, 80);
    const plainCheese = addPizza('Test Plain Cheese', 90_000, 100);
    // A lot of fajitas, a few of the others (quantity 30 a line).
    const sell = (item: string, lines: number) => {
      for (let i = 0; i < lines; i++) {
        const o = s.r.createOrder(s.db, { mode: 'takeaway' }, CASHIER);
        s.r.addOrderItem(s.db, { orderId: o.id, menuItemId: item, quantity: 30, modifierIds: [], notes: null }, CASHIER);
        s.r.sendOrderToKitchen(s.db, o.id, CASHIER);
        s.markPaid(o.id, s.at);
      }
    };
    sell(s.item.fajitaM, 3);
    sell(marg, 1);
    sell(plainCheese, 1);
    const pizza = () => s.r.buildMenuMap(s.db, s.period, s.at).categories.find((c) => c.categoryId === s.cat.pizza)!;
    expect(pizza()).toMatchObject({ state: 'few_sales', units: 150, items: [] });

    sell(s.item.fajitaM, 1);
    sell(marg, 1);
    sell(plainCheese, 0);
    const map = pizza();
    expect(map.state).toBe('ok');
    expect(map.units).toBe(210);
    // Three dishes placed, four in the category (Veggie Lovers did not sell): the popular line is 70% of a quarter.
    expect(map.popularLineBps).toBe(1_750);
    expect(map.items.find((d) => d.menuItemId === plainCheese)!.mixBps).toBe(1_429); // 30 of 210
    const cls = Object.fromEntries(map.items.map((d) => [d.name, d.class]));
    expect(cls['Fajita Pizza — Medium']).toMatch(/star|plowhorse/);
    expect(map.items.find((d) => d.menuItemId === plainCheese)!.popular).toBe(false);
    // Veggie Lovers is on the menu and did not sell.
    expect(map.notSold.map((d) => d.menuItemId)).toContain(s.item.veggieL);
    // What one sale earns is its price less what it kept as its cost.
    const m = map.items.find((d) => d.menuItemId === marg)!;
    expect(m.profitPerSaleCents).toBe(m.priceCents - m.costCents);
    // The last 28 days by default.
    const def = s.r.buildMenuMap(s.db, undefined, s.at);
    expect(def.lastDays).toBe(true);
    expect(Date.parse(def.untilIso) - Date.parse(def.sinceIso)).toBe(28 * 86_400_000);
  });
});

live('test orders the owner deleted (0043): in no profit figure; their food is Waste, on its own line', () => {
  it('sales, food cost, sent-not-paid, channels, categories, Menu, the menu map, delivery areas and What-if leave them out — the Reports worker too', async () => {
    const s = await shop();
    s.sale([['fajitaM', 2]]);
    // Tests rung the way real orders are: a delivery to a zone, a foodpanda
    // order, a takeaway, and a delivery handed over and never paid.
    const tests = [
      s.sale([['fajitaM', 1], ['delivery', 1]], { mode: 'delivery', area: 'DHA Phase 6', phone: '03000000001' }),
      s.sale([['fajitaM', 1]], { mode: 'foodpanda' }),
      s.sale([['fajitaM', 3]]),
    ];
    const handedOver = s.ring([['fajitaM', 1]]);
    s.r.sendOrderToKitchen(s.db, handedOver, CASHIER);
    s.db.prepare(`UPDATE orders SET status = 'delivered', mode = 'delivery', created_at = ? WHERE id = ?`).run(s.at.toISOString(), handedOver);
    // They counted before the delete (so the checks below mean something).
    const before = s.tab();
    expect(before.channels.reduce((a, c) => a + c.orderCount, 0)).toBe(4);
    expect(before.sentNotPaid.costCents).toBeGreaterThan(0);

    for (const o of [...tests, handedOver]) {
      const status = s.r.findOrder(s.db, o)!.status;
      expect(
        s.r.deleteTestOrder(s.db, { orderId: o, reason: 'Printer test', restock: false, expectStatus: status, ownerUserId: OWNER.userId }, OWNER),
      ).toMatchObject({ deleteStock: 'waste' });
    }

    // The same shop with only the real sale rung: every figure but waste is its.
    const only = await shop();
    only.sale([['fajitaM', 2]]);
    const t = s.tab();
    const o = only.tab();
    const noIds = (cs: typeof t.categories) => cs.map(({ categoryId: _id, ...rest }) => rest);
    for (const key of ['sales', 'food_cost', 'unknown_cost', 'sent_not_paid', 'commission', 'payment_fees', 'rider']) {
      expect({ key, cents: s.step(t, key) }).toEqual({ key, cents: only.step(o, key) });
    }
    expect(t.channels).toEqual(o.channels);
    expect(noIds(t.categories)).toEqual(noIds(o.categories));
    expect(t.sentNotPaid).toEqual({ ...o.sentNotPaid });

    // Their food: Waste, on its own line — the same lines Food cost & stock shows.
    expect(t.wasteByReason.map((w) => [w.reason, w.times])).toEqual([['test_order', 4]]);
    const wasted = t.wasteByReason[0]!.cents;
    expect(wasted).toBeGreaterThan(0);
    expect(s.step(t, 'waste')).toBe(-wasted);
    expect(t.profitCents).toBe(o.profitCents - wasted);
    expect(t.wasteByReason).toEqual(s.r.getFoodCost(s.db, s.period).wasteByReason);

    // Menu (cost and profit per item), the menu map, delivery areas and What-if.
    expect(s.r.buildReportTab(s.db, 'menu', s.period).costs!.items[s.item.fajitaM]).toMatchObject({ units: 2, salesCents: 240_000 });
    expect(s.r.buildMenuMap(s.db, s.period, s.at).categories.find((c) => c.categoryId === s.cat.pizza)).toMatchObject({ units: 2 });
    const ch = s.r.buildReportTab(s.db, 'channels', s.period);
    expect(ch.areas).toEqual([]);
    expect(ch.noRateDeliveries).toEqual([]);
    expect(ch.profit!.channels.map((c) => [c.channel, c.orderCount])).toEqual(o.channels.map((c) => [c.channel, c.orderCount]));
    const { getWhatIf } = await import('../costing-service.js');
    const whatIf = getWhatIf(s.db, { ingredients: [], items: [] }, s.at);
    expect(whatIf.rows.find((r) => r.menuItemId === s.item.fajitaM)).toMatchObject({ soldLast28: 2 });

    // The Reports worker (its own bundle, the same code) hands over the same figures.
    const worker = await import('./worker.js');
    const viaWorker = (kind: string, request: unknown) => {
      const reply = worker.handleRunRequest(s.db, { type: 'run', id: 1, kind: kind as never, request, nowIso: s.at.toISOString() });
      if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
      return structuredClone(reply.data);
    };
    expect(viaWorker('profit', s.period)).toEqual(structuredClone(t));
    expect((viaWorker('menuMap', s.period) as { categories: Array<{ categoryId: string; units: number }> }).categories.find((c) => c.categoryId === s.cat.pizza)).toMatchObject({ units: 2 });
    expect((viaWorker('whatIf', { ingredients: [], items: [] }) as typeof whatIf).rows.find((r) => r.menuItemId === s.item.fajitaM)).toMatchObject({ soldLast28: 2 });
    expect((viaWorker('channels', s.period) as typeof ch).areas).toEqual([]);
  });
});
