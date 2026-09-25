/** Date-range presets used by the Reports UI. */
export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'custom';

export interface DateRange {
  sinceIso: string;
  untilIso: string;
}

/**
 * The shop trades 12 noon – 1 am, so a trading day runs 05:00 → 05:00 local
 * (Pakistan). Cutting days at midnight made "Today" at 00:40 show forty
 * minutes of sales and put last night's 00:00–01:00 into the wrong day (audit
 * 2026-09-25). 05:00 PKT is 00:00 UTC, so a trading day is also exactly one
 * UTC date — the same day the reports' per-day grouping and order numbers use.
 */
export const TRADING_DAY_START_HOUR = 5;

/** 05:00 on the trading day that `d` belongs to (before 05:00 = the previous day's). */
export function tradingDayStart(d: Date): Date {
  const s = new Date(d);
  if (s.getHours() < TRADING_DAY_START_HOUR) s.setDate(s.getDate() - 1);
  s.setHours(TRADING_DAY_START_HOUR, 0, 0, 0);
  return s;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function rangeForPreset(preset: RangePreset, now: Date = new Date()): DateRange {
  const today = tradingDayStart(now);
  let start = today;
  let end = addDays(today, 1);
  switch (preset) {
    case 'today':
      break;
    case 'yesterday':
      start = addDays(today, -1);
      end = today;
      break;
    case '7d':
      start = addDays(today, -6);
      break;
    case '30d':
      start = addDays(today, -29);
      break;
    case 'thisMonth':
      start = new Date(today);
      start.setDate(1);
      end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      break;
    case 'custom':
      // Caller is responsible for setting sinceIso/untilIso explicitly.
      break;
  }
  return { sinceIso: start.toISOString(), untilIso: end.toISOString() };
}

/** The calendar date (local) of a trading day, as YYYY-MM-DD. */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The trading day an instant falls in, as YYYY-MM-DD (for a date input). */
export function fmtDateInput(iso: string): string {
  return localYmd(tradingDayStart(new Date(iso)));
}

/** "2026-09-25 → 2026-09-26" style label: first and last trading day of a range. */
export function fmtRange(r: DateRange): string {
  const first = fmtDateInput(r.sinceIso);
  const last = fmtDateInput(new Date(Date.parse(r.untilIso) - 1).toISOString());
  return first === last ? first : `${first} → ${last}`;
}

/** A date input's trading day: from its 05:00, or (endOfDay) to the next 05:00. */
export function dateInputToIso(date: string, endOfDay: boolean): string {
  const d = new Date(`${date}T${String(TRADING_DAY_START_HOUR).padStart(2, '0')}:00:00`);
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
