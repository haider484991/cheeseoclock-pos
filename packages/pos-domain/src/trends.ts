/**
 * Trends and time (costing spec 4.10, Phase 7): which stretch of time a
 * figure is compared with, how the change is put, the weekday × hour
 * heatmap and the parts of the day. Pure, so every edge (month ends, 29
 * February, the 05:00 trading-day cut, a till with no history yet) is
 * unit-tested.
 *
 * Time here is worked in explicit UTC arithmetic, never a computer's own
 * time zone. Pakistan is UTC+5 all year and the trading day starts at 05:00
 * Pakistan time, which is exactly 00:00 UTC: an instant's trading day is its
 * UTC date, and a trading day's number is floor(ms ÷ one day).
 */
import { daypartHours, type Daypart, type ReportDaypartLine, type ReportHeatCell, type ReportHeatmap, type TrendChange } from '@cheeseoclock/shared-types';
import { mulDivRound } from './units.js';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Pakistan is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * HOUR_MS;

/** A stretch of time, [since, until) in ms. */
export interface TimeWindow {
  sinceMs: number;
  untilMs: number;
}

/** The trading day an instant falls in, as a day number (days since 1970-01-01). */
export function tradingDayOfMs(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** The instant a trading day starts (05:00 Pakistan time = 00:00 UTC). */
export function tradingDayStartMs(dayNumber: number): number {
  return dayNumber * DAY_MS;
}

/** 0 = Monday … 6 = Sunday (1970-01-01 was a Thursday). */
export function weekdayOfDay(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/** The Pakistan clock hour (0–23) of an instant. */
export function pakistanHourOfMs(ms: number): number {
  return Math.floor((((ms + PKT_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS);
}

/** Day number of the 1st of the month `months` away from the month of `dayNumber`. */
export function monthStartDay(dayNumber: number, months = 0): number {
  const d = new Date(dayNumber * DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1) / DAY_MS;
}

/** Day number of 1 January `years` away from the year of `dayNumber`. */
export function yearStartDay(dayNumber: number, years = 0): number {
  return Date.UTC(new Date(dayNumber * DAY_MS).getUTCFullYear() + years, 0, 1) / DAY_MS;
}

/** The same calendar date `years` back: 29 February becomes 28 February in a year without one. */
export function sameDateYearsBack(dayNumber: number, years: number): number {
  const d = new Date(dayNumber * DAY_MS);
  const y = d.getUTCFullYear() - years;
  const m = d.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastOfMonth)) / DAY_MS;
}

/** YYYY-MM-DD of a trading day number. */
export function dayYmd(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** A trading day (YYYY-MM-DD) as a day number, or null when it is not a real date. */
export function dayNumberOfYmd(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || dayYmd(ms / DAY_MS) !== ymd) return null;
  return ms / DAY_MS;
}

// ------------------------------------------------------------- comparisons --

/** The four trend lines the owner reads (costing spec 4.10). */
export const TREND_PERIODS = ['today', 'week', 'month', 'year'] as const;
export type TrendPeriod = (typeof TREND_PERIODS)[number];

export interface TrendWindows {
  /** So far: from the start of the day / week / month / year up to now. */
  current: TimeWindow;
  /** What it is compared with, as far into it as we are now. */
  previous: TimeWindow;
  /**
   * The same stretch a year ago: weekday-aligned (52 weeks, 364 days, back)
   * for a day or a week, the calendar month for a month. Null for the year,
   * whose comparison already IS last year.
   */
  lastYear: TimeWindow | null;
}

/**
 * Which stretches of time a trend line compares, at `nowMs`:
 *  - today so far vs the same weekday last week, to the same clock time;
 *  - this week so far (weeks start Monday) vs last week at the same elapsed time;
 *  - this month so far vs the same day numbers last month, clipped at its end
 *    (on 31 March, all of February);
 *  - this year so far vs last year to the same date and clock time
 *    (29 February counts as 28 February).
 * "Last year" is weekday-aligned (−364 days) for a day or a week and
 * calendar-aligned for a month or a year.
 */
export function trendWindows(period: TrendPeriod, nowMs: number): TrendWindows {
  const today = tradingDayOfMs(nowMs);
  const intoToday = nowMs - tradingDayStartMs(today);
  switch (period) {
    case 'today': {
      const start = tradingDayStartMs(today);
      return {
        current: { sinceMs: start, untilMs: nowMs },
        previous: { sinceMs: start - 7 * DAY_MS, untilMs: nowMs - 7 * DAY_MS },
        lastYear: { sinceMs: start - 364 * DAY_MS, untilMs: nowMs - 364 * DAY_MS },
      };
    }
    case 'week': {
      const start = tradingDayStartMs(today - weekdayOfDay(today));
      return {
        current: { sinceMs: start, untilMs: nowMs },
        previous: { sinceMs: start - 7 * DAY_MS, untilMs: nowMs - 7 * DAY_MS },
        lastYear: { sinceMs: start - 364 * DAY_MS, untilMs: nowMs - 364 * DAY_MS },
      };
    }
    case 'month': {
      const start = tradingDayStartMs(monthStartDay(today));
      const elapsed = nowMs - start;
      const prevStart = tradingDayStartMs(monthStartDay(today, -1));
      const lyStart = tradingDayStartMs(monthStartDay(today, -12));
      const lyEnd = tradingDayStartMs(monthStartDay(today, -11));
      return {
        current: { sinceMs: start, untilMs: nowMs },
        previous: { sinceMs: prevStart, untilMs: Math.min(prevStart + elapsed, start) },
        lastYear: { sinceMs: lyStart, untilMs: Math.min(lyStart + elapsed, lyEnd) },
      };
    }
    case 'year': {
      const start = tradingDayStartMs(yearStartDay(today));
      return {
        current: { sinceMs: start, untilMs: nowMs },
        previous: {
          sinceMs: tradingDayStartMs(yearStartDay(today, -1)),
          untilMs: tradingDayStartMs(sameDateYearsBack(today, 1)) + intoToday,
        },
        lastYear: null,
      };
    }
  }
}

/**
 * The owner's week (the Dashboard card and the weekly sheet): 'this' week so
 * far (from Monday, 05:00) against last week at the same elapsed time, or
 * 'last' week in full against the week before it.
 */
export function ownerWeekWindows(which: 'this' | 'last', nowMs: number): { current: TimeWindow; previous: TimeWindow; isCurrent: boolean } {
  const today = tradingDayOfMs(nowMs);
  const start = tradingDayStartMs(today - weekdayOfDay(today));
  if (which === 'this') {
    return {
      current: { sinceMs: start, untilMs: nowMs },
      previous: { sinceMs: start - 7 * DAY_MS, untilMs: nowMs - 7 * DAY_MS },
      isCurrent: true,
    };
  }
  return {
    current: { sinceMs: start - 7 * DAY_MS, untilMs: start },
    previous: { sinceMs: start - 14 * DAY_MS, untilMs: start - 7 * DAY_MS },
    isCurrent: false,
  };
}

/** The last 12 calendar months, oldest first; this month runs to `nowMs`. */
export function lastTwelveMonths(nowMs: number): Array<TimeWindow & { month: string }> {
  const today = tradingDayOfMs(nowMs);
  const out: Array<TimeWindow & { month: string }> = [];
  for (let k = -11; k <= 0; k += 1) {
    const since = tradingDayStartMs(monthStartDay(today, k));
    const until = k === 0 ? nowMs : tradingDayStartMs(monthStartDay(today, k + 1));
    out.push({ sinceMs: since, untilMs: until, month: dayYmd(monthStartDay(today, k)).slice(0, 7) });
  }
  return out;
}

/** Whole days a window covers, rounded up (a window of 1 ms is one day's read). */
export function windowDays(w: TimeWindow): number {
  return Math.ceil((w.untilMs - w.sinceMs) / DAY_MS);
}

/**
 * Was this till trading for the whole of `w`? Not when it starts before the
 * trading day of the till's first order (or the till has no orders yet):
 * comparing with a stretch the till knows nothing of would read "up 100%".
 */
export function tillHadData(w: TimeWindow, firstOrderMs: number | null): boolean {
  if (firstOrderMs === null) return false;
  return w.sinceMs >= tradingDayStartMs(tradingDayOfMs(firstOrderMs));
}

/**
 * How a figure moved (costing spec 4.10): change % = (now − then) ÷ then, in
 * basis points, rounded once; 'new' when then was 0 (and now is not);
 * 'noData' when the till has no figures for then (`previous` null).
 */
export function trendChange(current: number, previous: number | null): TrendChange {
  if (previous === null) return { kind: 'noData' };
  if (previous === 0) return current === 0 ? { kind: 'pct', bps: 0 } : { kind: 'new' };
  return { kind: 'pct', bps: mulDivRound(current - previous, 10_000, Math.abs(previous)) };
}

/** Net sales ÷ orders, to the paisa (0 with no orders). */
export function averageOrderCents(netSalesCents: number, orderCount: number): number {
  return orderCount > 0 ? mulDivRound(netSalesCents, 1, orderCount) : 0;
}

// ----------------------------------------------------------------- heatmap --

/** Hours in trading-day order: 5 am … 11 pm, then midnight … 4 am. */
export const TRADING_DAY_HOURS: readonly number[] = [...Array.from({ length: 19 }, (_, i) => i + 5), 0, 1, 2, 3, 4];

/** Sales of one trading day in one Pakistan clock hour. */
export interface HourTally {
  dayNumber: number;
  hour: number;
  orderCount: number;
  netSalesCents: number;
}

export type HeatCell = ReportHeatCell;
export type Heatmap = ReportHeatmap;

/**
 * The weekday × hour heatmap (costing spec 4.10): each cell is an average
 * day's sales in that hour — the sales of that weekday and hour ÷ the number
 * of trading days of that weekday in [firstDay, lastDay] (inclusive day
 * numbers). Days marked closed are left out of both, so a Friday the shop
 * was shut for Eid does not pull every Friday down. Empty hours at either end
 * of the trading day are trimmed; empty hours between stay (the gaps show).
 */
export function buildHeatmap(input: {
  tallies: readonly HourTally[];
  firstDay: number;
  lastDay: number;
  closedDays: ReadonlySet<number>;
}): Heatmap {
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  let closed = 0;
  for (let d = input.firstDay; d <= input.lastDay; d += 1) {
    if (input.closedDays.has(d)) closed += 1;
    else dayCounts[weekdayOfDay(d)]! += 1;
  }
  const totals = new Map<number, { orders: number; net: number }>();
  for (const t of input.tallies) {
    if (t.dayNumber < input.firstDay || t.dayNumber > input.lastDay || input.closedDays.has(t.dayNumber)) continue;
    const key = weekdayOfDay(t.dayNumber) * 24 + t.hour;
    const cell = totals.get(key);
    if (cell) {
      cell.orders += t.orderCount;
      cell.net += t.netSalesCents;
    } else totals.set(key, { orders: t.orderCount, net: t.netSalesCents });
  }
  const used = TRADING_DAY_HOURS.map((h, i) => ([0, 1, 2, 3, 4, 5, 6].some((w) => (totals.get(w * 24 + h)?.orders ?? 0) > 0) ? i : -1)).filter(
    (i) => i >= 0,
  );
  const hours = used.length === 0 ? [] : TRADING_DAY_HOURS.slice(Math.min(...used), Math.max(...used) + 1);
  const cells: HeatCell[] = [];
  for (let w = 0; w < 7; w += 1) {
    const days = dayCounts[w]!;
    for (const hour of hours) {
      const t = totals.get(w * 24 + hour) ?? { orders: 0, net: 0 };
      cells.push({
        weekday: w,
        hour,
        orderCount: t.orders,
        netSalesCents: t.net,
        avgNetSalesCents: days > 0 ? mulDivRound(t.net, 1, days) : 0,
        avgOrdersTenths: days > 0 ? mulDivRound(t.orders, 10, days) : 0,
      });
    }
  }
  return { dayCounts, closedDays: closed, hours, cells };
}

// ---------------------------------------------------------------- dayparts --

export type DaypartLine = ReportDaypartLine;

/**
 * Sales by part of the day (costing spec 4.10): Lunch 12–15:59, Afternoon
 * 16–18:59, Dinner 19–22:59, Late 23–04:59 by default (Late runs across
 * midnight: 11 pm, then midnight to 4:59 am, which the trading day counts as
 * the same night). Hours outside every part (the morning) are "Other hours",
 * listed only when something sold then. The lines add up to the period.
 */
export function splitDayparts(
  byHour: ReadonlyArray<{ hour: number; orderCount: number; netSalesCents: number }>,
  dayparts: readonly Daypart[],
): { lines: DaypartLine[]; other: DaypartLine | null } {
  const total = byHour.reduce((s, h) => s + h.netSalesCents, 0);
  const owner = new Map<number, number>();
  dayparts.forEach((d, i) => {
    for (const h of daypartHours(d)) if (!owner.has(h)) owner.set(h, i);
  });
  const sums = dayparts.map(() => ({ orders: 0, net: 0 }));
  const rest = { orders: 0, net: 0 };
  for (const h of byHour) {
    const i = owner.get(h.hour);
    const into = i === undefined ? rest : sums[i]!;
    into.orders += h.orderCount;
    into.net += h.netSalesCents;
  }
  const line = (name: string, fromHour: number, toHour: number, s: { orders: number; net: number }): DaypartLine => ({
    name,
    fromHour,
    toHour,
    orderCount: s.orders,
    netSalesCents: s.net,
    avgOrderCents: averageOrderCents(s.net, s.orders),
    shareBps: total > 0 ? mulDivRound(s.net, 10_000, total) : null,
  });
  return {
    lines: dayparts.map((d, i) => line(d.name, d.fromHour, d.toHour, sums[i]!)),
    other: rest.orders > 0 || rest.net !== 0 ? line('Other hours', -1, -1, rest) : null,
  };
}
