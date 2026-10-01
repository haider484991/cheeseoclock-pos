import { PICKUP_DISCOUNT_PERCENT } from '@cheeseoclock/shared-types';

/**
 * The website cancels an order it has not seen confirmed this long after the
 * customer placed it, and tells them to call: the mirror of
 * UNCONFIRMED_ORDER_TTL_MS in apps/web/src/lib/store-status.ts. The bridge
 * refuses to cook an order older than this, and the till shows when the
 * website will cancel one it has not confirmed yet.
 */
export const WEBSITE_UNCONFIRMED_TTL_MS = 45 * 60_000;

/**
 * The bridge asks the website again about an imported order it has not seen
 * confirmed (retryAcks) for this long after the import. An order the website
 * has not confirmed by then is long past its 45-minute cancel: only the
 * status push can still learn what happened to it. Every screen warns about
 * a not-confirmed order for the same 2 hours (alert-watch.ts), so its "the
 * till keeps trying" stays true.
 */
export const ACK_RETRY_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Is a web order too old to cook? Pure so it can be unit-tested without the
 * bridge. An unparseable timestamp is NOT treated as stale — the website's own
 * sweep still protects that case, and refusing a fresh order on a bad string
 * would be the worse mistake.
 */
export function isStaleWebOrder(createdAt: string, maxAgeMs: number, now: number = Date.now()): boolean {
  const placed = Date.parse(createdAt);
  return Number.isFinite(placed) && now - placed > maxAgeMs;
}

/**
 * The pick-up percent the customer was shown, read back from the order the
 * site sent (discount ÷ subtotal). The till used its own constant, so an order
 * placed just before an update changed the offer was billed at a price the
 * customer never saw. Orders from a site that predates the field fall back to
 * the constant; the result is kept to a sane 0–50%.
 */
export function pickupPercentOf(web: { fulfilment?: string; discountCents?: number; subtotalCents: number }): number {
  if (web.fulfilment !== 'pickup') return 0;
  if (typeof web.discountCents !== 'number' || !(web.subtotalCents > 0)) return PICKUP_DISCOUNT_PERCENT;
  const pct = Math.round((web.discountCents * 100) / web.subtotalCents);
  return Math.max(0, Math.min(50, pct));
}
