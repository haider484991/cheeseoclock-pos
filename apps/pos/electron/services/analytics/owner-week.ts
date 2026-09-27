/**
 * The owner's week (costing spec Phase 7): the Dashboard "This week" card
 * and the printed weekly sheet, worked out in the Reports worker thread.
 *
 * At most five numbers (costing spec D15): sales, orders and the average
 * order against last week by this time (report.view); food cost with how
 * much of it is known, and waste (COST_CAPABILITY only). Then ONE ranked
 * "Do this" list (4.17), each line with its rupees per week. Never rupee
 * profit on the Dashboard card: the printed sheet ranks dishes by what they
 * earn per sale, and — for profit.view only (Phase 9) — prints what one
 * sale earns and the week's profit before overheads.
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
 * Phase 8 adds stock variance: the latest two stock takes, when more than
 * 3% of food sales went unexplained (stock-control.ts, kept for the day).
 * Settings phase 7 makes that share, the shortest stretch and the rating
 * the owner's ('stock.rules', Settings → Kitchen & stock), and adds the
 * stock-take reminders he can turn on (off by default: no line).
 * Later phases add their own source to the list: leakage flags (Phase 10).
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
import type { DoThisItem, OwnerWeek, OwnerWeekItem, OwnerWeekSheet, OwnerWeekWhich, TillLinkState } from '@cheeseoclock/shared-types';
import {
  collectDoThis,
  dayYmd,
  missingCostsWeekCents,
  ownerWeekWindows,
  redItemWeekCents,
  stockTakesDue,
  tillHadData,
  tradingDayOfMs,
  tradingDayStartMs,
  trendChange,
  varianceWeekCents,
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
import { profitBeforeOverheads } from './profit.js';
import { isVarianceDoThis, latestVariance, warmLatestVariance } from './stock-control.js';
import { readStockRules } from '../../db/business-settings-read.js';

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
  /** The printed sheet's profit lines (profit.view, Phase 9). Never on the Dashboard card. */
  withProfit?: boolean;
  sheet?: boolean;
  /**
   * The second-till link as the main process sees it (the worker can't read
   * the sync switch): stock variance is left out when two tills take orders
   * and the link is off. Omitted: off.
   */
  link?: TillLinkState;
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
  link: TillLinkState;
  /** False: the main process working it out itself (no worker): nothing that reads over 31 days. */
  longReads: boolean;
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

/**
 * Read the day's sales ahead of the first tap (the worker, as it starts and
 * as each trading day begins), and the latest two stock takes' variance
 * (Phase 8) with the link as the main process last said it is (off, as the
 * shop runs, until told).
 */
export function warmOwnerWeek(db: AppDatabase, now: Date, link: TillLinkState = LINK_OFF): void {
  db.transaction(() => wholeDaysSales(db, now))();
  warmLatestVariance(db, link, now);
}

const LINK_OFF: TillLinkState = { on: false, stale: false, lastHeardAt: null };

function ownerWeekCtx(db: AppDatabase, now: Date, link: TillLinkState, longReads: boolean): OwnerWeekCtx {
  let costing: CostingContext | null = null;
  let dishes: Dish[] | null = null;
  const ctx: OwnerWeekCtx = {
    db,
    now,
    link,
    longReads,
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

/**
 * A key item (ingredients.count_weekly — the ONE list the weekly stock take
 * counts and the price alerts watch) at or under its low-stock level on this
 * till's count: pinned first, no rupees (report.view).
 */
const lowStockSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'low_stock',
  cost: false,
  collect: ({ db }) => {
    const low = db
      .prepare(
        `SELECT id, name, unit, current_qty AS qty, low_threshold AS low
           FROM ingredients
          WHERE deleted_at IS NULL AND is_active = 1 AND count_weekly = 1 AND current_qty <= low_threshold`,
      )
      .all() as Array<{ id: string; name: string; unit: string; qty: number; low: number }>;
    return low
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
 * The latest two full or key-items stock takes, the owner's shortest
 * stretch apart or more (6 days by default), when more than his share of
 * the food sales between them (3% by default) went unexplained (costing
 * spec 4.17, Phase 8; Settings → Kitchen & stock): what went, spread over
 * the weeks between them. Left out when two tills take orders with the link
 * off (stock-control.ts latestVariance, isVarianceDoThis).
 */
const stockVarianceSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'stock_variance',
  cost: true,
  collect: ({ db, now, link, longReads }) => {
    const v = latestVariance(db, link, now, { longReads });
    if (!isVarianceDoThis(v, readStockRules(db))) return [];
    return [
      {
        kind: 'stock_variance',
        key: `stock_variance:${v.toCountId}`,
        weekCents: varianceWeekCents(v.totalCents, v.windowMs),
        pinned: false,
        cost: true,
        fromCountId: v.fromCountId,
        toCountId: v.toCountId,
        varianceBps: v.varianceBps,
        totalCents: v.totalCents,
        topIngredient: v.topIngredient,
        countedAt: v.countedAt,
      },
    ];
  },
};

/** When the latest key-items (or full) and the latest full stock take were finished (any till's). */
function lastStockTakes(db: AppDatabase): { keyItemsAt: string | null; fullAt: string | null } {
  const latest = db.prepare(
    `SELECT MAX(finished_at) AS at FROM stock_counts
      WHERE status = 'done' AND deleted_at IS NULL AND finished_at IS NOT NULL AND scope = ?`,
  );
  const at = (scope: string) => ((latest.get(scope) as { at: string | null } | undefined)?.at ?? null);
  return { keyItemsAt: at('key_items'), fullAt: at('full') };
}

/**
 * A stock take the owner asked to be reminded of is due (Settings →
 * Kitchen & stock; off by default, so nothing shows until he turns it on):
 * the key items or a full stock take, last finished that many trading days
 * ago or more, or never. Pinned, first of the pinned (pinFirst: two low key
 * items can't push it off the card); no rupees (pos-domain stockTakesDue).
 */
const stockTakeDueSource: DoThisSource<OwnerWeekCtx, DoThisItem> = {
  kind: 'stock_take_due',
  cost: false,
  collect: ({ db, now }) => {
    const { reminders } = readStockRules(db);
    if (reminders.keyItemsEveryDays === null && reminders.fullEveryDays === null) return [];
    return stockTakesDue(reminders, lastStockTakes(db), now.getTime()).map((d) => ({
      kind: 'stock_take_due' as const,
      key: `stock_take_due:${d.scope}`,
      weekCents: null,
      pinned: true,
      // Ahead of the low-stock pins: many key items read low exactly when nothing was counted for a while.
      pinFirst: true,
      cost: false,
      scope: d.scope,
      everyDays: d.everyDays,
      lastAt: d.lastAt,
      daysSince: d.daysSince,
    }));
  },
};

/**
 * The "Do this" sources, in no particular order (the ranking orders the
 * lines). Later phases add theirs here: Phase 10 leakage flags.
 */
export const DO_THIS_SOURCES: Array<DoThisSource<OwnerWeekCtx, DoThisItem>> = [
  lowStockSource,
  redItemsSource,
  missingCostsSource,
  priceAlertsSource,
  stockVarianceSource,
  stockTakeDueSource,
];

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
function sheetDishes(ctx: OwnerWeekCtx, units: Map<string, number>, withProfit: boolean): Pick<OwnerWeekSheet, 'earnsMost' | 'earnsLeast'> {
  const costed = ctx
    .dishes()
    .filter((d) => (units.get(d.item.id) ?? 0) > 0 && !d.target.nonFood && d.pc.hasRecipe && d.pc.missingLines === 0 && d.pc.typicalPriceMc > 0)
    .sort((a, b) => b.pc.profitCents - a.pc.profitCents || a.item.name.localeCompare(b.item.name));
  const view = (d: Dish): OwnerWeekItem => ({
    menuItemId: d.item.id,
    name: d.item.name,
    soldThisWeek: units.get(d.item.id) ?? 0,
    foodCostBps: d.pc.foodCostBps,
    profitPerSaleCents: withProfit ? d.pc.profitCents : null,
  });
  const most = costed.slice(0, SHEET_ITEMS);
  const least = costed.slice(Math.max(SHEET_ITEMS, costed.length - SHEET_ITEMS)).reverse();
  return { earnsMost: most.map(view), earnsLeast: least.map(view) };
}

// -------------------------------------------------------------------- week --

/** The owner's week at `now`, as a login that may (or may not) see costs is to get it. */
export function buildOwnerWeek(db: AppDatabase, job: OwnerWeekJob, now: Date, opts: { longReads: boolean } = { longReads: true }): Omit<OwnerWeek, 'engine'> {
  const w = ownerWeekWindows(job.week, now.getTime());
  const first = firstOrderMs(db);
  const current = salesIn(db, w.current);
  const previous = tillHadData(w.previous, first) ? salesIn(db, w.previous) : null;
  const range = { sinceIso: iso(w.current.sinceMs), untilIso: iso(w.current.untilMs) };
  const ctx = ownerWeekCtx(db, now, job.link ?? LINK_OFF, opts.longReads);
  const list = collectDoThis(DO_THIS_SOURCES, ctx, { canSeeCosts: job.withCosts });

  let costs: OwnerWeek['costs'] = null;
  let sheet: OwnerWeekSheet | null = null;
  if (job.withCosts) {
    const food = getFoodCost(db, range, now);
    costs = { foodCostBps: food.foodCostBps, coverageBps: food.coverageBps, wasteCents: food.wasteCents, hasCosts: food.hasCosts };
    if (job.sheet) {
      let dishes: Pick<OwnerWeekSheet, 'earnsMost' | 'earnsLeast'> = { earnsMost: [], earnsLeast: [] };
      try {
        dishes = sheetDishes(ctx, unitsSold(db, range.sinceIso, range.untilIso), job.withProfit === true);
      } catch {
        // The sheet still prints its other lines; the list says a check could not run.
        list.failed.push('sheet');
      }
      // The sheet's five numbers are all against last week (costing spec §5): food cost and waste too,
      // over the same stretch the sales are compared with. None when the till has no figures for then.
      const before = previous ? getFoodCost(db, { sinceIso: iso(w.previous.sinceMs), untilIso: iso(w.previous.untilMs) }, now) : null;
      // The last stock-take variance (Phase 8), kept for the day with "Do this"'s.
      let lastStockTake: OwnerWeekSheet['lastStockTake'] = null;
      try {
        const v = latestVariance(db, ctx.link, now, { longReads: ctx.longReads });
        lastStockTake = v
          ? {
              sinceIso: v.sinceIso,
              untilIso: v.countedAt,
              compared: v.compared,
              totalCents: v.totalCents,
              varianceBps: v.varianceBps,
              band: v.band,
              topIngredient: v.topIngredient,
            }
          : null;
      } catch {
        list.failed.push('stock_take');
      }
      // Profit before overheads (Phase 9, profit.view): the Profit tab's waterfall over the week, and over last week.
      let profit: OwnerWeekSheet['profit'] = null;
      if (job.withProfit) {
        try {
          const now2 = profitBeforeOverheads(db, range);
          const then = previous ? profitBeforeOverheads(db, { sinceIso: iso(w.previous.sinceMs), untilIso: iso(w.previous.untilMs) }) : null;
          profit = { profitCents: now2.profitCents, unknownSalesCents: now2.unknownSalesCents, previousProfitCents: then?.profitCents ?? null };
        } catch {
          list.failed.push('profit');
        }
      }
      sheet = {
        ...dishes,
        profit,
        lastStockTake,
        wasteByReason: food.wasteByReason,
        ...(food.wasteLabels ? { wasteLabels: food.wasteLabels } : {}),
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
 * cost lines in "Do this" and no sheet dishes; without profit.view (Phase
 * 9) no profit on the sheet. (The worker already left them out for such a
 * login; this holds whatever it sent.)
 */
export function ownerWeekForLogin<T extends Pick<OwnerWeek, 'costs' | 'sheet' | 'doThis' | 'doThisMore'>>(week: T, canSeeCosts: boolean, canSeeProfit = false): T {
  if (canSeeCosts && !canSeeProfit && week.sheet) {
    const noProfit = (i: OwnerWeekItem): OwnerWeekItem => (i.profitPerSaleCents === null ? i : { ...i, profitPerSaleCents: null });
    return { ...week, sheet: { ...week.sheet, profit: null, earnsMost: week.sheet.earnsMost.map(noProfit), earnsLeast: week.sheet.earnsLeast.map(noProfit) } };
  }
  if (canSeeCosts) return week;
  const kept = week.doThis.filter((i) => !i.cost);
  return { ...week, costs: null, sheet: null, doThis: kept, doThisMore: kept.length === week.doThis.length ? week.doThisMore : 0 };
}
