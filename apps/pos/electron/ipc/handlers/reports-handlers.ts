import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  getSalesSummary,
  getSalesByDay,
  getSalesByHour,
  getSalesByCategory,
  getTopItems,
  getSalesByMode,
  getSalesByPaymentMethod,
  getSalesByCashier,
  getDiscountSummary,
  getLowStock,
  getCogs,
  getCashSummary,
} from '../../services/reports-service.js';

function requireReportView(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'report.view')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Reports require manager or admin role' });
  }
  return session;
}

export function registerReportsHandlers(ctx: HandlerContext): void {
  defineHandler('reports:salesSummary', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesSummary(ctx.db, payload));
  });
  defineHandler('reports:salesByDay', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByDay(ctx.db, payload));
  });
  defineHandler('reports:salesByHour', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByHour(ctx.db, payload));
  });
  defineHandler('reports:salesByCategory', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByCategory(ctx.db, payload));
  });
  defineHandler('reports:topItems', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getTopItems(ctx.db, payload, payload.limit));
  });
  defineHandler('reports:salesByMode', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByMode(ctx.db, payload));
  });
  defineHandler('reports:salesByPaymentMethod', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByPaymentMethod(ctx.db, payload));
  });
  defineHandler('reports:salesByCashier', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getSalesByCashier(ctx.db, payload));
  });
  defineHandler('reports:discounts', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getDiscountSummary(ctx.db, payload));
  });
  defineHandler('reports:lowStock', ctx, () => {
    requireReportView();
    return ok(getLowStock(ctx.db));
  });
  defineHandler('reports:cogs', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(getCogs(ctx.db, payload));
  });
  defineHandler('reports:cashSummary', ctx, (_ctx, payload) => {
    requireReportView();
    return ok(
      getCashSummary(
        ctx.db,
        { sinceIso: payload.sinceIso, untilIso: payload.untilIso },
        payload.openingCashCents ?? 0,
      ),
    );
  });
}
