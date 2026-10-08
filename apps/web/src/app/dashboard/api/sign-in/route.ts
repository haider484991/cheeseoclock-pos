import { addressTooBusy, findLogin, lockedMinutes, logEvent, noteSignedIn, noteWrongPassword, recentWrongFrom } from '@/lib/dashboard/logins';
import { signInBodySchema } from '@/lib/dashboard/forms';
import { decoyHash, verifyPassword } from '@/lib/dashboard/password';
import { answer, isHttps, refuse, sameSiteOnly, sessionCookie, startSession } from '@/lib/dashboard/session';
import { logFailure } from '@/lib/menu-deploy-auth';
import { clientIpHash } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

const WRONG = 'Wrong username or password.';

/**
 * Sign in to the phone dashboard: { username, password } → 200 with the
 * session cookie; 401 wrong (one answer for an unknown username and a
 * wrong password, and the same scrypt time); 409 not set up yet (use the
 * setup code); 429 locked (5 wrong for this username) or busy (30 wrong
 * from this address in 15 minutes) — both fail CLOSED when the count can't
 * be read.
 */
export async function POST(req: Request): Promise<Response> {
  const crossSite = sameSiteOnly(req);
  if (crossSite) return crossSite;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return refuse(400, 'validation');
  }
  const parsed = signInBodySchema.safeParse(json);
  if (!parsed.success) return refuse(400, 'validation', 'Type your username and password.');
  const { username, password } = parsed.data;
  const ipHash = clientIpHash(req) ?? 'unknown';
  try {
    if (addressTooBusy(await recentWrongFrom(ipHash))) {
      return refuse(429, 'busy', 'Too many wrong tries from here. Wait 15 minutes and try again.', { 'Retry-After': '900' });
    }
    const login = await findLogin(username);
    if (!login || !login.password_hash) {
      // The same scrypt work either way, so the time taken doesn't say which usernames exist.
      await verifyPassword(password, await decoyHash());
      await logEvent('sign_in_wrong', { loginId: login?.id ?? null, ipHash });
      if (login && login.setup_code_hash) {
        return refuse(409, 'not_set_up', 'This sign-in is not set up yet. Tap “First time? Use your setup code”.');
      }
      return refuse(401, 'wrong', WRONG);
    }
    const locked = lockedMinutes(login);
    if (locked > 0) {
      return refuse(429, 'locked', `Too many wrong passwords. Try again in ${locked} minute${locked === 1 ? '' : 's'}.`);
    }
    if (!(await verifyPassword(password, login.password_hash))) {
      const { lockedNow } = await noteWrongPassword(login.id);
      await logEvent(lockedNow ? 'locked' : 'sign_in_wrong', { loginId: login.id, ipHash });
      return lockedNow
        ? refuse(429, 'locked', 'Too many wrong passwords. Try again in 15 minutes, or ask the owner for a new setup code.')
        : refuse(401, 'wrong', WRONG);
    }
    await noteSignedIn(login.id);
    const token = await startSession(login.id, req.headers.get('user-agent'));
    await logEvent('sign_in', { loginId: login.id, ipHash });
    return answer({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, isHttps(req)) });
  } catch (e) {
    logFailure('POST /dashboard/api/sign-in failed', e);
    return refuse(503, 'internal', 'The dashboard could not sign you in just now. Try again in a minute.');
  }
}
