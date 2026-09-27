/**
 * Reports → Overview's trend strip and 12-month chart (costing spec 4.10,
 * Phase 7), worked out in the Reports worker thread like the tabs.
 *
 *  - Today / this week / this month / this year so far, each against the
 *    stretch it is compared with, to the minute (trendWindows in
 *    pos-domain: same weekday last week, last week by now, the same day
 *    numbers last month, last year by this date) and the same stretch a year
 *    ago (weekday-aligned for a day or a week, calendar for a month).
 *  - A stretch that starts before this till's first order has "no data then"
 *    instead of a change of +100%.
 *  - The last 8 weeks by day and the last 12 months, with each month's food
 *    cost for a login that may see costs. A month that is over is worked out
 *    once a trading day and kept (monthCostsFor): twelve months of food cost
 *    are a year's read (1–2 s), and Overview is the default tab, refreshed
 *    every 5 minutes; only this month is worked out on every ask.
 *
 * Sales are the counted orders' stored totals less part refunds (net sales,
 * the Overview's "Sales"), dated by the trading day they were started in.
 * Every figure is for the orders saved on THIS till (costing spec D14).
 *
 * Read-only, and never loads Electron: it runs in the worker thread.
 */
import type {
  ReportDayPoint,
  ReportMonthCost,
  ReportMonthPoint,
  ReportTrendLine,
  ReportTrends,
  TrendComparison,
  TrendFigures,
} from '@cheeseoclock/shared-types';
import {
  DAY_MS,
  TREND_PERIODS,
  averageOrderCents,
  dayYmd,
  lastTwelveMonths,
  tillHadData,
  tradingDayOfMs,
  trendChange,
  trendWindows,
  windowDays,
  type TimeWindow,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getFoodCost } from '../business-report.js';
import { COUNTED, IN_RANGE, REFUNDED, firstOrderMs } from './sql.js';

/** What the main process asks for: the food cost per month only for a login that may see costs. */
export interface TrendsJob {
  withCosts: boolean;
}

/** How many trading days back the day-by-day line goes (8 weeks). */
export const RECENT_DAYS = 56;

/**
 * The tables a closed month's food cost is worked out from besides its own
 * orders and stock rows: prices and their history, recipes and batches, the
 * menu, categories and targets (which items are not food). A change to any
 * of them (a price filled in, a recipe fixed, from this till or the other)
 * works the months out again; so does a new trading day.
 */
const COSTING_INPUTS = ['ingredients', 'ingredient_costs', 'batch_recipe_lines', 'recipes', 'menu_items', 'categories', 'business_settings'] as const;

/** What the months kept were worked out from: the trading day and the costing inputs as they stand (small tables). */
function costingStamp(db: AppDatabase, today: number): string {
  const parts = COSTING_INPUTS.map(
    (t) => `(SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(SUM(version), 0) FROM ${t})`,
  );
  const row = db.prepare(`SELECT ${parts.join(` || '|' || `)} AS stamp`).get() as { stamp: string };
  return `${today}|${row.stamp}`;
}

/**
 * The closed months' food cost, per connection (the worker keeps one for its
 * life; each test database gets its own): worked out once, then kept while
 * the stamp holds.
 */
const closedMonths = new WeakMap<AppDatabase, { stamp: string; byMonth: Map<string, ReportMonthCost> }>();

/**
 * Each of the 12 months' food cost, as Food cost & stock works it out (costs
 * kept with each sale, older orders estimated): this month on every ask, the
 * months before it from the day's keep when nothing that prices a sale has
 * changed since.
 */
export function monthCostsFor(
  db: AppDatabase,
  months: ReadonlyArray<TimeWindow & { month: string }>,
  first: number | null,
  now: Date,
): ReportMonthCost[] {
  const stamp = costingStamp(db, tradingDayOfMs(now.getTime()));
  let kept = closedMonths.get(db);
  if (!kept || kept.stamp !== stamp) {
    kept = { stamp, byMonth: new Map() };
    closedMonths.set(db, kept);
  }
  const keep = kept.byMonth;
  return months.map((m, i) => {
    if (first === null || m.untilMs <= first) return { month: m.month, foodCostBps: null, coverageBps: null };
    const closed = i < months.length - 1;
    const key = `${m.month}|${m.sinceMs}|${m.untilMs}|${first}`;
    const got = closed ? keep.get(key) : undefined;
    if (got) return got;
    const f = getFoodCost(db, { sinceIso: iso(m.sinceMs), untilIso: iso(m.untilMs) }, now);
    const cost: ReportMonthCost = { month: m.month, foodCostBps: f.foodCostBps, coverageBps: f.coverageBps };
    if (closed) keep.set(key, cost);
    return cost;
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Net sales and orders of the counted orders started in a stretch (one indexed range scan). */
export function salesIn(db: AppDatabase, w: TimeWindow): TrendFigures {
  if (w.untilMs <= w.sinceMs) return { netSalesCents: 0, orderCount: 0, avgOrderCents: 0 };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(o.total_cents - ${REFUNDED}), 0) AS net
         FROM orders o
        WHERE ${IN_RANGE} AND ${COUNTED}`,
    )
    .get(iso(w.sinceMs), iso(w.untilMs)) as { n: number; net: number };
  const orders = Number(row.n);
  const net = Number(row.net);
  return { netSalesCents: net, orderCount: orders, avgOrderCents: averageOrderCents(net, orders) };
}

/** A stretch compared with `current`: its figures, or none when the till has no data for then. */
export function compareWith(db: AppDatabase, current: TrendFigures, w: TimeWindow, firstOrder: number | null): TrendComparison {
  const figures = tillHadData(w, firstOrder) ? salesIn(db, w) : null;
  return {
    sinceIso: iso(w.sinceMs),
    untilIso: iso(w.untilMs),
    figures,
    change: {
      sales: trendChange(current.netSalesCents, figures?.netSalesCents ?? null),
      orders: trendChange(current.orderCount, figures?.orderCount ?? null),
      avgOrder: trendChange(current.avgOrderCents, figures?.avgOrderCents ?? null),
    },
  };
}

/** Sales by trading day (UTC date of created_at: the day starts 05:00 Pakistan time = 00:00 UTC) or by month. */
function groupedSales(db: AppDatabase, w: TimeWindow, chars: 10 | 7): Map<string, { orders: number; net: number }> {
  const rows = db
    .prepare(
      `SELECT substr(o.created_at, 1, ${chars}) AS k, COUNT(*) AS n, COALESCE(SUM(o.total_cents - ${REFUNDED}), 0) AS net
         FROM orders o
        WHERE ${IN_RANGE} AND ${COUNTED}
        GROUP BY k`,
    )
    .all(iso(w.sinceMs), iso(w.untilMs)) as Array<{ k: string; n: number; net: number }>;
  return new Map(rows.map((r) => [r.k, { orders: Number(r.n), net: Number(r.net) }]));
}

/**
 * The trend strip and the 12 months at `now`. `longReads` false (the main
 * process working it out itself, 31 days at most): every stretch longer than
 * `maxDays` is left out — the year line, the 8 weeks, the 12 months — and
 * the answer says so (`partial`).
 */
export function buildTrends(
  db: AppDatabase,
  job: TrendsJob,
  now: Date,
  opts: { longReads: boolean; maxDays: number },
): Omit<ReportTrends, 'engine'> {
  const nowMs = now.getTime();
  const first = firstOrderMs(db);
  const fits = (w: TimeWindow) => opts.longReads || windowDays(w) <= opts.maxDays;

  const lines: ReportTrendLine[] = [];
  for (const period of TREND_PERIODS) {
    const w = trendWindows(period, nowMs);
    if (![w.current, w.previous, ...(w.lastYear ? [w.lastYear] : [])].every(fits)) continue;
    const current = salesIn(db, w.current);
    lines.push({
      period,
      current: { sinceIso: iso(w.current.sinceMs), untilIso: iso(w.current.untilMs), figures: current },
      previous: compareWith(db, current, w.previous, first),
      lastYear: w.lastYear ? compareWith(db, current, w.lastYear, first) : null,
    });
  }

  // The last 8 weeks, day by day (every day, 0 when nothing sold).
  const today = tradingDayOfMs(nowMs);
  const recent: TimeWindow = { sinceMs: (today - RECENT_DAYS + 1) * DAY_MS, untilMs: nowMs };
  let recentDays: ReportDayPoint[] = [];
  if (fits(recent)) {
    const byDay = groupedSales(db, recent, 10);
    recentDays = Array.from({ length: RECENT_DAYS }, (_, i) => {
      const day = dayYmd(today - RECENT_DAYS + 1 + i);
      const t = byDay.get(day);
      return { day, orderCount: t?.orders ?? 0, netSalesCents: t?.net ?? 0 };
    });
  }

  // The last 12 calendar months.
  const monthWindows = lastTwelveMonths(nowMs);
  const span: TimeWindow = { sinceMs: monthWindows[0]!.sinceMs, untilMs: nowMs };
  let months: ReportMonthPoint[] = [];
  let monthCosts: ReportMonthCost[] | null = null;
  if (fits(span)) {
    const byMonth = groupedSales(db, span, 7);
    months = monthWindows.map((m) => {
      const t = byMonth.get(m.month);
      const net = t?.net ?? 0;
      const orders = t?.orders ?? 0;
      return {
        month: m.month,
        sinceIso: iso(m.sinceMs),
        untilIso: iso(m.untilMs),
        netSalesCents: net,
        orderCount: orders,
        avgOrderCents: averageOrderCents(net, orders),
        hadData: tillHadData(m, first),
      };
    });
    if (job.withCosts) monthCosts = monthCostsFor(db, monthWindows, first, now);
  }

  return {
    nowIso: now.toISOString(),
    firstOrderAt: first === null ? null : iso(first),
    lines,
    recentDays,
    months,
    monthCosts: job.withCosts ? monthCosts : null,
    partial: !opts.longReads && (lines.length < TREND_PERIODS.length || recentDays.length === 0 || months.length === 0),
  };
}
