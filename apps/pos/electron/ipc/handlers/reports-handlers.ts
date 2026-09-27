import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import {
  COST_CAPABILITY,
  hasCapability,
  ok,
  type ApiResult,
  type BusinessReportRequest,
  type ReportTab,
  type ReportTabData,
  type ReportTabFigures,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { requireCapability, REFUSED } from '../guards.js';
import { getLowStock } from '../../services/inventory-service.js';
import { buildReportTab, fitsMainThread, MAIN_THREAD_MAX_DAYS, reportTabForLogin } from '../../services/analytics/report-tabs.js';
import { WorkerRunError, type AnalyticsWorkerState } from '../../services/analytics/worker-client.js';
import { getAnalyticsWorker } from '../../services/analytics/worker-host.js';

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
 */

/** Longest period one report may cover — two years and a bit (leap day, comparison). */
const MAX_REPORT_DAYS = 800;

/** What the main process needs of the Reports worker (worker-client.ts AnalyticsWorkerClient). */
export interface ReportWorker {
  settled(): Promise<AnalyticsWorkerState>;
  run(kind: ReportTab, request: BusinessReportRequest, nowIso?: string): Promise<unknown>;
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

/** The period (and comparison) a tab was asked for, checked. */
function tabRequest(payload: unknown): BusinessReportRequest {
  const p = (payload ?? {}) as Partial<BusinessReportRequest>;
  checkRange(p.sinceIso, p.untilIso, 'report period');
  const withCompare = p.compareSinceIso !== undefined || p.compareUntilIso !== undefined;
  if (withCompare) checkRange(p.compareSinceIso, p.compareUntilIso, 'comparison period');
  return {
    sinceIso: p.sinceIso as string,
    untilIso: p.untilIso as string,
    ...(withCompare ? { compareSinceIso: p.compareSinceIso as string, compareUntilIso: p.compareUntilIso as string } : {}),
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
 * One tab's figures: from the worker when it is running, else (31 days or
 * less) from the main process. The login's rules are applied by the caller.
 */
export async function workOutTab<K extends ReportTab>(
  db: AppDatabase,
  worker: ReportWorker | null,
  kind: K,
  req: BusinessReportRequest,
): Promise<ReportTabData[K]> {
  let whyNot: string = TOO_LONG_WITHOUT_WORKER;
  if (worker && (await worker.settled()) === 'ready') {
    try {
      const figures = (await worker.run(kind, req)) as ReportTabFigures<K>;
      return { ...figures, engine: 'worker' } as ReportTabData[K];
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
          throw new ReportWorkerFailure(`Report tab ${kind} failed in the worker: ${e.message}`);
        case 'crashed':
          whyNot = e.message;
          break;
        case 'unavailable':
          break;
      }
    }
  }
  // The fallback: the till's own connection, for a month at most.
  if (!fitsMainThread(req)) throw new IpcGuardError({ code: 'precondition_failed', message: whyNot, retryable: true });
  return { ...buildReportTab(db, kind, req), engine: 'main' } as ReportTabData[K];
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
    // Costs are the owner's business figures (costing spec §2).
    if (kind === 'foodStock' && !canSeeCosts) throw new IpcGuardError({ code: 'forbidden', message: REFUSED.costs });
    const data = await workOutTab(ctx.db, deps.worker(), kind, tabRequest(payload));
    return ok(reportTabForLogin(kind, data, canSeeCosts));
  }

  defineHandler('reports:overview', ctx, (_ctx, payload) => tab('overview', payload));
  defineHandler('reports:when', ctx, (_ctx, payload) => tab('when', payload));
  defineHandler('reports:menu', ctx, (_ctx, payload) => tab('menu', payload));
  defineHandler('reports:channels', ctx, (_ctx, payload) => tab('channels', payload));
  defineHandler('reports:foodStock', ctx, (_ctx, payload) => tab('foodStock', payload));
  defineHandler('reports:team', ctx, (_ctx, payload) => tab('team', payload));
}
