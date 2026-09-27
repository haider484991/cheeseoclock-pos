/**
 * Report periods, in TRADING days.
 *
 * The shop trades 12 noon – 1 am, so a trading day runs 05:00 → 05:00
 * Pakistan time (audit 2026-09-25: cutting at midnight made "Today" at 00:40
 * show forty minutes of sales and put the last hour of the night into the
 * wrong day). Pakistan is UTC+5 all year, so 05:00 PKT is 00:00 UTC and a
 * trading day is exactly one UTC date — the same day the order numbers and
 * the reports' per-day figures use.
 *
 * Everything here is worked out in explicit UTC arithmetic, never the
 * computer's own time zone, so a till whose Windows clock zone is wrong still
 * cuts the day in the right place.
 */

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'last7'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisYear'
  | 'last12'
  | 'lastYear'
  | 'custom';

export const TRADING_DAY_START_HOUR = 5;
const PKT_OFFSET_HOURS = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** How far the trading day's start sits from 00:00 UTC (0: 05:00 PKT is midnight UTC). */
const DAY_START_OFFSET_MS = (TRADING_DAY_START_HOUR - PKT_OFFSET_HOURS) * HOUR_MS;

export interface DateRange {
  sinceIso: string;
  untilIso: string;
}

export interface ReportPeriod extends DateRange {
  preset: RangePreset;
  /** First and last trading day covered, YYYY-MM-DD. */
  firstDay: string;
  lastDay: string;
  /** Number of trading days covered. */
  days: number;
  /** "Today", "This week", "Your dates"… */
  title: string;
  /** "Sat 26 Sep 2026" / "Mon 21 Sep – Sun 27 Sep 2026". */
  dates: string;
  /** The period is still running (it contains the present moment). */
  isCurrent: boolean;
  /** What it is compared with, or null. */
  compare: (DateRange & { label: string }) | null;
}

// ------------------------------------------------------------ day numbers --

/** The trading day an instant falls in, as a day number (days since 1970-01-01). */
function dayNumberOf(ms: number): number {
  return Math.floor((ms - DAY_START_OFFSET_MS) / DAY_MS);
}

/** The instant a trading day starts (05:00 Pakistan time). */
function dayStartMs(dayNumber: number): number {
  return dayNumber * DAY_MS + DAY_START_OFFSET_MS;
}

function ymdOf(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → day number, or null when it is not a real date. */
function dayNumberFromYmd(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || ymdOf(ms / DAY_MS) !== ymd) return null;
  return ms / DAY_MS;
}

/** Day number of the 1st of the month `monthsFromNow` away from the month of `dayNumber`. */
function monthStart(dayNumber: number, monthsFromNow: number): number {
  const d = new Date(dayNumber * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsFromNow, 1) / DAY_MS;
}

/** Day number of 1 January `yearsFromNow` years away from the year of `dayNumber`. */
function yearStart(dayNumber: number, yearsFromNow: number): number {
  return Date.UTC(new Date(dayNumber * DAY_MS).getUTCFullYear() + yearsFromNow, 0, 1) / DAY_MS;
}

/**
 * The same calendar date `years` years before `dayNumber`: 29 February
 * becomes 28 February in a year without one.
 */
function sameDateYearsBack(dayNumber: number, years: number): number {
  const d = new Date(dayNumber * DAY_MS);
  const y = d.getUTCFullYear() - years;
  const m = d.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastOfMonth)) / DAY_MS;
}

/** 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday). */
export function weekdayIndex(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

// ----------------------------------------------------------------- public --

/** 05:00 on the trading day that `d` belongs to (before 05:00 = the previous day's). */
export function tradingDayStart(d: Date): Date {
  return new Date(dayStartMs(dayNumberOf(d.getTime())));
}

/** The trading day an instant falls in, as YYYY-MM-DD (for a date input). */
export function fmtDateInput(iso: string): string {
  return ymdOf(dayNumberOf(Date.parse(iso)));
}

/** A trading day (YYYY-MM-DD) as a day number, or null. Exposed for the weekday chart. */
export function tradingDayNumber(ymd: string): number | null {
  return dayNumberFromYmd(ymd);
}

// Fixed names, not Intl: ICU versions disagree ("Sep" vs "Sept") between the
// till's Chromium and Node, and a date should read the same on screen, on
// paper and in the tests.
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Sat 26 Sep" (+ " 2026" with the year). */
export function fmtDay(ymd: string, withYear = true): string {
  const n = dayNumberFromYmd(ymd);
  if (n === null) return ymd;
  const d = new Date(n * DAY_MS);
  const text = `${WEEKDAYS[weekdayIndex(n)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${text} ${d.getUTCFullYear()}` : text;
}

/** "Sep 2026" — a month label for long ranges. */
export function fmtMonth(ymd: string): string {
  const n = dayNumberFromYmd(ymd);
  if (n === null) return ymd;
  const d = new Date(n * DAY_MS);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Sat 26 Sep 2026" or "Mon 21 Sep – Sun 27 Sep 2026". */
export function fmtDays(firstDay: string, lastDay: string): string {
  if (firstDay === lastDay) return fmtDay(firstDay);
  const sameYear = firstDay.slice(0, 4) === lastDay.slice(0, 4);
  return `${fmtDay(firstDay, !sameYear)} – ${fmtDay(lastDay)}`;
}

const TITLES: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  last7: 'Last 7 days',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisYear: 'This year',
  last12: 'Last 12 months',
  lastYear: 'Last year',
  custom: 'Your dates',
};

/**
 * The period for a preset, and what it is compared with.
 *
 * Comparison rule, in one sentence the owner can hold: the same stretch of
 * time just before — and while a period is still running, only as far into
 * it as we are now ("today so far" vs "yesterday by this time", "this month
 * so far" vs "last month by this date"). Months compare with calendar months,
 * and years with calendar years: "this year so far" vs "last year by this
 * date" (29 February counts as 28 February in a year without one). "Last 12
 * months" runs to today, from the day after this date a year ago (365 days,
 * or 366 across a 29 February), like "Last 7 days".
 */
export function periodFor(
  preset: RangePreset,
  now: Date = new Date(),
  custom?: { from: string; to: string },
): ReportPeriod {
  const nowMs = now.getTime();
  const today = dayNumberOf(nowMs);
  let start = today;
  let end = today + 1; // exclusive, in day numbers
  let prevStart: number;
  let prevEnd: number;
  let compareLabel: string;

  switch (preset) {
    case 'today':
      prevStart = today - 1;
      prevEnd = today;
      compareLabel = 'yesterday by this time';
      break;
    case 'yesterday':
      start = today - 1;
      end = today;
      prevStart = today - 2;
      prevEnd = today - 1;
      compareLabel = 'the day before';
      break;
    case 'thisWeek':
      start = today - weekdayIndex(today);
      end = start + 7;
      prevStart = start - 7;
      prevEnd = start;
      compareLabel = 'last week by this time';
      break;
    case 'last7':
      start = today - 6;
      prevStart = start - 7;
      prevEnd = start;
      compareLabel = 'the 7 days before';
      break;
    case 'thisMonth':
      start = monthStart(today, 0);
      end = monthStart(today, 1);
      prevStart = monthStart(today, -1);
      prevEnd = start;
      compareLabel = 'last month by this date';
      break;
    case 'lastMonth':
      start = monthStart(today, -1);
      end = monthStart(today, 0);
      prevStart = monthStart(today, -2);
      prevEnd = start;
      compareLabel = 'the month before';
      break;
    case 'thisYear':
      start = yearStart(today, 0);
      end = yearStart(today, 1);
      prevStart = yearStart(today, -1);
      prevEnd = start;
      compareLabel = 'last year by this date';
      break;
    case 'last12':
      start = sameDateYearsBack(today, 1) + 1;
      prevStart = sameDateYearsBack(today, 2) + 1;
      prevEnd = start;
      compareLabel = 'the 12 months before';
      break;
    case 'lastYear':
      start = yearStart(today, -1);
      end = yearStart(today, 0);
      prevStart = yearStart(today, -2);
      prevEnd = start;
      compareLabel = 'the year before';
      break;
    case 'custom': {
      let from = custom ? dayNumberFromYmd(custom.from) : null;
      let to = custom ? dayNumberFromYmd(custom.to) : null;
      if (from === null || to === null) {
        from = today;
        to = today;
      }
      if (to < from) [from, to] = [to, from];
      start = from;
      end = to + 1;
      const n = end - start;
      prevStart = start - n;
      prevEnd = start;
      compareLabel = n === 1 ? 'the day before' : `the ${n} days before`;
      break;
    }
  }

  const sinceMs = dayStartMs(start);
  const untilMs = dayStartMs(end);
  const isCurrent = nowMs >= sinceMs && nowMs < untilMs;
  const prevSinceMs = dayStartMs(prevStart);
  let prevUntilMs = dayStartMs(prevEnd);
  if (isCurrent) {
    // Only as far into the comparison period as we are into this one: for
    // a year, to the same calendar date (a 29 February in between must not
    // shift it by a day); otherwise the same length of time.
    const soFar =
      preset === 'thisYear'
        ? dayStartMs(sameDateYearsBack(today, 1)) + (nowMs - dayStartMs(today))
        : prevSinceMs + (nowMs - sinceMs);
    prevUntilMs = Math.min(prevUntilMs, soFar);
  }

  const firstDay = ymdOf(start);
  const lastDay = ymdOf(end - 1);
  return {
    preset,
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
    firstDay,
    lastDay,
    days: end - start,
    title: TITLES[preset],
    dates: fmtDays(firstDay, lastDay),
    isCurrent,
    compare:
      prevUntilMs > prevSinceMs
        ? {
            sinceIso: new Date(prevSinceMs).toISOString(),
            untilIso: new Date(prevUntilMs).toISOString(),
            label: compareLabel,
          }
        : null,
  };
}

/** The trading days of a period that have already started (no future days). */
export function daysSoFar(period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>, now: Date = new Date()): string[] {
  const first = dayNumberFromYmd(period.firstDay);
  const last = dayNumberFromYmd(period.lastDay);
  if (first === null || last === null) return [];
  const upTo = Math.min(last, dayNumberOf(now.getTime()));
  const out: string[] = [];
  for (let n = first; n <= upTo; n += 1) out.push(ymdOf(n));
  return out;
}

// ---------------------------------------------------------- auto-refresh --

/** The longest period that refreshes itself while it is open. */
export const AUTO_REFRESH_MAX_DAYS = 31;

/**
 * Does the open report refresh itself once a minute? Only while the period
 * includes today (new sales still come in — `isCurrent`, as of its last
 * refresh, so "Today" left open past 5 am still moves on to the new day
 * once), covers at most 31 days, and the window is on screen: a year's
 * report is never re-run every minute behind the cashier's back (costing
 * spec Phase 2). Anything else refreshes when asked (a new period, "Try
 * again").
 */
export function autoRefreshes(period: Pick<ReportPeriod, 'isCurrent' | 'days'>, visible: boolean): boolean {
  return visible && period.isCurrent && period.days <= AUTO_REFRESH_MAX_DAYS;
}
