import { readClosedNotice } from '@/lib/site-facts';
import { getStoreStatus } from '@/lib/store-status';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Public: is the shop taking online orders right now? The menu page polls
 * this so a customer who has the page open sees it close (or reopen) without
 * refreshing. Only the boolean is exposed — the heartbeat timestamp and
 * device id are operational detail.
 *
 * With it (v0.7.30), the owner's closed notice as it stands NOW (the words
 * only, worked out here — never its last day): a page left open past the
 * notice's last Karachi day goes back to its own closed words at the next
 * poll, and a notice saved since shows (null = the page's own words; no
 * key = no word, as from an older website: the page keeps what it was served).
 */
export async function GET(): Promise<Response> {
  const [status, closedNotice] = await Promise.all([getStoreStatus(), readClosedNotice()]);
  return Response.json(
    {
      ok: true,
      data: {
        acceptingOrders: status.acceptingOrders,
        pickupAvailable: status.pickupAvailable,
        pickupDiscountPercent: status.pickupDiscountPercent,
        // Absent (undefined drops out of the JSON) when there is no word: the page keeps its own.
        ...(closedNotice === undefined ? {} : { closedNotice }),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
