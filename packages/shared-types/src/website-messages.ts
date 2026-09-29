/**
 * The website's messages and its delivery minimum (Settings → Online orders,
 * 'online.options' format 2 — sweep bundle B1): the owner's closed notice,
 * the announcement, and the smallest website DELIVERY order. They reach the
 * website in the settings block (shared-types web-bridge.ts, THE SETTINGS
 * BLOCK → "WEBSITE MESSAGES"). Pure and shared by the till (its card, the
 * block) and the website (its pages, the order route): no clock of its own —
 * every helper that needs the time takes `nowMs`.
 *
 * Every default is today's website: no notice (the website's own closed
 * texts), no announcement, no minimum.
 */

/** The owner's words while the website is closed (the banner and the "closed" refusals). */
export interface ClosedNotice {
  /** One line of plain words, at most CLOSED_NOTICE_MAX letters; '' = no notice (the website's own closed texts, as today). */
  text: string;
  /**
   * The LAST Karachi calendar day the notice shows ('YYYY-MM-DD', that whole
   * day included); null = no end date: it shows every night the website is
   * closed (the website closes by itself when the last shift closes). From
   * 00:00 Karachi time the day after, the website's own texts come back by
   * themselves.
   */
  until: string | null;
}

/** A line the website shows on the home page and the menu page while it is on. */
export interface WebsiteAnnouncement {
  on: boolean;
  /** One line of plain words, at most ANNOUNCEMENT_MAX letters; never '' while on (the till refuses it). */
  text: string;
}

/** The longest closed notice (letters). */
export const CLOSED_NOTICE_MAX = 160;
/** The longest announcement (letters). */
export const ANNOUNCEMENT_MAX = 120;
/** The highest smallest-delivery-order: Rs 5,000 (paisa, whole rupees). */
export const MIN_DELIVERY_ORDER_MAX_CENTS = 500_000;

/**
 * Characters a website message may not hold, anywhere in it:
 * - every control character (Unicode Cc: U+0000-U+001F, U+007F-U+009F; a
 *   line break or a tab too, a message is ONE line) and the line and
 *   paragraph separators U+2028, U+2029;
 * - every format character (Unicode Cf): the marks that turn or embed the
 *   text's direction (they can make the words read differently from what was
 *   typed: U+200E, U+200F, U+202A-U+202E, U+2066-U+2069, the Arabic letter
 *   mark U+061C), the invisible ones (the zero-width space U+200B, the word
 *   joiner and invisible operators U+2060-U+2064, the byte order mark U+FEFF,
 *   the soft hyphen U+00AD, U+180E, the Arabic shaping controls
 *   U+206A-U+206F, U+FFF9-U+FFFB, the tag characters U+E0001 and
 *   U+E0020-U+E007F) and any other one, whatever Unicode adds;
 * - EXCEPT the zero-width non-joiner U+200C (an Urdu keyboard types it
 *   between letters that must not join) and the zero-width joiner U+200D (it
 *   builds emoji: the chef is the man U+1F468, U+200D, the cooking U+1F373).
 * Urdu letters are words like any other. The till's Save and the website's
 * check both use this one rule (shared-schemas websiteLine).
 */
export const WEBSITE_TEXT_FORBIDDEN_RE = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Today: no notice. */
export const NO_CLOSED_NOTICE: Readonly<ClosedNotice> = Object.freeze({ text: '', until: null });
/** Today: no announcement. */
export const NO_ANNOUNCEMENT: Readonly<WebsiteAnnouncement> = Object.freeze({ on: false, text: '' });

/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const KARACHI_OFFSET_MS = 5 * 60 * 60_000;

/**
 * The calendar day in Karachi at `nowMs` ('YYYY-MM-DD'). Worked in UTC only,
 * never with the machine's own time zone: a server in another zone (Vercel
 * runs in UTC; a developer's laptop anywhere) gives the same day.
 */
export function karachiDateOf(nowMs: number): string {
  return new Date(nowMs + KARACHI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The owner's closed notice to show at `nowMs`, or null when the website's
 * own texts apply: no notice, no words, or its last day (`until`, a Karachi
 * calendar day, included) is over.
 */
export function closedNoticeInForce(notice: ClosedNotice | null | undefined, nowMs: number): string | null {
  if (!notice) return null;
  const text = notice.text.trim();
  if (text === '') return null;
  if (notice.until !== null && karachiDateOf(nowMs) > notice.until) return null;
  return text;
}

/** The announcement's words while it is on (and has words), else null. */
export function announcementInForce(a: WebsiteAnnouncement | null | undefined): string | null {
  if (!a || !a.on) return null;
  const text = a.text.trim();
  return text === '' ? null : text;
}

/**
 * How much more FOOD a website delivery order needs to reach the owner's
 * smallest delivery order (paisa): 0 when there is no minimum (0) or it is
 * reached. `foodCents` = the order's lines (each item with its choices, times
 * its quantity) BEFORE tax, the delivery charge and any discount. Only ever
 * asked for a website DELIVERY: a pick-up is never refused, and an order
 * rung up at the till is never checked.
 */
export function deliveryMinimumShortfallCents(foodCents: number, minimumCents: number): number {
  if (!(minimumCents > 0)) return 0;
  return Math.max(0, minimumCents - foodCents);
}
