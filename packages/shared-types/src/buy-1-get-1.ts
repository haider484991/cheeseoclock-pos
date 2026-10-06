/**
 * Buy 1 Get 1 (the owner's poster, 5 Oct 2026; built 7 Oct): the deals are menu items in a category whose name
 * says so ("Buy 1 Get 1 Deals"), made and priced on the till like the value deals — the regular pizza you pay
 * for, and the free burger, side or Medium as a Rs 0 choice. Rules ride on top, here once for the till and the
 * website alike, set by the owner in Settings → Money & discounts → "Buy 1 Get 1 deals" ('offers.buy1Get1',
 * shop-settings.ts; owner, 7 Oct 2026: "all these settings should be in the settings"):
 *
 *  - ON / OFF: off, the deals are sold nowhere (the till greys them, the website hides them and its offer).
 *  - HOURS: every day from `opensMinute` up to `closesMinute` of the Karachi day (1 PM–7 PM until the owner
 *    changes them). The till refuses one rung up outside them (unless the order was started inside them), and
 *    the website shows them closed and refuses them.
 *  - TAG US: the customer earns the free item by posting the meal, tagging the shop and showing the post. On the
 *    website the order asks for their Instagram or Facebook name — required with a deal in the cart while
 *    `asksSocial` is on; it goes first in the order's notes, so the cashier sees whose post to check. At the
 *    counter the cashier just looks.
 *
 * Like the value deals, they never take a % off (categoryNeverDiscounted). Pure: no clock of its own.
 */

/** A category of Buy 1 Get 1 deals, by its name: "Buy 1 Get 1", "Buy One Get One Free", "Buy 1 Get 1 Deals". */
export const BUY_1_GET_1_NAME_RE = /\bbuy\s*(?:1|one)\s*get\s*(?:1|one)\b/i;

export function isBuy1Get1Category(name: string): boolean {
  return BUY_1_GET_1_NAME_RE.test(name);
}

/** The rules the till and the website apply (the owner's setting, or these defaults until the owner saves one). */
export interface Buy1Get1Rules {
  /** Sold at all. */
  on: boolean;
  /** From this minute of the Karachi day (0–1439)… */
  opensMinute: number;
  /** …up to, not including, this one (1–1440, after `opensMinute`). */
  closesMinute: number;
  /** The website asks for the customer's Instagram / Facebook name with a deal in the cart (required). */
  asksSocial: boolean;
}

/** The poster's rules: on, every day 1 PM up to 7 PM, the name asked for. */
export const DEFAULT_BUY_1_GET_1_RULES: Readonly<Buy1Get1Rules> = Object.freeze({
  on: true,
  opensMinute: 13 * 60,
  closesMinute: 19 * 60,
  asksSocial: true,
});

/** Pakistan Standard Time is UTC+5 all year (no daylight saving since 2009). */
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/** The minute of the Karachi day (0–1439) at a moment. */
export function karachiMinuteOfDay(ms: number): number {
  const day = 24 * 60 * 60 * 1000;
  const local = (((ms + KARACHI_OFFSET_MS) % day) + day) % day;
  return Math.floor(local / 60_000);
}

/**
 * Why these hours can't be saved, in the owner's words, or null: a start from 12 AM to 11:59 PM (0–1439), an end
 * from 12:01 AM to midnight (1–1440), not the same minute. An end before the start runs past midnight ("10 PM–1 AM").
 */
export function buy1Get1HoursProblem(h: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'>): string | null {
  const { opensMinute: from, closesMinute: to } = h;
  if (!Number.isInteger(from) || from < 0 || from > 1439) return 'Pick when the Buy 1 Get 1 deals start';
  if (!Number.isInteger(to) || to < 1 || to > 1440) return 'Pick when the Buy 1 Get 1 deals end';
  if (from === to) return 'The Buy 1 Get 1 deals start and end at the same time: pick a different end';
  return null;
}

/** Every minute of the day (12 AM up to midnight). */
const allDay = (rules: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'>) => rules.opensMinute === 0 && rules.closesMinute === 1440;

/** Whether Buy 1 Get 1 deals are on sale at a moment: switched on, and inside the hours. */
export function buy1Get1OpenAt(ms: number, rules: Buy1Get1Rules = DEFAULT_BUY_1_GET_1_RULES): boolean {
  if (!rules.on) return false;
  const m = karachiMinuteOfDay(ms);
  // Hours past midnight ("10 PM–1 AM"): from the start to the day's end, and from midnight to the end.
  return rules.opensMinute < rules.closesMinute
    ? m >= rules.opensMinute && m < rules.closesMinute
    : m >= rules.opensMinute || m < rules.closesMinute;
}

/**
 * Whether a deal may go on an order now: on sale now, or the order was started while they were (a counter order
 * begun at 6:58 PM may still take its deal at 7:02). Switched off, never. A missing or unreadable start counts as
 * not started then.
 */
export function buy1Get1AllowedOn(
  nowMs: number,
  orderStartedAt: string | null | undefined,
  rules: Buy1Get1Rules = DEFAULT_BUY_1_GET_1_RULES,
): boolean {
  if (!rules.on) return false;
  if (buy1Get1OpenAt(nowMs, rules)) return true;
  const started = orderStartedAt ? Date.parse(orderStartedAt) : Number.NaN;
  return Number.isFinite(started) && buy1Get1OpenAt(started, rules);
}

/** A minute of the day as the poster prints it, without "AM"/"PM": 780 → "1", 810 → "1:30", 0 → "12". */
function clockWords(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  const h12 = Math.floor(m / 60) % 12 || 12;
  const mm = m % 60;
  return mm === 0 ? String(h12) : `${h12}:${String(mm).padStart(2, '0')}`;
}
const half = (minute: number) => (((minute % 1440) + 1440) % 1440 < 720 ? 'AM' : 'PM');

/**
 * The hours as the poster and the screens print them: "1–7 PM", "11 AM–3 PM", "1:30–7 PM", "10 PM–1 AM",
 * "6 PM–12 AM" (to midnight), "all day".
 */
export function buy1Get1WindowWords(rules: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'> = DEFAULT_BUY_1_GET_1_RULES): string {
  if (allDay(rules)) return 'all day';
  const from = clockWords(rules.opensMinute);
  const to = clockWords(rules.closesMinute);
  const fromHalf = half(rules.opensMinute);
  const toHalf = half(rules.closesMinute);
  // "1–7 PM" only when both are in the same half of ONE day: "1 PM–1 PM" past midnight is never "1–1 PM".
  return fromHalf === toHalf && rules.opensMinute < rules.closesMinute ? `${from}–${to} ${toHalf}` : `${from} ${fromHalf}–${to} ${toHalf}`;
}

/**
 * The hours in a sentence: "from 1 PM to 7 PM", "all day". Never "every day": the website says that only while the
 * shop opens all seven days (its own claimed copy), and the deals are sold only while the shop is open.
 */
function windowSentence(rules: Pick<Buy1Get1Rules, 'opensMinute' | 'closesMinute'>): string {
  if (allDay(rules)) return 'all day';
  return `from ${clockWords(rules.opensMinute)} ${half(rules.opensMinute)} to ${clockWords(rules.closesMinute)} ${half(rules.closesMinute)}`;
}

/** The till's and the website's words when a deal is asked for outside the hours, or while they are switched off. */
export function buy1Get1ClosedMessage(rules: Buy1Get1Rules = DEFAULT_BUY_1_GET_1_RULES): string {
  return rules.on ? `Buy 1 Get 1 deals are sold ${windowSentence(rules)}.` : 'Buy 1 Get 1 deals are not on at the moment.';
}

/** The owner's rules in one line (the Settings card, its history): "On · every day 1–7 PM · the website asks for…". */
export function buy1Get1Summary(rules: Buy1Get1Rules): string {
  if (!rules.on) return 'Off: the deals are not sold, on the till or the website';
  const name = rules.asksSocial ? 'the website asks for the Instagram or Facebook name' : 'the name is optional on the website';
  return `On · ${allDay(rules) ? 'all day, every day' : `every day ${buy1Get1WindowWords(rules)}`} · ${name}`;
}

/** The website's words when a deal is ordered without the customer's Instagram or Facebook name. */
export const BUY_1_GET_1_SOCIAL_MESSAGE =
  'Add your Instagram or Facebook name to get the Buy 1 Get 1 deal: post your meal, tag us and show us the post.';

/**
 * What a website order's notes say first, so the cashier knows whose post to check — or, with no name given (the
 * owner made it optional), to ask for it. Plain ASCII: the notes print on the kitchen's printer.
 */
export function buy1Get1NoteLine(social: string | null): string {
  return social ? `Buy 1 Get 1: check the post by ${social}` : 'Buy 1 Get 1: ask to see the post';
}
