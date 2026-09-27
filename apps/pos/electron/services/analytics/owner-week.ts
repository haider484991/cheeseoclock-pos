/**
 * The owner's week (costing spec Phase 7): the Dashboard "This week" card
 * and the printed weekly sheet, worked out in the Reports worker thread.
 *
 * At most five numbers (costing spec D15): sales, orders and the average
 * order against last week by this time (report.view); food cost with how
 * much of it is known, and waste (COST_CAPABILITY only). Then ONE ranked
 * "Do this" list (4.17), each line with its rupees per week. Never rupee
 * profit (that is Phase 9's, behind profit.view): the sheet ranks dishes by
 * what they earn per sale but prints no profit figure.
 *
 * "Do this" is a list of SOURCES (DO_THIS_SOURCES below), one per kind of
 * problem; pos-domain's collectDoThis runs the ones this login may see and
 * ranks them. Phase 7 registers:
 *   - low stock:       a key ingredient (Costing → Targets, the price
 *                      alerts' key ingredients) at or under its low-stock
 *                      level, pinned first (report.view: no costs);
 *   - items over target: n̄ per week × (cost − target × price);
 *   - missing costs:   the week's sales they touch × the category target;
 *   - price alerts:    each alert not seen yet, at its rupees per week.
 * Later phases add their own source to the list: stock variance over 3%
 * (Phase 8), leakage flags (Phase 10).
 *
 * "Do this" works from the 28 WHOLE trading days before today (its rupees
 * per week are a quarter of them): read once a trading day and kept
 * (wholeDaysSales), so the list holds still through the day and the card
 * stays inside its budget (≤ 300 ms on the shop PC). Prices, recipes, the
 * menu and targets are read on every ask, so a price fixed on Costing moves
 * the list at once; an order from those days changed later (a late refund)
 * shows from the next day. The worker reads the day's sales as it starts
 * and as each trading day begins (warmOwnerWeek), so the first tap of the
 * day does not wait for them either.
 *
 * Every figure is for the orders on THIS till (costing spec D14). Read-only;
 * never loads Electron.
 */
import type { DoThisItem, OwnerWeek, OwnerWeekItem, OwnerWeekSheet, OwnerWeekWhich } from '@cheeseoclock/shared-types';
import {
  collectDoThis,
  dayYmd,
  missingCostsWeekCents,
  ownerWeekWindows,
  redItemWeekCents,
  tillHadData,
  tradingDayOfMs,
  tradingDayStartMs,
  trendChange,
  type DoThisSource,
  type PlateCost,
  type ResolvedTarget,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getFoodCost } from '../business-report.js';
import {
  flagFor,
  getCostAlerts,
  itemsOnMenu,
  loadAlertSettings,
  loadCostingContextWith,
  loadCostingSales,
  MIX_WINDOW_DAYS,
  missingCostsIn,
  plateAt,
  soldLast28,
  targetFor,
  type CostingContext,
  type CostingMenuItem,
  type CostingSales,
} from '../costing-service.js';
import { COUNTED, IN_RANGE, firstOrderMs } from './sql.js';
import { salesIn } from './trends.js';

/**
 * What the main process asks for: the week, whether this login may see
 * costs (cost sources only run then), and whether it is for the printed
 * sheet — the Dashboard card shows none of the sheet's lines (the dishes,
 * waste by reason, last week's food cost and waste), so it does not wait for
 * them (costing spec: the card ≤ 300 ms on the shop PC).
 */
export interface OwnerWeekJob {
  week: OwnerWeekWhich;
  withCosts: boolean;
  sheet?: boolean;
}

/** How many dishes each end of the printed sheet lists. */
export const SHEET_ITEMS = 3;

const iso = (ms: number) => new Date(ms).toISOString();

/** A dish on the menu with its plate and target, worked out once for every source. */
interface Dish {
  item: CostingMenuItem;
  pc: PlateCost;
  target: ResolvedTarget;
  flag: ReturnType<typeof flagFor>;
}

/** What the sources read: the database, the clock, and the costing figures, loaded once when first needed. */
export interface OwnerWeekCtx {
  db: AppDatabase;
  now: Date;
  costing: () => CostingContext;
  dishes: () => Dish[];
}

/** The 28 whole trading days' sales, per connection (the worker keeps one for its life), for one trading day. */
const daySales = new WeakMap<AppDatabase, { day: number; sales: CostingSales }>();

/**
 * Every item's units, sales and picks over the 28 whole trading days before
 * `now`'s: read once a trading day, then kept. The slow part of "Do this"
 * (a walk of four weeks of order lines and their choices).
 */
export function wholeDaysSales(db: AppDatabase, now: Date): CostingSales {
  const today = tradingDayOfMs(now.getTime());
  const kept = daySales.get(db);
  if (kept && kept.day === today) return kept.sales;
  const untilMs = tradingDayStartMs(today) - 1; // the last instant of yesterday (the window is inclusive)
  const sales = loadCostingSales(db, iso(tradingDayStartMs(today - MIX_WINDOW_DAYS)), iso(untilMs));
  daySales.set(db, { day: today, sales });
  return sales;
}

/** Read the day's sales ahead of the first tap (the worker, as it starts and as each trading day begins). */
export function warmOwnerWeek(db: AppDatabase, now: Date): void {
  db.transaction(() => wholeDaysSales(db, now))();
}

function ownerWeekCtx(db: AppDatabase, now: Date): OwnerWeekCtx {
  let costing: CostingContext | null = null;
  let dishes: Dish[] | null = null;
  const ctx: OwnerWeekCtx = {
    db,
    now,
    costing: () => (costing ??= loadCostingContextWith(db, wholeDaysSales(db, now))),
    dishes: () => {
      if (dishes) return dishes;
      const c = ctx.costing();
      dishes = itemsOnMenu(c).map((item) => {
        const pc = plateAt(c, item, c.priceOf);
        return { item, pc, target: targetFor(c, item.categoryId), flag: flagFor(c, item, pc) };
      });
      return dishes;
    },
  };
  return ctx;
}

// ----------------------------------------------------------------- sources --

/** A key ingredient at or under its low-stock level: pinned first, no rupees (report.view). */
const lowStockSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'low_stock',
  cost: false,
  collect: ({ db }) => {
    const keys = loadAlertSettings(db).keyIds;
    if (keys.size === 0) return [];
    const low = db
      .prepare(
        `SELECT id, name, unit, current_qty AS qty, low_threshold AS low
           FROM ingredients
          WHERE deleted_at IS NULL AND is_active = 1 AND current_qty <= low_threshold`,
      )
      .all() as Array<{ id: string; name: string; unit: string; qty: number; low: number }>;
    return low
      .filter((i) => keys.has(i.id))
      .map((i) => ({
        kind: 'low_stock' as const,
        key: `low_stock:${i.id}`,
        weekCents: null,
        pinned: true,
        cost: false,
        ingredientId: i.id,
        name: i.name,
        unit: i.unit,
        currentQty: Number(i.qty),
        lowThreshold: Number(i.low),
      }));
  },
};

/** A dish over its target (red): a week of its sales × (cost − target × price). */
const redItemsSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'red_item',
  cost: true,
  collect: (ctx) => {
    const c = ctx.costing();
    const out: DoThisItem[] = [];
    for (const d of ctx.dishes()) {
      if (d.flag !== 'red' || d.pc.foodCostBps === null) continue;
      const sold = soldLast28(c, d.item.id);
      const weekCents = redItemWeekCents(sold, d.pc.typicalCostMc, d.pc.typicalPriceMc, d.target.bps);
      if (weekCents <= 0) continue;
      out.push({
        kind: 'red_item',
        key: `red_item:${d.item.id}`,
        weekCents,
        pinned: false,
        cost: true,
        menuItemId: d.item.id,
        name: d.item.name,
        foodCostBps: d.pc.foodCostBps,
        targetBps: d.target.bps,
        soldLast28: sold,
      });
    }
    return out;
  },
};

/** Costs still missing, as ONE line: the week's sales of the dishes they touch × each dish's category target. */
const missingCostsSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'missing_costs',
  cost: true,
  collect: (ctx) => {
    const c = ctx.costing();
    const missing = missingCostsIn(c);
    if (missing.total === 0) return [];
    // The food dishes that can't be costed yet: no recipe, or a line with no price.
    const touched = ctx.dishes().filter((d) => !d.target.nonFood && (!d.pc.hasRecipe || d.pc.missingLines > 0));
    return [
      {
        kind: 'missing_costs',
        key: 'missing_costs',
        weekCents: missingCostsWeekCents(touched.map((d) => ({ salesLast28Cents: c.sales.get(d.item.id)?.salesCents ?? 0, targetBps: d.target.bps }))),
        pinned: false,
        cost: true,
        things: missing.total,
        dishes: touched.length,
      },
    ];
  },
};

/** Each price alert not seen yet that costs something a week (Costing → Alerts). */
const priceAlertsSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'price_alert',
  cost: true,
  collect: ({ db }) => {
    const out: DoThisItem[] = [];
    for (const a of getCostAlerts(db).alerts) {
      if (a.seenAt !== null || a.impactWeekCents <= 0) continue;
      if (a.kind === 'price_jump' && a.detail?.kind === 'price_jump') {
        out.push({
          kind: 'price_alert',
          key: `price_alert:${a.id}`,
          weekCents: a.impactWeekCents,
          pinned: false,
          cost: true,
          alertId: a.id,
          alertKind: 'price_jump',
          ingredientName: a.detail.ingredientName,
          changeBps: a.detail.changeBps,
          dishes: a.detail.items.length,
        });
      } else if (a.kind === 'weekly_digest' && a.detail?.kind === 'weekly_digest') {
        out.push({
          kind: 'price_alert',
          key: `price_alert:${a.id}`,
          weekCents: a.impactWeekCents,
          pinned: false,
          cost: true,
          alertId: a.id,
          alertKind: 'weekly_digest',
          ingredientName: null,
          changeBps: null,
          dishes: a.detail.changes.length,
        });
      }
    }
    return out;
  },
};

/**
 * The "Do this" sources, in no particular order (the ranking orders the
 * lines). Later phases add theirs here: Phase 8 stock variance over 3%,
 * Phase 10 leakage flags.
 */
export const DO_THIS_SOURCES: Array<DoThisSource<OwnerWeekCtx, DoThisItem>> = [lowStockSource, redItemsSource, missingCostsSource, priceAlertsSource];

// ------------------------------------------------------------------- sheet --

/** Units of each menu item sold in the week, on the counted orders (by the orders' date index). */
function unitsSold(db: AppDatabase, sinceIso: string, untilIso: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT oi.menu_item_id AS item, SUM(oi.quantity) AS units
         FROM orders o CROSS JOIN order_items oi
        WHERE ${IN_RANGE} AND ${COUNTED}
          AND oi.order_id = o.id AND oi.deleted_at IS NULL AND oi.menu_item_id IS NOT NULL
        GROUP BY oi.menu_item_id`,
    )
    .all(sinceIso, untilIso) as Array<{ item: string; units: number }>;
  return new Map(rows.map((r) => [r.item, Number(r.units)]));
}

/**
 * The printed sheet's dishes: of the food sold this week whose cost is fully
 * known, the three that earn the most per sale and the three that earn the
 * least (at menu price, today's costs — as Costing → Menu costs shows them).
 */
function sheetDishes(ctx: OwnerWeekCtx, units: Map<string, number>): Pick<OwnerWeekSheet, 'earnsMost' | 'earnsLeast'> {
  const costed = ctx
    .dishes()
    .filter((d) => (units.get(d.item.id) ?? 0) > 0 && !d.target.nonFood && d.pc.hasRecipe && d.pc.missingLines === 0 && d.pc.typicalPriceMc > 0)
    .sort((a, b) => b.pc.profitCents - a.pc.profitCents || a.item.name.localeCompare(b.item.name));
  const view = (d: Dish): OwnerWeekItem => ({
    menuItemId: d.item.id,
    name: d.item.name,
    soldThisWeek: units.get(d.item.id) ?? 0,
    foodCostBps: d.pc.foodCostBps,
  });
  const most = costed.slice(0, SHEET_ITEMS);
  const least = costed.slice(Math.max(SHEET_ITEMS, costed.length - SHEET_ITEMS)).reverse();
  return { earnsMost: most.map(view), earnsLeast: least.map(view) };
}

// -------------------------------------------------------------------- week --

/** The owner's week at `now`, as a login that may (or may not) see costs is to get it. */
export function buildOwnerWeek(db: AppDatabase, job: OwnerWeekJob, now: Date): Omit<OwnerWeek, 'engine'> {
  const w = ownerWeekWindows(job.week, now.getTime());
  const first = firstOrderMs(db);
  const current = salesIn(db, w.current);
  const previous = tillHadData(w.previous, first) ? salesIn(db, w.previous) : null;
  const range = { sinceIso: iso(w.current.sinceMs), untilIso: iso(w.current.untilMs) };
  const ctx = ownerWeekCtx(db, now);
  const list = collectDoThis(DO_THIS_SOURCES, ctx, { canSeeCosts: job.withCosts });

  let costs: OwnerWeek['costs'] = null;
  let sheet: OwnerWeekSheet | null = null;
  if (job.withCosts) {
    const food = getFoodCost(db, range, now);
    costs = { foodCostBps: food.foodCostBps, coverageBps: food.coverageBps, wasteCents: food.wasteCents, hasCosts: food.hasCosts };
    if (job.sheet) {
      let dishes: Pick<OwnerWeekSheet, 'earnsMost' | 'earnsLeast'> = { earnsMost: [], earnsLeast: [] };
      try {
        dishes = sheetDishes(ctx, unitsSold(db, range.sinceIso, range.untilIso));
      } catch {
        // The sheet still prints its other lines; the list says a check could not run.
        list.failed.push('sheet');
      }
      // The sheet's five numbers are all against last week (costing spec §5): food cost and waste too,
      // over the same stretch the sales are compared with. None when the till has no figures for then.
      const before = previous ? getFoodCost(db, { sinceIso: iso(w.previous.sinceMs), untilIso: iso(w.previous.untilMs) }, now) : null;
      sheet = {
        ...dishes,
        wasteByReason: food.wasteByReason,
        previousCosts: before
          ? { foodCostBps: before.foodCostBps, coverageBps: before.coverageBps, wasteCents: before.wasteCents, hasCosts: before.hasCosts }
          : null,
      };
    }
  }

  const lastDayMs = w.isCurrent ? w.current.sinceMs + 6 * 86_400_000 : w.current.untilMs - 1;
  return {
    week: job.week,
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    compareSinceIso: iso(w.previous.sinceMs),
    compareUntilIso: iso(w.previous.untilMs),
    firstDay: dayYmd(tradingDayOfMs(w.current.sinceMs)),
    lastDay: dayYmd(tradingDayOfMs(lastDayMs)),
    isCurrent: w.isCurrent,
    current,
    previous,
    change: {
      sales: trendChange(current.netSalesCents, previous?.netSalesCents ?? null),
      orders: trendChange(current.orderCount, previous?.orderCount ?? null),
      avgOrder: trendChange(current.avgOrderCents, previous?.avgOrderCents ?? null),
    },
    costs,
    doThis: list.items,
    doThisMore: list.more,
    doThisFailed: list.failed,
    sheet,
  };
}

/**
 * The owner's week as a login may read it (costing spec §2), in the main
 * process, so neither the card nor the printed sheet can carry more: without
 * COST_CAPABILITY no food cost, no waste (this week's or last week's), no
 * cost lines in "Do this" and no sheet dishes. (The worker already left the cost checks out for such a
 * login; this holds whatever it sent.)
 */
export function ownerWeekForLogin<T extends Pick<OwnerWeek, 'costs' | 'sheet' | 'doThis' | 'doThisMore'>>(week: T, canSeeCosts: boolean): T {
  if (canSeeCosts) return week;
  const kept = week.doThis.filter((i) => !i.cost);
  return { ...week, costs: null, sheet: null, doThis: kept, doThisMore: kept.length === week.doThis.length ? week.doThisMore : 0 };
}
