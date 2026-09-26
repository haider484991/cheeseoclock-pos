import { createHmac } from 'node:crypto';
import type { AppDatabase } from '../db/connection.js';
import { attemptKey } from './attempt-key.js';

/**
 * Brute-force protection for everything typed to sign in or to approve as a
 * manager (login, the idle-lock unlock, discount / cancel / refund / cash
 * in-out approvals). Argon2id alone is not enough at PIN entropy (~10k combinations for
 * a 4-digit PIN), so a counter sits on top. The lockout escalates with
 * consecutive failures:
 *   5 failures → 30s lockout
 *   10 failures → 5 min lockout
 *   15+ failures → 30 min lockout
 * Two sign-in counters share the same `login_attempts` table (migration 0009):
 *   - one per secret (a stuck key on one PIN locks only that PIN);
 *   - one fixed device-wide row, so walking 0000…9999 — where no single PIN
 *     is ever retried — still locks after five wrong guesses.
 * A success clears only that secret's row. The device-wide row counts wrong
 * guesses in a rolling 15-minute window and is never cleared by a good one:
 * clearing it let a cashier guess 4 PINs, log in with their own, and repeat
 * until the manager's PIN fell (audit 2026-09-25). Its locks are short
 * (DEVICE_LOCKOUT_TIERS) so a burst of typos can't shut the till for 30 min.
 *
 * The per-secret row is filed under an HMAC of what was typed, keyed with a
 * key kept outside the database (attempt-key.ts): the table travels in every
 * backup and cloud copy, and a plain hash of a guess could be reversed there.
 * Rows nobody has failed on for an hour (and not locked) are deleted, so
 * wrong guesses are not kept for ever.
 *
 * A new PIN or password refused on the Users page because someone already
 * has it is NOT a wrong guess at sign-in: the owner typed it, not the person
 * who has it. It has its own counter (SECRET_IN_USE_ATTEMPTS_KEY) that only
 * slows down saving new secrets. Counting it here locked the holder's own
 * PIN, and after five clashes the whole till (review 2026-09-26).
 */

const SECRET_LOCKOUT_TIERS = [
  { threshold: 15, lockMs: 30 * 60 * 1000 }, // 30 min
  { threshold: 10, lockMs: 5 * 60 * 1000 }, //  5 min
  { threshold: 5, lockMs: 30 * 1000 }, // 30 s
] as const;

const DEVICE_LOCKOUT_TIERS = [
  { threshold: 10, lockMs: 60 * 1000 }, // 1 min
  { threshold: 5, lockMs: 30 * 1000 }, // 30 s
] as const;
const DEVICE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Fixed `login_attempts.pin_hash` for the device-wide counter. Every other
 * key is a 64-character hex digest, so it can never collide with one.
 */
export const DEVICE_ATTEMPTS_KEY = '__device__';

/**
 * Fixed `login_attempts.pin_hash` for "that PIN or password is already used
 * by someone else" refusals. Each one tells whoever typed it that somebody
 * has that secret, so they are braked, but only on the Users page and setup:
 * sign-in, manager approvals and the holder's own PIN never see this counter.
 */
export const SECRET_IN_USE_ATTEMPTS_KEY = '__secret_in_use__';
const SECRET_IN_USE_TIERS = [
  { threshold: 10, lockMs: 5 * 60 * 1000 }, // 5 min
  { threshold: 5, lockMs: 30 * 1000 }, // 30 s
] as const;
const SECRET_IN_USE_WINDOW_MS = 15 * 60 * 1000;

/** A per-secret row with no failure for this long (and not locked) is deleted. */
const FORGET_AFTER_MS = 60 * 60 * 1000;

/** The row a secret's failures are counted under. Never the secret itself. */
export function attemptsKeyFor(secret: string): string {
  return createHmac('sha256', attemptKey()).update(`attempts:${secret}`).digest('hex');
}

function assertKeyNotLocked(db: AppDatabase, key: string, what = 'Too many failed attempts'): void {
  const row = db
    .prepare(`SELECT locked_until FROM login_attempts WHERE pin_hash = ?`)
    .get(key) as { locked_until: string | null } | undefined;
  if (row?.locked_until) {
    const until = Number(row.locked_until);
    if (Number.isFinite(until) && until > Date.now()) {
      const seconds = Math.ceil((until - Date.now()) / 1000);
      const human = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`;
      throw new Error(`${what}. Try again in ${human}.`);
    }
  }
}

function recordKeyFailure(
  db: AppDatabase,
  key: string,
  tiers: ReadonlyArray<{ threshold: number; lockMs: number }>,
  windowMs?: number,
): void {
  const now = new Date().toISOString();
  const row = db
    .prepare(`SELECT failed_count, last_failed_at FROM login_attempts WHERE pin_hash = ?`)
    .get(key) as { failed_count: number; last_failed_at: string } | undefined;
  // A rolling window: failures older than it no longer count.
  const stale =
    windowMs !== undefined && row !== undefined && Date.now() - Date.parse(row.last_failed_at) > windowMs;
  const next = (stale ? 0 : row?.failed_count ?? 0) + 1;
  // Find the highest tier this count crosses.
  const tier = tiers.find((t) => next >= t.threshold);
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

/** Forget per-secret rows nobody has failed on for a while (the device row stays). */
function forgetOldAttempts(db: AppDatabase): void {
  const nowMs = Date.now();
  db.prepare(
    `DELETE FROM login_attempts
      WHERE pin_hash != ?
        AND last_failed_at < ?
        AND (locked_until IS NULL OR CAST(locked_until AS INTEGER) <= ?)`,
  ).run(DEVICE_ATTEMPTS_KEY, new Date(nowMs - FORGET_AFTER_MS).toISOString(), nowMs);
}

/**
 * Throws "Too many failed attempts. Try again in <N>s." if this secret, or
 * the device as a whole, is locked. Always call BEFORE any argon2 verify, so
 * a locked secret doesn't even reach the hash check. `secret` is normalized
 * (normalizeSecret) by the caller.
 */
export function assertSecretNotLocked(db: AppDatabase, secret: string): void {
  assertKeyNotLocked(db, DEVICE_ATTEMPTS_KEY);
  assertKeyNotLocked(db, attemptsKeyFor(secret));
}

/** One wrong guess: counts against this secret and against the device. */
export function recordSecretFailure(db: AppDatabase, secret: string): void {
  db.transaction(() => {
    forgetOldAttempts(db);
    recordKeyFailure(db, attemptsKeyFor(secret), SECRET_LOCKOUT_TIERS);
    recordKeyFailure(db, DEVICE_ATTEMPTS_KEY, DEVICE_LOCKOUT_TIERS, DEVICE_WINDOW_MS);
  })();
}

/**
 * Throws "Too many PINs or passwords that are already used. Try again in
 * <N>s." while saving new secrets is paused. Call before comparing a new PIN
 * or password with everyone's (users create / update, first-time setup).
 */
export function assertSecretInUseNotLocked(db: AppDatabase): void {
  assertKeyNotLocked(db, SECRET_IN_USE_ATTEMPTS_KEY, 'Too many PINs or passwords that are already used');
}

/** A new PIN or password was refused because someone has it. Touches no sign-in counter. */
export function recordSecretInUse(db: AppDatabase): void {
  recordKeyFailure(db, SECRET_IN_USE_ATTEMPTS_KEY, SECRET_IN_USE_TIERS, SECRET_IN_USE_WINDOW_MS);
}

/** A success: this secret's count only — the device-wide one runs out on its own window. */
export function clearSecretAttempts(db: AppDatabase, secret: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM login_attempts WHERE pin_hash = ?`).run(attemptsKeyFor(secret));
    forgetOldAttempts(db);
  })();
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run secret checks one at a time: lock check → argon2 → count / clear, and
 * the duplicate check → hash → write of a new PIN or password. Without it,
 * guesses sent at the same moment all passed the lock check before any
 * failure was counted, and two saves at once could give two people the same
 * secret. Tens of milliseconds each at a till; nothing waits long.
 */
export function oneSecretCheckAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}
