import { z } from 'zod';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
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
    });
    return Response.json({ ok: true, data: status });
  } catch (e) {
    console.error('PUT /api/bridge/status failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/** Bridge: read back what the site currently believes, for diagnostics. */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  return Response.json({ ok: true, data: await getStoreStatus() });
}
