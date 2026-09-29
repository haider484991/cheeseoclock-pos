import { logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';
import { ensureMenuDeploySchema, readMenuDeployStatus } from '@/lib/menu-deploy-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: a till's regular look (every few minutes) at the menu files from
 * the costing PC — the key's hint, the newest file and its state, the last
 * one put in, and each till's newest word about the newest file.
 * `?history=1` adds the last 50 history lines (Settings). Reads only; never
 * the file (claim it, or GET …/<id>/content for the wait-mode preview).
 * A website older than this route answers 404: the till then waits quietly.
 */
export async function GET(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  try {
    await ensureMenuDeploySchema();
    const history = new URL(req.url).searchParams.get('history') === '1';
    return noStore(await readMenuDeployStatus({ events: history }));
  } catch (e) {
    logFailure('GET /api/bridge/menu-deploy failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
