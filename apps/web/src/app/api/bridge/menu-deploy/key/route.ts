import { menuDeployKeyBodySchema } from '@cheeseoclock/shared-schemas/menu-deploy';
import { menuDeployKeyHash, logFailure, noStore, refuseUnlessBridge } from '@/lib/menu-deploy-auth';
import { ensureMenuDeploySchema, storeKey } from '@/lib/menu-deploy-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/**
 * Bridge: the owner made a new upload key on this till (Settings, owner
 * only). The till sends its SHA-256 and last 4 characters — never the key.
 * The one key row is replaced, so the old key stops working at once.
 * 200 { ok, createdAt }; 400 validation (including the hash of BRIDGE_SECRET
 * itself: the two are never the same thing).
 */
export async function PUT(req: Request): Promise<Response> {
  const refused = refuseUnlessBridge(req);
  if (refused) return refused;
  try {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return noStore({ ok: false, error: 'validation' }, 400);
    }
    const parsed = menuDeployKeyBodySchema.safeParse(json);
    if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
    const secret = process.env['BRIDGE_SECRET'];
    if (secret && parsed.data.keyHash === menuDeployKeyHash(secret)) {
      return noStore({ ok: false, error: 'validation' }, 400);
    }
    await ensureMenuDeploySchema();
    const createdAt = await storeKey(parsed.data);
    return noStore({ ok: true, createdAt });
  } catch (e) {
    logFailure('PUT /api/bridge/menu-deploy/key failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}
