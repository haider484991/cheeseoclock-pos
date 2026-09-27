import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { COST_CAPABILITY, ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import { getLowStock } from '../../services/inventory-service.js';
import { getBusinessReport, reportForLogin } from '../../services/business-report.js';

/**
 * The Reports page. Two channels: the whole page for one period
 * (`reports:business`) and the ingredients running low. The older one-figure
 * channels (salesSummary, cogs…) and reports-service.ts were retired with
 * costing Phase 2: nothing called them, and their cost of goods was valued
 * at today's prices.
 */

/** Longest period one report may cover — two years and a bit (leap day, comparison). */
const MAX_REPORT_DAYS = 800;

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

function requireReportView(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'report.view')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Reports require manager or admin role' });
  }
  return session;
}

export function registerReportsHandlers(ctx: HandlerContext): void {
  defineHandler('reports:lowStock', ctx, () => {
    requireReportView();
    return ok(getLowStock(ctx.db));
  });
  defineHandler('reports:business', ctx, (_ctx, payload) => {
    const s = requireReportView();
    checkRange(payload?.sinceIso, payload?.untilIso, 'report period');
    const withCompare = payload.compareSinceIso !== undefined || payload.compareUntilIso !== undefined;
    if (withCompare) checkRange(payload.compareSinceIso, payload.compareUntilIso, 'comparison period');
    const report = getBusinessReport(ctx.db, {
      sinceIso: payload.sinceIso,
      untilIso: payload.untilIso,
      ...(withCompare ? { compareSinceIso: payload.compareSinceIso, compareUntilIso: payload.compareUntilIso } : {}),
    });
    // Food cost and waste are costs: only for a login that may see them.
    return ok(reportForLogin(report, hasCapability(s.role, COST_CAPABILITY)));
  });
}
