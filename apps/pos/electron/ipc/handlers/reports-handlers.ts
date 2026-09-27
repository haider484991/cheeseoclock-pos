import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import type { ZodError } from 'zod';
import {
  COST_CAPABILITY,
  err,
  hasCapability,
  ok,
  type ApiResult,
  type BusinessReportRequest,
  type DaypartsView,
  type OwnerWeek,
  type OwnerWeekWhich,
  type ReportEngine,
  type ReportMenuMap,
  type ReportTab,
  type ReportTabData,
  type ReportTabFigures,
  type ReportTrends,
  type ReportVariance,
} from '@cheeseoclock/shared-types';
import {
  dayNoteInputSchema,
  drawerLogInputSchema,
  menuMapInputSchema,
  removeDayNoteInputSchema,
  setDaypartsInputSchema,
  varianceInputSchema,
} from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from '../../db/connection.js';
import { mayProfit, requireCapability, requireProfit, REFUSED } from '../guards.js';
import { getLowStock } from '../../services/inventory-service.js';
import {
  buildAnalytics,
  buildReportTab,
  fitsMainThread,
  MAIN_THREAD_MAX_DAYS,
  periodDays,
  reportTabForLogin,
  type TabJob,
} from '../../services/analytics/report-tabs.js';
import { menuMapRange } from '../../services/analytics/menu-engineering.js';
import { WorkerRunError, type AnalyticsWorkerState } from '../../services/analytics/worker-client.js';
import { getAnalyticsWorker } from '../../services/analytics/worker-host.js';
import type { AnalyticsKind, AnalyticsRequest, ExtraAnalytics } from '../../services/analytics/worker-protocol.js';
import { ownerWeekForLogin, type OwnerWeekJob } from '../../services/analytics/owner-week.js';
import { daypartsInForce } from '../../services/analytics/heatmap.js';
import { addDayNote, removeDayNote } from '../../db/repositories/day-note-repo.js';
import { setBusinessSetting } from '../../db/repositories/business-settings-repo.js';
import { VARIANCE_MAIN_THREAD_MAX_DAYS, varianceWindowDays, type VarianceJob } from '../../services/analytics/stock-control.js';
import { readTillLink } from '../../services/till-link.js';
import { listDrawerLog } from '../../db/repositories/drawer-open-repo.js';

/**
 * The Reports page (costing spec Phase 3): one channel per tab —
 * reports:overview, when, menu, channels, foodStock, team — plus the
 * ingredients running low.
 *
 * Each tab channel is checked here, in the main process: report.view (a
 * cashier is refused), and Food cost & stock needs COST_CAPABILITY as well.
 * The figures are then worked out in the Reports worker thread
 * (services/analytics/worker.ts), so a year of Reports never holds up the
 * counter. If that worker could not start, the main process works a tab out
 * itself, for periods of 31 days or less only (the page shows a note), and
 * refuses longer ones in plain words.
 *
 * The whole-page `reports:business` was retired with this (the page was its
 * only caller: every tab, its printout and its file now use the tab
 * channels), as the older one-figure channels were with Phase 2.
 *
 * The owner's week (costing spec Phase 7), report.view like the tabs and
 * worked out in the same worker:
 *  - reports:ownerWeek: the Dashboard "This week" card and the weekly
 *    sheet; food cost, waste and every cost line of "Do this" only for
 *    COST_CAPABILITY (the worker leaves those checks out for anyone else, and
 *    ownerWeekForLogin drops them again here). Never rupee profit;
 *  - reports:trends: Overview's trend strip and 12 months (each month's
 *    food cost for COST_CAPABILITY only);
 *  - reports:addDayNote / removeDayNote: notes on days (report.view to add),
 *    through the repository, synced and audited;
 *  - reports:getDayparts (report.view) / setDayparts (the owner,
 *    settings.manage).
 * Without the worker, the owner's week (a fortnight) is worked out here;
 * the trends leave out every stretch over 31 days and say so.
 *
 * Stock takes (costing spec Phase 8): reports:variance, "used vs should
 * have used" between two stock takes and the real food cost between two
 * full ones — report.view and COST_CAPABILITY, like Food cost & stock;
 * worked out in the worker (without it, here, for a window of 31 days or
 * less). The second-till link's state is read here and handed to the
 * worker with the job (it can't read the sync settings), as it is for the
 * owner's week's stock-variance line.
 *
 * Profit (costing spec Phase 9), profit.view AND COST_CAPABILITY in the main
 * process (a cashier is refused; so is any login without profit.view):
 *  - reports:profit, the Profit tab (the waterfall, by channel and by
 *    category); "Between stock takes" sends the two stock takes, for the
 *    stock-loss step when both were full counts;
 *  - reports:menuMap, the menu map (the last 28 days unless a period is
 *    asked for);
 *  - Menu's cost columns (COST_CAPABILITY) and profit (profit.view), and
 *    Channels' rider cost and what orders earn (profit.view), are left out
 *    of the tab for a login without them — the worker is told not to work
 *    them out, and reportTabForLogin drops them again here, so the printout
 *    and the file carry nothing more;
 *  - the weekly sheet's profit before overheads (reports:ownerWeek).
 */

/** Longest period one report may cover — two years and a bit (leap day, comparison). */
const MAX_REPORT_DAYS = 800;

/** What the main process needs of the Reports worker (worker-client.ts AnalyticsWorkerClient). */
export interface ReportWorker {
  settled(): Promise<AnalyticsWorkerState>;
  run<K extends AnalyticsKind>(kind: K, request: AnalyticsRequest<K>, nowIso?: string): Promise<unknown>;
}

export interface ReportsHandlerDeps {
  /** The running Reports worker; null before it was started (the main process works tabs out). */
  worker: () => ReportWorker | null;
}

/** Plain words for a period the main process will not work out itself. */
export const TOO_LONG_WITHOUT_WORKER =
  `Reports over ${MAIN_THREAD_MAX_DAYS} days are worked out in the background, and that part of the till is not running. ` +
  `Pick ${MAIN_THREAD_MAX_DAYS} days or fewer, or restart the till.`;

/** A usable [since, until) pair of ISO instants, or a precondition error the page can show. */
function checkRange(sinceIso: unknown, untilIso: unknown, what: string): void {
  const since = typeof sinceIso === 'string' ? Date.parse(sinceIso) : NaN;
  const until = typeof untilIso === 'string' ? Date.parse(untilIso) : NaN;
  if (!Number.isFinite(since) || !Number.isFinite(until)) {
    throw new IpcGuardError({ code: 'validation_failed', message: `The ${what} dates are not valid` });
  }
  if (until <= since) {
    throw new IpcGuardError({ code: 'validation_failed', message: `The ${what} must end after it starts` });
  }
  if (until - since > MAX_REPORT_DAYS * 86_400_000) {
    throw new IpcGuardError({
      code: 'validation_failed',
      message: `Pick a shorter ${what} — reports cover up to two years at a time`,
    });
  }
}

/** "Between stock takes": the two stock takes, when sent (the Profit tab only). */
function stockTakesOf(p: Partial<BusinessReportRequest>): BusinessReportRequest['stockTakes'] {
  const st = p.stockTakes as unknown;
  if (st === undefined || st === null) return undefined;
  const pair = st as { fromCountId?: unknown; toCountId?: unknown };
  const ok = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 64;
  if (typeof st !== 'object' || !ok(pair.fromCountId) || !ok(pair.toCountId)) {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Pick the two stock takes' });
  }
  return { fromCountId: pair.fromCountId as string, toCountId: pair.toCountId as string };
}

/** The period (and comparison) a tab was asked for, checked. */
function tabRequest(payload: unknown): BusinessReportRequest {
  const p = (payload ?? {}) as Partial<BusinessReportRequest>;
  checkRange(p.sinceIso, p.untilIso, 'report period');
  const withCompare = p.compareSinceIso !== undefined || p.compareUntilIso !== undefined;
  if (withCompare) checkRange(p.compareSinceIso, p.compareUntilIso, 'comparison period');
  const stockTakes = stockTakesOf(p);
  return {
    sinceIso: p.sinceIso as string,
    untilIso: p.untilIso as string,
    ...(withCompare ? { compareSinceIso: p.compareSinceIso as string, compareUntilIso: p.compareUntilIso as string } : {}),
    ...(stockTakes ? { stockTakes } : {}),
  };
}

/** A worker failure that is not the owner's to read (logged with a reference by defineHandler). */
class ReportWorkerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportWorkerFailure';
  }
}

/**
 * Ask the worker, when it is running. Its figures, or why the main process
 * must work them out itself ('unavailable', 'crashed'); a superseded, timed
 * out or failed ask is answered here, in plain words.
 */
async function fromWorker<K extends AnalyticsKind>(
  worker: ReportWorker | null,
  kind: K,
  request: AnalyticsRequest<K>,
): Promise<{ data: unknown } | { whyNot: string }> {
  let whyNot: string = TOO_LONG_WITHOUT_WORKER;
  if (worker && (await worker.settled()) === 'ready') {
    try {
      return { data: await worker.run(kind, request) };
    } catch (e) {
      if (!(e instanceof WorkerRunError)) throw e;
      switch (e.code) {
        case 'superseded':
          throw new IpcGuardError({ code: 'conflict', message: 'A newer report was asked for.', retryable: true });
        case 'timeout':
          throw new IpcGuardError({
            code: 'precondition_failed',
            message: 'The report took longer than 30 seconds. Pick a shorter period and try again.',
            retryable: true,
          });
        case 'failed':
          throw new ReportWorkerFailure(`Report ${kind} failed in the worker: ${e.message}`);
        case 'crashed':
          whyNot = e.message;
          break;
        case 'unavailable':
          break;
      }
    }
  }
  return { whyNot };
}

/**
 * One tab's figures: from the worker when it is running, else (31 days or
 * less) from the main process. The login's rules are applied by the caller.
 */
export async function workOutTab<K extends ReportTab>(
  db: AppDatabase,
  worker: ReportWorker | null,
  kind: K,
  req: BusinessReportRequest,
): Promise<ReportTabData[K]> {
  const got = await fromWorker(worker, kind, req as AnalyticsRequest<K>);
  if ('data' in got) return { ...(got.data as ReportTabFigures<K>), engine: 'worker' } as ReportTabData[K];
  // The fallback: the till's own connection, for a month at most.
  if (!fitsMainThread(req)) throw new IpcGuardError({ code: 'precondition_failed', message: got.whyNot, retryable: true });
  return { ...buildReportTab(db, kind, req), engine: 'main' } as ReportTabData[K];
}

/**
 * The trends or the owner's week: from the worker when it is running, else
 * from the main process: the owner's week whole (it reads a fortnight and
 * the last 28 days), the trends without their stretches over 31 days.
 */
export async function workOutExtra<K extends ExtraAnalytics>(
  db: AppDatabase,
  worker: ReportWorker | null,
  kind: K,
  job: AnalyticsRequest<K>,
): Promise<{ data: unknown; engine: ReportEngine }> {
  const got = await fromWorker(worker, kind, job);
  if ('data' in got) return { data: got.data, engine: 'worker' };
  return { data: buildAnalytics(db, kind, job, new Date(), { longReads: false }), engine: 'main' };
}

function validationFailed(error: ZodError) {
  const first = error.issues[0];
  return err({ code: 'validation_failed', message: first?.message ?? 'Invalid input' });
}

/** Which week the card or the sheet asks for: this one unless last is named. */
function weekOf(payload: unknown): OwnerWeekWhich {
  return (payload as { week?: unknown } | undefined)?.week === 'last' ? 'last' : 'this';
}

/** The printed sheet asks for its own lines too; the Dashboard card does not. */
function forSheet(payload: unknown): boolean {
  return (payload as { sheet?: unknown } | undefined)?.sheet === true;
}

function daypartsView(db: AppDatabase): DaypartsView {
  const p = daypartsInForce(db);
  return { dayparts: p.dayparts, isDefault: p.isDefault, savedAt: p.savedAt };
}

export function registerReportsHandlers(ctx: HandlerContext, deps: ReportsHandlerDeps = { worker: getAnalyticsWorker }): void {
  defineHandler('reports:lowStock', ctx, () => {
    requireCapability('report.view', REFUSED.reports);
    return ok(getLowStock(ctx.db));
  });

  /** A tab: who may see it, the period, then its figures as this login may read them. */
  async function tab<K extends ReportTab>(kind: K, payload: unknown): Promise<ApiResult<ReportTabData[K]>> {
    const s = requireCapability('report.view', REFUSED.reports);
    const canSeeCosts = hasCapability(s.role, COST_CAPABILITY);
    // Costs are the owner's business figures (costing spec §2); profit is profit.view's (Phase 9).
    if (kind === 'foodStock' && !canSeeCosts) throw new IpcGuardError({ code: 'forbidden', message: REFUSED.costs });
    if (kind === 'profit') requireProfit();
    const canSeeProfit = mayProfit(s);
    const req = tabRequest(payload);
    // What the login may see goes with the job, so the worker does not work out rupees nobody is shown.
    const job: TabJob = {
      ...req,
      withCosts: canSeeCosts,
      withProfit: canSeeProfit,
      ...(kind === 'profit' && req.stockTakes ? { link: readTillLink(ctx.db) } : {}),
    };
    if (kind !== 'profit') delete job.stockTakes;
    const data = await workOutTab(ctx.db, deps.worker(), kind, job);
    return ok(reportTabForLogin(kind, data, canSeeCosts, canSeeProfit));
  }

  defineHandler('reports:overview', ctx, (_ctx, payload) => tab('overview', payload));
  defineHandler('reports:when', ctx, (_ctx, payload) => tab('when', payload));
  defineHandler('reports:menu', ctx, (_ctx, payload) => tab('menu', payload));
  defineHandler('reports:channels', ctx, (_ctx, payload) => tab('channels', payload));
  defineHandler('reports:foodStock', ctx, (_ctx, payload) => tab('foodStock', payload));
  defineHandler('reports:team', ctx, (_ctx, payload) => tab('team', payload));
  defineHandler('reports:profit', ctx, (_ctx, payload) => tab('profit', payload));

  // ---- The menu map (costing spec 4.8, Phase 9) ----

  /** Each category's dishes by how popular and how profitable: report.view, profit.view and costs. */
  defineHandler('reports:menuMap', ctx, async (_ctx, payload) => {
    requireCapability('report.view', REFUSED.reports);
    requireProfit();
    const parsed = menuMapInputSchema.safeParse(payload ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const req = parsed.data.sinceIso && parsed.data.untilIso ? { sinceIso: parsed.data.sinceIso, untilIso: parsed.data.untilIso } : undefined;
    if (req) checkRange(req.sinceIso, req.untilIso, 'report period');
    const got = await fromWorker(deps.worker(), 'menuMap', req);
    if ('data' in got) return ok({ ...(got.data as Omit<ReportMenuMap, 'engine'>), engine: 'worker' as const });
    // The fallback: the till's own connection, a month at most (the last 28 days always fit).
    if (periodDays(menuMapRange(req, new Date())) > MAIN_THREAD_MAX_DAYS) {
      throw new IpcGuardError({ code: 'precondition_failed', message: got.whyNot, retryable: true });
    }
    const data = buildAnalytics(ctx.db, 'menuMap', req, new Date(), { longReads: false }) as Omit<ReportMenuMap, 'engine'>;
    return ok({ ...data, engine: 'main' as const });
  });

  // ---- Stock takes: used vs should have used (costing spec Phase 8) ----

  defineHandler('reports:variance', ctx, async (_ctx, payload) => {
    const s = requireCapability('report.view', REFUSED.reports);
    if (!hasCapability(s.role, COST_CAPABILITY)) throw new IpcGuardError({ code: 'forbidden', message: REFUSED.costs });
    const parsed = varianceInputSchema.safeParse(payload ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const job: VarianceJob = { fromCountId: parsed.data.fromCountId ?? null, toCountId: parsed.data.toCountId ?? null, link: readTillLink(ctx.db) };
    const got = await fromWorker(deps.worker(), 'variance', job);
    if ('data' in got) return ok(got.data as ReportVariance);
    // The fallback: the till's own connection, for a window of a month at most.
    if (varianceWindowDays(ctx.db, job) > VARIANCE_MAIN_THREAD_MAX_DAYS) {
      throw new IpcGuardError({ code: 'precondition_failed', message: got.whyNot, retryable: true });
    }
    return ok(buildAnalytics(ctx.db, 'variance', job, new Date(), { longReads: false }) as ReportVariance);
  });

  // ---- The cash drawer log (migration 0042) ----

  // Every drawer open, a page at a time: a small keyset read on indexed
  // columns, so it runs here rather than in the worker. report.view (the
  // owner): a manager or cashier is refused like the rest of Reports.
  defineHandler('reports:drawerLog', ctx, (_ctx, payload) => {
    requireCapability('report.view', REFUSED.reports);
    const parsed = drawerLogInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(listDrawerLog(ctx.db, parsed.data, ctx.deviceId));
  });

  // ---- The owner's week (costing spec Phase 7) ----

  /**
   * The Dashboard card and the weekly sheet: report.view; the cost lines for
   * COST_CAPABILITY only; the sheet's profit before overheads for profit.view
   * only (Phase 9). Never profit on the Dashboard card.
   */
  defineHandler('reports:ownerWeek', ctx, async (_ctx, payload) => {
    const s = requireCapability('report.view', REFUSED.reports);
    const canSeeCosts = hasCapability(s.role, COST_CAPABILITY);
    const sheet = forSheet(payload);
    const canSeeProfit = sheet && mayProfit(s);
    const job: OwnerWeekJob = { week: weekOf(payload), withCosts: canSeeCosts, withProfit: canSeeProfit, sheet, link: readTillLink(ctx.db) };
    const { data, engine } = await workOutExtra(ctx.db, deps.worker(), 'ownerWeek', job);
    return ok(ownerWeekForLogin({ ...(data as Omit<OwnerWeek, 'engine'>), engine }, canSeeCosts, canSeeProfit));
  });

  /** Overview's trend strip and 12 months: report.view; each month's food cost for COST_CAPABILITY only. */
  defineHandler('reports:trends', ctx, async () => {
    const s = requireCapability('report.view', REFUSED.reports);
    const canSeeCosts = hasCapability(s.role, COST_CAPABILITY);
    const { data, engine } = await workOutExtra(ctx.db, deps.worker(), 'trends', { withCosts: canSeeCosts });
    const trends: ReportTrends = { ...(data as Omit<ReportTrends, 'engine'>), engine };
    return ok(canSeeCosts ? trends : { ...trends, monthCosts: null });
  });

  /** A note for a day (report.view): through the repository, synced and audited. */
  defineHandler('reports:addDayNote', ctx, (_ctx, payload) => {
    const s = requireCapability('report.view', REFUSED.reports);
    const parsed = dayNoteInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    try {
      return ok(addDayNote(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
    } catch (e) {
      // The day will not do (too far ahead, before 2020): the repository's plain words.
      return err({ code: 'validation_failed', message: e instanceof Error ? e.message : 'That note could not be added' });
    }
  });

  defineHandler('reports:removeDayNote', ctx, (_ctx, payload) => {
    const s = requireCapability('report.view', REFUSED.reports);
    const parsed = removeDayNoteInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok({ removed: removeDayNote(ctx.db, parsed.data.id, { userId: s.id, deviceId: ctx.deviceId }) });
  });

  /** The parts of the day Reports → When uses (a setting, read like the other costing settings). */
  defineHandler('reports:getDayparts', ctx, () => {
    requireCapability('report.view', REFUSED.reports);
    return ok(daypartsView(ctx.db));
  });

  /** The owner changes them (settings.manage): business-settings-repo, synced and audited, both tills. */
  defineHandler('reports:setDayparts', ctx, (_ctx, payload) => {
    requireCapability('report.view', REFUSED.reports);
    const s = requireCapability('settings.manage', 'Only the owner can change the parts of the day.');
    const parsed = setDaypartsInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    setBusinessSetting(ctx.db, 'analytics.dayparts', parsed.data.dayparts, { userId: s.id, deviceId: ctx.deviceId });
    return ok(daypartsView(ctx.db));
  });
}
