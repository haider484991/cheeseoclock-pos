/**
 * Buy 1 Get 1 (the owner's poster, 5 Oct 2026; built 7 Oct): the deals are menu items in a category whose name
 * says so ("Buy 1 Get 1 Deals"), made and priced on the till like the value deals — the regular pizza you pay
 * for, and the free burger, side or Medium as a Rs 0 choice. Two rules ride on top, here once for the till and
 * the website alike:
 *
 *  - HOURS: they are sold every day from 1 PM up to 7 PM, Karachi time. The till refuses one rung up outside
 *    them (unless the order was started inside them), and the website shows them closed and refuses them.
 *  - TAG US: the customer earns the free item by posting the meal, tagging the shop and showing the post. On the
 *    website the order asks for their Instagram or Facebook name (required with a deal in the cart); it goes
 *    first in the order's notes, so the cashier sees whose post to check. At the counter the cashier just looks.
 *
 * Like the value deals, they never take a % off (categoryNeverDiscounted). Pure: no clock of its own.
 */

/** A category of Buy 1 Get 1 deals, by its name: "Buy 1 Get 1", "Buy One Get One Free", "Buy 1 Get 1 Deals". */
export const BUY_1_GET_1_NAME_RE = /\bbuy\s*(?:1|one)\s*get\s*(?:1|one)\b/i;

export function isBuy1Get1Category(name: string): boolean {
  return BUY_1_GET_1_NAME_RE.test(name);
}

/** The hours, as minutes of the Karachi day: from 13:00 up to (not including) 19:00. */
export const BUY_1_GET_1_HOURS = { opensMinute: 13 * 60, closesMinute: 19 * 60 } as const;

/** The hours as the poster and the screens print them. */
export const BUY_1_GET_1_WINDOW = '1–7 PM';

/** Pakistan Standard Time is UTC+5 all year (no daylight saving since 2009). */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/** The minute of the Karachi day (0–1439) at a moment. */
export function karachiMinuteOfDay(ms: number): number {
  const day = 24 * 60 * 60 * 1000;
  const local = (((ms + KARACHI_OFFSET_MS) % day) + day) % day;
  return Math.floor(local / 60_000);
}

/** Whether Buy 1 Get 1 deals are on sale at a moment. */
export function buy1Get1OpenAt(ms: number): boolean {
  const m = karachiMinuteOfDay(ms);
  return m >= BUY_1_GET_1_HOURS.opensMinute && m < BUY_1_GET_1_HOURS.closesMinute;
}

/**
 * Whether a deal may go on an order now: on sale now, or the order was started while they were (a counter order
 * begun at 6:58 PM may still take its deal at 7:02). A missing or unreadable start counts as not started then.
 */
export function buy1Get1AllowedOn(nowMs: number, orderStartedAt: string | null | undefined): boolean {
  if (buy1Get1OpenAt(nowMs)) return true;
  const started = orderStartedAt ? Date.parse(orderStartedAt) : Number.NaN;
  return Number.isFinite(started) && buy1Get1OpenAt(started);
}

/** The till's and the website's words when a deal is asked for outside the hours. */
export const BUY_1_GET_1_CLOSED_MESSAGE = `Buy 1 Get 1 deals are sold every day from 1 PM to 7 PM.`;

/** The website's words when a deal is ordered without the customer's Instagram or Facebook name. */
export const BUY_1_GET_1_SOCIAL_MESSAGE =
  'Add your Instagram or Facebook name to get the Buy 1 Get 1 deal: post your meal, tag us and show us the post.';

/** What the order's notes say first, so the cashier knows whose post to check. */
export function buy1Get1NoteLine(social: string): string {
  return `Buy 1 Get 1: check the post by ${social}`;
}
