import type { AppDatabase } from '../db/connection.js';
import { hasCapability, type AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../services/auth-service.js';
import { IpcGuardError } from './registry.js';

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

export function requireSettingsManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'settings.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Admin or manager required' });
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
