import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DASH_LOCK_MINUTES,
  DASH_SESSION_IDLE_DAYS,
  DASH_SETUP_CODE_HOURS,
  DASH_SETUP_CODE_TRIES,
  DASH_WRONG_PASSWORDS,
  DASH_WRONG_PER_ADDRESS,
  normalizeSetupCode,
  type DashLoginAction,
  type DashLoginRefusal,
  type DashLoginView,
  type DashRole,
} from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import { ensureDashSchema } from './schema';

/**
 * The sign-in list (shared-types dashboard.ts SIGN-INS): changed only by a
 * till (POST /api/bridge/dashboard/logins, BRIDGE_SECRET), used by the
 * dashboard's own sign-in, setup and password routes.
 *
 * The website never sees a setup code, only its SHA-256 (the till made it);
 * and keeps passwords only as scrypt (password.ts). Every change and every
 * sign-in leaves a dash_events line (no secrets in it), which the till's
 * card reads as "last signed in".
 */

type Stamp = Date | string;
const isoOf = (v: Stamp | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** The SHA-256 a till registers for a setup code, and the website compares against. */
export function setupCodeHash(code: string): string {
  return sha256Hex(normalizeSetupCode(code));
}

function sameHex(a: string | null, b: string): boolean {
  if (!a || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export interface LoginRow {
  id: string;
  username: string;
  display_name: string;
  role: DashRole;
  sees_reports: boolean;
  password_hash: string | null;
  setup_code_hash: string | null;
  setup_expires_at: Stamp | null;
  setup_tries: number;
  wrong_passwords: number;
  locked_until: Stamp | null;
  last_sign_in_at: Stamp | null;
  created_at: Stamp;
}

export async function findLogin(username: string): Promise<LoginRow | null> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, username, display_name, role, sees_reports, password_hash, setup_code_hash, setup_expires_at,
           setup_tries, wrong_passwords, locked_until, last_sign_in_at, created_at
      FROM dash_logins WHERE username = ${username}::text AND removed_at IS NULL`) as LoginRow[];
  return rows[0] ?? null;
}

export async function logEvent(
  kind: string,
  fields: { loginId?: string | null; ipHash?: string | null; deviceId?: string | null; detail?: unknown } = {},
): Promise<void> {
  try {
    await ensureDashSchema();
    await sql()`
      INSERT INTO dash_events (kind, login_id, ip_hash, device_id, detail)
      VALUES (${kind}::text, ${fields.loginId ?? null}::uuid, ${fields.ipHash ?? null}::text,
              ${fields.deviceId ?? null}::text, ${fields.detail === undefined ? null : JSON.stringify(fields.detail)}::jsonb)`;
  } catch (e) {
    // History only: a sign-in never fails for it.
    console.error('dashboard: an event line could not be written', (e as Error)?.message?.slice(0, 200));
  }
}

/** Wrong sign-ins and setup codes from one address in the last 15 minutes. */
export async function recentWrongFrom(ipHash: string): Promise<number> {
  await ensureDashSchema();
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = (await sql()`
    SELECT count(*)::int AS n FROM dash_events
     WHERE kind IN ('sign_in_wrong', 'setup_wrong') AND ip_hash = ${ipHash}::text AND at > ${since}::timestamptz`) as Array<{
    n: number;
  }>;
  return rows[0]?.n ?? 0;
}

export function addressTooBusy(wrongCount: number): boolean {
  return wrongCount >= DASH_WRONG_PER_ADDRESS;
}

/** Minutes until this username may try again, or 0. */
export function lockedMinutes(row: Pick<LoginRow, 'locked_until'>, now = Date.now()): number {
  const until = row.locked_until ? new Date(row.locked_until).getTime() : 0;
  return until > now ? Math.ceil((until - now) / 60_000) : 0;
}

/** One more wrong password: the 5th locks the username for 15 minutes (and starts the count again). */
export async function noteWrongPassword(loginId: string): Promise<{ lockedNow: boolean }> {
  const lockUntil = new Date(Date.now() + DASH_LOCK_MINUTES * 60_000).toISOString();
  const rows = (await sql()`
    UPDATE dash_logins SET
      wrong_passwords = CASE WHEN wrong_passwords + 1 >= ${DASH_WRONG_PASSWORDS}::int THEN 0 ELSE wrong_passwords + 1 END,
      locked_until    = CASE WHEN wrong_passwords + 1 >= ${DASH_WRONG_PASSWORDS}::int THEN ${lockUntil}::timestamptz ELSE locked_until END,
      updated_at = now()
     WHERE id = ${loginId}::uuid
     RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`) as Array<{ locked: boolean }>;
  return { lockedNow: rows[0]?.locked === true };
}

export async function noteSignedIn(loginId: string): Promise<void> {
  await sql()`
    UPDATE dash_logins SET wrong_passwords = 0, locked_until = NULL, last_sign_in_at = now(), updated_at = now()
     WHERE id = ${loginId}::uuid`;
}

export type SetupCheck = 'ok' | 'no_code' | 'expired' | 'wrong';

/** Is this the person's setup code? A wrong one counts; the 5th voids the code. */
export async function checkSetupCode(row: LoginRow, code: string): Promise<SetupCheck> {
  if (!row.setup_code_hash) return 'no_code';
  const expires = row.setup_expires_at ? new Date(row.setup_expires_at).getTime() : 0;
  if (expires <= Date.now()) return 'expired';
  if (sameHex(row.setup_code_hash, setupCodeHash(code))) return 'ok';
  await sql()`
    UPDATE dash_logins SET
      setup_tries = setup_tries + 1,
      setup_code_hash  = CASE WHEN setup_tries + 1 >= ${DASH_SETUP_CODE_TRIES}::int THEN NULL ELSE setup_code_hash END,
      setup_expires_at = CASE WHEN setup_tries + 1 >= ${DASH_SETUP_CODE_TRIES}::int THEN NULL ELSE setup_expires_at END,
      updated_at = now()
     WHERE id = ${row.id}::uuid`;
  return 'wrong';
}

/**
 * The code was right: the new password replaces any old one, the code is
 * used up, and every other phone of this person is signed out — all in one
 * statement, guarded on the code still being the one checked (two phones
 * using it at once: one wins, the other is told to sign in).
 */
export async function finishSetup(row: LoginRow, passwordHash: string): Promise<boolean> {
  const rows = (await sql()`
    WITH done AS (
      UPDATE dash_logins SET
        password_hash = ${passwordHash}::text, setup_code_hash = NULL, setup_expires_at = NULL, setup_tries = 0,
        wrong_passwords = 0, locked_until = NULL, updated_at = now()
       WHERE id = ${row.id}::uuid AND setup_code_hash = ${row.setup_code_hash}::text AND removed_at IS NULL
       RETURNING id
    ), gone AS (
      DELETE FROM dash_sessions WHERE login_id IN (SELECT id FROM done) RETURNING 1
    )
    SELECT count(*)::int AS n FROM done`) as Array<{ n: number }>;
  return (rows[0]?.n ?? 0) === 1;
}

export async function passwordHashOf(loginId: string): Promise<string | null> {
  const rows = (await sql()`SELECT password_hash FROM dash_logins WHERE id = ${loginId}::uuid AND removed_at IS NULL`) as Array<{
    password_hash: string | null;
  }>;
  return rows[0]?.password_hash ?? null;
}

/** A new password from the signed-in person; their other phones are signed out, this one stays. */
export async function changePassword(loginId: string, passwordHash: string, keepTokenHash: string): Promise<void> {
  await sql()`
    WITH done AS (
      UPDATE dash_logins SET password_hash = ${passwordHash}::text, updated_at = now()
       WHERE id = ${loginId}::uuid AND removed_at IS NULL
       RETURNING id
    )
    DELETE FROM dash_sessions WHERE login_id IN (SELECT id FROM done) AND token_hash <> ${keepTokenHash}::text`;
}

// ---------------------------------------------------------------------------
// The list, for the tills
// ---------------------------------------------------------------------------

interface ViewRow {
  id: string;
  username: string;
  display_name: string;
  role: DashRole;
  sees_reports: boolean;
  has_password: boolean;
  setup_pending: boolean;
  setup_expires_at: Stamp | null;
  last_sign_in_at: Stamp | null;
  signed_in: number;
  created_at: Stamp;
}

export async function listLogins(): Promise<DashLoginView[]> {
  await ensureDashSchema();
  const idleSince = new Date(Date.now() - DASH_SESSION_IDLE_DAYS * 86_400_000).toISOString();
  const rows = (await sql()`
    SELECT l.id, l.username, l.display_name, l.role, l.sees_reports,
           (l.password_hash IS NOT NULL) AS has_password,
           (l.setup_code_hash IS NOT NULL AND l.setup_expires_at > now()) AS setup_pending,
           CASE WHEN l.setup_code_hash IS NOT NULL AND l.setup_expires_at > now() THEN l.setup_expires_at END AS setup_expires_at,
           l.last_sign_in_at, l.created_at,
           (SELECT count(*)::int FROM dash_sessions s
             WHERE s.login_id = l.id AND s.last_seen_at > ${idleSince}::timestamptz) AS signed_in
      FROM dash_logins l
     WHERE l.removed_at IS NULL
     ORDER BY CASE l.role WHEN 'owner' THEN 0 ELSE 1 END, l.display_name, l.username`) as ViewRow[];
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    seesReports: r.role === 'owner' || r.sees_reports === true,
    hasPassword: r.has_password === true,
    setupPending: r.setup_pending === true,
    setupExpiresAt: isoOf(r.setup_expires_at),
    lastSignInAt: isoOf(r.last_sign_in_at),
    signedInPhones: Number(r.signed_in ?? 0),
    createdAt: isoOf(r.created_at) ?? new Date(0).toISOString(),
  }));
}

export interface ChangeBy {
  deviceId: string;
  deviceName: string | null;
  actorName: string | null;
}

/** One change from a till; the refusal names why, for the till to show in its own words. */
export async function applyLoginChange(change: DashLoginAction, by: ChangeBy): Promise<{ ok: true } | { ok: false; refusal: DashLoginRefusal }> {
  await ensureDashSchema();
  const detail = { by: by.actorName, till: by.deviceName };
  const codeUntil = new Date(Date.now() + DASH_SETUP_CODE_HOURS * 3_600_000).toISOString();
  switch (change.action) {
    case 'add': {
      const id = randomUUID();
      const rows = (await sql()`
        INSERT INTO dash_logins (id, username, display_name, role, sees_reports, setup_code_hash, setup_expires_at)
        SELECT ${id}::uuid, ${change.username}::text, ${change.displayName}::text, ${change.role}::text,
               ${change.role === 'owner' || change.seesReports}::boolean, ${change.setupCodeHash}::text,
               ${codeUntil}::timestamptz
         WHERE NOT EXISTS (SELECT 1 FROM dash_logins WHERE username = ${change.username}::text AND removed_at IS NULL)
        RETURNING id`) as Array<{ id: string }>;
      if (rows.length === 0) return { ok: false, refusal: 'username_taken' };
      await logEvent('login_added', { loginId: id, deviceId: by.deviceId, detail: { ...detail, role: change.role } });
      return { ok: true };
    }
    case 'update': {
      const rows = (await sql()`
        UPDATE dash_logins SET display_name = ${change.displayName}::text, role = ${change.role}::text,
               sees_reports = ${change.role === 'owner' || change.seesReports}::boolean, updated_at = now()
         WHERE id = ${change.id}::uuid AND removed_at IS NULL
        RETURNING id`) as Array<{ id: string }>;
      if (rows.length === 0) return { ok: false, refusal: 'not_found' };
      await logEvent('login_updated', { loginId: change.id, deviceId: by.deviceId, detail: { ...detail, role: change.role } });
      return { ok: true };
    }
    case 'newCode': {
      const rows = (await sql()`
        UPDATE dash_logins SET setup_code_hash = ${change.setupCodeHash}::text, setup_expires_at = ${codeUntil}::timestamptz,
               setup_tries = 0, updated_at = now()
         WHERE id = ${change.id}::uuid AND removed_at IS NULL
        RETURNING id`) as Array<{ id: string }>;
      if (rows.length === 0) return { ok: false, refusal: 'not_found' };
      await logEvent('code_made', { loginId: change.id, deviceId: by.deviceId, detail });
      return { ok: true };
    }
    case 'signOutAll': {
      const rows = (await sql()`
        WITH l AS (SELECT id FROM dash_logins WHERE id = ${change.id}::uuid AND removed_at IS NULL),
             gone AS (DELETE FROM dash_sessions WHERE login_id IN (SELECT id FROM l) RETURNING 1)
        SELECT (SELECT count(*) FROM l)::int AS found`) as Array<{ found: number }>;
      if ((rows[0]?.found ?? 0) === 0) return { ok: false, refusal: 'not_found' };
      await logEvent('signed_out_all', { loginId: change.id, deviceId: by.deviceId, detail });
      return { ok: true };
    }
    case 'remove': {
      const rows = (await sql()`
        WITH l AS (
          UPDATE dash_logins SET removed_at = now(), password_hash = NULL, setup_code_hash = NULL,
                 setup_expires_at = NULL, updated_at = now()
           WHERE id = ${change.id}::uuid AND removed_at IS NULL
          RETURNING id
        ), gone AS (DELETE FROM dash_sessions WHERE login_id IN (SELECT id FROM l) RETURNING 1)
        SELECT (SELECT count(*) FROM l)::int AS found`) as Array<{ found: number }>;
      if ((rows[0]?.found ?? 0) === 0) return { ok: false, refusal: 'not_found' };
      await logEvent('login_removed', { loginId: change.id, deviceId: by.deviceId, detail });
      return { ok: true };
    }
  }
}
