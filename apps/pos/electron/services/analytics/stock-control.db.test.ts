/**
 * "Used vs should have used" between two stock takes, and the real food
 * cost between two full ones (costing spec 4.6, Phase 8), against a real
 * database built from every migration and a made-up shop:
 *   - V = A − T − W for a raw ingredient, a batch, a sub-batch and a
 *     bought-in one, from the ledger as the till writes it (sales, batches,
 *     a purchase, waste, a typed fix listed beside V, not in it);
 *   - the critic's cases: send, stock take, cancel NOT made, stock take — and
 *     the same with the food made — leave nothing unexplained in either
 *     window; the "already in the stock take" count rows are left out and
 *     listed;
 *   - a Convert (kg → g) between the two stock takes is scaled;
 *   - a batch whose stock rose with no batch logged is shown with what it is
 *     made from, and warned about;
 *   - the real food cost only between two FULL stock takes, limited to what
 *     recipes and batches use (other purchases listed apart), labelled;
 *   - two tills taking orders with the link off: switched off, in a
 *     sentence; the stale-link note never shows with the link off;
 *   - "Do this" gets the variance when it is over 3% of food sales.
 *
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE AND QUANTITY IS MADE UP (costing spec D11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { varianceWeekCents } from '@cheeseoclock/pos-domain';
import type { ReportVariance, TillLinkState } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, safeStorage: { isEncryptionAvailable: () => false } }));

const live = describe.skipIf(!DatabaseSync);
const OFF: TillLinkState = { on: false, stale: false, lastHeardAt: null };

afterEach(() => {
  vi.useRealTimers();
});

async function repos() {
  return {
    ...(await import('../../db/repositories/stock-count-repo.js')),
    ...(await import('../../db/repositories/order-stock-repo.js')),
    ...(await import('../../db/repositories/procurement-repo.js')),
    ...(await import('../../db/repositories/batch-recipe-repo.js')),
    ...(await import('../../db/repositories/ingredient-repo.js')),
    ...(await import('../../db/repositories/business-settings-repo.js')),
    ...(await import('../../db/repositories/settings-repo.js')),
    ...(await import('../costing-settings.js')),
    ...(await import('./stock-control.js')),
    ...(await import('./owner-week.js')),
    ...(await import('../till-link.js')),
  };
}

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = { ...s.r, ...(await repos()) };
  const clock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  /** Sent to the kitchen now (stock taken, cost kept), and paid (a counted sale). */
  const sell = (lines: Parameters<typeof s.ring>[0]) => {
    const o = s.ring(lines);
    r.sendOrderToKitchen(db, o, CASHIER);
    s.markPaid(o, new Date());
    return o;
  };
  const send = (lines: Parameters<typeof s.ring>[0]) => {
    const o = s.ring(lines);
    r.sendOrderToKitchen(db, o, CASHIER);
    return o;
  };
  /** A stock take counted as given (a quantity, or "what the till says" ± something), finished now. */
  const stockTake = (counts: Array<[string, number]>, scope: 'custom' | 'full' | 'key_items' = 'custom') => {
    const c =
      scope === 'custom'
        ? r.startStockCount(db, { scope: 'custom', ingredientIds: counts.map(([id]) => id) }, MANAGER)
        : r.startStockCount(db, { scope }, MANAGER);
    const given = new Map(counts);
    r.saveStockCountLines(
      db,
      { countId: c.id, lines: c.lines.map((l) => ({ ingredientId: l.ingredientId, countedQty: given.get(l.ingredientId) ?? tillCount(l.ingredientId) })) },
      MANAGER,
    );
    return r.finishStockCount(db, c.id, MANAGER).count;
  };
  const tillCount = (id: string) => Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(id) as { q: number }).q);
  const variance = (from: string, to: string, link: TillLinkState = OFF): ReportVariance => r.buildVariance(db, { fromCountId: from, toCountId: to, link });
  return { ...s, db, r, clock, sell, send, stockTake, tillCount, variance };
}

const lineOf = (v: ReportVariance, id: string) => v.lines.find((l) => l.ingredientId === id)!;
const identity = (v: ReportVariance) => v.lines.every((l) => l.unexplained === l.used - l.shouldHaveUsed - l.wasted && l.used === l.opening + l.delivered + l.madeHere - l.closing && l.shouldHaveUsed === l.sold + l.usedInBatches);

live('used vs should have used (costing spec 4.6)', () => {
  it('V = A − T − W for raw, batch, sub-batch and bought-in ingredients; a typed fix is listed beside it', async () => {
    const s = await shop();
    // A topping mix made here from the sauce (itself made here) and cheese: a batch of a batch.
    const mix = s.r.createIngredient(s.db, { name: 'Test topping mix', unit: 'g', currentQty: 0 }, MANAGER).id;
    s.r.setBatchRecipe(s.db, { ingredientId: mix, batchYield: 1_000, lines: [{ inputIngredientId: s.ing.sauce, qty: 800 }, { inputIngredientId: s.ing.cheese, qty: 300 }] }, MANAGER);
    // Something no recipe or batch uses (not food).
    const soap = s.r.createIngredient(s.db, { name: 'Test dish soap', unit: 'ml', currentQty: 5_000, packSize: 1_000, packPriceCents: 30_000 }, MANAGER).id;

    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake([], 'full');
    s.clock('2026-09-21T07:00:00.000Z');
    s.r.makeBatch(s.db, { ingredientId: s.ing.sauce, batches: 1 }, MANAGER);
    s.clock('2026-09-21T07:30:00.000Z');
    s.r.makeBatch(s.db, { ingredientId: mix, amount: 1_000 }, MANAGER);
    s.clock('2026-09-21T08:00:00.000Z');
    s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.cheese, qty: 2_000, billCents: 240_000, usePrice: false }] }, MANAGER);
    s.r.recordPurchase(s.db, { lines: [{ ingredientId: soap, qty: 1_000, billCents: 30_000, usePrice: false }] }, MANAGER);
    s.clock('2026-09-21T09:00:00.000Z');
    s.sell([['fajitaM', 2]]); // 2 × (dough 200, sauce 50, cheese 60, chicken 40, onion 10, box 1)
    s.clock('2026-09-21T10:00:00.000Z');
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.onion, deltaQty: -100, reason: 'waste', wasteReason: 'burnt' }, MANAGER);
    s.clock('2026-09-21T10:30:00.000Z');
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.chicken, deltaQty: 50, reason: 'adjustment', notes: 'Found a bag' }, MANAGER);
    s.clock('2026-09-21T12:00:00.000Z');
    // The shelves: 150 g of cheese went that nothing explains; everything else as the till says.
    const s1 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese) - 150]], 'full');

    const v = s.variance(s0.id, s1.id);
    expect(v.state).toBe('ok');
    expect(identity(v)).toBe(true);
    expect(lineOf(v, s.ing.tomato)).toMatchObject({ usedInBatches: 2_500, used: 2_500, shouldHaveUsed: 2_500, unexplained: 0 });
    expect(lineOf(v, s.ing.sauce)).toMatchObject({ madeHere: 2_000, usedInBatches: 800, sold: 100, unexplained: 0 });
    expect(lineOf(v, mix)).toMatchObject({ madeHere: 1_000, sold: 0, unexplained: 0, madeInHouse: true });
    expect(lineOf(v, s.ing.cheese)).toMatchObject({ delivered: 2_000, usedInBatches: 300, sold: 120, unexplained: 150, unexplainedCents: 18_000, priced: true });
    expect(lineOf(v, s.ing.onion)).toMatchObject({ sold: 20, wasted: 100, unexplained: 0 });
    // The fix is on the till's count, so on the shelf: more there than sales explain (−50 g), and the fix listed beside it.
    expect(lineOf(v, s.ing.chicken)).toMatchObject({ sold: 80, unexplained: -50, corrections: 50, unexplainedCents: -4_500 });
    expect(v.corrections).toEqual([expect.objectContaining({ ingredientId: s.ing.chicken, qty: 50, kind: 'fix', notes: 'Found a bag' })]);
    expect(v.totalCents).toBe(18_000 - 4_500);
    expect(v.foodSalesCents).toBe(240_000);
    expect(v.varianceBps).toBe(563);
    expect(v.band).toBe('look_now');
    // Most rupees first.
    expect(v.lines[0]!.ingredientId).toBe(s.ing.cheese);
    // Batches with what they are made from, all logged: no warning.
    expect(v.pairs.map((p) => [p.batchName, p.noBatchLogged])).toEqual([
      ['Test sauce', false],
      ['Test topping mix', false],
    ]);
    expect(v.pairs.every((p) => p.warning === null)).toBe(true);

    // The real food cost (both full): recipe and batch ingredients only; the soap is listed apart.
    const a = v.actualCogs!;
    expect(a).not.toBeNull();
    expect(a.costCents).toBe(a.openingCents + a.purchasesCents - a.closingCents);
    expect(a.purchasesCents).toBe(240_000);
    expect(a.otherPurchases).toEqual([{ ingredientId: soap, name: 'Test dish soap', spendCents: 30_000 }]);
    const held = (countId: string) =>
      Number(
        (
          s.db
            .prepare(`SELECT COALESCE(SUM(value_cents), 0) AS n FROM stock_count_lines WHERE stock_count_id = ? AND ingredient_id <> ?`)
            .get(countId, soap) as { n: number }
        ).n,
      );
    expect(a.openingCents).toBe(held(s0.id));
    expect(a.closingCents).toBe(held(s1.id));
    expect(a.foodSalesCents).toBe(240_000);
    expect(a.actualBps).not.toBeNull();
    expect(v.actualCogsWhyNot).toBeNull();
  });

  it("the critic's cases: a cancel after a stock take leaves nothing unexplained in either window", async () => {
    const s = await shop();
    const ids = [s.ing.cheese, s.ing.onion];
    const counted = (at: Record<string, number>) => ids.map((id) => [id, at[id] ?? s.tillCount(id)] as [string, number]);
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake(counted({}));
    // Sent at 07:00; the food is never made.
    s.clock('2026-09-21T07:00:00.000Z');
    const o1 = s.send([['fajitaM', 1]]);
    // The 08:00 stock take finds it all still on the shelf.
    s.clock('2026-09-21T08:00:00.000Z');
    const s1 = s.stockTake(counted({ [s.ing.cheese]: 100_000, [s.ing.onion]: 100_000 }));
    // Cancelled at 09:00, "not made": the stock take had already counted it.
    s.clock('2026-09-21T09:00:00.000Z');
    s.r.settleOrderStock(s.db, { orderId: o1, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'not_made', approverUserId: MANAGER.userId }, MANAGER);
    s.clock('2026-09-21T10:00:00.000Z');
    const s2 = s.stockTake(counted({}));
    const a = s.variance(s0.id, s1.id);
    const b = s.variance(s1.id, s2.id);
    for (const v of [a, b]) {
      expect(identity(v)).toBe(true);
      expect(v.lines.map((l) => [l.name, l.unexplained])).toEqual([
        ['Test cheese', 0],
        ['Test onion', 0],
      ]);
      expect(v.totalCents).toBe(0);
    }
    // The "already in the stock take" rows: left out, listed in the window of the order's take.
    expect(a.alreadyCounted.map((x) => [x.name, x.qty, x.orderId]).sort()).toEqual([
      ['Test cheese', -60, o1],
      ['Test onion', -10, o1],
    ]);
    expect(b.alreadyCounted).toEqual([]);

    // The same with the food MADE: its waste lands with the order's take.
    s.clock('2026-09-21T11:00:00.000Z');
    const o2 = s.send([['fajitaM', 1]]);
    s.clock('2026-09-21T12:00:00.000Z');
    const s3 = s.stockTake(counted({})); // the shelf after cooking: the till's count
    s.clock('2026-09-21T13:00:00.000Z');
    s.r.settleOrderStock(s.db, { orderId: o2, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'made', approverUserId: MANAGER.userId }, MANAGER);
    s.clock('2026-09-21T14:00:00.000Z');
    const s4 = s.stockTake(counted({}));
    const c = s.variance(s2.id, s3.id);
    const d = s.variance(s3.id, s4.id);
    expect(lineOf(c, s.ing.cheese)).toMatchObject({ used: 60, sold: 0, wasted: 60, unexplained: 0 });
    expect(lineOf(d, s.ing.cheese)).toMatchObject({ used: 0, sold: 0, wasted: 0, unexplained: 0 });
    expect([c.totalCents, d.totalCents]).toEqual([0, 0]);
  });

  it('the sums worked out in SQL agree with pos-domain dating every row itself (rows from before costing, a late cancel)', async () => {
    const s = await shop();
    const { ledgerRowsOf, firstTakesOf } = await import('../../db/stock-ledger-read.js');
    const { addToSums, emptySums, ledgerDate, ledgerKind, unitFactor } = await import('@cheeseoclock/pos-domain');
    const ids = [s.ing.cheese, s.ing.onion, s.ing.chicken, s.ing.dough];
    const till = () => ids.map((id) => [id, s.tillCount(id)] as [string, number]);
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake(till());
    s.clock('2026-09-21T07:00:00.000Z');
    const o1 = s.send([['fajitaM', 1]]);
    s.clock('2026-09-21T07:30:00.000Z');
    const o2 = s.send([['fajitaM', 2]]);
    s.clock('2026-09-21T08:00:00.000Z');
    s.r.settleOrderStock(s.db, { orderId: o1, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'made', approverUserId: MANAGER.userId }, MANAGER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.dough, deltaQty: 75, reason: 'adjustment', notes: 'Recounted a tray' }, MANAGER);
    s.clock('2026-09-21T09:00:00.000Z');
    // o2 is never made: its food is still on the shelf when it is counted. 100 g of cheese is not.
    const o2Took = new Map(
      (s.db.prepare(`SELECT ingredient_id AS id, -SUM(delta_qty) AS q FROM stock_movements WHERE ref_order_id = ? AND reason = 'sale' GROUP BY ingredient_id`).all(o2) as Array<{
        id: string;
        q: number;
      }>).map((r) => [r.id, Number(r.q)]),
    );
    const s1 = s.stockTake(ids.map((id) => [id, s.tillCount(id) + (o2Took.get(id) ?? 0) - (id === s.ing.cheese ? 100 : 0)]));
    // Cancelled after the stock take, "not made": its rows are written after t1 and date back into the window.
    s.clock('2026-09-21T10:00:00.000Z');
    s.r.settleOrderStock(s.db, { orderId: o2, how: 'cancelled', statusBefore: 'sent_to_kitchen', foodMade: 'not_made', approverUserId: MANAGER.userId }, MANAGER);
    // o1's settle rows as a till from before costing wrote them: no ref_taken_at (dated by the order's first take).
    s.db.prepare(`UPDATE stock_movements SET ref_taken_at = NULL WHERE ref_order_id = ? AND NOT (reason = 'sale' AND delta_qty < 0)`).run(o1);

    const v = s.variance(s0.id, s1.id);
    const t0 = s0.finishedAt!;
    const t1 = s1.finishedAt!;
    for (const id of ids) {
      const rows = ledgerRowsOf(s.db, id, '');
      const firstTake = firstTakesOf(s.db, rows);
      const sums = emptySums();
      for (const r of rows) {
        const d = ledgerDate(r, firstTake);
        if (d > t0 && d <= t1) addToSums(sums, ledgerKind(r), r.deltaQty * (unitFactor(r.unit, 'g') ?? 1));
      }
      const l = lineOf(v, id);
      expect({ id, delivered: l.delivered, madeHere: l.madeHere, usedInBatches: l.usedInBatches, sold: l.sold, wasted: l.wasted, corrections: l.corrections }).toEqual({
        id,
        delivered: sums.delivered,
        madeHere: sums.madeHere,
        usedInBatches: sums.usedInBatches,
        sold: sums.sold,
        wasted: sums.wasted,
        corrections: sums.fixes + sums.oldCounts,
      });
    }
    // Nothing unexplained but the 100 g of cheese and the fix the till's count already holds.
    expect(v.lines.filter((l) => l.unexplained !== 0).map((l) => [l.name, l.unexplained]).sort()).toEqual([
      ['Test cheese', 100],
      ['Test dough', -75],
    ]);
    // o2's "already in the stock take" rows: left out of the figures, listed.
    expect(v.alreadyCounted.map((a) => a.name).sort()).toEqual(['Test cheese', 'Test chicken', 'Test dough', 'Test onion']);
    expect(new Set(v.alreadyCounted.map((a) => a.orderId))).toEqual(new Set([o2]));

    // The one-by-one read is bounded by the window however old it is (the main process runs it without the worker):
    // a fix and a count written later are not read; only rows settling an order taken in the window are.
    const { ledgerRowsToDate } = await import('../../db/stock-ledger-read.js');
    s.clock('2026-09-21T11:00:00.000Z');
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.dough, deltaQty: 5, reason: 'adjustment', notes: 'A later fix' }, MANAGER);
    s.stockTake([[s.ing.onion, s.tillCount(s.ing.onion)]]);
    const read = ledgerRowsToDate(s.db, t0, t1);
    expect(read.some((r) => r.notes === 'A later fix' || r.occurredAt === '2026-09-21T11:00:00.000Z')).toBe(false);
    expect(read.every((r) => r.occurredAt <= t1 || (r.refTakenAt !== null && r.refTakenAt > t0 && r.refTakenAt <= t1))).toBe(true);
    // …and still every "already in the stock take" count row of o2 (written at 10:00, after t1), dated back into it.
    expect(read.filter((r) => r.reason === 'count' && r.refOrderId === o2 && r.occurredAt > t1)).toHaveLength(4);
    expect(s.variance(s0.id, s1.id)).toEqual(v);
  });

  it('its food sales are the Reports figures (discounts, a delivery charge, an estimated order), worked out in one pass', async () => {
    const s = await shop();
    const { getFoodCost, getFoodSales } = await import('../business-report.js');
    s.clock('2026-09-21T09:00:00.000Z');
    s.sell([['fajitaM', 2], ['delivery', 1]]);
    s.sell([['deal', 1, ['d1Fajita', 'd2Veggie', 'sideRanch']]]);
    const discounted = s.ring([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']], ['cola', 2]]);
    s.r.applyDiscount(s.db, { orderId: discounted, discountType: 'percent', value: 10, reason: 'Regular' }, CASHIER);
    s.r.sendOrderToKitchen(s.db, discounted, CASHIER);
    s.markPaid(discounted, new Date());
    // An order that kept no cost (sent before costing): estimated from the stock it took.
    const old = s.sell([['crispyWings', 1]]);
    s.db.prepare(`DELETE FROM order_item_costs WHERE order_id = ?`).run(old);
    const range = { sinceIso: '2026-09-21T00:00:00.000Z', untilIso: '2026-09-22T00:00:00.000Z' };
    const full = getFoodCost(s.db, range);
    expect(full.estimatedOrders).toBe(1);
    expect(full.feeSalesCents).toBe(10_000);
    expect(getFoodSales(s.db, range)).toEqual({ foodSalesCents: full.foodSalesCents, costOfSalesCents: full.costOfSalesCents });
  });

  it('a Convert (kg → g) between the two stock takes is scaled', async () => {
    const s = await shop();
    const flour = s.r.createIngredient(s.db, { name: 'Test flour sack', unit: 'kg', currentQty: 50, packSize: 1, packPriceCents: 10_000 }, MANAGER).id;
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake([[flour, 50]]);
    s.clock('2026-09-21T07:00:00.000Z');
    s.r.recordPurchase(s.db, { lines: [{ ingredientId: flour, qty: 10, billCents: 100_000, usePrice: false }] }, MANAGER);
    s.clock('2026-09-21T08:00:00.000Z');
    s.r.convertIngredientToBaseUnit(s.db, flour, MANAGER);
    s.clock('2026-09-21T09:00:00.000Z');
    s.r.recordStockMovement(s.db, { ingredientId: flour, deltaQty: -2_000, reason: 'waste', wasteReason: 'expired' }, MANAGER);
    s.clock('2026-09-21T10:00:00.000Z');
    const s1 = s.stockTake([[flour, 57_500]]);
    const l = lineOf(s.variance(s0.id, s1.id), flour);
    expect(l).toMatchObject({ unit: 'g', opening: 50_000, delivered: 10_000, closing: 57_500, used: 2_500, wasted: 2_000, unexplained: 500 });
    // Rs 100 / kg: 500 g is Rs 50.
    expect(l.unexplainedCents).toBe(5_000);
  });

  it('a batch whose stock rose with no batch logged is warned about, beside what it is made from', async () => {
    const s = await shop();
    const ids = [s.ing.tomato, s.ing.garlic, s.ing.sauce];
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake(ids.map((id) => [id, s.tillCount(id)]));
    // A batch of sauce made at 09:00 and never logged: the shelves show it, the till doesn't.
    s.clock('2026-09-21T12:00:00.000Z');
    const s1 = s.stockTake([
      [s.ing.tomato, s.tillCount(s.ing.tomato) - 2_500],
      [s.ing.garlic, s.tillCount(s.ing.garlic) - 125],
      [s.ing.sauce, s.tillCount(s.ing.sauce) + 2_000],
    ]);
    const v = s.variance(s0.id, s1.id);
    expect(lineOf(v, s.ing.tomato).unexplained).toBe(2_500);
    expect(lineOf(v, s.ing.sauce).unexplained).toBe(-2_000);
    expect(v.pairs).toEqual([
      expect.objectContaining({
        batchName: 'Test sauce',
        noBatchLogged: true,
        warning: 'Test sauce went up but no batch was logged: the Test tomato and Test garlic difference is probably that batch.',
      }),
    ]);
  });

  it('a batch bought in when it ran short went up by its delivery: no "no batch logged" warning blaming what it is made from', async () => {
    const s = await shop();
    const ids = [s.ing.tomato, s.ing.garlic, s.ing.sauce];
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake(ids.map((id) => [id, s.tillCount(id)]));
    // 2 kg of sauce bought from a supplier; no batch made. The tomato is 300 g short for a reason of its own.
    s.clock('2026-09-21T08:00:00.000Z');
    s.r.recordPurchase(s.db, { lines: [{ ingredientId: s.ing.sauce, qty: 2_000, billCents: 50_000, usePrice: false }] }, MANAGER);
    s.clock('2026-09-21T12:00:00.000Z');
    const s1 = s.stockTake([
      [s.ing.tomato, s.tillCount(s.ing.tomato) - 300],
      [s.ing.garlic, s.tillCount(s.ing.garlic)],
      [s.ing.sauce, s.tillCount(s.ing.sauce)],
    ]);
    const v = s.variance(s0.id, s1.id);
    expect(lineOf(v, s.ing.sauce)).toMatchObject({ delivered: 2_000, madeHere: 0, unexplained: 0 });
    expect(lineOf(v, s.ing.tomato).unexplained).toBe(300);
    expect(v.pairs).toEqual([expect.objectContaining({ batchName: 'Test sauce', noBatchLogged: false, warning: null })]);
  });

  it('the real food cost needs a full stock take at both ends, and says so', async () => {
    const s = await shop();
    s.clock('2026-09-21T06:00:00.000Z');
    const full = s.stockTake([], 'full');
    s.clock('2026-09-21T07:00:00.000Z');
    const part = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]]);
    const v = s.variance(full.id, part.id);
    expect(v.state).toBe('ok');
    expect(v.actualCogs).toBeNull();
    expect(v.actualCogsWhyNot).toBe('The real food cost needs a full stock take at both ends.');
    // Counted only on the later one: listed, not compared.
    expect(v.lines.map((l) => l.ingredientId)).toEqual([s.ing.cheese]);
    expect(v.notOnBoth).toEqual([]);
    // Asked the wrong way round: nothing was finished before the full one, so there is nothing to compare.
    expect(s.variance(part.id, full.id).state).toBe('no_counts');
  });

  it('picks the pair by itself: the latest full or key-items stock take — never the Stock button’s one-liner — and before it a full one or one of the same kind', async () => {
    const s = await shop();
    expect(s.r.buildVariance(s.db, { link: OFF })).toMatchObject({ state: 'no_counts', message: expect.stringMatching(/^No stock take is finished yet/) });
    s.clock('2026-09-14T06:00:00.000Z');
    const full = s.stockTake([], 'full');
    expect(s.r.buildVariance(s.db, { link: OFF })).toMatchObject({ state: 'no_counts', message: expect.stringMatching(/^Only one stock take/) });
    s.clock('2026-09-18T07:00:00.000Z');
    s.stockTake([[s.ing.onion, s.tillCount(s.ing.onion)]]); // a one-off in between
    s.clock('2026-09-21T08:00:00.000Z');
    const key = s.stockTake([], 'key_items');
    const pair = (v: ReportVariance) => [v.from?.id, v.to?.id];
    expect(pair(s.r.buildVariance(s.db, { link: OFF }))).toEqual([full.id, key.id]);
    // Tuesday: the Stock button's one-line count of the cheese, finished last. Still the same pair — for Reports,
    // "Do this" and the weekly sheet alike (it is a fix for one shelf, not the week's count).
    s.clock('2026-09-22T09:00:00.000Z');
    const one = s.r.countOneIngredient(s.db, { ingredientId: s.ing.cheese, countedQty: s.tillCount(s.ing.cheese) - 1_000 }, MANAGER).count;
    expect(pair(s.r.buildVariance(s.db, { link: OFF }))).toEqual([full.id, key.id]);
    expect(s.r.latestVariance(s.db, OFF, new Date('2026-09-22T10:00:00.000Z'))).toMatchObject({ fromCountId: full.id, toCountId: key.id, compared: 3 });
    // Picked, it is compared (with the last full stock take before it).
    expect(pair(s.r.buildVariance(s.db, { toCountId: one.id, link: OFF }))).toEqual([full.id, one.id]);
    // A recount of the key items the same day stands in for the first: the stretch runs from the last key-items count on
    // an earlier day, never from the first count two hours before.
    s.clock('2026-09-22T11:00:00.000Z');
    const recount = s.stockTake([], 'key_items');
    s.clock('2026-09-22T13:00:00.000Z');
    const recount2 = s.stockTake([], 'key_items');
    const v = s.r.buildVariance(s.db, { link: OFF });
    expect(pair(v)).toEqual([key.id, recount2.id]);
    expect(recount.id).not.toBe(v.from?.id);
    expect(v.sinceIso).toBe('2026-09-21T08:00:00.000Z');
    expect(v.untilIso).toBe('2026-09-22T13:00:00.000Z');
  });

  it('nothing counted on both: no share of sales and no rating (never "Good")', async () => {
    const s = await shop();
    s.clock('2026-09-14T06:00:00.000Z');
    const a = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]]);
    s.clock('2026-09-14T09:00:00.000Z');
    s.sell([['fajitaM', 1]]);
    s.clock('2026-09-21T06:00:00.000Z');
    const b = s.stockTake([[s.ing.box, s.tillCount(s.ing.box)]]);
    const v = s.variance(a.id, b.id);
    expect(v).toMatchObject({ state: 'ok', lines: [], totalCents: 0, varianceBps: null, band: null });
    expect(v.foodSalesCents).toBeGreaterThan(0);
    expect(v.notOnBoth.map((n) => n.ingredientId)).toEqual([s.ing.box]);
  });
});

live('two tills, and the link (costing spec D14)', () => {
  async function twoCounts() {
    const s = await shop();
    s.clock('2026-09-21T06:00:00.000Z');
    const s0 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]]);
    s.clock('2026-09-21T07:00:00.000Z');
    s.sell([['fajitaM', 1]]);
    s.clock('2026-09-21T08:00:00.000Z');
    const s1 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese) - 1_000]]);
    return { s, s0, s1 };
  }

  it("two tills taking orders with the link off: switched off, in a sentence (the other till's sales aren't here)", async () => {
    const { s, s0, s1 } = await twoCounts();
    s.r.saveTillsSetting(s.db, { sellingTills: 2 }, OWNER, OFF);
    const off = s.variance(s0.id, s1.id, OFF);
    expect(off).toMatchObject({ state: 'other_till_missing', lines: [], actualCogs: null, sellingTills: 2 });
    expect(off.message).toMatch(/^The other till's sales aren't on this till/);
    // …and nothing for "Do this".
    expect(s.r.latestVariance(s.db, OFF, new Date())).toBeNull();
    // With the link on, both tills' sales are here: worked out.
    const on = s.variance(s0.id, s1.id, { on: true, stale: false, lastHeardAt: new Date().toISOString() });
    expect(on.state).toBe('ok');
    expect(on.staleSync).toBe(false);
    // One till: worked out with the link off too.
    s.r.saveTillsSetting(s.db, { sellingTills: 1 }, OWNER, OFF);
    expect(s.variance(s0.id, s1.id, OFF).state).toBe('ok');
  });

  it('the stale-link note shows only while the link is on and quiet; never with it off', async () => {
    const { s, s0, s1 } = await twoCounts();
    expect(s.variance(s0.id, s1.id, OFF).staleSync).toBe(false);
    // Even told "stale" with the link off, it stays quiet.
    expect(s.variance(s0.id, s1.id, { on: false, stale: true, lastHeardAt: null }).staleSync).toBe(false);
    expect(s.variance(s0.id, s1.id, { on: true, stale: true, lastHeardAt: null }).staleSync).toBe(true);
    // As the till reads it: the switch off, the link failing — not stale.
    s.db.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES ('sync.consecutive_fails', '9', 'x')`).run();
    expect(s.r.readTillLink(s.db)).toEqual({ on: false, stale: false, lastHeardAt: null });
    // Switched on and paused: stale.
    s.r.setSetting(s.db, 'sync.config', { mode: 'mock', paused: true });
    expect(s.r.readTillLink(s.db)).toMatchObject({ on: true, stale: true });
  });
});

live('"Do this": stock variance over 3% (costing spec 4.17)', () => {
  /** A shop whose one key item is the cheese, counted on the key-items stock take a week apart (Mon 14 → Mon 21 Sep). */
  async function weekOfCheese(shortG: number) {
    const s = await shop();
    s.r.setKeyItems(s.db, [s.ing.cheese], MANAGER);
    s.clock('2026-09-14T06:00:00.000Z');
    const s0 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]], 'key_items');
    s.clock('2026-09-14T09:00:00.000Z');
    s.sell([['fajitaM', 2]]);
    s.clock('2026-09-21T06:00:00.000Z');
    const s1 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese) - shortG]], 'key_items');
    return { s, s0, s1 };
  }
  const NOW = new Date('2026-09-21T07:00:00.000Z');
  const varianceLine = (s: Awaited<ReturnType<typeof shop>>, now = NOW) =>
    s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, link: OFF }, now).doThis.find((i) => i.kind === 'stock_variance');

  it('the latest two stock takes, when over 3% of food sales went unexplained: its rupees per week; only with costs', async () => {
    // 250 g of cheese unexplained: Rs 300 of Rs 2,400 food sales (12.5%).
    const { s, s0, s1 } = await weekOfCheese(250);
    expect(varianceLine(s)).toMatchObject({
      kind: 'stock_variance',
      cost: true,
      pinned: false,
      fromCountId: s0.id,
      toCountId: s1.id,
      totalCents: 30_000,
      varianceBps: 1_250,
      topIngredient: 'Test cheese',
      weekCents: varianceWeekCents(30_000, 7 * 86_400_000),
    });
    // The printed weekly sheet carries it too (costing spec §5).
    const sheet = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true, link: OFF }, NOW).sheet!;
    expect(sheet.lastStockTake).toEqual({
      sinceIso: s0.finishedAt,
      untilIso: s1.finishedAt,
      compared: 1,
      totalCents: 30_000,
      varianceBps: 1_250,
      band: 'look_now',
      topIngredient: 'Test cheese',
    });
    // Not for a login without costs: the check does not even run.
    expect(s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: false, link: OFF }, NOW).doThis.some((i) => i.kind === 'stock_variance')).toBe(false);
    // Two tills with the link off: nothing to say.
    s.r.saveTillsSetting(s.db, { sellingTills: 2 }, OWNER, OFF);
    expect(varianceLine(s)).toBeUndefined();
  });

  it("the Stock button's one-line count finished afterwards neither hides the line nor makes a false one", async () => {
    const { s, s0, s1 } = await weekOfCheese(250);
    // Tuesday: the oil (not a key item) counted with the Stock button, and the cheese fixed the same way.
    const TUE = new Date('2026-09-22T09:00:00.000Z');
    s.clock(TUE.toISOString());
    s.r.countOneIngredient(s.db, { ingredientId: s.ing.onion, countedQty: s.tillCount(s.ing.onion) }, MANAGER);
    s.clock('2026-09-22T09:05:00.000Z');
    // A Rs 1,000 correction a day after (on one day of sales it would have passed 3%, blown up ×7 into "Rs 7,000 a week").
    s.r.countOneIngredient(s.db, { ingredientId: s.ing.cheese, countedQty: s.tillCount(s.ing.cheese) - 833 }, MANAGER);
    const later = new Date('2026-09-22T10:00:00.000Z');
    expect(varianceLine(s, later)).toMatchObject({ fromCountId: s0.id, toCountId: s1.id, totalCents: 30_000, weekCents: 30_000 });
    const sheet = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true, link: OFF }, later).sheet!;
    expect(sheet.lastStockTake).toMatchObject({ sinceIso: s0.finishedAt, untilIso: s1.finishedAt, compared: 1, band: 'look_now' });
  });

  it('a stretch shorter than about a week is never blown up into rupees a week: no line (Reports and the sheet show it as it is)', async () => {
    const s = await shop();
    s.r.setKeyItems(s.db, [s.ing.cheese], MANAGER);
    s.clock('2026-09-19T06:00:00.000Z');
    const s0 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]], 'key_items');
    s.clock('2026-09-19T09:00:00.000Z');
    s.sell([['fajitaM', 2]]);
    // Two days later: 250 g unexplained, 12.5% of food sales.
    s.clock('2026-09-21T06:00:00.000Z');
    const s1 = s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese) - 250]], 'key_items');
    expect(varianceLine(s)).toBeUndefined();
    const sheet = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true, link: OFF }, NOW).sheet!;
    expect(sheet.lastStockTake).toMatchObject({ sinceIso: s0.finishedAt, untilIso: s1.finishedAt, compared: 1, totalCents: 30_000, band: 'look_now' });
  });

  it('nothing counted on both: no line, and the sheet says so', async () => {
    const s = await shop();
    s.r.setKeyItems(s.db, [s.ing.cheese], MANAGER);
    s.clock('2026-09-14T06:00:00.000Z');
    s.stockTake([[s.ing.cheese, s.tillCount(s.ing.cheese)]], 'key_items');
    s.clock('2026-09-14T09:00:00.000Z');
    s.sell([['fajitaM', 2]]);
    // The owner changes the key items to the boxes before the next count: nothing on both.
    s.r.setKeyItems(s.db, [s.ing.box], MANAGER);
    s.clock('2026-09-21T06:00:00.000Z');
    s.stockTake([[s.ing.box, s.tillCount(s.ing.box) - 5]], 'key_items');
    expect(varianceLine(s)).toBeUndefined();
    const sheet = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true, link: OFF }, NOW).sheet!;
    expect(sheet.lastStockTake).toMatchObject({ compared: 0, totalCents: 0, varianceBps: null, band: null });
  });

  it('3% or less is not a "Do this" line', async () => {
    // 50 g unexplained: Rs 60 of Rs 2,400 (2.5%).
    const { s } = await weekOfCheese(50);
    expect(varianceLine(s)).toBeUndefined();
  });

  it('the worker works the latest pair out as soon as a stock take is finished: the next ask finds it kept', async () => {
    const { s, s1 } = await weekOfCheese(250);
    s.r.warmLatestVariance(s.db, OFF, NOW);
    // Kept for the day: the next ask is answered from what was worked out (a figure changed behind its back is not
    // read again — made up here only to show that nothing was re-read).
    s.db.prepare(`UPDATE stock_count_lines SET counted_qty = counted_qty - 1000 WHERE stock_count_id = ?`).run(s1.id);
    expect(s.r.latestVariance(s.db, OFF, NOW)).toMatchObject({ toCountId: s1.id, totalCents: 30_000 });
    // A new trading day works it out again.
    expect(s.r.latestVariance(s.db, OFF, new Date('2026-09-22T07:00:00.000Z'))).toMatchObject({ toCountId: s1.id, totalCents: 30_000 + 120_000 });
  });
});
