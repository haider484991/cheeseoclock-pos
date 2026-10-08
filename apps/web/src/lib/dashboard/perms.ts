import type { DashUser } from './session';

/**
 * What a signed-in person may see on the dashboard — the till's roles
 * (shared-types auth.ts ROLE_CAPABILITIES; dashboard.ts WHO SEES WHAT):
 *  - orders, the shift open now, stock, the menu with costs: owner and
 *    managers (order.history, shift.close, COST_CAPABILITY);
 *  - sales reports, past shifts, cash in/out history: report.view — the
 *    owner, or a manager the owner ticked;
 *  - profit, the drawer log: the owner alone.
 * The pages and their data both ask these; a refused section is never
 * fetched, not just hidden.
 */

export function seesReports(u: DashUser): boolean {
  return u.role === 'owner' || u.seesReports;
}

export function seesProfit(u: DashUser): boolean {
  return u.role === 'owner';
}

export function seesDrawerLog(u: DashUser): boolean {
  return u.role === 'owner';
}

/** Costs of ingredients and dishes (the till's COST_CAPABILITY: owner and managers). */
export function seesCosts(u: DashUser): boolean {
  return u.role === 'owner' || u.role === 'manager';
}

export function roleWord(u: Pick<DashUser, 'role'>): string {
  return u.role === 'owner' ? 'Owner' : 'Manager';
}
