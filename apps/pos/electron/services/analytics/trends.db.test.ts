/**
 * Reports' Phase 7 figures (costing spec 4.10) on a real database built from
 * every migration (the made-up shop, db/costing-shop.fixture.ts):
 *   - When: the weekday × hour heatmap leaves out a day marked closed (its
 *     sales and its place in the day count) and counts each weekday
 *     correctly, leaving today out until it is over; the parts of the day
 *     run across midnight (a 12:30 am sale is
 *     Late, on the night before) and add up to the period; the owner's own
 *     parts replace the usual ones; the period's notes are listed;
 *   - Overview's trends: today vs the same weekday last week to the minute,
 *     the 05:00 cut, "no data then" before the first COUNTED order (a
 *     training order voided before go-live does not count), the 12 months,
 *     each month's food cost only when asked (a month that is over worked out
 *     once a day and kept), and the main process's fallback leaving out every
 *     stretch over 31 days.
 *
 * The clock is set (Date only) to Wednesday 30 Sep 2026, 3 pm in Karachi.
 * node:sqlite behind better-sqlite3's shape; skips where it is missing.
 * EVERY PRICE IS MADE UP (costing spec D11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportMonthCost, ReportTrendLine } from '@cheeseoclock/shared-types';
import { CASHIER, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);
const NOW = new Date('2026-09-30T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function shop() {
  const db = openMigrated();
  const s = await openCostingShop(db);
  const r = {
    ...(await import('../../db/repositories/day-note-repo.js')),
    ...(await import('../../db/repositories/business-settings-repo.js')),
    ...(await import('./report-tabs.js')),
    ...(await import('./trends.js')),
  };
  const sale = (lines: Line[], at: string) => {
    const o = s.ring(lines);
    s.r.decrementForOrder(db, o, CASHIER);
    s.markPaid(o, new Date(at));
    return o;
  };
  return { db, ...s, r, sale };
}

/** Monday 14 Sep – Sunday 27 Sep 2026: two whole weeks. */
const TWO_WEEKS = { sinceIso: '2026-09-14T00:00:00.000Z', untilIso: '2026-09-28T00:00:00.000Z' };

live('Reports → When (costing Phase 7)', () => {
  async function whenShop() {
    const s = await shop();
    s.sale([['fajitaM', 1]], '2026-09-14T08:00:00.000Z'); // Mon 1 pm
    s.sale([['fajitaM', 1]], '2026-09-21T08:00:00.000Z'); // Mon 1 pm
    s.sale([['fajitaM', 5]], '2026-09-18T15:00:00.000Z'); // Fri 8 pm — a day marked closed (a test order)
    s.sale([['fajitaM', 2]], '2026-09-25T15:00:00.000Z'); // Fri 8 pm
    s.sale([['crispyWings', 1]], '2026-09-26T17:59:00.000Z'); // Sat 10:59 pm: Dinner
    s.sale([['crispyWings', 1]], '2026-09-26T19:30:00.000Z'); // Sun 12:30 am: Late, on Saturday's trading night
    s.r.addDayNote(s.db, { day: '2026-09-18', tag: 'closed', note: 'Gas line repair' }, MANAGER, NOW);
    s.r.addDayNote(s.db, { day: '2026-09-25', tag: 'rain' }, MANAGER, NOW);
    return s;
  }

  it('the heatmap: an average day per weekday and hour, the closed day left out of both the sales and the count', async () => {
    const s = await whenShop();
    const when = s.r.buildReportTab(s.db, 'when', TWO_WEEKS, NOW);
    const hm = when.heatmap;
    expect(hm.closedDays).toBe(1);
    expect(hm.dayCounts).toEqual([2, 2, 2, 2, 1, 2, 2]);
    // 1 pm through 11 pm, then midnight: the late sale stays at the end of the trading night.
    expect(hm.hours).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0]);
    const cell = (w: number, h: number) => hm.cells.find((c) => c.weekday === w && c.hour === h)!;
    expect(cell(0, 13)).toMatchObject({ orderCount: 2, netSalesCents: 240_000, avgNetSalesCents: 120_000, avgOrdersTenths: 10 });
    // Only the open Friday: Rs 2,400 over one Friday (the closed one's Rs 6,000 is not in it).
    expect(cell(4, 20)).toMatchObject({ orderCount: 1, netSalesCents: 240_000, avgNetSalesCents: 240_000 });
    expect(cell(5, 0)).toMatchObject({ orderCount: 1, netSalesCents: 90_000, avgNetSalesCents: 45_000, avgOrdersTenths: 5 });
  });

  it('days before the first order, today (until it is over) and days still to come are not counted', async () => {
    const s = await whenShop();
    // This month: 1–30 Sep, the till's first order on 14 Sep, today the 30th (a Wednesday, 3 pm).
    const month = s.r.buildReportTab(s.db, 'when', { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-01T00:00:00.000Z' }, NOW);
    // 14–29 Sep: Mon 14/21/28, Tue 15/22/29, Wed 16/23 (not today), Thu 17/24, Fri 18 (closed)/25, Sat 19/26, Sun 20/27.
    expect(month.heatmap.dayCounts).toEqual([3, 3, 2, 2, 1, 2, 2]);
  });

  it('today is left out until it is over — its sales and its place in the count — so a Wednesday evening still to come does not read as a quiet one', async () => {
    const s = await whenShop();
    s.sale([['fajitaM', 1]], '2026-09-16T08:00:00.000Z'); // Wed 16 Sep, 1 pm
    s.sale([['fajitaM', 1]], '2026-09-23T15:00:00.000Z'); // Wed 23 Sep, 8 pm
    s.sale([['fajitaM', 3]], '2026-09-30T08:00:00.000Z'); // today, Wed 30 Sep, 1 pm (it is 3 pm now)
    const month = s.r.buildReportTab(s.db, 'when', { sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-10-01T00:00:00.000Z' }, NOW);
    const hm = month.heatmap;
    expect(hm.dayCounts[2]).toBe(2);
    const cell = (w: number, h: number) => hm.cells.find((c) => c.weekday === w && c.hour === h)!;
    // Wednesday 8 pm: one Rs 1,200 sale over the two whole Wednesdays — not over three, as if tonight had been dead.
    expect(cell(2, 20)).toMatchObject({ orderCount: 1, netSalesCents: 120_000, avgNetSalesCents: 60_000 });
    // Wednesday 1 pm: today's sale joins the average once today is over.
    expect(cell(2, 13)).toMatchObject({ orderCount: 1, netSalesCents: 120_000, avgNetSalesCents: 60_000 });
    // Today's sales are still in the period's own figures.
    expect(month.kpis.orderCount).toBe(9);
    expect(month.dayparts.lines.reduce((n, l) => n + l.orderCount, 0)).toBe(9);
    // "This week" on a Wednesday: two whole days so far — too few for the screen to show an average weekday.
    const thisWeek = s.r.buildReportTab(s.db, 'when', { sinceIso: '2026-09-28T00:00:00.000Z', untilIso: '2026-10-05T00:00:00.000Z' }, NOW);
    expect(thisWeek.heatmap.dayCounts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('parts of the day run across midnight and add up to the period; the owner’s own replace the usual ones', async () => {
    const s = await whenShop();
    const when = s.r.buildReportTab(s.db, 'when', TWO_WEEKS, NOW);
    const line = (name: string) => when.dayparts.lines.find((l) => l.name === name)!;
    expect(when.dayparts.isDefault).toBe(true);
    expect(line('Lunch')).toMatchObject({ orderCount: 2, netSalesCents: 240_000 });
    // The closed Friday's sales are still sales of the period: every part adds up to its total.
    expect(line('Dinner')).toMatchObject({ orderCount: 3, netSalesCents: 600_000 + 240_000 + 90_000 });
    expect(line('Late')).toMatchObject({ orderCount: 1, netSalesCents: 90_000, fromHour: 23, toHour: 4 });
    expect(when.dayparts.other).toBeNull();
    const total = when.dayparts.lines.reduce((sum, l) => sum + l.netSalesCents, 0);
    expect(total).toBe(when.kpis.netSalesCents);

    s.r.setBusinessSetting(
      s.db,
      'analytics.dayparts',
      [
        { name: 'Day', fromHour: 11, toHour: 18 },
        { name: 'Night', fromHour: 19, toHour: 2 },
      ],
      OWNER,
    );
    const mine = s.r.buildReportTab(s.db, 'when', TWO_WEEKS, NOW);
    expect(mine.dayparts.isDefault).toBe(false);
    expect(mine.dayparts.lines.map((l) => [l.name, l.orderCount])).toEqual([
      ['Day', 2],
      ['Night', 4],
    ]);
  });

  it("lists the period's notes, oldest day first, with who added them", async () => {
    const s = await whenShop();
    const when = s.r.buildReportTab(s.db, 'when', TWO_WEEKS, NOW);
    expect(when.dayNotes.map((n) => [n.day, n.tag, n.note, n.addedBy])).toEqual([
      ['2026-09-18', 'closed', 'Gas line repair', 'Test Manager'],
      ['2026-09-25', 'rain', null, 'Test Manager'],
    ]);
    const lastWeek = s.r.buildReportTab(s.db, 'when', { sinceIso: '2026-09-21T00:00:00.000Z', untilIso: '2026-09-28T00:00:00.000Z' }, NOW);
    expect(lastWeek.dayNotes.map((n) => n.day)).toEqual(['2026-09-25']);
    expect(lastWeek.heatmap.closedDays).toBe(0);
  });
});

live('Reports → Overview: the trends (costing Phase 7)', () => {
  async function trendShop() {
    const s = await shop();
    s.sale([['crispyWings', 1]], '2025-11-10T12:00:00.000Z'); // the till's first order
    s.sale([['fajitaM', 1]], '2026-08-12T12:00:00.000Z');
    s.sale([['crispyWings', 1]], '2026-09-23T08:00:00.000Z'); // last Wednesday, 1 pm
    s.sale([['fajitaM', 3]], '2026-09-23T11:00:00.000Z'); // last Wednesday, 4 pm: after "by now"
    s.sale([['fajitaM', 2]], '2026-09-29T23:59:00.000Z'); // Wednesday 4:59 am: still Tuesday's trading day
    s.sale([['fajitaM', 1]], '2026-09-30T08:00:00.000Z'); // today, 1 pm
    return s;
  }
  const line = (lines: ReportTrendLine[], p: ReportTrendLine['period']) => lines.find((l) => l.period === p)!;

  it('today so far against the same weekday last week, to the minute; the 05:00 cut; no data a year ago', async () => {
    const s = await trendShop();
    const t = s.r.buildTrends(s.db, { withCosts: false }, NOW, { longReads: true, maxDays: 31 });
    expect(t.firstOrderAt).toBe('2025-11-10T12:00:00.000Z');
    expect(t.lines.map((l) => l.period)).toEqual(['today', 'week', 'month', 'year']);
    const today = line(t.lines, 'today');
    // The 4:59 am sale belongs to Tuesday: today is the 1 pm sale alone.
    expect(today.current.figures).toEqual({ netSalesCents: 120_000, orderCount: 1, avgOrderCents: 120_000 });
    expect(today.previous.figures).toEqual({ netSalesCents: 90_000, orderCount: 1, avgOrderCents: 90_000 });
    expect(today.previous.change.sales).toEqual({ kind: 'pct', bps: 3_333 });
    // A year ago the till was not in use yet.
    expect(today.lastYear!.figures).toBeNull();
    expect(today.lastYear!.change.sales).toEqual({ kind: 'noData' });
    // This week: Tuesday's 4:59 am sale and today's.
    expect(line(t.lines, 'week').current.figures).toMatchObject({ orderCount: 2, netSalesCents: 360_000 });
    // The year against last year by this date: the till started in November, so no data then.
    const year = line(t.lines, 'year');
    expect(year.lastYear).toBeNull();
    expect(year.previous.change.sales).toEqual({ kind: 'noData' });
    expect(year.current.figures.orderCount).toBe(5);
  });

  it('"no data then" counts from the first COUNTED order: a training order voided, or a cart left open, before go-live does not start the till', async () => {
    const s = await shop();
    const training = s.ring([['fajitaM', 1]]);
    s.db.prepare(`UPDATE orders SET status = 'void', created_at = ? WHERE id = ?`).run('2026-08-01T08:00:00.000Z', training);
    const leftOpen = s.ring([['cola', 1]]);
    s.db.prepare(`UPDATE orders SET created_at = ? WHERE id = ?`).run('2026-08-02T08:00:00.000Z', leftOpen);
    s.sale([['fajitaM', 1]], '2026-09-01T08:00:00.000Z'); // real trading starts
    s.sale([['fajitaM', 1]], '2026-09-30T08:00:00.000Z');
    const t = s.r.buildTrends(s.db, { withCosts: false }, NOW, { longReads: true, maxDays: 31 });
    expect(t.firstOrderAt).toBe('2026-09-01T08:00:00.000Z');
    // This month against August by this date: no data then, not "new".
    const month = line(t.lines, 'month');
    expect(month.previous.figures).toBeNull();
    expect(month.previous.change.sales).toEqual({ kind: 'noData' });
    expect(t.months.find((m) => m.month === '2026-08')).toMatchObject({ orderCount: 0, hadData: false });
    // The heatmap's days start on 1 Sep, not 1 Aug: 1–28 Sep.
    const when = s.r.buildReportTab(s.db, 'when', { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-29T00:00:00.000Z' }, NOW);
    expect(when.heatmap.dayCounts.reduce((a, b) => a + b, 0)).toBe(28);
  });

  it('a month that is over has its food cost worked out once a day and kept; this month every time; a price change or a new day works them out again', async () => {
    const s = await trendShop();
    const { setTypedPrice } = await import('../../db/repositories/ingredient-cost-repo.js');
    const month = (t: { monthCosts: ReportMonthCost[] | null }, m: string) => t.monthCosts!.find((x) => x.month === m);
    const first = s.r.buildTrends(s.db, { withCosts: true }, NOW, { longReads: true, maxDays: 31 });
    const aug = month(first, '2026-08');
    expect(aug!.foodCostBps! > 0).toBe(true);
    // An August order paid late, and one today: August stays as worked out today, September moves.
    s.sale([['crispyWings', 5]], '2026-08-20T12:00:00.000Z');
    s.sale([['crispyWings', 5]], '2026-09-30T09:00:00.000Z');
    const again = s.r.buildTrends(s.db, { withCosts: true }, NOW, { longReads: true, maxDays: 31 });
    expect(month(again, '2026-08')).toEqual(aug);
    expect(month(again, '2026-09')).not.toEqual(month(first, '2026-09'));
    // A price set (anything that prices a sale): the months are worked out again.
    setTypedPrice(s.db, { ingredientId: s.ing.cheese, typed: { per: 'thousand', priceCents: 150_000 } }, MANAGER);
    const priced = s.r.buildTrends(s.db, { withCosts: true }, NOW, { longReads: true, maxDays: 31 });
    const augNow = month(priced, '2026-08');
    expect(augNow).not.toEqual(aug);
    // …as they would be from scratch, and as they are on the next trading day.
    const { getFoodCost } = await import('../business-report.js');
    const fresh = getFoodCost(s.db, { sinceIso: '2026-08-01T00:00:00.000Z', untilIso: '2026-09-01T00:00:00.000Z' }, NOW);
    expect(augNow).toEqual({ month: '2026-08', foodCostBps: fresh.foodCostBps, coverageBps: fresh.coverageBps });
    const tomorrow = s.r.buildTrends(s.db, { withCosts: true }, new Date(NOW.getTime() + 86_400_000), { longReads: true, maxDays: 31 });
    expect(month(tomorrow, '2026-08')).toEqual(augNow);
  });

  it('the last 8 weeks day by day and the 12 months; each month’s food cost only when asked', async () => {
    const s = await trendShop();
    const t = s.r.buildTrends(s.db, { withCosts: false }, NOW, { longReads: true, maxDays: 31 });
    expect(t.recentDays).toHaveLength(56);
    expect(t.recentDays.at(-1)).toEqual({ day: '2026-09-30', orderCount: 1, netSalesCents: 120_000 });
    expect(t.recentDays.at(-2)).toEqual({ day: '2026-09-29', orderCount: 1, netSalesCents: 240_000 });
    expect(t.months.map((m) => m.month)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
    ]);
    expect(t.months[0]).toMatchObject({ month: '2025-10', orderCount: 0, hadData: false });
    // November: the till started on the 10th, so the month is only part there.
    expect(t.months[1]).toMatchObject({ month: '2025-11', orderCount: 1, hadData: false });
    expect(t.months[10]).toMatchObject({ month: '2026-08', orderCount: 1, netSalesCents: 120_000, hadData: true });
    expect(t.months[11]).toMatchObject({ month: '2026-09', orderCount: 4, netSalesCents: 90_000 + 360_000 + 240_000 + 120_000 });
    expect(t.monthCosts).toBeNull();
    expect(t.partial).toBe(false);

    const withCosts = s.r.buildTrends(s.db, { withCosts: true }, NOW, { longReads: true, maxDays: 31 });
    expect(withCosts.monthCosts).toHaveLength(12);
    expect(withCosts.monthCosts![0]).toEqual({ month: '2025-10', foodCostBps: null, coverageBps: null });
    expect(withCosts.monthCosts![11]!.foodCostBps).toBeGreaterThan(0);
  });

  it('worked out on the main thread (no worker): only stretches of 31 days or less, and it says so', async () => {
    const s = await trendShop();
    const t = s.r.buildAnalytics(s.db, 'trends', { withCosts: true }, NOW, { longReads: false }) as Awaited<ReturnType<typeof s.r.buildTrends>>;
    expect(t.partial).toBe(true);
    expect(t.lines.map((l) => l.period)).toEqual(['today', 'week', 'month']);
    expect(t.recentDays).toEqual([]);
    expect(t.months).toEqual([]);
    expect(t.monthCosts).toBeNull();
  });
});
