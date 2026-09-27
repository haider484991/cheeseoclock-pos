import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { findUserBySecret, touchUserLogin } from '../db/repositories/user-repo.js';
import { writeAudit } from '../db/repositories/audit-repo.js';
import { DEFAULT_STAFF_TIMING, type AuthenticatedUser, type StaffTiming, type UUID } from '@cheeseoclock/shared-types';
import { normalizeSecret, secretProblem } from '@cheeseoclock/shared-schemas';
import { readStaffTiming } from '../db/business-settings-read.js';
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
 * design (sessions older than the longest login are auto-closed).
 *
 * The timings are the owner's (Settings → Staff & kitchen timing,
 * 'staff.timing', read on every check on both tills: login expiry, restart
 * recovery, the startup clean-up, the step-in hold). The constants below are
 * the released defaults, used while nothing is saved. Who can do what stays
 * in the role table, never a setting.
 *
 * Everyone signs in with a number PIN or a password (sign-in-secret.ts in
 * shared-schemas); the same rules and the same lockout (login-attempts.ts)
 * apply to both, and to every manager approval. What was typed is never
 * logged or stored — only argon2id hashes and HMAC-keyed attempt counters.
 */

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** The longest a login lasts by default (12 h); the owner's is 'staff.timing' maxLoginHours. */
export const SESSION_MAX_AGE_MS = DEFAULT_STAFF_TIMING.maxLoginHours * HOUR_MS;

/**
 * An owner or manager login left open on the counter hands anyone walking past
 * the settings, the staff list and the reports. It ends after this long with
 * no one touching the till (key presses and clicks — the screens that refresh
 * themselves don't count). Cashiers work the till all day and are not timed
 * out; every login still ends after the longest login. By default 15
 * minutes; the owner's is 'staff.timing' idleLogoutMin (5–60, never off).
 */
export const ELEVATED_IDLE_MS = DEFAULT_STAFF_TIMING.idleLogoutMin * MIN_MS;

/**
 * An owner or manager signing in on a till a cashier was just using is
 * stepping in: to approve something, fix a customer, reprint an old order,
 * close the shift. The idle timer can't end that login — at a busy counter
 * the cashier's own taps keep it alive, and the cashier would work on with
 * the customer list, the history and the reports on screen, every sale in
 * the manager's name (owner, 2026-09-26).
 *
 * So this long after it began, however busy the till is, that login is HELD:
 * nothing more is allowed on it, but it is not ended and the screen keeps
 * everything on it (a half-edited menu item, a drawer count being typed).
 * The till asks for that same person's PIN or password (keepStepIn): typed,
 * the login carries on as a normal one; "Hand back to cashier" logs out. The
 * screen warns a minute before. Nobody answering: the owner / manager idle
 * rule ends it (no key presses count while it is held). By default 10
 * minutes; the owner's is 'staff.timing' stepInMin (5–30).
 */
export const STEP_IN_MAX_MS = DEFAULT_STAFF_TIMING.stepInMin * MIN_MS;
/**
 * A cashier on this till within this long before the sign-in means the
 * manager is stepping in. Short on purpose: the owner signing in the next
 * morning, or a manager arriving long after the cashier left, is not.
 */
export const STEP_IN_LOOKBACK_MS = 15 * 60 * 1000;
/** The audit action that makes a stepping-in login a normal one (also read back after a restart). */
const STEP_IN_KEPT = 'session_step_in_kept';

/** The owner's timings in ms, as this till reads them now (the defaults when nothing is saved). */
function timings(db: AppDatabase | null): { idleMs: number; maxAgeMs: number; stepInMs: number; stepInMinutes: number } {
  const t: StaffTiming = readStaffTiming(db);
  return {
    idleMs: t.idleLogoutMin * MIN_MS,
    maxAgeMs: t.maxLoginHours * HOUR_MS,
    stepInMs: t.stepInMin * MIN_MS,
    stepInMinutes: t.stepInMin,
  };
}

/** A PIN or password nobody has. */
export const WRONG_SECRET = 'PIN or password is wrong';
/**
 * A manager approval that failed. One message whether nobody has that secret
 * or a cashier does: a separate "not a manager" told whoever typed it that
 * the string is a real staff password, which may be used elsewhere too.
 */
export const NOT_A_MANAGER = "That is not a manager's PIN or password";

/** Keeping a stepping-in login with a secret that is not that person's (same message for nobody's). */
export function notTheirSecret(fullName: string): string {
  return `That is not ${fullName}'s PIN or password`;
}

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
/** When a stepping-in login ends (the step-in minutes after it began), or null. */
let stepInEndsAtMs: number | null = null;
/** How many minutes that step-in was given (for the words on screen). */
let stepInMinutes: number | null = null;

/**
 * When this run of the app began (the module loads at startup, before anyone
 * can sign in), and the logins it opened or brought back. Any other login
 * still open in user_sessions (pure-local: this till's own) was left by a
 * till that stopped — shut down, crashed, lost power — without a sign-out.
 */
const RUN_STARTED_AT_MS = Date.now();
const openedThisRun = new Set<string>();

/**
 * When a login left open by a till that stopped was last seen on this till:
 * the last thing that person did here after signing in (audit_log is this
 * till's own), before this run began — or the sign-in itself. Not "until
 * now": the owner signing in the morning after a cashier left the till
 * signed in and shut it down is not stepping in, however long a login may
 * last (Settings → Staff & kitchen timing). A till restarted a minute after
 * a sale still is.
 */
function lastSeenBeforeStop(db: AppDatabase, userId: string, startedAt: string, beforeMs: number): number {
  const until = new Date(Math.min(beforeMs, RUN_STARTED_AT_MS)).toISOString();
  const row = db
    .prepare(`SELECT MAX(created_at) AS at FROM audit_log WHERE actor_user_id = ? AND created_at >= ? AND created_at <= ?`)
    .get(userId, startedAt, until) as { at: string | null } | undefined;
  const at = row?.at ? Date.parse(row.at) : Number.NaN;
  return Number.isFinite(at) ? at : Date.parse(startedAt);
}

/**
 * Is this owner / manager login stepping in for a cashier? The session this
 * till had before `sessionId` belonged to a cashier who was on the till
 * within STEP_IN_LOOKBACK_MS of `startMs`. A cashier login never logged out
 * counts as on the till until `startMs` — unless the till stopped since
 * (`signingInNow` and the login is not this run's): then only until the last
 * thing they did on it (lastSeenBeforeStop). Returns when the login is held,
 * or null (a cashier's own login, the first login of the morning, a manager
 * after a manager, a login already kept with its PIN).
 */
function stepInEnd(
  db: AppDatabase,
  deviceId: string,
  sessionId: string,
  role: AuthenticatedUser['role'],
  startMs: number,
  signingInNow: boolean,
): number | null {
  if (role === 'cashier' || !Number.isFinite(startMs)) return null;
  const before = db
    .prepare(
      `SELECT s.id AS id, s.user_id AS user_id, u.role AS role, s.started_at AS started_at, s.ended_at AS ended_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.device_id = ? AND s.id <> ? AND s.started_at <= ?
        ORDER BY s.started_at DESC, s.rowid DESC
        LIMIT 1`,
    )
    .get(deviceId, sessionId, new Date(startMs).toISOString()) as
    | { id: string; user_id: string; role: string; started_at: string; ended_at: string | null }
    | undefined;
  if (!before || before.role !== 'cashier') return null;
  const lastSeenMs =
    before.ended_at !== null
      ? Date.parse(before.ended_at)
      : signingInNow && !openedThisRun.has(before.id)
        ? lastSeenBeforeStop(db, before.user_id, before.started_at, startMs)
        : startMs;
  if (!Number.isFinite(lastSeenMs) || startMs - lastSeenMs > STEP_IN_LOOKBACK_MS) return null;
  const kept = db
    .prepare(`SELECT 1 AS kept FROM audit_log WHERE entity_type = 'user_sessions' AND entity_id = ? AND action = ? LIMIT 1`)
    .get(sessionId, STEP_IN_KEPT);
  if (kept) return null;
  const { stepInMs, stepInMinutes: minutes } = timings(db);
  stepInMinutes = minutes;
  return startMs + stepInMs;
}

function withStepIn(user: AuthenticatedUser): AuthenticatedUser {
  if (stepInEndsAtMs === null) return user;
  return {
    ...user,
    stepInEndsAt: new Date(stepInEndsAtMs).toISOString(),
    ...(stepInMinutes !== null ? { stepInMinutes } : {}),
  };
}

/** Someone pressed a key or clicked on the till (renderer → `auth:activity`). */
export function noteActivity(): void {
  // A held login is not kept alive by whoever is tapping the screen meanwhile.
  if (currentSession && !stepInIsHeld()) lastActivityAtMs = Date.now();
}

/**
 * The logged-in user, or null — also null while a stepping-in login is held
 * (see STEP_IN_MAX_MS and getHeldStepIn), so every guard refuses it. The
 * login itself ends here (liveSession) for an owner or manager idle for the
 * owner's idle minutes (ELEVATED_IDLE_MS by default), any login older than
 * the longest login (SESSION_MAX_AGE_MS by default), and a user switched
 * off since they logged in. The role is read again each time, so
 * a manager demoted to cashier loses manager rights at once, not at next login.
 */
export function getCurrentSession(): AuthenticatedUser | null {
  const s = liveSession();
  if (!s || stepInIsHeld()) return null;
  return s;
}

/**
 * A stepping-in login whose step-in minutes are up, marked `stepInHeld`: it
 * waits for that person's PIN or password (keepStepIn) or a hand-back
 * (logout), and nothing else is allowed on it meanwhile. Null otherwise.
 */
export function getHeldStepIn(): AuthenticatedUser | null {
  const s = liveSession();
  if (!s || !stepInIsHeld()) return null;
  return { ...s, stepInHeld: true };
}

function stepInIsHeld(): boolean {
  return stepInEndsAtMs !== null && Date.now() >= stepInEndsAtMs;
}

/** The session after the rules that END a login, held or not. */
function liveSession(): AuthenticatedUser | null {
  if (!currentSession) return null;
  const now = Date.now();
  // The owner's timings, read now: a Save here or from the other till counts at once.
  const { maxAgeMs, idleMs } = timings(sessionDb);
  if (now - sessionStartedAtMs > maxAgeMs) {
    endSession('session_expired');
    return null;
  }
  if (currentSession.role !== 'cashier' && now - lastActivityAtMs > idleMs) {
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

/**
 * "It's still me": a stepping-in login's own PIN or password makes it a
 * normal login, before or after it is held, and nothing on the screen is
 * lost. Only that person's secret: anyone else's (or nobody's) is refused
 * and counted as a wrong guess, like a manager approval — someone else takes
 * the till by handing it back and signing in. Kept is written to the audit
 * trail, which is also how a restart knows (recoverSession).
 */
export async function keepStepIn(db: AppDatabase, pin: string): Promise<AuthenticatedUser> {
  const secret = readSecret(pin);
  const s = liveSession();
  if (!s) throw new Error('Not logged in');
  if (stepInEndsAtMs === null) return s;
  const endsAtMs = stepInEndsAtMs;
  await oneSecretCheckAtATime(async () => {
    assertSecretNotLocked(db, secret);
    const found = await findUserBySecret(db, secret);
    if (!found || found.id !== s.id) {
      recordSecretFailure(db, secret);
      throw new Error(notTheirSecret(s.fullName));
    }
    clearSecretAttempts(db, secret);
  });
  // Handed back, or ended, while the secret was being checked.
  if (!currentSession || currentSession.sessionId !== s.sessionId) throw new Error('Not logged in');
  currentSession = {
    id: currentSession.id,
    fullName: currentSession.fullName,
    role: currentSession.role,
    sessionId: currentSession.sessionId,
  };
  stepInEndsAtMs = null;
  stepInMinutes = null;
  lastActivityAtMs = Date.now();
  const sessionId = s.sessionId;
  try {
    db.transaction(() => {
      writeAudit(db, {
        entityType: 'user_sessions',
        entityId: sessionId,
        action: STEP_IN_KEPT,
        actorUserId: s.id,
        before: { stepInEndsAt: new Date(endsAtMs).toISOString() },
        after: { stepInEndsAt: null },
      });
    })();
  } catch (e) {
    // The login is kept either way; only a restart would ask for the PIN again.
    log.warn('Keeping the step-in login failed to write', { error: String(e) });
  }
  log.info('Step-in login kept', { userId: s.id });
  return currentSession;
}

function endSession(
  action: 'logout' | 'session_expired' | 'session_idle_timeout' | 'session_revoked',
): void {
  const session = currentSession;
  const db = sessionDb;
  currentSession = null;
  sessionDb = null;
  stepInEndsAtMs = null;
  stepInMinutes = null;
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

  openedThisRun.add(sessionId);
  stepInMinutes = null;
  stepInEndsAtMs = stepInEnd(db, deviceId, sessionId, user.role, Date.parse(now), true);
  currentSession = withStepIn({
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    sessionId: sessionId as UUID,
  });
  sessionDb = db;
  sessionStartedAtMs = Date.now();
  lastActivityAtMs = sessionStartedAtMs;

  log.info('User logged in', { userId: user.id, role: user.role, steppingIn: stepInEndsAtMs !== null });
  return currentSession;
}

export function logout(db: AppDatabase): void {
  if (!currentSession) return;
  sessionDb = db;
  endSession('logout');
}

/**
 * On boot, try to recover a recent in-progress session. Returns the user if a
 * session younger than the longest login ('staff.timing') exists for this
 * device. It still ends the longest login after it BEGAN (a restart never
 * lengthens a login), and a lowered setting ends it by its real age. (The app
 * does not call this today: a restart always asks for a PIN or password.)
 */
export function recoverSession(db: AppDatabase, deviceId: string): AuthenticatedUser | null {
  const cutoff = new Date(Date.now() - timings(db).maxAgeMs).toISOString();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, u.full_name, u.role, s.started_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.device_id = ? AND s.ended_at IS NULL AND s.started_at >= ?
        ORDER BY s.started_at DESC
        LIMIT 1`,
    )
    .get(deviceId, cutoff) as
    | {
        session_id: string;
        user_id: string;
        full_name: string;
        role: AuthenticatedUser['role'];
        started_at: string;
      }
    | undefined;

  if (!row) return null;

  // A restart does not give a stepping-in login a fresh step-in (its cashier was on the till until it began)…
  const startedMs = Date.parse(row.started_at);
  openedThisRun.add(row.session_id);
  stepInMinutes = null;
  stepInEndsAtMs = stepInEnd(db, deviceId, row.session_id, row.role, startedMs, false);
  currentSession = withStepIn({
    id: row.user_id as UUID,
    fullName: row.full_name,
    role: row.role,
    sessionId: row.session_id as UUID,
  });
  sessionDb = db;
  // …nor a fresh longest login: it ends the owner's hours after it began, not after the restart.
  sessionStartedAtMs = Number.isFinite(startedMs) ? startedMs : Date.now();
  lastActivityAtMs = Date.now();
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

/** Close any session that's been open longer than the longest login ('staff.timing'; called on boot). */
export function reapStaleSessions(db: AppDatabase): void {
  const cutoff = new Date(Date.now() - timings(db).maxAgeMs).toISOString();
  db.prepare(`UPDATE user_sessions SET ended_at = started_at WHERE ended_at IS NULL AND started_at < ?`).run(
    cutoff,
  );
}
