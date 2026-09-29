import { MENU_DEPLOY_LEASE_SECONDS } from '@cheeseoclock/shared-types';
import { menuDeployClaimBodySchema } from '@cheeseoclock/shared-schemas/menu-deploy';
import { isUuid, logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';
import { claimPackage, ensureMenuDeploySchema } from '@/lib/menu-deploy-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: a till asks to import a package (lib/menu-deploy-store.ts
 * claimPackage has the rules). 200 { ok, leaseSeconds, package, contentGzB64 }:
 * import it and report within the lease. 409 { ok: false, error, package }:
 * why not (shared-types MENU_CLAIM_REFUSALS). 404 not_found.
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
    const parsed = menuDeployClaimBodySchema.safeParse(json);
    if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
    await ensureMenuDeploySchema();
    const r = await claimPackage(params.id.toLowerCase(), parsed.data);
    if (r.ok) {
      return noStore({
        ok: true,
        leaseSeconds: MENU_DEPLOY_LEASE_SECONDS,
        package: r.meta,
        contentGzB64: r.contentGzB64,
      });
    }
    if (r.status === 404) return noStore({ ok: false, error: 'not_found' }, 404);
    return noStore({ ok: false, error: r.error, package: r.meta, blockedBy: r.blockedBy }, 409);
  } catch (e) {
    logFailure('POST /api/bridge/menu-deploy/[id]/claim failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
