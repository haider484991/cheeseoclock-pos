/**
 * The times printed on paper — the receipt and the bill, refund and cancel
 * slips, DUPLICATE and late stamps, the kitchen ticket, the printer's test
 * page — and on the screens that show what the paper says (the receipt after
 * Pay). Papers print Pakistan time whatever the PC's own zone, so a till
 * whose Windows clock is set to another zone still prints the time the
 * customer saw on the wall, and the same day the FBR invoice carries
 * (fbr-core karachiDate). Worked in UTC only, never with Intl or the
 * machine's zone, as karachiDateOf is. Pakistan writes the day first, 24-hour.
 */

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

/** "19:35" in Pakistan; '' for a time that does not read. */
export function paperClock(at: PaperTimeInput): string {
  const d = pk(at);
  return d ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : '';
}

/** "26/09 19:35" in Pakistan (the kitchen ticket); '' for a time that does not read. */
export function paperDayMonthClock(at: PaperTimeInput): string {
  const d = pk(at);
  return d ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} ${paperClock(at)}` : '';
}

/** "26/09/2026 19:35" in Pakistan — the one date format on every paper; '' for a time that does not read. */
export function paperDateTime(at: PaperTimeInput): string {
  const d = pk(at);
  return d ? `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${paperClock(at)}` : '';
}
