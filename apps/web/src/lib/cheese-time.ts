import { SCHEMA_ORG_DAY, SHOP_DAYS, timeWords, type PublishedShopHours, type ShopDay } from '@cheeseoclock/shared-types';

/**
 * The brand line under the home page's and the late-night page's hero
 * ("It's 8:47 PM in DHA — definitely Cheese O’Clock."), worked out from the
 * owner's opening hours (display only) and, once the page has asked, from
 * whether the till is taking website orders right now (GET
 * /api/store-status: the shift decides, never the hours). Pure: the clock
 * and the status come in (components/CheeseTimeClient.tsx reads them).
 */

/** Minutes after midnight of "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** The day before (the hours after midnight belong to the day that opened them). */
function dayBefore(day: ShopDay): ShopDay {
  const i = SHOP_DAYS.indexOf(day);
  return SHOP_DAYS[(i + SHOP_DAYS.length - 1) % SHOP_DAYS.length]!;
}

/**
 * Open by its hours at this Karachi clock: `day` is the calendar day, `now`
 * the minutes after midnight. A close after midnight ("01:00", or "00:00")
 * belongs to the day before: at 00:30 on Tuesday the shop is open if it
 * opened on Monday.
 */
export function openByHours(hours: Pick<PublishedShopHours, 'opens' | 'closes' | 'days'>, day: ShopDay, now: number): boolean {
  const opens = minutesOf(hours.opens);
  const closes = minutesOf(hours.closes);
  if (closes > opens) return hours.days.includes(day) && now >= opens && now < closes;
  if (now >= opens) return hours.days.includes(day);
  return now < closes && hours.days.includes(dayBefore(day));
}

/** When it opens next, from a moment it is closed: "at 12 noon" (today), "tomorrow at 12 noon", "on Monday at 12 noon". */
export function nextOpening(hours: Pick<PublishedShopHours, 'opens' | 'closes' | 'days'>, day: ShopDay, now: number): string {
  const at = `at ${timeWords(hours.opens)}`;
  if (hours.days.includes(day) && now < minutesOf(hours.opens)) return at;
  const i = SHOP_DAYS.indexOf(day);
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const d = SHOP_DAYS[(i + ahead) % SHOP_DAYS.length]!;
    if (!hours.days.includes(d)) continue;
    return ahead === 1 ? `tomorrow ${at}` : `on ${SCHEMA_ORG_DAY[d]} ${at}`;
  }
  return at;
}

export interface CheeseTimeInput {
  hours: Pick<PublishedShopHours, 'opens' | 'closes' | 'days'>;
  /** The shop's name is today's: the line may play on it ("definitely Cheese O’Clock"). */
  nameIsDefault: boolean;
  /** The name in running text ("Cheese O’Clock"). */
  nameProse: string;
}

/** The line the page is served with (before the clock is read): today's words for today's name. */
export function cheeseTimeFallback(o: Pick<CheeseTimeInput, 'nameIsDefault' | 'nameProse'>): string {
  return o.nameIsDefault ? `It’s always ${o.nameProse} in DHA.` : 'Hot from our kitchen in DHA.';
}

/**
 * What follows "It's 8:47 PM in DHA — ":
 *  - taking website orders (the till's status) → "definitely Cheese O’Clock."
 *    (another name: "the kitchen is open.");
 *  - not taking them while the hours say open (the shift not opened yet, a
 *    pause) → "the kitchen isn’t taking website orders just now — WhatsApp us.";
 *  - not taking them, and closed by the hours → "we open at 12 noon. Almost
 *    Cheese O’Clock." (tomorrow / on Monday when not today);
 *  - `accepting` null (the status could not be read) → by the hours alone,
 *    as the line always was.
 */
export function cheeseTimeLine(o: CheeseTimeInput & { day: ShopDay; now: number; accepting: boolean | null }): string {
  const open = openByHours(o.hours, o.day, o.now);
  const taking = o.accepting ?? open;
  if (taking) return o.nameIsDefault ? `definitely ${o.nameProse}.` : 'the kitchen is open.';
  if (open) return 'the kitchen isn’t taking website orders just now — WhatsApp us.';
  const when = `we open ${nextOpening(o.hours, o.day, o.now)}.`;
  return o.nameIsDefault ? `${when} Almost ${o.nameProse}.` : when;
}

const WEEKDAY: Readonly<Record<string, ShopDay>> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/** Karachi's clock at this instant: the time as the page prints it, the calendar day, the minutes after midnight. */
export function karachiClock(at: Date): { time: string; day: ShopDay; now: number } {
  const time = at.toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit' });
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = WEEKDAY[part('weekday')] ?? 'mon';
  return { time, day, now: Number(part('hour')) * 60 + Number(part('minute')) };
}
