import { logFailure, noStore, refuseUnlessUploadKey } from '@/lib/menu-deploy-auth';
import { ensureMenuDeploySchema, readMenuDeployStatus } from '@/lib/menu-deploy-store';
import { handleMenuUpload } from '@/lib/menu-deploy-upload';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * The costing PC (deploy_menu.py, with the owner's UPLOAD KEY — never
 * BRIDGE_SECRET): POST uploads a generated menu file (lib/menu-deploy-upload.ts);
 * GET says which till put in the latest one, or why not, with the last 50
 * history lines. Never the file itself: only the tills get that
 * (/api/bridge/menu-deploy/<id>/claim).
 */
export async function POST(req: Request): Promise<Response> {
  return handleMenuUpload(req);
}

export async function GET(req: Request): Promise<Response> {
  const refused = await refuseUnlessUploadKey(req);
  if (refused) return refused;
  try {
    await ensureMenuDeploySchema();
    return noStore(await readMenuDeployStatus({ events: true }));
  } catch (e) {
    logFailure('GET /api/menu-deploy failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
