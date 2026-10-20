/**
 * The shop's clock (international edition, Phase 1c): which trading day an
 * instant belongs to, what hour it is at the shop, and when today started.
 *
 * Pakistan keeps the integer maths it has always used, untouched: Pakistan is
 * UTC+5 all year, and its trading day starts at 05:00, which is 00:00 UTC —
 * so a Pakistani trading day is simply the UTC date. That coincidence is what
 * the till was built on, and it is why a New York till numbered its orders
 * from #0001 again at 7 pm. Every other shop works from its own wall clock,
 * through Intl and its IANA zone, so daylight saving is followed: a US
 * trading day is 05:00 to 05:00 local, 23 or 25 hours long on the days the
 * clocks change.
 */
import { getShopLocale, type ShopLocale } from './shop-locale.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Pakistan is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * HOUR_MS;

/** A shop on Pakistan's arithmetic: the integer maths, never Intl. */
function onPakistanTime(locale: ShopLocale): boolean {
  return locale.country === 'PK';
}

/** The shop's wall clock at an instant, read through Intl (cached per zone). */
interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
const wallFormats = new Map<string, Intl.DateTimeFormat>();
function wallAt(ms: number, timeZone: string): Wall {
  let f = wallFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallFormats.set(timeZone, f);
  }
  const out: Wall = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'year') out.y = Number(p.value);
    else if (p.type === 'month') out.m = Number(p.value);
    else if (p.type === 'day') out.d = Number(p.value);
    else if (p.type === 'hour') out.h = Number(p.value) % 24;
    else if (p.type === 'minute') out.mi = Number(p.value);
    else if (p.type === 'second') out.s = Number(p.value);
  }
  return out;
}

/** How far the shop's wall clock is ahead of UTC at an instant (negative in the US). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallAt(ms, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The shop's wall clock at an instant, for a till outside Pakistan (paper-time.ts). */
export function shopWallClock(ms: number, locale: ShopLocale = getShopLocale()): Readonly<Wall> {
  return wallAt(ms, locale.timeZone);
}

/** "2026-10-20" for a UTC midnight. */
const ymdOf = (utcMidnightMs: number): string => new Date(utcMidnightMs).toISOString().slice(0, 10);

/**
 * The trading day (YYYY-MM-DD) an instant belongs to. Before the day's start
 * hour (05:00) an instant belongs to the night before: a 2 a.m. order is
 * yesterday's. Pakistan: its UTC date, exactly as the till always did.
 */
export function shopTradingDay(ms: number, locale: ShopLocale = getShopLocale()): string {
  if (onPakistanTime(locale)) return new Date(ms).toISOString().slice(0, 10);
  const w = wallAt(ms, locale.timeZone);
  const date = Date.UTC(w.y, w.m - 1, w.d) - (w.h < locale.tradingDayStartHour ? DAY_MS : 0);
  return ymdOf(date);
}

/** The trading day as whole days since 1970-01-01, for counting days apart and bucketing. */
export function shopTradingDayIndex(ms: number, locale: ShopLocale = getShopLocale()): number {
  if (onPakistanTime(locale)) return Math.floor(ms / DAY_MS);
  return Date.parse(`${shopTradingDay(ms, locale)}T00:00:00.000Z`) / DAY_MS;
}

/** The hour (0–23) on the shop's wall clock. Pakistan: UTC+5, as always. */
export function shopHourOf(ms: number, locale: ShopLocale = getShopLocale()): number {
  if (onPakistanTime(locale)) return new Date(ms + PKT_OFFSET_MS).getUTCHours();
  return wallAt(ms, locale.timeZone).h;
}

/**
 * The instant a trading day (YYYY-MM-DD) starts: its start hour on the shop's
 * wall clock. Pakistan: that date's 00:00 UTC (= 05:00 in Karachi).
 */
export function shopTradingDayStartOf(ymd: string, locale: ShopLocale = getShopLocale()): number {
  const midnight = Date.parse(`${ymd}T00:00:00.000Z`);
  if (onPakistanTime(locale)) return midnight;
  // The wall time wanted, read as if it were UTC; then take the zone's offset
  // away. Two passes settle it across a daylight-saving change (05:00 is
  // never inside the 2 a.m. gap or overlap, so there is one answer).
  const wall = midnight + locale.tradingDayStartHour * HOUR_MS;
  const first = wall - offsetAt(wall, locale.timeZone);
  return wall - offsetAt(first, locale.timeZone);
}

/** The instant the trading day numbered `dayNumber` (days since 1970-01-01) starts. Pakistan: dayNumber × DAY_MS. */
export function shopTradingDayStartOfIndex(dayNumber: number, locale: ShopLocale = getShopLocale()): number {
  if (onPakistanTime(locale)) return dayNumber * DAY_MS;
  return shopTradingDayStartOf(ymdOf(dayNumber * DAY_MS), locale);
}

/** The instant the current trading day started, for "today so far". */
export function shopTradingDayStart(ms: number, locale: ShopLocale = getShopLocale()): number {
  if (onPakistanTime(locale)) return Math.floor(ms / DAY_MS) * DAY_MS;
  return shopTradingDayStartOf(shopTradingDay(ms, locale), locale);
}
