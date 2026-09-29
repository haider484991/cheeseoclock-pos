import { isUuid, logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';
import { ensureMenuDeploySchema, readPackageContent } from '@/lib/menu-deploy-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: one package's file, for the till's "Show the changes" (wait for
 * my OK). Changes nothing — importing it takes a claim. 404 not_found;
 * 410 gone once the website no longer keeps it (only the newest few).
 */
export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  if (!isUuid(params.id)) return noStore({ ok: false, error: 'not_found' }, 404);
  try {
    await ensureMenuDeploySchema();
    const r = await readPackageContent(params.id.toLowerCase());
    if (r.kind === 'missing') return noStore({ ok: false, error: 'not_found' }, 404);
    if (r.kind === 'gone') return noStore({ ok: false, error: 'gone' }, 410);
    return noStore({ ok: true, sha256: r.sha256, contentGzB64: r.contentGzB64 });
  } catch (e) {
    logFailure('GET /api/bridge/menu-deploy/[id]/content failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
