import { DASH_PUSH_MAX_CHARS } from '@cheeseoclock/shared-types';
import { dashPushBodySchema } from '@cheeseoclock/shared-schemas/dashboard';
import { keepPush, stateFor } from '@/lib/dashboard/ingest';
import { logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: a till's figures for the owner's phone dashboard (shared-types
 * dashboard.ts DASHBOARD PUSH).
 *
 * GET ?device=<id> → { ok, data: DashPushState }: where the website is up to
 *   for this till (cursors null = it has never heard from it: send the
 *   history) and the days it holds figures for.
 * POST DashPushBody → { ok, data: DashPushResult }; 400 validation; 413 when
 *   the body is over DASH_PUSH_MAX_CHARS. Nothing here is ever public: the
 *   dashboard's pages read these tables behind their own sign-in.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  const device = new URL(req.url).searchParams.get('device') ?? '';
  if (device.length === 0 || device.length > 100) return noStore({ ok: false, error: 'validation' }, 400);
  try {
    return noStore({ ok: true, data: await stateFor(device) });
  } catch (e) {
    logFailure('GET /api/bridge/dashboard/push failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}

export async function POST(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  try {
    const text = await req.text();
    if (text.length > DASH_PUSH_MAX_CHARS) return noStore({ ok: false, error: 'too_large' }, 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return noStore({ ok: false, error: 'validation' }, 400);
    }
    const parsed = dashPushBodySchema.safeParse(json);
    if (!parsed.success) {
      // Where it failed (a path, never a value): the till logs it.
      const first = parsed.error.issues[0];
      return noStore({ ok: false, error: 'validation', message: first ? `${first.path.join('.')}: ${first.message}`.slice(0, 200) : undefined }, 400);
    }
    return noStore({ ok: true, data: await keepPush(parsed.data) });
  } catch (e) {
    logFailure('POST /api/bridge/dashboard/push failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
