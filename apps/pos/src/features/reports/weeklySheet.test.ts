/**
 * The printed weekly owner sheet (costing spec Phase 7) and the owner's-week
 * words: what the sheet carries for a login with costs, what it leaves out
 * without (the cost lines), never profit; and each "Do this" line, change and
 * part of the day in plain words. Every name and price is made up.
 */
import { describe, expect, it } from 'vitest';
import type { DoThisItem, OwnerWeek, ReportOverviewTab, ReportTrends, ReportWhenTab } from '@cheeseoclock/shared-types';
import { buildWeeklySheet } from './WeeklySheet';
import { buildPrintEverything, buildTabCsv, buildTabPrintBody } from './exporters';
import { periodFor } from './dateRange';
import {
  dayNoteAddedText,
  dayNoteText,
  daypartHoursText,
  doThisWords,
  heatmapShown,
  monthNote,
  perWeekText,
  trendChangeOf,
  trendSparklines,
} from './ownerWeekFormat';
import { daypartsProblem } from '../costing/DaypartsCard';

const WEEK: OwnerWeek = {
  week: 'last',
  sinceIso: '2026-09-21T00:00:00.000Z',
  untilIso: '2026-09-28T00:00:00.000Z',
  compareSinceIso: '2026-09-14T00:00:00.000Z',
  compareUntilIso: '2026-09-21T00:00:00.000Z',
  firstDay: '2026-09-21',
  lastDay: '2026-09-27',
  isCurrent: false,
  engine: 'worker',
  current: { netSalesCents: 9_000_000, orderCount: 75, avgOrderCents: 120_000 },
  previous: { netSalesCents: 10_000_000, orderCount: 80, avgOrderCents: 125_000 },
  change: { sales: { kind: 'pct', bps: -1_000 }, orders: { kind: 'pct', bps: -625 }, avgOrder: { kind: 'pct', bps: -400 } },
  costs: { foodCostBps: 3_050, coverageBps: 10_000, wasteCents: 240_000, hasCosts: true },
  doThis: [
    { kind: 'low_stock', key: 'low_stock:i1', weekCents: null, pinned: true, cost: false, ingredientId: 'i1', name: 'Test flour', unit: 'g', currentQty: -20, lowThreshold: 5_000 },
    { kind: 'red_item', key: 'red_item:m1', weekCents: 150_000, pinned: false, cost: true, menuItemId: 'm1', name: 'Test Deal <2 pizzas>', foodCostBps: 4_100, targetBps: 3_500, soldLast28: 20 },
  ],
  doThisMore: 0,
  doThisFailed: [],
  sheet: {
    earnsMost: [{ menuItemId: 'm2', name: 'Test Large Fajita', soldThisWeek: 30, foodCostBps: 2_500 }],
    earnsLeast: [{ menuItemId: 'm3', name: 'Test Garlic Bread', soldThisWeek: 12, foodCostBps: 4_500 }],
    wasteByReason: [{ reason: 'burnt', times: 3, cents: 240_000 }],
    previousCosts: { foodCostBps: 2_800, coverageBps: 9_500, wasteCents: 180_000, hasCosts: true },
  },
};

describe('the weekly owner sheet', () => {
  it('with costs: the five numbers against the week before, "Do this" with rupees a week, the dishes and waste', () => {
    const out = buildWeeklySheet(WEEK, { canSeeCosts: true, madeAt: new Date('2026-09-28T04:00:00.000Z') });
    expect(out).toContain('Last week: Mon 21 Sep – Sun 27 Sep 2026');
    expect(out).toContain('The whole week, compared with the week before.');
    for (const label of ['Sales', 'Orders', 'Average order', 'Food cost', 'Waste']) expect(out).toContain(`<span>${label}</span>`);
    expect(out).toContain('▼ 10%, was Rs 100,000');
    expect(out).toContain('costs known for all sales');
    // Food cost and waste against last week too: all five numbers are "vs last week".
    expect(out).toContain('costs known for all sales, was 28%');
    expect(out).toContain('thrown away, at cost, was Rs 1,800');
    // Flour's count is below zero: out on the till's count, not "0 g left".
    expect(out).toContain('Out on this till&#39;s count: Test flour');
    // Escaped, with its rupees a week.
    expect(out).toContain('Test Deal &lt;2 pizzas&gt; costs too much to make</b> — Rs 1,500 a week');
    expect(out).toContain('Earn the most per sale');
    expect(out).toContain('Test Large Fajita');
    expect(out).toContain('Earn the least per sale');
    expect(out).toContain('Waste by reason');
    expect(out).toContain('Burnt');
    expect(out).not.toMatch(/profit/i);
  });

  it('without costs: no food cost, waste, cost line or dishes — whether the main process left them out or not', () => {
    const stripped: OwnerWeek = { ...WEEK, costs: null, sheet: null, doThis: WEEK.doThis.filter((i) => !i.cost) };
    for (const week of [stripped, WEEK]) {
      const out = buildWeeklySheet(week, { canSeeCosts: false });
      expect(out).toContain('<span>Sales</span>');
      expect(out).toContain('Out on this till&#39;s count: Test flour');
      expect(out).not.toContain('Food cost');
      expect(out).not.toContain('Waste');
      expect(out).not.toContain('Test Deal');
      expect(out).not.toContain('a week');
      expect(out).not.toContain('per sale');
      expect(out).not.toContain('was 28%');
      expect(out).not.toMatch(/profit/i);
    }
  });

  it('no figures for the week before: food cost and waste print without a "was"', () => {
    const out = buildWeeklySheet({ ...WEEK, sheet: { ...WEEK.sheet!, previousCosts: null } }, { canSeeCosts: true });
    expect(out).toContain('costs known for all sales</small>');
    expect(out).toContain('thrown away, at cost</small>');
  });
});

describe('When on paper and in the file (Phase 7)', () => {
  const when: ReportWhenTab = {
    sinceIso: '2026-09-13T00:00:00.000Z',
    untilIso: '2026-09-27T00:00:00.000Z',
    engine: 'worker',
    kpis: { orderCount: 2, netSalesCents: 300_000 },
    byDay: [{ day: '2026-09-25', orderCount: 2, netSalesCents: 300_000 }],
    byHour: [
      { hour: 20, orderCount: 1, netSalesCents: 200_000 },
      { hour: 0, orderCount: 1, netSalesCents: 100_000 },
    ],
    heatmap: {
      dayCounts: [2, 2, 2, 2, 1, 2, 2],
      closedDays: 1,
      hours: [20, 21, 22, 23, 0],
      cells: [0, 1, 2, 3, 4, 5, 6].flatMap((w) =>
        [20, 21, 22, 23, 0].map((h) => ({ weekday: w, hour: h, orderCount: 0, netSalesCents: 0, avgNetSalesCents: w === 3 && h === 20 ? 200_000 : 0, avgOrdersTenths: 0 })),
      ),
    },
    dayparts: {
      lines: [
        { name: 'Dinner', fromHour: 19, toHour: 22, orderCount: 1, netSalesCents: 200_000, avgOrderCents: 200_000, shareBps: 6_667 },
        { name: 'Late', fromHour: 23, toHour: 4, orderCount: 1, netSalesCents: 100_000, avgOrderCents: 100_000, shareBps: 3_333 },
      ],
      other: null,
      isDefault: true,
    },
    dayNotes: [{ id: 'n1', day: '2026-09-25', tag: 'closed', note: 'Eid holiday', excludeFromForecast: true, addedBy: 'Test Owner', createdAt: 'x' }],
  };

  it('the file has the parts of the day, the heatmap over a week of whole days or more, and the day notes', () => {
    const week = periodFor('custom', new Date('2026-09-30T10:00:00.000Z'), { from: '2026-09-13', to: '2026-09-26' });
    const csv = buildTabCsv('when', when, week);
    expect(csv).toContain('PARTS OF THE DAY');
    expect(csv).toContain('Late,11 pm – 4:59 am,1,1000.00,1000.00');
    expect(csv).toContain('AN AVERAGE DAY BY WEEKDAY AND HOUR');
    expect(csv).toContain('Thu,2,2000.00,0.00,0.00,0.00,0.00');
    expect(csv).toContain('Days marked closed, left out: 1');
    expect(csv).toContain('Fri 25 Sep 2026,Closed,Eid holiday,Test Owner,Yes');
    // Under a week of whole days counted (a single day, or "Last 7 days" with today left out): no heatmap.
    const day = periodFor('custom', new Date('2026-09-30T10:00:00.000Z'), { from: '2026-09-25', to: '2026-09-25' });
    const oneDay = { ...when, heatmap: { ...when.heatmap, dayCounts: [0, 0, 0, 0, 1, 0, 0] } };
    expect(buildTabCsv('when', oneDay, day)).not.toContain('AN AVERAGE DAY');
    const sixDays = { ...when, heatmap: { ...when.heatmap, dayCounts: [1, 1, 1, 1, 1, 1, 0] } };
    expect(heatmapShown(sixDays.heatmap)).toBe(false);
    expect(buildTabCsv('when', sixDays, week)).not.toContain('AN AVERAGE DAY');
    expect(heatmapShown({ ...when.heatmap, dayCounts: [1, 1, 1, 1, 1, 1, 1] })).toBe(true);
    expect(heatmapShown({ ...when.heatmap, hours: [] })).toBe(false);
    const paper = buildTabPrintBody('when', when, week);
    expect(paper).toContain('Parts of the day');
    expect(paper).toContain('Closed · Eid holiday');
  });
});

describe("the owner's week in plain words", () => {
  it('how a figure moved', () => {
    expect(trendChangeOf({ kind: 'pct', bps: 1_249 })).toEqual({ text: '▲ 12%', direction: 'up' });
    expect(trendChangeOf({ kind: 'pct', bps: -40 })).toEqual({ text: '▼ <1%', direction: 'down' });
    expect(trendChangeOf({ kind: 'pct', bps: 0 })).toEqual({ text: 'Same', direction: 'flat' });
    expect(trendChangeOf({ kind: 'new' })).toEqual({ text: 'New', direction: 'up' });
    expect(trendChangeOf({ kind: 'noData' })).toEqual({ text: 'No data then', direction: 'flat' });
  });

  it('each "Do this" line', () => {
    const lines: DoThisItem[] = [
      { kind: 'low_stock', key: 'l', weekCents: null, pinned: true, cost: false, ingredientId: 'i', name: 'Test oil', unit: 'ml', currentQty: 1_500, lowThreshold: 4_000 },
      { kind: 'missing_costs', key: 'm', weekCents: 10_000, pinned: false, cost: true, things: 1, dishes: 1 },
      { kind: 'price_alert', key: 'p', weekCents: 10_000, pinned: false, cost: true, alertId: 'a', alertKind: 'weekly_digest', ingredientName: null, changeBps: null, dishes: 2 },
    ];
    expect(lines.map(doThisWords)).toEqual([
      { title: 'Running low: Test oil', detail: '1,500 ml left. You reorder at 4,000 ml.', action: 'Open stock', amount: null },
      {
        title: 'Fill in 1 missing cost',
        detail: "1 dish can't be costed yet. The rupees are roughly its food cost a week, which the till can't see yet: not money lost.",
        action: 'Open missing costs',
        // Food cost not seen yet, not a loss: said as "about", and not drawn as a loss.
        amount: { text: 'about Rs 100 a week', tone: 'unseen' },
      },
      {
        title: '2 dishes moved past their target this week',
        detail: "This week's price changes. Look at their prices or recipes.",
        action: 'Open alerts',
        amount: { text: 'Rs 100 a week', tone: 'loss' },
      },
    ]);
    expect(perWeekText(123_450)).toBe('Rs 1,234.50 a week');
    // A key ingredient at or below zero, or with no reorder level: out on the till's count, no "reorder at 0".
    for (const [currentQty, lowThreshold] of [
      [0, 4_000],
      [-3_000, 0],
      [-20, 5_000],
    ] as const) {
      expect(doThisWords({ ...lines[0]!, kind: 'low_stock', currentQty, lowThreshold } as DoThisItem)).toEqual({
        title: "Out on this till's count: Test oil",
        detail: 'Record the delivery, or count it, so the till knows what is there.',
        action: 'Open stock',
        amount: null,
      });
    }
  });

  it('the parts of the day and day notes', () => {
    expect(daypartHoursText(12, 15)).toBe('12 pm – 3:59 pm');
    expect(daypartHoursText(23, 4)).toBe('11 pm – 4:59 am');
    expect(daypartHoursText(-1, -1)).toBe('the rest of the day');
    expect(dayNoteText({ tag: 'load_shedding', note: 'No power 7 to 9' })).toBe('Load-shedding · No power 7 to 9');
    expect(dayNoteText({ tag: 'eid', note: null })).toBe('Eid');
  });

  it('the parts of the day are checked on screen as the till checks them', () => {
    expect(daypartsProblem([{ name: 'Lunch', fromHour: 12, toHour: 15 }, { name: 'Late', fromHour: 23, toHour: 4 }])).toBeNull();
    expect(daypartsProblem([])).toBe('Keep at least one part of the day.');
    expect(daypartsProblem([{ name: ' ', fromHour: 12, toHour: 15 }])).toBe('Give each part of the day a name.');
    expect(daypartsProblem([{ name: 'Lunch', fromHour: 12, toHour: 15 }, { name: 'lunch', fromHour: 16, toHour: 17 }])).toBe('Two parts of the day are called "lunch".');
    expect(daypartsProblem([{ name: 'Late', fromHour: 22, toHour: 2 }, { name: 'Night', fromHour: 1, toHour: 3 }])).toBe('"Late" and "Night" both take 1 am.');
  });
});

describe('notes on days: added for a day outside the dates on screen', () => {
  it('says where the note went, since the list shows only the dates picked', () => {
    const lastWeek = { firstDay: '2026-09-21', lastDay: '2026-09-27' };
    expect(dayNoteAddedText('2026-09-25', lastWeek)).toBe('Added for Fri 25 Sep 2026.');
    expect(dayNoteAddedText('2026-10-20', lastWeek)).toBe('Added for Tue 20 Oct 2026. Pick dates that include it to see it in the list.');
    expect(dayNoteAddedText('2026-09-20', lastWeek)).toContain('Pick dates that include it');
  });
});

/** Made-up trends at Wednesday 30 Sep 2026, 3 pm: the till's first order on 10 Jan. */
function madeUpTrends(): ReportTrends {
  const figures = (net: number, orders: number) => ({ netSalesCents: net, orderCount: orders, avgOrderCents: Math.round(net / orders) });
  const span = { sinceIso: '2026-09-30T00:00:00.000Z', untilIso: '2026-09-30T10:00:00.000Z' };
  // 56 days to today (4 Aug – 30 Sep), each Rs 1,000 + a paisa a day; today (part-done) only Rs 100.
  const recentDays = Array.from({ length: 56 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 7, 6 + i)).toISOString().slice(0, 10);
    return { day, orderCount: 1, netSalesCents: i === 55 ? 10_000 : 100_000 + i };
  });
  const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map(
    (month, i) => ({
      month,
      sinceIso: `${month}-01T00:00:00.000Z`,
      untilIso: `${month}-28T00:00:00.000Z`,
      netSalesCents: i < 3 ? 0 : 1_000_000 + i,
      orderCount: i < 3 ? 0 : 10,
      avgOrderCents: i < 3 ? 0 : 100_000,
      hadData: i > 3,
    }),
  );
  return {
    nowIso: '2026-09-30T10:00:00.000Z',
    engine: 'worker',
    firstOrderAt: '2026-01-10T12:00:00.000Z',
    lines: [
      {
        period: 'today',
        current: { ...span, figures: figures(120_000, 3) },
        previous: { ...span, figures: figures(90_000, 2), change: { sales: { kind: 'pct', bps: 3_333 }, orders: { kind: 'pct', bps: 5_000 }, avgOrder: { kind: 'pct', bps: -1_111 } } },
        lastYear: { ...span, figures: null, change: { sales: { kind: 'noData' }, orders: { kind: 'noData' }, avgOrder: { kind: 'noData' } } },
      },
    ],
    recentDays,
    months,
    monthCosts: months.map((m) => ({ month: m.month, foodCostBps: m.hadData ? 2_910 : null, coverageBps: m.hadData ? 9_000 : null })),
    partial: false,
  };
}

describe('the trend strip: small lines and months', () => {
  it('the small lines leave out what is still going (today, this week, this month) and anything before the first order', () => {
    const t = madeUpTrends();
    const spark = trendSparklines(t);
    // The 14 days before today: never today's part-done Rs 100.
    expect(spark.today!.values).toHaveLength(14);
    expect(spark.today!.values).not.toContain(10_000);
    expect(spark.today!.values.at(-1)).toBe(100_000 + 54);
    expect(spark.today!.caption).toBe('The 14 days before today');
    // Today is Wednesday: this week began Monday 28 Sep; the whole weeks before it are Monday to Sunday.
    expect(spark.week!.values).toHaveLength(7);
    expect(spark.week!.values.at(-1)).toBe(7 * 100_000 + (46 + 47 + 48 + 49 + 50 + 51 + 52));
    expect(spark.week!.caption).toBe('The 7 weeks before this one');
    // The months before this one that the till traded for in full (February to August).
    expect(spark.month!.values).toEqual([1_000_004, 1_000_005, 1_000_006, 1_000_007, 1_000_008, 1_000_009, 1_000_010]);
    // No line before the till started: the days before 10 Jan are not drawn.
    const early = trendSparklines({ ...t, firstOrderAt: '2026-09-25T08:00:00.000Z' });
    expect(early.today!.values).toHaveLength(5);
    expect(early.week).toBeUndefined();
  });

  it('each month in words: no data then, so far, part-way through', () => {
    expect(monthNote({ hadData: false, orderCount: 0 }, false)).toBe('no data then');
    expect(monthNote({ hadData: true, orderCount: 10 }, true)).toBe('so far');
    expect(monthNote({ hadData: false, orderCount: 3 }, false)).toBe('the till started part-way through');
    expect(monthNote({ hadData: true, orderCount: 10 }, false)).toBeNull();
  });

  it('Overview on paper and in the file carries the trend strip and the 12 months (print and file follow the tab)', () => {
    const t = madeUpTrends();
    const period = periodFor('today', new Date('2026-09-30T10:00:00.000Z'));
    const overview = {
      sinceIso: period.sinceIso,
      untilIso: period.untilIso,
      engine: 'worker',
      kpis: {
        orderCount: 0, netSalesCents: 0, avgOrderCents: 0, itemCount: 0, menuSalesCents: 0, discountCents: 0, discountedOrderCount: 0, taxCents: 0,
        partialRefundCents: 0, partialRefundOrderCount: 0, fullRefundCount: 0, fullRefundCents: 0, voidCount: 0, voidCents: 0, unpaidCount: 0, unpaidCents: 0,
        payments: { cash: 0, card: 0, transfer: 0, foodpanda: 0 }, unrecordedPaymentCents: 0,
      },
      previous: null,
      channels: [],
    } as unknown as ReportOverviewTab;
    const csv = buildTabCsv('overview', overview, period, new Date('2026-09-30T10:00:00.000Z'), { trends: t });
    expect(csv).toContain('HOW THE SHOP IS TRENDING');
    expect(csv).toContain('Today so far,1200.00,3,400.00,same day last week,900.00,▲ 33%,no data then,No data then');
    expect(csv).toContain('THE LAST 12 MONTHS');
    expect(csv).toContain('Month,Sales Rs,Orders,Average order Rs,Food cost,Costs known for,Note');
    expect(csv).toContain('Oct 2025,,,,,,no data then');
    expect(csv).toContain('Sep 2026,10000.11,10,1000.00,29.1%,90%,so far');
    // Without costs sent, no food cost column.
    expect(buildTabCsv('overview', overview, period, new Date(), { trends: { ...t, monthCosts: null } })).not.toContain('Food cost');
    // Nothing sent (the trends could not be worked out): the tab's own figures only.
    expect(buildTabCsv('overview', overview, period)).not.toContain('TRENDING');

    const paper = buildTabPrintBody('overview', overview, period, new Date(), { trends: t });
    expect(paper).toContain('How the shop is trending');
    expect(paper).toContain('The last 12 months');
    expect(paper).toContain('Sep 2026 <span class="muted">so far</span>');
    expect(buildPrintEverything({ overview }, period, new Date(), { trends: t })).toContain('The last 12 months');
  });
});
