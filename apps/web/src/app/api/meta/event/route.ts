import { z } from 'zod';
import { findFactZone } from '@/lib/delivery-facts';
import { sendServerLocation } from '@/lib/meta-capi';
import { EVENT_ID, LOCATION_EVENT_NAME } from '@/lib/meta-pixel';
import { getSiteFacts } from '@/lib/site-facts';

export const dynamic = 'force-dynamic';

/**
 * Public: the server's copy of the landing popup's LocationConfirmed (components/location), for
 * Meta's Conversions API (lib/meta-capi) — the browser's own event can be lost to a blocker, this one
 * can't. Carries only delivery or pick-up and the area's name (checked against the owner's areas),
 * plus what the request itself says (IP, browser, the Pixel's cookies). Nothing is stored.
 *
 * Always answers 204, and with the Conversions API off (no token) sends nothing. A burst from one
 * address is cut off (LIMIT per WINDOW_MS, this server's memory): it can only ever send these events.
 */

const Body = z.object({
  event: z.literal(LOCATION_EVENT_NAME),
  eventId: z.string().regex(EVENT_ID),
  fulfilment: z.enum(['delivery', 'pickup']),
  zoneId: z.string().max(40).nullish(),
});

const LIMIT = 12;
const WINDOW_MS = 10 * 60_000;
const seen = new Map<string, number[]>();

/** True while this address is under LIMIT events in WINDOW_MS (and counts this one). Not exported: a route file may export only its handlers. */
function underLimit(ip: string, nowMs: number = Date.now()): boolean {
  const recent = (seen.get(ip) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    seen.set(ip, recent);
    return false;
  }
  recent.push(nowMs);
  seen.set(ip, recent);
  // Forget quiet addresses now and then, so the map cannot grow without end.
  if (seen.size > 5_000) for (const [k, v] of seen) if (v.every((t) => nowMs - t >= WINDOW_MS)) seen.delete(k);
  return true;
}

const done = () => new Response(null, { status: 204 });

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return done();
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return done();
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || '';
  if (!underLimit(ip || 'unknown')) return done();
  const { eventId, fulfilment, zoneId } = parsed.data;
  let zoneName: string | null = null;
  if (fulfilment === 'delivery') {
    // Only an area the owner delivers to now: anything else is not sent.
    const zone = findFactZone(await getSiteFacts(), zoneId);
    if (!zone?.active) return done();
    zoneName = zone.name;
  }
  await sendServerLocation(req, { fulfilment, zoneName }, eventId);
  return done();
}
