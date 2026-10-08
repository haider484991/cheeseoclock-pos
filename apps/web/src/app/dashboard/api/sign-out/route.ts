import { logEvent } from '@/lib/dashboard/logins';
import { signOutBodySchema } from '@/lib/dashboard/forms';
import { answer, clearedSessionCookie, endOtherSessions, endSession, isHttps, refuse, sameSiteOnly, userFromRequest } from '@/lib/dashboard/session';
import { logFailure } from '@/lib/menu-deploy-auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Sign out this phone ({}), or every phone of the person ({ everywhere: true }).
 * Always answers 200 with the cookie cleared, signed in or not.
 */
export async function POST(req: Request): Promise<Response> {
  const crossSite = sameSiteOnly(req);
  if (crossSite) return crossSite;
  let everywhere = false;
  try {
    const parsed = signOutBodySchema.safeParse(await req.json());
    everywhere = parsed.success && parsed.data.everywhere === true;
  } catch {
    // An empty body is a plain sign-out.
  }
  const cleared = { 'Set-Cookie': clearedSessionCookie(isHttps(req)) };
  try {
    const user = await userFromRequest(req);
    if (user) {
      if (everywhere) {
        await endOtherSessions(user.loginId, null);
        await logEvent('signed_out_all', { loginId: user.loginId });
      } else {
        await endSession(user.tokenHash);
      }
    }
    return answer({ ok: true }, 200, cleared);
  } catch (e) {
    logFailure('POST /dashboard/api/sign-out failed', e);
    return refuse(503, 'internal', 'Could not sign out on the website just now; this phone is signed out.', cleared);
  }
}
