import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { findUserByPin, touchUserLogin } from '../db/repositories/user-repo.js';
import { writeAudit } from '../db/repositories/audit-repo.js';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
}

/**
 * The auth service owns the single "currently logged-in user" for this device.
 * Sessions persist across app restarts so a closed laptop doesn't kick a cashier
 * mid-shift, but a fresh app boot will require fresh PIN entry by design
 * (sessions older than SESSION_MAX_AGE_MS are auto-closed).
 */

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

let currentSession: AuthenticatedUser | null = null;

export function getCurrentSession(): AuthenticatedUser | null {
  return currentSession;
}

export async function login(
  db: AppDatabase,
  pin: string,
  deviceId: string,
): Promise<AuthenticatedUser> {
  const user = await findUserByPin(db, pin);
  if (!user) throw new Error('Invalid PIN');

  const sessionId = uuidv7();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Close any stale sessions for this user on this device
    db.prepare(
      `UPDATE user_sessions SET ended_at = ? WHERE user_id = ? AND device_id = ? AND ended_at IS NULL`,
    ).run(now, user.id, deviceId);

    db.prepare(
      `INSERT INTO user_sessions (id, user_id, device_id, started_at) VALUES (?, ?, ?, ?)`,
    ).run(sessionId, user.id, deviceId, now);

    touchUserLogin(db, user.id);

    writeAudit(db, {
      entityType: 'user_sessions',
      entityId: sessionId,
      action: 'login',
      actorUserId: user.id,
      before: null,
      after: { userId: user.id, deviceId, startedAt: now },
    });
  });
  tx();

  currentSession = {
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    sessionId: sessionId as UUID,
  };

  log.info('User logged in', { userId: user.id, role: user.role });
  return currentSession;
}

export function logout(db: AppDatabase): void {
  if (!currentSession) return;

  const now = new Date().toISOString();
  const session = currentSession;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE user_sessions SET ended_at = ? WHERE id = ?`).run(now, session.sessionId);
    writeAudit(db, {
      entityType: 'user_sessions',
      entityId: session.sessionId,
      action: 'logout',
      actorUserId: session.id,
      before: { sessionId: session.sessionId },
      after: { endedAt: now },
    });
  });
  tx();

  currentSession = null;
  log.info('User logged out', { userId: session.id });
}

/**
 * On boot, try to recover a recent in-progress session. Returns the user if a
 * session that's < SESSION_MAX_AGE_MS old exists for this device.
 */
export function recoverSession(db: AppDatabase, deviceId: string): AuthenticatedUser | null {
  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, u.full_name, u.role
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.device_id = ? AND s.ended_at IS NULL AND s.started_at >= ?
        ORDER BY s.started_at DESC
        LIMIT 1`,
    )
    .get(deviceId, cutoff) as
    | { session_id: string; user_id: string; full_name: string; role: AuthenticatedUser['role'] }
    | undefined;

  if (!row) return null;

  currentSession = {
    id: row.user_id as UUID,
    fullName: row.full_name,
    role: row.role,
    sessionId: row.session_id as UUID,
  };
  return currentSession;
}

/**
 * Verify a manager-level PIN without changing the current session.
 * Used for discount approvals, void overrides, etc.
 */
export async function verifyManagerPin(
  db: AppDatabase,
  pin: string,
): Promise<{ approverUserId: string; approverName: string }> {
  const user = await findUserByPin(db, pin);
  if (!user) throw new Error('Invalid PIN');
  if (user.role !== 'manager' && user.role !== 'admin') {
    throw new Error('Not authorized — manager PIN required');
  }
  return { approverUserId: user.id, approverName: user.fullName };
}

/** Close any session that's been open longer than SESSION_MAX_AGE_MS (called on boot). */
export function reapStaleSessions(db: AppDatabase): void {
  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString();
  db.prepare(`UPDATE user_sessions SET ended_at = started_at WHERE ended_at IS NULL AND started_at < ?`).run(
    cutoff,
  );
}
