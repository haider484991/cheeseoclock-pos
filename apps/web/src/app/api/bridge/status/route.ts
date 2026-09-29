import { z } from 'zod';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { storedHeld } from '@/lib/publish-settings';
import { getStoreStatus, setStoreStatus } from '@/lib/store-status';

export const dynamic = 'force-dynamic';

const StatusSchema = z.object({
  acceptingOrders: z.boolean(),
  deviceId: z.string().max(200).nullable().optional(),
  /**
   * What this till can do (BridgeHeartbeatBody). Tills from before pickup send
   * none, and unknown words from newer ones are ignored rather than refused.
   */
  features: z.array(z.string().max(40)).max(20).optional(),
  /** The pickup discount the till applies (v0.7.1+; v0.7.0 sends none = 10). */
  pickupDiscountPercent: z.number().int().min(0).max(50).optional(),
});

/**
 * Bridge: the POS heartbeats whether it is accepting online orders. Sent on
 * every poll and immediately when the setting is toggled, so the website
 * closes the moment the till stops listening rather than collecting orders
 * nobody will cook.
 */
export async function PUT(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = StatusSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'validation', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const status = await setStoreStatus({
      acceptingOrders: parsed.data.acceptingOrders,
      deviceId: parsed.data.deviceId ?? null,
      pickup: parsed.data.features?.includes('pickup') ?? false,
      pickupDiscountPercent: parsed.data.pickupDiscountPercent ?? null,
    });
    return Response.json({ ok: true, data: status });
  } catch (e) {
    console.error('PUT /api/bridge/status failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/**
 * Bridge: read back what the site currently believes, for diagnostics — and
 * which settings block it holds (`settings`: its stamp, the till that sent
 * it, and whether it fits the stored menu; null when none), so a till can
 * tell a website that lost its block (a rollback) at its next start. The
 * same for the shop block (`shop`: its stamp and the till that sent it;
 * null when none — THE SHOP BLOCK), with the home page's featured items the
 * stored menu lacks (`homeMissing`).
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  const [status, held] = await Promise.all([
    getStoreStatus(),
    storedHeld().catch((e: unknown) => {
      console.error('stored settings read failed', e);
      return undefined;
    }),
  ]);
  // Unreadable: no `settings` and no `shop` at all (the till keeps what it knew), never "none" (it
  // would resend).
  return Response.json({
    ok: true,
    data: held === undefined ? status : { ...status, settings: held.settings, shop: held.shop, homeMissing: held.homeMissing },
  });
}
