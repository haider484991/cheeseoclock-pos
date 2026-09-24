import { getStoreStatus } from '@/lib/store-status';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Public: is the shop taking online orders right now? The menu page polls
 * this so a customer who has the page open sees it close (or reopen) without
 * refreshing. Only the boolean is exposed — the heartbeat timestamp and
 * device id are operational detail.
 */
export async function GET(): Promise<Response> {
  const status = await getStoreStatus();
  return Response.json(
    {
      ok: true,
      data: { acceptingOrders: status.acceptingOrders, pickupAvailable: status.pickupAvailable },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
