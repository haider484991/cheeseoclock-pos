import { dashLoginsBodySchema } from '@cheeseoclock/shared-schemas/dashboard';
import { applyLoginChange, listLogins } from '@/lib/dashboard/logins';
import { logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: the phone dashboard's sign-in list, as the owner keeps it on a
 * till (Settings → Online orders → Phone dashboard). The till checks the
 * owner login itself; here the till's BRIDGE_SECRET is the gate.
 *
 * GET  → { ok, data: { logins: DashLoginView[] } } (never a hash or a code).
 * POST { change, deviceId, deviceName, appVersion, actorName } → the same,
 *      after the change; 409 username_taken / 404 not_found; 400 validation.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  try {
    return noStore({ ok: true, data: { logins: await listLogins() } });
  } catch (e) {
    logFailure('GET /api/bridge/dashboard/logins failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}

export async function POST(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return noStore({ ok: false, error: 'validation' }, 400);
  }
  const parsed = dashLoginsBodySchema.safeParse(json);
  if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
  const { change, deviceId, deviceName, actorName } = parsed.data;
  try {
    const done = await applyLoginChange(change, { deviceId, deviceName, actorName });
    if (!done.ok) {
      const status = done.refusal === 'username_taken' ? 409 : done.refusal === 'not_found' ? 404 : 400;
      return noStore({ ok: false, error: done.refusal }, status);
    }
    return noStore({ ok: true, data: { logins: await listLogins() } });
  } catch (e) {
    // Two tills adding the same username at once: the unique index answers.
    if ((e as { code?: unknown })?.code === '23505') return noStore({ ok: false, error: 'username_taken' }, 409);
    logFailure('POST /api/bridge/dashboard/logins failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
