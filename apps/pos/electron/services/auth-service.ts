import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
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

// Brute-force protection. Argon2id alone is insufficient at PIN entropy
// (~10k combinations for a 4-digit PIN), so we layer a per-PIN-hash sliding
// window counter on top. The lockout escalates with consecutive failures:
//   5 failures → 30s lockout
//   10 failures → 5 min lockout
//   15+ failures → 30 min lockout
// A successful login clears the row entirely.
const PIN_LOCKOUT_TIERS = [
  { threshold: 15, lockMs: 30 * 60 * 1000 }, // 30 min
  { threshold: 10, lockMs: 5 * 60 * 1000 }, //  5 min
  { threshold: 5, lockMs: 30 * 1000 }, // 30 s
] as const;

/** Hash the PIN so we never store/key on the raw value. */
function hashPinForAttempts(pin: string): string {
  return createHash('sha256').update(`attempts:${pin.trim()}`).digest('hex');
}

/**
 * Throws "Too many failed attempts. Try again in <N>s." if this PIN is
 * currently locked. Always call BEFORE the argon2 verify so a locked PIN
 * doesn't even hit the hash check.
 */
function assertPinNotLocked(db: AppDatabase, pin: string): void {
  const row = db
    .prepare(
      `SELECT locked_until FROM login_attempts WHERE pin_hash = ?`,
    )
    .get(hashPinForAttempts(pin)) as { locked_until: string | null } | undefined;
  if (row?.locked_until) {
    const until = Number(row.locked_until);
    if (Number.isFinite(until) && until > Date.now()) {
      const seconds = Math.ceil((until - Date.now()) / 1000);
      const human = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`;
      throw new Error(`Too many failed attempts. Try again in ${human}.`);
    }
  }
}

function recordPinFailure(db: AppDatabase, pin: string): void {
  const key = hashPinForAttempts(pin);
  const now = new Date().toISOString();
  const row = db
    .prepare(`SELECT failed_count FROM login_attempts WHERE pin_hash = ?`)
    .get(key) as { failed_count: number } | undefined;
  const next = (row?.failed_count ?? 0) + 1;
  // Find the highest tier this count crosses.
  const tier = PIN_LOCKOUT_TIERS.find((t) => next >= t.threshold);
  const lockedUntil = tier ? String(Date.now() + tier.lockMs) : null;
  db.prepare(
    `INSERT INTO login_attempts (pin_hash, failed_count, last_failed_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pin_hash) DO UPDATE SET
       failed_count = excluded.failed_count,
       last_failed_at = excluded.last_failed_at,
       locked_until = excluded.locked_until`,
  ).run(key, next, now, lockedUntil);
}

function clearPinAttempts(db: AppDatabase, pin: string): void {
  db.prepare(`DELETE FROM login_attempts WHERE pin_hash = ?`).run(hashPinForAttempts(pin));
}

let currentSession: AuthenticatedUser | null = null;

export function getCurrentSession(): AuthenticatedUser | null {
  return currentSession;
}

export async function login(
  db: AppDatabase,
  pin: string,
  deviceId: string,
): Promise<AuthenticatedUser> {
  assertPinNotLocked(db, pin);
  const user = await findUserByPin(db, pin);
  if (!user) {
    recordPinFailure(db, pin);
    throw new Error('Invalid PIN');
  }
  clearPinAttempts(db, pin);

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
  assertPinNotLocked(db, pin);
  const user = await findUserByPin(db, pin);
  if (!user) {
    recordPinFailure(db, pin);
    throw new Error('Invalid PIN');
  }
  if (user.role !== 'manager' && user.role !== 'admin') {
    // Not authorized → still count as a failed attempt (someone is trying
    // cashier PINs as manager overrides).
    recordPinFailure(db, pin);
    throw new Error('Not authorized — manager PIN required');
  }
  clearPinAttempts(db, pin);
  return { approverUserId: user.id, approverName: user.fullName };
}

/** Close any session that's been open longer than SESSION_MAX_AGE_MS (called on boot). */
export function reapStaleSessions(db: AppDatabase): void {
  const cutoff = new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString();
  db.prepare(`UPDATE user_sessions SET ended_at = started_at WHERE ended_at IS NULL AND started_at < ?`).run(
    cutoff,
  );
}
