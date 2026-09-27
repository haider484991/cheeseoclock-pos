import { describe, expect, it } from 'vitest';
import { DEFAULT_DAYPARTS, daypartHours } from '@cheeseoclock/shared-types';
import {
  averageOrderCents,
  buildHeatmap,
  dayNumberOfYmd,
  lastTwelveMonths,
  ownerWeekWindows,
  pakistanHourOfMs,
  splitDayparts,
  tillHadData,
  trendChange,
  trendWindows,
  weekdayOfDay,
  type TimeWindow,
} from './trends.js';

/** A window as ISO text, to read the expectations. */
const iso = (w: TimeWindow | null) => (w ? [new Date(w.sinceMs).toISOString(), new Date(w.untilMs).toISOString()] : null);
const at = (s: string) => Date.parse(s);
const day = (ymd: string) => dayNumberOfYmd(ymd)!;

describe('trend windows (costing spec 4.10): what "so far" is compared with', () => {
  // Tuesday 29 Sep 2026, 2 pm in Karachi (09:00 UTC).
  const TUE_2PM = at('2026-09-29T09:00:00.000Z');

  it('today so far vs the same weekday last week to the same clock time, and 52 weeks back', () => {
    const w = trendWindows('today', TUE_2PM);
    expect(iso(w.current)).toEqual(['2026-09-29T00:00:00.000Z', '2026-09-29T09:00:00.000Z']);
    expect(iso(w.previous)).toEqual(['2026-09-22T00:00:00.000Z', '2026-09-22T09:00:00.000Z']);
    expect(iso(w.lastYear)).toEqual(['2025-09-30T00:00:00.000Z', '2025-09-30T09:00:00.000Z']);
    // Weekday-aligned: last year's day is a Tuesday too.
    expect(weekdayOfDay(day('2025-09-30'))).toBe(weekdayOfDay(day('2026-09-29')));
    expect(weekdayOfDay(day('2026-09-29'))).toBe(1);
  });

  it('this week so far (from Monday 5 am) vs last week at the same elapsed time', () => {
    const w = trendWindows('week', TUE_2PM);
    expect(iso(w.current)).toEqual(['2026-09-28T00:00:00.000Z', '2026-09-29T09:00:00.000Z']);
    expect(iso(w.previous)).toEqual(['2026-09-21T00:00:00.000Z', '2026-09-22T09:00:00.000Z']);
    expect(iso(w.lastYear)).toEqual(['2025-09-29T00:00:00.000Z', '2025-09-30T09:00:00.000Z']);
  });

  it('the trading day turns at 05:00 Pakistan time: 04:59 is still the night before, 05:00 starts a new day and week', () => {
    // Monday 5 Oct 2026, 04:59 in Karachi = Sunday 23:59 UTC: still Sunday's trading day, still last week.
    const before = at('2026-10-04T23:59:00.000Z');
    expect(iso(trendWindows('today', before).current)).toEqual(['2026-10-04T00:00:00.000Z', '2026-10-04T23:59:00.000Z']);
    expect(iso(trendWindows('week', before).current)).toEqual(['2026-09-28T00:00:00.000Z', '2026-10-04T23:59:00.000Z']);
    expect(pakistanHourOfMs(before)).toBe(4);
    // 05:00: Monday's trading day has just begun — an empty "so far", compared with an empty stretch.
    const five = at('2026-10-05T00:00:00.000Z');
    expect(iso(trendWindows('today', five).current)).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z']);
    expect(iso(trendWindows('today', five).previous)).toEqual(['2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z']);
    expect(iso(trendWindows('week', five).current)).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z']);
    expect(pakistanHourOfMs(five)).toBe(5);
  });

  it('this month vs the same day numbers last month, clipped at its end (31 March: all of February)', () => {
    const mar31 = trendWindows('month', at('2026-03-31T10:00:00.000Z'));
    expect(iso(mar31.current)).toEqual(['2026-03-01T00:00:00.000Z', '2026-03-31T10:00:00.000Z']);
    expect(iso(mar31.previous)).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
    expect(iso(mar31.lastYear)).toEqual(['2025-03-01T00:00:00.000Z', '2025-03-31T10:00:00.000Z']);
    // 28 March: February's own 28th, to the same clock time.
    expect(iso(trendWindows('month', at('2026-03-28T10:00:00.000Z')).previous)).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-02-28T10:00:00.000Z',
    ]);
    // 31 May against 30-day April: all of April.
    expect(iso(trendWindows('month', at('2026-05-31T18:00:00.000Z')).previous)).toEqual([
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ]);
    // 1 January against December, across the year.
    expect(iso(trendWindows('month', at('2027-01-01T09:00:00.000Z')).previous)).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2026-12-01T09:00:00.000Z',
    ]);
  });

  it('29 February: last year stops at 28 February, a leap February against a short one is clipped, and a year on it is calendar-aligned', () => {
    const leap = at('2028-02-29T10:00:00.000Z');
    expect(iso(trendWindows('year', leap).previous)).toEqual(['2027-01-01T00:00:00.000Z', '2027-02-28T10:00:00.000Z']);
    expect(trendWindows('year', leap).lastYear).toBeNull();
    // This February so far (29 days) against last year's 28-day February: all of it, no further.
    expect(iso(trendWindows('month', leap).lastYear)).toEqual(['2027-02-01T00:00:00.000Z', '2027-03-01T00:00:00.000Z']);
    // Against January (31 days): the same day number.
    expect(iso(trendWindows('month', leap).previous)).toEqual(['2028-01-01T00:00:00.000Z', '2028-01-29T10:00:00.000Z']);
    // A year after it: calendar-aligned (1 March to 1 March, the leap day inside last year's stretch).
    expect(iso(trendWindows('year', at('2029-03-01T10:00:00.000Z')).previous)).toEqual([
      '2028-01-01T00:00:00.000Z',
      '2028-03-01T10:00:00.000Z',
    ]);
    // A day a year on is weekday-aligned: 364 days back, so the leap day shifts it by one date.
    expect(iso(trendWindows('today', at('2029-03-01T10:00:00.000Z')).lastYear)).toEqual([
      '2028-03-02T00:00:00.000Z',
      '2028-03-02T10:00:00.000Z',
    ]);
  });

  it("the owner's week: this week so far vs last week by now, or last week in full vs the week before", () => {
    const thisWeek = ownerWeekWindows('this', TUE_2PM);
    expect(iso(thisWeek.current)).toEqual(['2026-09-28T00:00:00.000Z', '2026-09-29T09:00:00.000Z']);
    expect(iso(thisWeek.previous)).toEqual(['2026-09-21T00:00:00.000Z', '2026-09-22T09:00:00.000Z']);
    expect(thisWeek.isCurrent).toBe(true);
    const lastWeek = ownerWeekWindows('last', TUE_2PM);
    expect(iso(lastWeek.current)).toEqual(['2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z']);
    expect(iso(lastWeek.previous)).toEqual(['2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z']);
    expect(lastWeek.isCurrent).toBe(false);
  });

  it('the last 12 calendar months, across the year end, this month to now', () => {
    const months = lastTwelveMonths(TUE_2PM);
    expect(months.map((m) => m.month)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(iso(months[0]!)).toEqual(['2025-10-01T00:00:00.000Z', '2025-11-01T00:00:00.000Z']);
    expect(iso(months[11]!)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-29T09:00:00.000Z']);
  });
});

describe('the change, in plain terms', () => {
  it('(now − then) ÷ then, in basis points, rounded once', () => {
    expect(trendChange(120_000, 100_000)).toEqual({ kind: 'pct', bps: 2_000 });
    expect(trendChange(80_000, 100_000)).toEqual({ kind: 'pct', bps: -2_000 });
    expect(trendChange(100_000, 100_000)).toEqual({ kind: 'pct', bps: 0 });
    // −66.666…% → −6,667 bps (half away from zero, once).
    expect(trendChange(1, 3)).toEqual({ kind: 'pct', bps: -6_667 });
  });

  it("'new' when then was 0; nothing then and nothing now is the same", () => {
    expect(trendChange(50_000, 0)).toEqual({ kind: 'new' });
    expect(trendChange(0, 0)).toEqual({ kind: 'pct', bps: 0 });
  });

  it("'no data then' when the till has no figures for then", () => {
    expect(trendChange(50_000, null)).toEqual({ kind: 'noData' });
    const firstOrder = at('2026-09-22T15:00:00.000Z');
    // From the first order's own trading day: the till was trading.
    expect(tillHadData({ sinceMs: at('2026-09-22T00:00:00.000Z'), untilMs: at('2026-09-22T09:00:00.000Z') }, firstOrder)).toBe(true);
    // A stretch that starts the day before it: no data then.
    expect(tillHadData({ sinceMs: at('2026-09-21T00:00:00.000Z'), untilMs: at('2026-09-23T09:00:00.000Z') }, firstOrder)).toBe(false);
    // A till with no orders yet has none for any stretch.
    expect(tillHadData({ sinceMs: at('2026-09-21T00:00:00.000Z'), untilMs: at('2026-09-22T00:00:00.000Z') }, null)).toBe(false);
  });

  it('the average order, to the paisa', () => {
    expect(averageOrderCents(100_000, 3)).toBe(33_333);
    expect(averageOrderCents(200_000, 3)).toBe(66_667);
    expect(averageOrderCents(0, 0)).toBe(0);
  });
});

describe('the weekday × hour heatmap', () => {
  const MON_14 = day('2026-09-14');
  const SUN_27 = day('2026-09-27');

  it('an average day per weekday and hour; a day marked closed is left out of both the sales and the day count', () => {
    const map = buildHeatmap({
      firstDay: MON_14,
      lastDay: SUN_27,
      closedDays: new Set([day('2026-09-18')]), // Friday, Eid
      tallies: [
        { dayNumber: day('2026-09-14'), hour: 13, orderCount: 2, netSalesCents: 30_000 },
        { dayNumber: day('2026-09-21'), hour: 13, orderCount: 1, netSalesCents: 10_000 },
        // Sales on the closed Friday (a test order) do not count.
        { dayNumber: day('2026-09-18'), hour: 20, orderCount: 10, netSalesCents: 100_000 },
        { dayNumber: day('2026-09-25'), hour: 20, orderCount: 4, netSalesCents: 40_000 },
      ],
    });
    // Two of every weekday, less the closed Friday.
    expect(map.dayCounts).toEqual([2, 2, 2, 2, 1, 2, 2]);
    expect(map.closedDays).toBe(1);
    expect(map.hours).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    const cell = (w: number, h: number) => map.cells.find((c) => c.weekday === w && c.hour === h)!;
    expect(cell(0, 13)).toEqual({ weekday: 0, hour: 13, orderCount: 3, netSalesCents: 40_000, avgNetSalesCents: 20_000, avgOrdersTenths: 15 });
    expect(cell(4, 20)).toEqual({ weekday: 4, hour: 20, orderCount: 4, netSalesCents: 40_000, avgNetSalesCents: 40_000, avgOrdersTenths: 40 });
    expect(cell(2, 15)).toMatchObject({ orderCount: 0, avgNetSalesCents: 0 });
    // Every weekday × every hour shown.
    expect(map.cells).toHaveLength(7 * 8);
  });

  it('counts each weekday in a stretch that does not start on a Monday', () => {
    const map = buildHeatmap({ firstDay: day('2026-09-16'), lastDay: day('2026-09-25'), closedDays: new Set(), tallies: [] });
    // Wed 16 … Fri 25: Wed, Thu, Fri twice; Sat, Sun, Mon, Tue once.
    expect(map.dayCounts).toEqual([1, 1, 2, 2, 2, 1, 1]);
    expect(map.hours).toEqual([]);
    expect(map.cells).toEqual([]);
  });

  it('late sales run on past midnight in trading-day order (11 pm, 12 am, 1 am), and a closed day outside the stretch changes nothing', () => {
    const map = buildHeatmap({
      firstDay: MON_14,
      lastDay: SUN_27,
      closedDays: new Set([day('2026-10-02')]),
      tallies: [
        { dayNumber: MON_14, hour: 22, orderCount: 1, netSalesCents: 5_000 },
        { dayNumber: MON_14, hour: 1, orderCount: 1, netSalesCents: 7_000 },
      ],
    });
    expect(map.hours).toEqual([22, 23, 0, 1]);
    expect(map.closedDays).toBe(0);
    expect(map.dayCounts).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
});

describe('parts of the day', () => {
  it('Late runs across midnight: 11 pm to 4:59 am', () => {
    expect(daypartHours({ fromHour: 23, toHour: 4 })).toEqual([23, 0, 1, 2, 3, 4]);
    expect(daypartHours({ fromHour: 12, toHour: 15 })).toEqual([12, 13, 14, 15]);
    expect(daypartHours({ fromHour: 5, toHour: 5 })).toEqual([5]);
  });

  it('splits the hours into the owner parts, with the morning as "Other hours"; the lines add up to the period', () => {
    const byHour = [
      { hour: 9, orderCount: 1, netSalesCents: 10_000 },
      { hour: 12, orderCount: 2, netSalesCents: 30_000 },
      { hour: 15, orderCount: 1, netSalesCents: 10_000 },
      { hour: 17, orderCount: 1, netSalesCents: 20_000 },
      { hour: 20, orderCount: 3, netSalesCents: 60_000 },
      { hour: 23, orderCount: 1, netSalesCents: 20_000 },
      { hour: 0, orderCount: 1, netSalesCents: 25_000 },
      { hour: 4, orderCount: 1, netSalesCents: 25_000 },
    ];
    const { lines, other } = splitDayparts(byHour, DEFAULT_DAYPARTS);
    expect(lines.map((l) => [l.name, l.orderCount, l.netSalesCents, l.avgOrderCents, l.shareBps])).toEqual([
      ['Lunch', 3, 40_000, 13_333, 2_000],
      ['Afternoon', 1, 20_000, 20_000, 1_000],
      ['Dinner', 3, 60_000, 20_000, 3_000],
      ['Late', 3, 70_000, 23_333, 3_500],
    ]);
    expect(other).toMatchObject({ name: 'Other hours', orderCount: 1, netSalesCents: 10_000, shareBps: 500 });
    const total = byHour.reduce((s, h) => s + h.netSalesCents, 0);
    expect(lines.reduce((s, l) => s + l.netSalesCents, 0) + (other?.netSalesCents ?? 0)).toBe(total);
  });

  it('no "Other hours" line when nothing sold outside the parts; no share with no sales', () => {
    const { lines, other } = splitDayparts([], DEFAULT_DAYPARTS);
    expect(other).toBeNull();
    expect(lines.every((l) => l.shareBps === null && l.orderCount === 0)).toBe(true);
  });
});
