/**
 * The times printed on paper — the receipt and the bill, refund and cancel
 * slips, DUPLICATE and late stamps, the kitchen ticket, the printer's test
 * page — and on the screens that show what the paper says (the receipt after
 * Pay). Papers print Pakistan time whatever the PC's own zone, so a till
 * whose Windows clock is set to another zone still prints the time the
 * customer saw on the wall, and the same day the FBR invoice carries
 * (fbr-core karachiDate). Worked in UTC only, never with Intl or the
 * machine's zone, as karachiDateOf is. Pakistan writes the day first, 24-hour.
 *
 * A till outside Pakistan (international edition) prints its own shop's wall
 * clock instead: the shop's IANA zone through Intl (still never the PC's own
 * zone), its date order and its clock — a US receipt reads
 * "10/20/2026 7:35 PM". Pakistan's lines below are untouched, and the
 * printer-core oracle holds them to v0.7.51.
 */
import { getShopLocale, type ShopLocale } from './shop-locale.js';
import { shopWallClock } from './shop-clock.js';

/** Pakistan is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 3_600_000;

/** A moment the till stored or made: a Date, epoch ms, or an ISO text. */
type PaperTimeInput = Date | number | string;

/** The Pakistan wall clock at `at`, to be read with getUTC*; null for a time that does not read. */
function pk(at: PaperTimeInput): Date | null {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms + PKT_OFFSET_MS) : null;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** The shop's wall clock at `at` on a till outside Pakistan; null for a time that does not read. */
function abroad(at: PaperTimeInput, locale: ShopLocale): ReturnType<typeof shopWallClock> | null {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? shopWallClock(ms, locale) : null;
}

/** "19:35", or "7:35 PM" for a shop on a 12-hour clock. */
function clockText(h: number, mi: number, locale: ShopLocale): string {
  if (locale.hourCycle === 'h23') return `${two(h)}:${two(mi)}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${two(mi)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "26/09", or "09/26" where the month comes first. */
function dayMonthText(d: number, m: number, locale: ShopLocale): string {
  return locale.dateOrder === 'mdy' ? `${two(m)}/${two(d)}` : `${two(d)}/${two(m)}`;
}

/** "19:35" in Pakistan; '' for a time that does not read. */
export function paperClock(at: PaperTimeInput): string {
  const locale = getShopLocale();
  if (locale.country !== 'PK') {
    const w = abroad(at, locale);
    return w ? clockText(w.h, w.mi, locale) : '';
  }
  const d = pk(at);
  return d ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '';
}

/** "26/09 19:35" in Pakistan (the kitchen ticket); '' for a time that does not read. */
export function paperDayMonthClock(at: PaperTimeInput): string {
  const locale = getShopLocale();
  if (locale.country !== 'PK') {
    const w = abroad(at, locale);
    return w ? `${dayMonthText(w.d, w.m, locale)} ${clockText(w.h, w.mi, locale)}` : '';
  }
  const d = pk(at);
  return d ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} ${paperClock(at)}` : '';
}

/** "26/09/2026 19:35" in Pakistan — the one date format on every paper; '' for a time that does not read. */
export function paperDateTime(at: PaperTimeInput): string {
  const locale = getShopLocale();
  if (locale.country !== 'PK') {
    const w = abroad(at, locale);
    return w ? `${dayMonthText(w.d, w.m, locale)}/${w.y} ${clockText(w.h, w.mi, locale)}` : '';
  }
  const d = pk(at);
  return d ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${paperClock(at)}` : '';
}
