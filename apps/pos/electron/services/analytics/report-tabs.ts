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
import { REPORT_TABS, type BusinessReportRequest, type ReportTab, type ReportTabData, type ReportTabFigures } from '@cheeseoclock/shared-types';
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

/** The longest period the main process works out itself when the worker is not there (a month). */
export const MAIN_THREAD_MAX_DAYS = 31;

type Builder<K extends ReportTab> = (db: AppDatabase, req: BusinessReportRequest, now: Date) => ReportTabFigures<K>;

const BUILDERS: { [K in ReportTab]: Builder<K> } = {
  overview: (db, req) => buildOverviewTab(db, req),
  when: (db, req) => buildWhenTab(db, req),
  menu: (db, req) => buildMenuTab(db, req),
  channels: (db, req) => buildChannelsTab(db, req),
  foodStock: (db, req, now) => buildFoodStockTab(db, req, now),
  team: (db, req) => buildTeamTab(db, req),
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

/** Whole trading days a period covers (a trading day is exactly one UTC day). */
export function periodDays(req: Pick<BusinessReportRequest, 'sinceIso' | 'untilIso'>): number {
  return Math.ceil((Date.parse(req.untilIso) - Date.parse(req.sinceIso)) / DAY_MS);
}

/** May the main process work this period out itself (the fallback)? At most a month. */
export function fitsMainThread(req: Pick<BusinessReportRequest, 'sinceIso' | 'untilIso'>): boolean {
  return periodDays(req) <= MAIN_THREAD_MAX_DAYS;
}

/**
 * A tab as a login may read it (costing spec §2), in the main process so the
 * printout and the file carry nothing more: without COST_CAPABILITY, Team &
 * leakage says nothing of what wasted food cost, and Food cost & stock is
 * never handed over (its channel refuses such a login before building it;
 * this refuses again).
 */
export function reportTabForLogin<K extends ReportTab>(kind: K, data: ReportTabData[K], canSeeCosts: boolean): ReportTabData[K] {
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
