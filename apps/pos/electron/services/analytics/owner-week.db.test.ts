/**
 * The owner's week (costing spec Phase 7) on a real database built from
 * every migration (the made-up shop, db/costing-shop.fixture.ts):
 *   - the card's numbers: this week so far against last week by now, and
 *     "no data then" before this till's first order;
 *   - "Do this": a key ingredient running low pinned first, then the most
 *     rupees a week (items over target at n̄ × (cost − target × price),
 *     missing costs, price alerts), at most five, and no cost line — nor
 *     cost check — for a login without costs;
 *   - no rupee profit anywhere in it;
 *   - the weekly sheet's dishes and waste, only with costs, and its food
 *     cost and waste against last week too; the Dashboard card asks for none
 *     of the sheet's lines;
 *   - a key ingredient with no reorder level, whose count has gone below
 *     zero, is still pinned (the words say "out on this till's count");
 *   - asked of the worker, it comes back exactly as worked out here.
 *
 * The clock is set (Date only) to Wednesday 30 Sep 2026, 3 pm in Karachi.
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE IS MADE UP (costing spec D11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redItemWeekCents } from '@cheeseoclock/pos-domain';
import type { DoThisItem } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
/** Wednesday 30 Sep 2026, 3 pm in Karachi. This week began Monday 28 Sep, 5 am. */
const NOW = new Date('2026-09-30T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...s.r,
    ...(await import('../../db/repositories/business-settings-repo.js')),
    ...(await import('../../db/repositories/ingredient-cost-repo.js')),
    ...(await import('../costing-settings.js')),
    ...(await import('../costing-service.js')),
    ...(await import('./owner-week.js')),
  };
  /** A sale at `at`: rung, stock taken and cost kept, paid. */
  const sale = (lines: Line[], at: string) => {
    const o = s.ring(lines);
    s.r.decrementForOrder(db, o, CASHIER);
    s.markPaid(o, new Date(at));
    return o;
  };
  return { db, ...s, r, sale };
}

type Shop = Awaited<ReturnType<typeof shop>>;

/** Pizza (and, when asked, deals) at a confirmed 5% target ("close" to 10%): every pizza is over. */
function strictTargets(s: Shop, withDeals = false) {
  s.r.saveCostingTargets(
    s.db,
    {
      defaultBps: 3000,
      amberBps: 500,
      perCategory: { [s.cat.pizza]: { bps: 500, confirmed: true }, ...(withDeals ? { [s.cat.deals]: { bps: 500, confirmed: true } } : {}) },
      nonFoodCategoryIds: [s.cat.fees],
      priceStepCents: 1000,
    },
    OWNER,
  );
}

const kinds = (items: DoThisItem[]) => items.map((i) => (i.kind === 'red_item' ? `red:${i.name}` : i.kind === 'low_stock' ? `low:${i.name}` : i.kind));

live("the owner's week: the card's numbers", () => {
  it('this week so far; "no data then" when last week predates the first order, then the change once it does not', async () => {
    const s = await shop();
    s.sale([['fajitaM', 1]], '2026-09-28T14:00:00.000Z'); // Monday 7 pm
    s.sale([['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]], '2026-09-29T15:00:00.000Z');
    const first = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(first).toMatchObject({
      week: 'this',
      sinceIso: '2026-09-28T00:00:00.000Z',
      untilIso: NOW.toISOString(),
      compareSinceIso: '2026-09-21T00:00:00.000Z',
      compareUntilIso: '2026-09-23T10:00:00.000Z',
      firstDay: '2026-09-28',
      lastDay: '2026-10-04',
      isCurrent: true,
      current: { netSalesCents: 270_000, orderCount: 2, avgOrderCents: 135_000 },
      previous: null,
      change: { sales: { kind: 'noData' }, orders: { kind: 'noData' }, avgOrder: { kind: 'noData' } },
    });

    // An older order (the till was in use then) and one last Tuesday, inside last week's "by now".
    s.sale([['crispyWings', 1]], '2026-09-14T12:00:00.000Z');
    s.sale([['fajitaM', 2]], '2026-09-22T12:00:00.000Z');
    // Last Wednesday after 3 pm: past "by now", so not compared.
    s.sale([['fajitaM', 5]], '2026-09-23T13:00:00.000Z');
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(week.previous).toEqual({ netSalesCents: 240_000, orderCount: 1, avgOrderCents: 240_000 });
    expect(week.change).toEqual({
      sales: { kind: 'pct', bps: 1_250 },
      orders: { kind: 'pct', bps: 10_000 },
      avgOrder: { kind: 'pct', bps: -4_375 },
    });

    // Last week in full, against the week before.
    const last = s.r.buildOwnerWeek(s.db, { week: 'last', withCosts: false }, NOW);
    expect(last).toMatchObject({ isCurrent: false, firstDay: '2026-09-21', lastDay: '2026-09-27', current: { orderCount: 2, netSalesCents: 840_000 } });
    expect(last.previous).toEqual({ netSalesCents: 90_000, orderCount: 1, avgOrderCents: 90_000 });
  });

  it('food cost, costs known and waste for a login with costs; none of it without', async () => {
    const s = await shop();
    s.sale([['fajitaM', 1]], '2026-09-28T14:00:00.000Z');
    s.sale([['cola', 1]], '2026-09-29T14:00:00.000Z'); // its bottle has no price: not fully costed
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -500, reason: 'waste', wasteReason: 'burnt', occurredAtIso: '2026-09-29T16:00:00.000Z' }, MANAGER);
    const withCosts = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true }, NOW);
    expect(withCosts.costs).toMatchObject({ hasCosts: true, wasteCents: 60_000 });
    expect(withCosts.costs!.foodCostBps).toBeGreaterThan(0);
    // Rs 1,200 of Rs 1,350 food sales are costed.
    expect(withCosts.costs!.coverageBps).toBe(8_889);
    expect(withCosts.sheet!.wasteByReason).toEqual([{ reason: 'burnt', times: 1, cents: 60_000 }]);
    // The card: the same five numbers, and none of the sheet's lines (it shows none of them).
    const card = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(card.costs).toEqual(withCosts.costs);
    expect(card.sheet).toBeNull();

    const noCosts = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: false }, NOW);
    expect(noCosts.costs).toBeNull();
    expect(noCosts.sheet).toBeNull();
    expect(noCosts.doThis.every((i) => !i.cost)).toBe(true);
  });
});

live('"Do this" (costing spec 4.17)', () => {
  /** A shop with something of every kind to fix. */
  async function busyShop(withDeals = false) {
    const s = await shop();
    strictTargets(s, withDeals);
    // Four weeks of sales: 8 Fajita, 4 Veggie Lovers, 2 deals, a cola (no bottle price), Baked Wings (no recipe).
    s.sale([['fajitaM', 4]], '2026-09-08T14:00:00.000Z');
    s.sale([['fajitaM', 4], ['cola', 1]], '2026-09-15T14:00:00.000Z');
    s.sale([['veggieL', 4, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']], ['bakedWings', 1]], '2026-09-22T14:00:00.000Z');
    s.sale([['deal', 2, ['d1Fajita', 'd2Veggie']]], '2026-09-29T14:00:00.000Z');
    // Cheese is a key ingredient, and running low; onion is low too, but not a key ingredient.
    s.r.saveCostAlertSettings(s.db, { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [s.ing.cheese] }, OWNER);
    s.r.updateIngredient(s.db, { id: s.ing.cheese, lowThreshold: 10_000_000 }, MANAGER);
    s.r.updateIngredient(s.db, { id: s.ing.onion, lowThreshold: 10_000_000 }, MANAGER);
    // Cheese goes up 25%: a price alert (key ingredient), costing the menu some rupees a week.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    return s;
  }

  it('a key ingredient running low is pinned first; then the most rupees a week; cost lines carry their rupees', async () => {
    const s = await busyShop();
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(week.doThisFailed).toEqual([]);
    const [pinned, ...rest] = week.doThis;
    expect(pinned).toMatchObject({ kind: 'low_stock', name: 'Test cheese', pinned: true, weekCents: null, cost: false });
    // Onion is low too, but not a key ingredient: not on the list.
    expect(week.doThis.some((i) => i.kind === 'low_stock' && i.name === 'Test onion')).toBe(false);
    // Every other line has rupees, most first.
    expect(rest.length).toBeGreaterThanOrEqual(4);
    expect(rest.every((i) => i.weekCents !== null && i.weekCents > 0 && !i.pinned && i.cost)).toBe(true);
    const cents = rest.map((i) => i.weekCents!);
    expect([...cents].sort((a, b) => b - a)).toEqual(cents);
    expect(kinds(rest).sort()).toEqual(['missing_costs', 'price_alert', 'red:Fajita Pizza — Medium', 'red:Veggie Lovers — Large'].sort());

    // A dish over target: a week of its sales × (cost − target × price), from the plate Costing shows.
    const ctx = s.r.loadCostingContext(s.db, NOW);
    for (const line of rest) {
      if (line.kind !== 'red_item') continue;
      const item = s.r.itemsOnMenu(ctx).find((i) => i.id === line.menuItemId)!;
      const pc = s.r.plateAt(ctx, item, ctx.priceOf);
      expect(line.weekCents).toBe(redItemWeekCents(s.r.soldLast28(ctx, item.id), pc.typicalCostMc, pc.typicalPriceMc, 500));
      expect(line).toMatchObject({ targetBps: 500, foodCostBps: pc.foodCostBps });
    }
    const fajita = rest.find((i) => i.kind === 'red_item' && i.name.startsWith('Fajita'));
    expect(fajita).toMatchObject({ soldLast28: 8 });
    // Missing costs: ONE line, for the bottle, Baked Wings' recipe and the rest.
    const missing = rest.find((i) => i.kind === 'missing_costs');
    expect(missing).toMatchObject({ things: s.r.getMissingCosts(s.db, NOW).total });
    expect(missing && missing.kind === 'missing_costs' && missing.dishes).toBeGreaterThanOrEqual(2);
    // The price alert, at its rupees a week.
    const alert = rest.find((i) => i.kind === 'price_alert');
    expect(alert).toMatchObject({ alertKind: 'price_jump', ingredientName: 'Test cheese', changeBps: 2_500 });
    const stored = s.db.prepare(`SELECT impact_week_cents AS c FROM cost_alerts WHERE kind = 'price_jump'`).get() as { c: number };
    expect(alert!.weekCents).toBe(Number(stored.c));
  });

  it('at most five lines, and how many more there were', async () => {
    const s = await busyShop(true);
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(week.doThis).toHaveLength(5);
    expect(week.doThisMore).toBe(1);
    expect(week.doThis[0]).toMatchObject({ kind: 'low_stock', pinned: true });
  });

  it('a seen alert leaves the list', async () => {
    const s = await busyShop();
    const { markCostAlertsSeen } = await import('../../db/repositories/cost-alert-repo.js');
    const ids = (s.db.prepare(`SELECT id FROM cost_alerts`).all() as Array<{ id: string }>).map((a) => a.id);
    markCostAlertsSeen(s.db, ids, MANAGER);
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(week.doThis.some((i) => i.kind === 'price_alert')).toBe(false);
  });

  it('works from the 28 whole days before today, read once a trading day: a sale today waits for tomorrow; a price moves it at once', async () => {
    const s = await busyShop();
    const fajita = (w: { doThis: DoThisItem[] }) => w.doThis.find((i) => i.kind === 'red_item' && i.name.startsWith('Fajita'));
    const first = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(fajita(first)).toMatchObject({ soldLast28: 8 });
    // Four more sold today, and four yesterday rung up after the first look: the same list all day…
    s.sale([['fajitaM', 4]], '2026-09-30T08:00:00.000Z');
    s.sale([['fajitaM', 4]], '2026-09-29T08:00:00.000Z');
    const anHourOn = new Date(NOW.getTime() + 3_600_000);
    const later = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, anHourOn);
    expect(fajita(later)).toMatchObject({ soldLast28: 8, weekCents: fajita(first)!.weekCents });
    // …while the week's own figures move with every sale.
    expect(later.current.orderCount).toBe(first.current.orderCount + 2);
    // A price fixed on Costing moves it at once: prices, recipes, the menu and targets are read on every ask.
    s.r.setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 300_000 } }, MANAGER);
    const priced = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, anHourOn);
    expect(fajita(priced)!.weekCents!).toBeGreaterThan(fajita(first)!.weekCents!);
    // The next trading day reads the 28 days afresh: yesterday's and today's four count now.
    const tomorrow = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, new Date(NOW.getTime() + 86_400_000));
    expect(fajita(tomorrow)).toMatchObject({ soldLast28: 16 });
    // The worker reads a day's sales ahead of its first tap (as it starts, and as each trading day begins): the card then reuses them.
    const { warmOwnerWeek, wholeDaysSales } = await import('./owner-week.js');
    const dayAfter = new Date(NOW.getTime() + 2 * 86_400_000);
    warmOwnerWeek(s.db, dayAfter);
    expect(wholeDaysSales(s.db, new Date(dayAfter.getTime() + 60_000))).toBe(wholeDaysSales(s.db, dayAfter));
  });

  it('without costs: only the low-stock line; no cost check runs, and the main process strips any it is sent', async () => {
    const s = await busyShop();
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: false }, NOW);
    expect(kinds(week.doThis)).toEqual(['low:Test cheese']);
    expect(week.doThisMore).toBe(0);
    // ownerWeekForLogin holds even if the cost lines were there.
    const full = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    const stripped = s.r.ownerWeekForLogin(full, false);
    expect(kinds(stripped.doThis)).toEqual(['low:Test cheese']);
    expect(stripped.costs).toBeNull();
    expect(stripped.sheet).toBeNull();
    expect(s.r.ownerWeekForLogin(full, true)).toBe(full);
  });

  it('never rupee profit: nothing in it is a profit figure', async () => {
    const s = await busyShop();
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true }, NOW);
    expect(JSON.stringify(week)).not.toMatch(/profit/i);
  });
});

live('the weekly sheet', () => {
  it('the dishes sold this week with a known cost, most and least earned per sale; never a dish twice; no uncosted dish', async () => {
    const s = await shop();
    s.sale([['fajitaM', 2], ['veggieL', 1, ['pickOnion', 'pickPepper', 'pickOlive', 'pickMushroom', 'pickCorn', 'dipChili']]], '2026-09-28T14:00:00.000Z');
    s.sale([['deal', 1, ['d1Fajita', 'd2Veggie']], ['crispyWings', 1], ['cola', 2], ['bakedWings', 1], ['delivery', 1]], '2026-09-29T14:00:00.000Z');
    // Sold last week only: not on this week's sheet.
    s.sale([['fajitaM', 1, ['extraCheese']]], '2026-09-22T14:00:00.000Z');
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true }, NOW);
    const names = [...week.sheet!.earnsMost, ...week.sheet!.earnsLeast].map((d) => d.name);
    // Fajita, Veggie Lovers, the deal and Crispy Wings (a guessed breading price is still a price); not the
    // cola (no bottle price), Baked Wings (no recipe) or the delivery charge.
    expect(new Set(names)).toEqual(new Set(['Fajita Pizza — Medium', 'Veggie Lovers — Large', 'Big Two Deal', 'Crispy Wings']));
    expect(names).toHaveLength(4);
    expect(week.sheet!.earnsMost).toHaveLength(3);
    expect(week.sheet!.earnsLeast).toHaveLength(1);
    expect(week.sheet!.earnsMost[0]).toMatchObject({ name: 'Big Two Deal', soldThisWeek: 1 });
    expect(week.sheet!.earnsMost.find((d) => d.name.startsWith('Fajita'))).toMatchObject({ soldThisWeek: 2 });
  });
});

live('the weekly sheet: food cost and waste against last week', () => {
  it('last week by now (or the week before in full): its food cost and waste; none when the till has no figures for then', async () => {
    const s = await shop();
    s.sale([['fajitaM', 1]], '2026-09-28T14:00:00.000Z'); // this Monday
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -500, reason: 'waste', wasteReason: 'burnt', occurredAtIso: '2026-09-29T16:00:00.000Z' }, MANAGER);
    // Before last week began, nothing: "no data then", so no "was".
    const first = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true }, NOW);
    expect(first.previous).toBeNull();
    expect(first.sheet!.previousCosts).toBeNull();

    s.sale([['crispyWings', 1]], '2026-09-14T12:00:00.000Z'); // the till was in use before last week
    s.sale([['fajitaM', 2]], '2026-09-22T12:00:00.000Z'); // last Tuesday: inside last week's "by now"
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -1_000, reason: 'waste', wasteReason: 'dropped', occurredAtIso: '2026-09-21T16:00:00.000Z' }, MANAGER);
    // Last Thursday, after "by now": not in last week's figures.
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -5_000, reason: 'waste', wasteReason: 'expired', occurredAtIso: '2026-09-24T16:00:00.000Z' }, MANAGER);
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: true, sheet: true }, NOW);
    const { getFoodCost } = await import('../business-report.js');
    const before = getFoodCost(s.db, { sinceIso: week.compareSinceIso, untilIso: week.compareUntilIso }, NOW);
    expect(week.sheet!.previousCosts).toEqual({ foodCostBps: before.foodCostBps, coverageBps: before.coverageBps, wasteCents: before.wasteCents, hasCosts: before.hasCosts });
    expect(week.sheet!.previousCosts!.wasteCents).toBe(120_000);
    expect(week.sheet!.previousCosts!.foodCostBps).toBeGreaterThan(0);
    // This week's waste stays this week's.
    expect(week.costs!.wasteCents).toBe(60_000);
  });
});

live('"Do this": a key ingredient out on the till\'s count', () => {
  it('no reorder level set and the count below zero: still pinned first', async () => {
    const s = await shop();
    s.r.saveCostAlertSettings(s.db, { jumpBps: 1_000, impactWeekCents: 100_000, keyIngredientIds: [s.ing.cheese] }, OWNER);
    s.r.recordStockMovement(s.db, { ingredientId: s.ing.cheese, deltaQty: -(s.stockOf('cheese') + 3_000), reason: 'waste', wasteReason: 'other', occurredAtIso: '2026-09-29T16:00:00.000Z' }, MANAGER);
    const week = s.r.buildOwnerWeek(s.db, { week: 'this', withCosts: false }, NOW);
    expect(week.doThis[0]).toMatchObject({ kind: 'low_stock', name: 'Test cheese', pinned: true, currentQty: -3_000, lowThreshold: 0 });
  });
});

live('the owner’s week through the worker', () => {
  it('asked of the worker, it comes back exactly as worked out on this thread', async () => {
    const s = await shop();
    strictTargets(s);
    s.sale([['fajitaM', 3]], '2026-09-21T14:00:00.000Z');
    s.sale([['fajitaM', 1]], '2026-09-29T14:00:00.000Z');
    const { handleRunRequest } = await import('./worker.js');
    const job = { week: 'this' as const, withCosts: true };
    const reply = handleRunRequest(s.db, { type: 'run', id: 7, kind: 'ownerWeek', request: job, nowIso: NOW.toISOString() });
    expect(reply).toMatchObject({ type: 'result', id: 7, ok: true });
    const direct = s.db.transaction(() => s.r.buildOwnerWeek(s.db, job, NOW))();
    expect(JSON.parse(JSON.stringify((reply as { data: unknown }).data))).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(direct.doThis.some((i) => i.kind === 'red_item')).toBe(true);
  });
});
