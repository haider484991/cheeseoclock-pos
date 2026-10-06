import { PICKUP_DISCOUNT_PERCENT, webOrderDeliveryPercent, webOrderPickupPercent } from '@cheeseoclock/shared-types';

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
 * site sent: the discount ÷ the lines it was worked on, which leave out the
 * lines the website flagged `noDiscount` (shared-types webOrderPickupPercent,
 * NO DISCOUNT ON VALUE DEALS). Discount ÷ subtotal read Rs 150 off a Rs 1,500
 * pizza next to a Rs 2,600 deal as 4%. The till used its own constant, so an
 * order placed just before an update changed the offer was billed at a price
 * the customer never saw. Orders from a site that predates the field fall
 * back to the constant; the result is kept to a sane 0–50%. A pick-up of
 * flagged lines only reads 0.
 */
export function pickupPercentOf(web: {
  fulfilment?: string;
  discountCents?: number;
  subtotalCents: number;
  items?: ReadonlyArray<{ unitPriceCents: number; quantity: number; noDiscount?: boolean }>;
}): number {
  return webOrderPickupPercent(web) ?? PICKUP_DISCOUNT_PERCENT;
}

/**
 * The website delivery % (v0.7.37, WEBSITE DELIVERY DISCOUNT) the customer
 * was shown, read back from the order: the discount ÷ the food it was worked
 * on (shared-types webOrderDeliveryPercent). 0 for a pick-up and for every
 * delivery that carries no discount (all of them before v0.7.37) — those
 * import exactly as before.
 */
export function deliveryPercentOf(web: {
  fulfilment?: string;
  discountCents?: number;
  items?: ReadonlyArray<{ name: string; unitPriceCents: number; quantity: number; noDiscount?: boolean }>;
}): number {
  return webOrderDeliveryPercent(web);
}
