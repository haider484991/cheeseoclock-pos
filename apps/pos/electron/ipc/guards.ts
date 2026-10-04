import type { AppDatabase } from '../db/connection.js';
import { COST_CAPABILITY, PROFIT_CAPABILITY, hasCapability, type AuthenticatedUser, type Capability } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../services/auth-service.js';
import { licenceService } from '../services/licence/licence-service.js';
import { IpcGuardError } from './registry.js';

/**
 * New orders and payments need a licence that still sells: the free trial,
 * the paid period or its grace days (licence-core.ts). Everything else on the
 * till stays open when it has run out. The message is the card's own words.
 */
export function requireLicenceForSales(): void {
  const status = licenceService.status();
  if (status.salesAllowed) return;
  throw new IpcGuardError({
    code: 'precondition_failed',
    message: `${status.message} (Settings → About → Licence.)`,
    details: { licence: status.state, daysLeft: status.daysLeft },
  });
}

/**
 * Shared guards for IPC handlers. Each throws IpcGuardError, which
 * defineHandler maps to { ok: false, error } for the renderer.
 */

/** True until the first user exists — the onboarding wizard is on screen. */
export function isSetupPhase(db: AppDatabase): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`)
    .get() as { n: number };
  return row.n === 0;
}

/**
 * The owner's settings (settings.manage: the owner alone since v0.7.18 —
 * managers and cashiers are refused here, in the main process).
 */
export function requireSettingsManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'settings.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: REFUSED.settings });
  }
  return session;
}

/**
 * The owner's login. Restoring or deleting backups rewrites or discards
 * history, so a manager's login is not enough — a manager covering up a
 * void by restoring yesterday's copy is exactly the case this exists for.
 */
export function requireAdmin(what: string): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (session.role !== 'admin') {
    throw new IpcGuardError({
      code: 'forbidden',
      message: `${what} needs the owner (admin) login`,
    });
  }
  return session;
}

/**
 * Owner login, except on a brand-new install where no login can exist yet:
 * that is the "restore this PC from a backup" path of the onboarding wizard.
 * Returns null in that setup phase.
 */
export function requireAdminOrSetupPhase(db: AppDatabase, what: string): AuthenticatedUser | null {
  if (isSetupPhase(db)) return null;
  return requireAdmin(what);
}

/**
 * Someone signed in whose role has `capability`. Nobody signed in is
 * 'unauthenticated' (the screen drops to the PIN pad); a role without it is
 * 'forbidden' with `message`, which is shown to that person as it is.
 */
export function requireCapability(capability: Capability, message: string): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, capability)) {
    throw new IpcGuardError({ code: 'forbidden', message });
  }
  return session;
}

/** What a counter login is told when it reaches a manager's area. Plain words, shown as they are. */
export const REFUSED = {
  customers: 'Only a manager or the owner can open the customer list.',
  history: 'Only a manager or the owner can look at past orders.',
  shiftTotals: 'Only a manager or the owner can see shift totals.',
  shiftHistory: 'Only the owner can look through past shifts.',
  earlierShiftCash: "Only a manager or the owner can see an earlier shift's cash.",
  stock: 'Only a manager or the owner can see stock, recipes and suppliers.',
  costs: 'Only a manager or the owner can see costs.',
  prices: 'Only a manager or the owner can change prices.',
  purchases: 'Only a manager or the owner can record purchases or see what was spent.',
  reports: 'Only the owner can see reports.',
  settings: 'Only the owner can change the shop’s settings.',
  stockTakes: 'Only a manager or the owner can do a stock take or see what went missing.',
  profit: 'Only the owner can see profit.',
  // The shift report printed again (shifts:printReport, v0.7.35).
  /** A cashier's login, with no manager's PIN or password typed. */
  shiftReportPin: "A manager's PIN or password is needed to print the shift report",
  /** A manager, more than 15 minutes after the close. */
  shiftReportOlder: 'Only the owner can print an older shift report - from Shift history',
  /** A manager, a shift closed on the other till. */
  shiftReportOtherTill: "Only the owner can print the other till's shift report - from Shift history",
  shiftStillOpen: 'This shift is still open - close it first',
  shiftNotFound: 'That shift was not found',
  /** No report was saved with the close: before 0.7.35, an older till, or it could not be made. */
  shiftReportNotSaved: 'This shift was closed before the till printed shift reports',
  shiftReportNewer: 'This shift report was made by a newer till - update this till to print it',
  shiftReportUnreadable: "This shift's saved report could not be read",
} as const;

/**
 * Someone signed in who may see rupee profit (costing spec D6, Phase 9):
 * profit.view, and — since profit says what things cost — COST_CAPABILITY
 * too. 'forbidden' with the plain words otherwise.
 */
export function requireProfit(): AuthenticatedUser {
  const s = requireCapability(PROFIT_CAPABILITY, REFUSED.profit);
  if (!hasCapability(s.role, COST_CAPABILITY)) throw new IpcGuardError({ code: 'forbidden', message: REFUSED.profit });
  return s;
}

/** May this login see rupee profit (profit.view and COST_CAPABILITY)? */
export function mayProfit(s: Pick<AuthenticatedUser, 'role'>): boolean {
  return hasCapability(s.role, PROFIT_CAPABILITY) && hasCapability(s.role, COST_CAPABILITY);
}
