import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { findUserBySecret, touchUserLogin } from '../db/repositories/user-repo.js';
import { writeAudit } from '../db/repositories/audit-repo.js';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';
import { normalizeSecret, secretProblem } from '@cheeseoclock/shared-schemas';
import {
  assertSecretNotLocked,
  clearSecretAttempts,
  oneSecretCheckAtATime,
  recordSecretFailure,
} from './login-attempts.js';

/**
 * The auth service owns the single "currently logged-in user" for this device.
 * Sessions persist across app restarts so a closed laptop doesn't kick a cashier
 * mid-shift, but a fresh app boot will require fresh PIN or password entry by
 * design (sessions older than SESSION_MAX_AGE_MS are auto-closed).
 *
 * Everyone signs in with a number PIN or a password (sign-in-secret.ts in
 * shared-schemas); the same rules and the same lockout (login-attempts.ts)
 * apply to both, and to every manager approval. What was typed is never
 * logged or stored — only argon2id hashes and HMAC-keyed attempt counters.
 */

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * An owner or manager login left open on the counter hands anyone walking past
 * the settings, the staff list and the reports. It ends after this long with
 * no one touching the till (key presses and clicks — the screens that refresh
 * themselves don't count). Cashiers work the till all day and are not timed
 * out; every login still ends after SESSION_MAX_AGE_MS.
 */
export const ELEVATED_IDLE_MS = 15 * 60 * 1000;

/** A PIN or password nobody has. */
export const WRONG_SECRET = 'PIN or password is wrong';
/**
 * A manager approval that failed. One message whether nobody has that secret
 * or a cashier does: a separate "not a manager" told whoever typed it that
 * the string is a real staff password, which may be used elsewhere too.
 */
export const NOT_A_MANAGER = "That is not a manager's PIN or password";

/**
 * The typed secret, normalized, or a plain-words refusal. A value that breaks
 * the rules is refused before the lockout lookup and before any hash, and is
 * not counted as a guess (it can't be anyone's). Also what stops an approval
 * with no PIN at all from reaching the hash check (orders:refund once passed
 * `undefined` straight through and showed a TypeError on the screen).
 */
function readSecret(raw: unknown): string {
  const problem = secretProblem(raw);
  if (problem !== null) throw new Error(problem);
  return normalizeSecret(raw as string);
}

let currentSession: AuthenticatedUser | null = null;
let sessionDb: AppDatabase | null = null;
let sessionStartedAtMs = 0;
let lastActivityAtMs = 0;

/** Someone pressed a key or clicked on the till (renderer → `auth:activity`). */
export function noteActivity(): void {
  if (currentSession) lastActivityAtMs = Date.now();
}

/**
 * The logged-in user, or null. Also where a login ends: an owner or manager
 * idle for ELEVATED_IDLE_MS, any login older than SESSION_MAX_AGE_MS, and a
 * user switched off since they logged in. The role is read again each time, so
 * a manager demoted to cashier loses manager rights at once, not at next login.
 */
export function getCurrentSession(): AuthenticatedUser | null {
  if (!currentSession) return null;
  const now = Date.now();
  if (now - sessionStartedAtMs > SESSION_MAX_AGE_MS) {
    endSession('session_expired');
    return null;
  }
  if (currentSession.role !== 'cashier' && now - lastActivityAtMs > ELEVATED_IDLE_MS) {
    endSession('session_idle_timeout');
    return null;
  }
  if (sessionDb) {
    const row = sessionDb
      .prepare(`SELECT role, is_active, deleted_at FROM users WHERE id = ?`)
      .get(currentSession.id) as
      | { role: AuthenticatedUser['role']; is_active: number; deleted_at: string | null }
      | undefined;
    if (!row || row.is_active !== 1 || row.deleted_at !== null) {
      endSession('session_revoked');
      return null;
    }
    if (row.role !== currentSession.role) {
      log.info('Session role changed', { userId: currentSession.id, from: currentSession.role, to: row.role });
      currentSession = { ...currentSession, role: row.role };
    }
  }
  return currentSession;
}

function endSession(action: 'logout' | 'session_expired' | 'session_idle_timeout' | 'session_revoked'): void {
  const session = currentSession;
  const db = sessionDb;
  currentSession = null;
  sessionDb = null;
  if (!session || !db) return;
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.prepare(`UPDATE user_sessions SET ended_at = ? WHERE id = ?`).run(now, session.sessionId);
      writeAudit(db, {
        entityType: 'user_sessions',
        entityId: session.sessionId,
        action,
        actorUserId: session.id,
        before: { sessionId: session.sessionId },
        after: { endedAt: now },
      });
    })();
  } catch (e) {
    log.warn('Ending the session failed to write', { error: String(e) });
  }
  log.info('Session ended', { userId: session.id, action });
}

/** Sign in with a PIN or a password. */
export async function login(
  db: AppDatabase,
  pin: string,
  deviceId: string,
): Promise<AuthenticatedUser> {
  const secret = readSecret(pin);
  const user = await oneSecretCheckAtATime(async () => {
    assertSecretNotLocked(db, secret);
    const found = await findUserBySecret(db, secret);
    if (!found) {
      recordSecretFailure(db, secret);
      throw new Error(WRONG_SECRET);
    }
    clearSecretAttempts(db, secret);
    return found;
  });

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
  sessionDb = db;
  sessionStartedAtMs = Date.now();
  lastActivityAtMs = sessionStartedAtMs;

  log.info('User logged in', { userId: user.id, role: user.role });
  return currentSession;
}

export function logout(db: AppDatabase): void {
  if (!currentSession) return;
  sessionDb = db;
  endSession('logout');
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
  sessionDb = db;
  sessionStartedAtMs = Date.now();
  lastActivityAtMs = sessionStartedAtMs;
  return currentSession;
}

/**
 * Verify a manager's PIN or password without changing the current session.
 * Used for discount approvals, cancel / refund overrides, cash in/out. A
 * cashier's own secret is refused (and counted, as a wrong guess is).
 */
export async function verifyManagerPin(
  db: AppDatabase,
  pin: string,
): Promise<{ approverUserId: string; approverName: string }> {
  const secret = readSecret(pin);
  return oneSecretCheckAtATime(async () => {
    assertSecretNotLocked(db, secret);
    const user = await findUserBySecret(db, secret);
    if (!user || (user.role !== 'manager' && user.role !== 'admin')) {
      // A cashier's secret typed as a manager override counts as a failed
      // attempt too (someone is trying staff secrets as approvals).
      recordSecretFailure(db, secret);
      throw new Error(NOT_A_MANAGER);
    }
    clearSecretAttempts(db, secret);
    return { approverUserId: user.id, approverName: user.fullName };
  });
}

/** Close any session that's been open longer than SESSION_MAX_AGE_MS (called on boot). */
export function reapStaleSessions(db: AppDatabase): void {
  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString();
  db.prepare(`UPDATE user_sessions SET ended_at = started_at WHERE ended_at IS NULL AND started_at < ?`).run(
    cutoff,
  );
}
