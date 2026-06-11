import { timingSafeEqual } from 'node:crypto';

/**
 * Shared-secret check for the /api/bridge/* endpoints. The POS sends
 * `Authorization: Bearer <BRIDGE_SECRET>`; constant-time compare so the
 * secret can't be timing-probed.
 */
export function isBridgeAuthorized(req: Request): boolean {
  const secret = process.env['BRIDGE_SECRET'];
  if (!secret || secret === 'change-me') return false; // refuse default config
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length === 0) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}
