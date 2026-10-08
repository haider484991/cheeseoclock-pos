/**
 * Periods of trading days (shared-types dashboard.ts): a trading day runs
 * 05:00–05:00 Karachi, which is exactly the UTC date, so "today" is the UTC
 * date now and a day is the 'YYYY-MM-DD' the till stamped on each order.
 * Weeks start on Monday, as the till's Reports do (pos-domain trends.ts).
 *
 * Pure: every function takes `now` so the tests pin the clock.
 */

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_30', 'custom'] as const;
export type PeriodKey = (typeof PERIODS)[number];

export interface Period {
  key: PeriodKey;
  /** First trading day, inclusive. */
  from: string;
  /** Last trading day, inclusive. */
  to: string;
  /** "Today", "This week", "1–7 Oct". */
  label: string;
  /** Whole days covered. */
  days: number;
  /** The same number of days just before, to compare with. */
  previous: { from: string; to: string; label: string };
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function msOf(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return dayOf(msOf(day) + n * DAY_MS);
}

export function isDay(s: string | null | undefined): s is string {
  return typeof s === 'string' && DAY_RE.test(s) && !Number.isNaN(msOf(s)) && dayOf(msOf(s)) === s;
}

export function todayOf(now: Date = new Date()): string {
  return dayOf(now.getTime());
}

/** Days from `from` to `to`, inclusive (1 for a single day). */
export function daysBetween(from: string, to: string): number {
  return Math.round((msOf(to) - msOf(from)) / DAY_MS) + 1;
}

/** Monday of the trading week holding `day`. */
export function weekStart(day: string): string {
  const dow = new Date(msOf(day)).getUTCDay(); // 0 Sunday … 6 Saturday
  return addDays(day, -((dow + 6) % 7));
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day: string): string {
  const d = new Date(msOf(monthStart(day)));
  return dayOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

const SHORT = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const LONG = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/** "Wed 8 Oct" — a trading day as people say it. */
export function dayLabel(day: string): string {
  return LONG.format(new Date(msOf(day)));
}

/** "1–7 Oct", "28 Sep – 4 Oct", or one day's label. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const a = SHORT.format(new Date(msOf(from)));
  const b = SHORT.format(new Date(msOf(to)));
  if (from.slice(0, 7) === to.slice(0, 7)) return `${a.split(' ')[0]}–${b}`;
  return `${a} – ${b}`;
}

function make(key: PeriodKey, from: string, to: string, label: string): Period {
  const days = daysBetween(from, to);
  const pTo = addDays(from, -1);
  const pFrom = addDays(pTo, -(days - 1));
  return { key, from, to, label, days, previous: { from: pFrom, to: pTo, label: rangeLabel(pFrom, pTo) } };
}

/**
 * The period a page was asked for (`?p=` and, for custom, `?from=&to=`).
 * Anything unreadable is today. A custom range is put in order and capped
 * at 400 days; days after today are cut back to today.
 */
export function periodFrom(params: { p?: string | null; from?: string | null; to?: string | null }, now: Date = new Date()): Period {
  const today = todayOf(now);
  const key = (PERIODS as readonly string[]).includes(params.p ?? '') ? (params.p as PeriodKey) : 'today';
  switch (key) {
    case 'today':
      return make('today', today, today, 'Today');
    case 'yesterday': {
      const y = addDays(today, -1);
      return make('yesterday', y, y, 'Yesterday');
    }
    case 'this_week':
      return make('this_week', weekStart(today), today, 'This week');
    case 'last_week': {
      const end = addDays(weekStart(today), -1);
      return make('last_week', weekStart(end), end, 'Last week');
    }
    case 'this_month':
      return make('this_month', monthStart(today), today, 'This month');
    case 'last_month': {
      const end = addDays(monthStart(today), -1);
      return make('last_month', monthStart(end), monthEnd(end), 'Last month');
    }
    case 'last_30':
      return make('last_30', addDays(today, -29), today, 'Last 30 days');
    case 'custom': {
      let from = isDay(params.from) ? params.from : today;
      let to = isDay(params.to) ? params.to : from;
      if (from > to) [from, to] = [to, from];
      if (to > today) to = today;
      if (from > to) from = to;
      if (daysBetween(from, to) > 400) from = addDays(to, -399);
      return make('custom', from, to, rangeLabel(from, to));
    }
  }
}

/** Every day of a period, in order (for a chart with no gaps). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The query string for a period (for links that keep it). */
export function periodQuery(p: Pick<Period, 'key' | 'from' | 'to'>): string {
  return p.key === 'custom' ? `p=custom&from=${p.from}&to=${p.to}` : `p=${p.key}`;
}
