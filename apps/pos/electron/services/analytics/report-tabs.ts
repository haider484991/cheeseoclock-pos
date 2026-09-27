/**
 * The Reports tabs (costing spec Phase 3): which builder makes which tab,
 * each in one read transaction, and what a login may see of it.
 *
 * Loaded by BOTH sides:
 *  - the Reports worker thread (worker.ts) builds tabs with it on its own
 *    read connection, so a year of figures never holds up the till;
 *  - the main process (reports-handlers.ts) builds a tab with it on the
 *    till's own connection only as the fallback (periods of 31 days or
 *    less, when the worker could not start), and filters every tab for
 *    the login that asked.
 * So nothing here, or below it, may load Electron (a test walks the imports).
 */
import {
  REPORT_TABS,
  type BusinessReportRequest,
  type MenuMapRequest,
  type ReportChannelsTab,
  type ReportLineCost,
  type ReportMenuCosts,
  type ReportTab,
  type ReportTabData,
  type ReportTabFigures,
  type TillLinkState,
  type WhatIfRequest,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import {
  buildChannelsTab,
  buildFoodStockTab,
  buildMenuTab,
  buildOverviewTab,
  buildTeamTab,
  buildWhenTab,
  withoutWasteCost,
} from '../business-report.js';
import { DAY_MS } from './sql.js';
import { buildOwnerWeek, type OwnerWeekJob } from './owner-week.js';
import { buildTrends, type TrendsJob } from './trends.js';
import { buildVariance, type VarianceJob } from './stock-control.js';
import { buildProfitTab, channelsExtras, menuCosts } from './profit.js';
import { buildMenuMap } from './menu-engineering.js';
import { getWhatIf } from '../costing-service.js';
import { EXTRA_ANALYTICS, type AnalyticsKind } from './worker-protocol.js';

/** The longest period the main process works out itself when the worker is not there (a month). */
export const MAIN_THREAD_MAX_DAYS = 31;

/**
 * A tab's period as the main process hands it to a builder (never as the
 * screen sent it): what the login may see, so the worker does not work out
 * rupees nobody will be shown (Menu's costs, Channels' profit), and the
 * second-till link (the Profit tab's stock-loss step). Left out — the tests
 * and the bench — everything is worked out.
 */
export interface TabJob extends BusinessReportRequest {
  withCosts?: boolean;
  withProfit?: boolean;
  link?: TillLinkState;
}

type Builder<K extends ReportTab> = (db: AppDatabase, req: TabJob, now: Date) => ReportTabFigures<K>;

const rangeOf = (req: BusinessReportRequest) => ({ sinceIso: req.sinceIso, untilIso: req.untilIso });

const BUILDERS: { [K in ReportTab]: Builder<K> } = {
  overview: (db, req) => buildOverviewTab(db, req),
  when: (db, req, now) => buildWhenTab(db, req, now),
  menu: (db, req) => ({
    ...buildMenuTab(db, req),
    costs: req.withCosts === false ? null : menuCosts(db, rangeOf(req), req.withProfit !== false),
  }),
  channels: (db, req) => ({ ...buildChannelsTab(db, req), ...channelsExtras(db, rangeOf(req), req.withProfit !== false && req.withCosts !== false) }),
  foodStock: (db, req, now) => buildFoodStockTab(db, req, now),
  team: (db, req) => buildTeamTab(db, req),
  profit: (db, req) => buildProfitTab(db, req),
};

export function isReportTab(x: unknown): x is ReportTab {
  return typeof x === 'string' && (REPORT_TABS as readonly string[]).includes(x);
}

/**
 * One tab's figures for one period. One read transaction: every figure on
 * the tab sees the same snapshot, even if a sale lands (on the till's
 * connection) while it is put together.
 */
export function buildReportTab<K extends ReportTab>(
  db: AppDatabase,
  kind: K,
  req: BusinessReportRequest,
  now: Date = new Date(),
): ReportTabFigures<K> {
  const build = BUILDERS[kind] as Builder<K>;
  return db.transaction(() => build(db, req, now))();
}

export function isAnalyticsKind(x: unknown): x is AnalyticsKind {
  return isReportTab(x) || (typeof x === 'string' && (EXTRA_ANALYTICS as readonly string[]).includes(x));
}

/**
 * Anything the worker is asked for (costing spec Phase 7): a tab, the trend
 * strip, the owner's week, "used vs should have used" between two stock
 * takes (Phase 8), the menu map or a what-if (Phase 9) — each in one read
 * transaction. `longReads`
 * false is the main process working it out itself (the worker is not
 * running): the trends then leave out every stretch over 31 days. The
 * owner's week reads a fortnight and the last 28 days' sales, so it always
 * fits.
 */
export function buildAnalytics(db: AppDatabase, kind: AnalyticsKind, request: unknown, now: Date, opts: { longReads: boolean } = { longReads: true }): unknown {
  if (isReportTab(kind)) return buildReportTab(db, kind, request as BusinessReportRequest, now);
  return db.transaction(() => {
    switch (kind) {
      case 'trends':
        return buildTrends(db, request as TrendsJob, now, { longReads: opts.longReads, maxDays: MAIN_THREAD_MAX_DAYS });
      case 'ownerWeek':
        return buildOwnerWeek(db, request as OwnerWeekJob, now, { longReads: opts.longReads });
      case 'variance':
        // The main process only asks for it itself with a window of 31 days or less (reports-handlers.ts).
        return buildVariance(db, request as VarianceJob);
      case 'menuMap':
        // The main process only asks for it itself with 31 days or less (reports-handlers.ts).
        return buildMenuMap(db, request as MenuMapRequest | undefined, now);
      case 'whatIf':
        // The last 28 days' sales and picks, always: it fits the main process too.
        return getWhatIf(db, request as WhatIfRequest, now);
    }
  })();
}

/** Whole trading days a period covers (a trading day is exactly one UTC day). */
export function periodDays(req: Pick<BusinessReportRequest, 'sinceIso' | 'untilIso'>): number {
  return Math.ceil((Date.parse(req.untilIso) - Date.parse(req.sinceIso)) / DAY_MS);
}

/** May the main process work this period out itself (the fallback)? At most a month. */
export function fitsMainThread(req: Pick<BusinessReportRequest, 'sinceIso' | 'untilIso'>): boolean {
  return periodDays(req) <= MAIN_THREAD_MAX_DAYS;
}

/** Rupee profit out of a Menu cost line (a login without profit.view). */
function withoutProfit(c: ReportLineCost): ReportLineCost {
  return c.profitCents === null && c.profitPerSaleCents === null ? c : { ...c, profitCents: null, profitPerSaleCents: null };
}

function menuCostsWithoutProfit(costs: ReportMenuCosts): ReportMenuCosts {
  const strip = (r: Record<string, ReportLineCost>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, withoutProfit(v)]));
  return { ...costs, items: strip(costs.items), categories: strip(costs.categories) };
}

function channelsWithoutProfit(data: ReportChannelsTab): ReportChannelsTab {
  return { ...data, profit: null, areas: data.areas.map((a) => ({ ...a, riderCents: null, contributionPerOrderCents: null })) };
}

/**
 * A tab as a login may read it (costing spec §2), in the main process so the
 * printout and the file carry nothing more:
 *  - without COST_CAPABILITY, Team & leakage says nothing of what wasted food
 *    cost, Menu has no cost columns, and Food cost & stock is never handed
 *    over (its channel refuses such a login before building it; this refuses
 *    again);
 *  - without profit.view (Phase 9: `canSeeProfit`, which also needs costs),
 *    Menu has no profit, Channels no rider cost or what orders earn, and the
 *    Profit tab is never handed over.
 */
export function reportTabForLogin<K extends ReportTab>(kind: K, data: ReportTabData[K], canSeeCosts: boolean, canSeeProfit = false): ReportTabData[K] {
  const profit = canSeeProfit && canSeeCosts;
  if (kind === 'profit' && !profit) throw new Error('Only the owner can see profit.');
  if (kind === 'menu') {
    const menu = data as ReportTabData['menu'];
    if (!canSeeCosts) return (menu.costs === null ? menu : { ...menu, costs: null }) as ReportTabData[K];
    if (!profit && menu.costs) return { ...menu, costs: menuCostsWithoutProfit(menu.costs) } as ReportTabData[K];
    return data;
  }
  if (kind === 'channels' && !profit) return channelsWithoutProfit(data as ReportChannelsTab) as ReportTabData[K];
  if (canSeeCosts) return data;
  if (kind === 'foodStock') throw new Error('Only a manager or the owner can see costs.');
  if (kind === 'team') {
    const team = data as ReportTabData['team'];
    return {
      ...team,
      foodCost: null,
      voids: team.voids.map(withoutWasteCost),
      refunds: team.refunds.map(withoutWasteCost),
    } as ReportTabData[K];
  }
  return data;
}
