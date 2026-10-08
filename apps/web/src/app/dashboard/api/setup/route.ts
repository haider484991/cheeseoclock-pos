import { isSetupCodeShape } from '@cheeseoclock/shared-types';
import { addressTooBusy, checkSetupCode, findLogin, finishSetup, logEvent, noteSignedIn, recentWrongFrom } from '@/lib/dashboard/logins';
import { passwordProblem, setupBodySchema } from '@/lib/dashboard/forms';
import { hashPassword } from '@/lib/dashboard/password';
import { answer, isHttps, refuse, sameSiteOnly, sessionCookie, startSession } from '@/lib/dashboard/session';
import { logFailure } from '@/lib/menu-deploy-auth';
import { clientIpHash } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

const NO_CODE = 'That setup code doesn’t work. Check it, or ask the owner to make a new one on the till.';

/**
 * First time on the dashboard: { username, code, password } — the one-time
 * code the owner made on the till, and the person's own new password.
 * 200 signs them in; 400 the password breaks a rule (the code is NOT used
 * up); 401 wrong / expired / used code (5 wrong void it); 429 busy.
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
  const parsed = setupBodySchema.safeParse(json);
  if (!parsed.success) return refuse(400, 'validation', 'Fill in your username, the setup code and a password.');
  const { username, code, password } = parsed.data;
  const problem = passwordProblem(password, username);
  if (problem) return refuse(400, 'weak_password', problem);
  const ipHash = clientIpHash(req) ?? 'unknown';
  try {
    if (addressTooBusy(await recentWrongFrom(ipHash))) {
      return refuse(429, 'busy', 'Too many wrong tries from here. Wait 15 minutes and try again.', { 'Retry-After': '900' });
    }
    const login = await findLogin(username);
    if (!login || !isSetupCodeShape(code)) {
      await logEvent('setup_wrong', { loginId: login?.id ?? null, ipHash });
      return refuse(401, 'bad_code', NO_CODE);
    }
    const check = await checkSetupCode(login, code);
    if (check !== 'ok') {
      await logEvent('setup_wrong', { loginId: login.id, ipHash, detail: { why: check } });
      return refuse(
        401,
        'bad_code',
        check === 'expired' ? 'That setup code has run out. Ask the owner to make a new one on the till.' : NO_CODE,
      );
    }
    if (!(await finishSetup(login, await hashPassword(password)))) {
      return refuse(409, 'used', 'That setup code was just used. Sign in with your password.');
    }
    await noteSignedIn(login.id);
    const token = await startSession(login.id, req.headers.get('user-agent'));
    await logEvent('setup_done', { loginId: login.id, ipHash });
    return answer({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, isHttps(req)) });
  } catch (e) {
    logFailure('POST /dashboard/api/setup failed', e);
    return refuse(503, 'internal', 'The dashboard could not finish your setup just now. Try again in a minute.');
  }
}
