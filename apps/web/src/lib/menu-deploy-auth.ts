import { createHash, timingSafeEqual } from 'node:crypto';
import { MENU_DEPLOY_BAD_KEY_LIMIT, MENU_DEPLOY_KEY_RE } from '@cheeseoclock/shared-types';
import { isBridgeAuthorized } from '@/lib/bridge-auth';
import { countRecentBadKeys, ensureMenuDeploySchema, readKeyHash, recordBadKey } from '@/lib/menu-deploy-store';
import { clientIpHash } from '@/lib/rate-limit';

/**
 * Who may use the menu file auto-deploy routes (shared-types menu-deploy.ts):
 *  - /api/bridge/menu-deploy/*: the tills, with BRIDGE_SECRET (isBridgeAuthorized);
 *  - /api/menu-deploy: the costing PC, with the UPLOAD KEY the owner made on a
 *    till. The website holds only the key's SHA-256; the key is shaped
 *    'cocmenu_…', so it can never be BRIDGE_SECRET, and BRIDGE_SECRET is
 *    never an upload key.
 *
 * Every answer from these routes is `Cache-Control: no-store` — refusals
 * too — and carries no detail beyond its code.
 */

/**
 * Log a failure without what it carried: the error's name, code and message
 * only. A database error's `detail` can quote a whole failing row, and a
 * package row holds the menu file (costs and recipes), which never goes in a log.
 */
export function logFailure(label: string, e: unknown): void {
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  const word = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : undefined);
  console.error(label, { name: word(err?.name), code: word(err?.code), message: word(err?.message) });
}

/** A JSON answer no cache may keep. */
export function noStore(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** null when the till's BRIDGE_SECRET is right, else the 401 to send. */
export function refuseUnlessBridge(req: Request): Response | null {
  return isBridgeAuthorized(req) ? null : noStore({ ok: false, error: 'unauthorized' }, 401);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * null when the upload key is right, else the answer to send. In order:
 *  1. not shaped like a key (or BRIDGE_SECRET itself) → 401, before any look-up;
 *  2. ten wrong keys from this address in 15 minutes → 429, even for the
 *     right key (fails CLOSED: 503 when that count can't be made);
 *  3. no key registered yet → 401 no_key;
 *  4. the wrong key → 401, and a history line against this address.
 */
export async function refuseUnlessUploadKey(req: Request): Promise<Response | null> {
  const token = bearer(req);
  const secret = process.env['BRIDGE_SECRET'];
  if (!MENU_DEPLOY_KEY_RE.test(token) || (secret !== undefined && token === secret)) {
    return noStore({ ok: false, error: 'unauthorized' }, 401);
  }
  const ipHash = clientIpHash(req) ?? 'unknown';
  let stored: string | null;
  try {
    await ensureMenuDeploySchema();
    if ((await countRecentBadKeys(ipHash)) >= MENU_DEPLOY_BAD_KEY_LIMIT) {
      return noStore({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': '900' });
    }
    stored = await readKeyHash();
  } catch (e) {
    logFailure('menu-deploy: the upload key check could not read the database', e);
    return noStore({ ok: false, error: 'internal' }, 503);
  }
  if (stored === null) return noStore({ ok: false, error: 'no_key' }, 401);
  const given = Buffer.from(sha256Hex(token), 'hex');
  const want = /^[0-9a-f]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : Buffer.alloc(0);
  if (want.length === given.length && timingSafeEqual(given, want)) return null;
  try {
    await recordBadKey(ipHash);
  } catch (e) {
    logFailure('menu-deploy: a wrong upload key could not be recorded', e);
  }
  return noStore({ ok: false, error: 'unauthorized' }, 401);
}

/** The hash a till registers for a key (what the website compares against). */
export function menuDeployKeyHash(key: string): string {
  return sha256Hex(key);
}
