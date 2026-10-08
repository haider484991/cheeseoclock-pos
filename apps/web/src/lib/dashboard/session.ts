import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DASH_SESSION_IDLE_DAYS, DASH_SESSION_MAX_DAYS, type DashRole } from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import { ensureDashSchema } from './schema';

/**
 * Signed-in phones (shared-types dashboard.ts). A session is a random
 * 32-byte token in an HttpOnly cookie; the website keeps only its SHA-256,
 * so a copy of the database signs nobody in.
 *
 * The cookie's path is /dashboard: every dashboard page AND its own small API
 * (/dashboard/api/*) live under it, so the cookie never travels with a
 * customer's request to the shop's pages or /api/orders. SameSite=Lax keeps
 * it off cross-site posts; the sign-in routes check Origin too (sameSiteOnly).
 *
 * A phone stays signed in DASH_SESSION_IDLE_DAYS after its last use, and
 * never past DASH_SESSION_MAX_DAYS from its sign-in. Removing a person on the
 * till, a new password, or "Sign out of every phone" deletes their rows, so
 * the cookie stops working at once.
 */

export const SESSION_COOKIE = 'coc_dash';
export const DASHBOARD_PATH = '/dashboard';

export interface DashUser {
  loginId: string;
  username: string;
  displayName: string;
  role: DashRole;
  /** Owner: always true. Manager: the owner's tick on the till. */
  seesReports: boolean;
  /** This phone's session (sha256 of the cookie). */
  tokenHash: string;
}

export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new session for this sign-in; the token goes in the cookie and nowhere else. */
export async function startSession(loginId: string, userAgent: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql()`
    INSERT INTO dash_sessions (token_hash, login_id, user_agent)
    VALUES (${tokenHashOf(token)}::text, ${loginId}::uuid, ${userAgent?.slice(0, 200) ?? null}::text)`;
  return token;
}

/** Set-Cookie for a new session. `secure` is false only on a plain-http dev server. */
export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = DASH_SESSION_MAX_DAYS * 24 * 60 * 60;
  return [
    `${SESSION_COOKIE}=${token}`,
    `Path=${DASHBOARD_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, `Path=${DASHBOARD_PATH}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join(
    '; ',
  );
}

export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:';
}

interface SessionRow {
  login_id: string;
  username: string;
  display_name: string;
  role: DashRole;
  sees_reports: boolean;
}

/**
 * Who this token signs in, or null. Touches the session's last use at most
 * once an hour (one statement either way), so a dashboard left open doesn't
 * write on every refresh.
 */
export async function userForToken(token: string | undefined | null): Promise<DashUser | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const hash = tokenHashOf(token);
  await ensureDashSchema();
  const idleSince = new Date(Date.now() - DASH_SESSION_IDLE_DAYS * 86_400_000).toISOString();
  const bornSince = new Date(Date.now() - DASH_SESSION_MAX_DAYS * 86_400_000).toISOString();
  const touchBefore = new Date(Date.now() - 3_600_000).toISOString();
  const rows = (await sql()`
    WITH hit AS (
      SELECT s.token_hash, l.id AS login_id, l.username, l.display_name, l.role, l.sees_reports
        FROM dash_sessions s
        JOIN dash_logins l ON l.id = s.login_id
       WHERE s.token_hash = ${hash}::text
         AND l.removed_at IS NULL
         AND l.password_hash IS NOT NULL
         AND s.last_seen_at > ${idleSince}::timestamptz
         AND s.created_at > ${bornSince}::timestamptz
    ), touch AS (
      UPDATE dash_sessions SET last_seen_at = now()
       WHERE token_hash IN (SELECT token_hash FROM hit)
         AND last_seen_at < ${touchBefore}::timestamptz
      RETURNING 1
    )
    SELECT login_id, username, display_name, role, sees_reports FROM hit`) as SessionRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    loginId: row.login_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    seesReports: row.role === 'owner' || row.sees_reports === true,
    tokenHash: hash,
  };
}

/** The signed-in person on a page (server component), or null. */
export async function currentUser(): Promise<DashUser | null> {
  try {
    return await userForToken(cookies().get(SESSION_COOKIE)?.value);
  } catch (e) {
    console.error('dashboard: the session could not be read', (e as Error)?.message?.slice(0, 200));
    return null;
  }
}

/** The signed-in person, or off to the sign-in page (and back to `from` afterwards). */
export async function requireUser(from: string = DASHBOARD_PATH): Promise<DashUser> {
  const user = await currentUser();
  if (!user) redirect(`${DASHBOARD_PATH}/sign-in?next=${encodeURIComponent(safeNext(from))}`);
  return user;
}

/** Only a dashboard path may be the "go back to" target (never another site). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith(`${DASHBOARD_PATH}`) || next.startsWith('//') || /[\\\s]/.test(next)) return DASHBOARD_PATH;
  if (next.startsWith(`${DASHBOARD_PATH}/sign-in`) || next.startsWith(`${DASHBOARD_PATH}/setup`)) return DASHBOARD_PATH;
  return next;
}

/** The session cookie on an API request (route handlers read the header, not next/headers). */
export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export async function userFromRequest(req: Request): Promise<DashUser | null> {
  return userForToken(tokenFromRequest(req));
}

export async function endSession(tokenHash: string): Promise<void> {
  await sql()`DELETE FROM dash_sessions WHERE token_hash = ${tokenHash}::text`;
}

/** Every phone of this person signed out, but `keepTokenHash` (this one, after a new password). */
export async function endOtherSessions(loginId: string, keepTokenHash: string | null): Promise<void> {
  await sql()`
    DELETE FROM dash_sessions
     WHERE login_id = ${loginId}::uuid
       AND (${keepTokenHash}::text IS NULL OR token_hash <> ${keepTokenHash}::text)`;
}

/**
 * The sign-in routes answer only the dashboard's own pages: a post from
 * another site (Origin set and different, or a fetch the browser marks
 * cross-site) is refused before anything is read. With SameSite=Lax and
 * JSON-only bodies this closes cross-site request forgery.
 */
export function sameSiteOnly(req: Request): Response | null {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return refuse(403, 'cross_site');
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return refuse(403, 'cross_site');
  const type = req.headers.get('content-type') ?? '';
  if (req.method === 'POST' && !type.toLowerCase().startsWith('application/json')) return refuse(415, 'json_only');
  return null;
}

/** A JSON answer no cache may keep. */
export function answer(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers },
  });
}

export function refuse(status: number, error: string, message?: string, headers: Record<string, string> = {}): Response {
  return answer({ ok: false, error, ...(message ? { message } : {}) }, status, headers);
}
