import { menuDeployReportBodySchema } from '@cheeseoclock/shared-schemas/menu-deploy';
import { isUuid, logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';
import { ensureMenuDeploySchema, reportPackage } from '@/lib/menu-deploy-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: a till says what became of a package — applied (with the counts
 * of what changed), received (through the link), waiting_for_owner, too_old,
 * failed or refused (lib/menu-deploy-store.ts reportPackage has the rules).
 * 200 { ok, state, duplicate, accepted }; 404 not_found.
 */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  if (!isUuid(params.id)) return noStore({ ok: false, error: 'not_found' }, 404);
  try {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return noStore({ ok: false, error: 'validation' }, 400);
    }
    const parsed = menuDeployReportBodySchema.safeParse(json);
    if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
    await ensureMenuDeploySchema();
    const r = await reportPackage(params.id.toLowerCase(), parsed.data);
    if (!r.ok) return noStore({ ok: false, error: 'not_found' }, 404);
    return noStore({ ok: true, state: r.state, duplicate: r.duplicate, accepted: r.accepted });
  } catch (e) {
    logFailure('POST /api/bridge/menu-deploy/[id]/report failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
