import { changePassword, logEvent, passwordHashOf } from '@/lib/dashboard/logins';
import { passwordBodySchema, passwordProblem } from '@/lib/dashboard/forms';
import { hashPassword, verifyPassword } from '@/lib/dashboard/password';
import { answer, refuse, sameSiteOnly, userFromRequest } from '@/lib/dashboard/session';
import { logFailure } from '@/lib/menu-deploy-auth';
import { clientIpHash } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * A new password for the person signed in: { current, next }. Their other
 * phones are signed out; this one stays signed in. 401 not signed in or the
 * current password is wrong; 400 the new one breaks a rule.
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
  const parsed = passwordBodySchema.safeParse(json);
  if (!parsed.success) return refuse(400, 'validation', 'Type your current password and the new one.');
  try {
    const user = await userFromRequest(req);
    if (!user) return refuse(401, 'signed_out', 'You are signed out. Sign in again.');
    const problem = passwordProblem(parsed.data.next, user.username);
    if (problem) return refuse(400, 'weak_password', problem);
    const stored = await passwordHashOf(user.loginId);
    if (!stored || !(await verifyPassword(parsed.data.current, stored))) {
      await logEvent('password_wrong', { loginId: user.loginId, ipHash: clientIpHash(req) });
      return refuse(401, 'wrong', 'That is not your current password.');
    }
    await changePassword(user.loginId, await hashPassword(parsed.data.next), user.tokenHash);
    await logEvent('password_changed', { loginId: user.loginId, ipHash: clientIpHash(req) });
    return answer({ ok: true });
  } catch (e) {
    logFailure('POST /dashboard/api/password failed', e);
    return refuse(503, 'internal', 'The password could not be changed just now. Try again in a minute.');
  }
}
