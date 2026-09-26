import { describe, expect, it } from 'vitest';
import type { BusinessReport, ReportKpis } from '@cheeseoclock/shared-types';
import { periodFor } from './dateRange';
import { buildCsv, buildPrintBody, csvFileName, escapeHtml, toCsv } from './exporters';
import {
  changeOf,
  daySeries,
  fmtMinutes,
  fmtWhen,
  hourLabel,
  hourSeries,
  percentOf,
  weekdayAverages,
} from './reportFormat';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');

describe('changeOf', () => {
  it('says how a figure moved, in words the owner reads', () => {
    expect(changeOf(112, 100)).toEqual({ text: '▲ 12%', direction: 'up' });
    expect(changeOf(95, 100)).toEqual({ text: '▼ 5%', direction: 'down' });
    expect(changeOf(100, 100)).toEqual({ text: 'Same', direction: 'flat' });
    expect(changeOf(50, 0)).toEqual({ text: 'New', direction: 'up' });
    expect(changeOf(1001, 1000)).toEqual({ text: '▲ <1%', direction: 'up' });
    expect(changeOf(5, null)).toEqual({ text: '', direction: 'none' });
    expect(changeOf(5, undefined)).toEqual({ text: '', direction: 'none' });
  });

  it('shares round to whole percents, never divide by zero', () => {
    expect(percentOf(1, 3)).toBe('33%');
    expect(percentOf(1, 1000)).toBe('<1%');
    expect(percentOf(5, 0)).toBe('0%');
  });
});

describe('hours', () => {
  it('reads the clock the way people say it', () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(['12 am', '1 am', '11 am', '12 pm', '1 pm', '11 pm']);
  });

  it('runs the evening into the small hours, keeping empty hours between', () => {
    const series = hourSeries([
      { hour: 0, orderCount: 1, netSalesCents: 100 },
      { hour: 12, orderCount: 2, netSalesCents: 200 },
      { hour: 22, orderCount: 3, netSalesCents: 300 },
    ]);
    expect(series.map((h) => h.hour)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0]);
    expect(series.find((h) => h.hour === 15)).toEqual({ hour: 15, orderCount: 0, netSalesCents: 0 });
    expect(hourSeries([])).toEqual([]);
  });
});

describe('days', () => {
  it('a bar per day so far (empty days kept, no future days)', () => {
    const week = periodFor('thisWeek', SAT_3PM); // Mon 21 – Sun 27, now Saturday
    const { unit, bars } = daySeries([{ day: '2026-09-23', orderCount: 4, netSalesCents: 4000 }], week, SAT_3PM);
    expect(unit).toBe('day');
    expect(bars.map((b) => b.key)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
    expect(bars[2]).toMatchObject({ label: '23', title: 'Wed 23 Sep 2026', netSalesCents: 4000 });
  });

  it('a bar per month for long ranges, adding up to the days', () => {
    const p = periodFor('custom', SAT_3PM, { from: '2026-06-01', to: '2026-08-31' });
    const { unit, bars } = daySeries(
      [
        { day: '2026-06-02', orderCount: 1, netSalesCents: 100 },
        { day: '2026-06-30', orderCount: 1, netSalesCents: 200 },
        { day: '2026-08-15', orderCount: 2, netSalesCents: 500 },
      ],
      p,
      SAT_3PM,
    );
    expect(unit).toBe('month');
    expect(bars.map((b) => [b.title, b.orderCount, b.netSalesCents])).toEqual([
      ['Jun 2026', 2, 300],
      ['Jul 2026', 0, 0],
      ['Aug 2026', 2, 500],
    ]);
  });

  it('averages each weekday over the days that happened, shut days as zero', () => {
    // Two weeks: Mon 7 – Sun 20 Sep 2026. Sales on both Mondays and one Friday.
    const p = periodFor('custom', SAT_3PM, { from: '2026-09-07', to: '2026-09-20' });
    const avg = weekdayAverages(
      [
        { day: '2026-09-07', orderCount: 10, netSalesCents: 10000 },
        { day: '2026-09-14', orderCount: 20, netSalesCents: 30000 },
        { day: '2026-09-11', orderCount: 5, netSalesCents: 8000 },
      ],
      p,
      SAT_3PM,
    );
    expect(avg[0]).toEqual({ weekday: 'Mon', days: 2, avgSalesCents: 20000, avgOrders: 15 });
    expect(avg[4]).toEqual({ weekday: 'Fri', days: 2, avgSalesCents: 4000, avgOrders: 2.5 });
    expect(avg[6]).toEqual({ weekday: 'Sun', days: 2, avgSalesCents: 0, avgOrders: 0 });
  });
});

describe('times', () => {
  it('shows instants on the Pakistan clock whatever the PC is set to', () => {
    expect(fmtWhen('2026-09-25T15:30:00.000Z')).toBe('25 Sep, 8:30 pm');
    expect(fmtWhen('2026-09-25T19:05:00.000Z')).toBe('26 Sep, 12:05 am');
    expect(fmtWhen(null)).toBe('—');
    expect(fmtMinutes(45)).toBe('45 min');
    expect(fmtMinutes(70)).toBe('1 h 10 min');
    expect(fmtMinutes(null)).toBe('—');
  });
});

// ------------------------------------------------------------ exporters --

const kpis = (over: Partial<ReportKpis> = {}): ReportKpis => ({
  orderCount: 2,
  itemCount: 3,
  menuSalesCents: 20000,
  discountCents: 1000,
  discountedOrderCount: 1,
  taxCents: 3040,
  billedCents: 22040,
  partialRefundCents: 500,
  partialRefundOrderCount: 1,
  netSalesCents: 21540,
  avgOrderCents: 10770,
  fullRefundCount: 0,
  fullRefundCents: 0,
  voidCount: 1,
  voidCents: 1160,
  unpaidCount: 0,
  unpaidCents: 0,
  payments: { cash: 11540, card: 10000, foodpanda: 0, transfer: 0 },
  unrecordedPaymentCents: 0,
  ...over,
});

const drawerOpen = (
  over: Partial<BusinessReport['drawerOpens'][number]> = {},
): BusinessReport['drawerOpens'][number] => ({
  id: 'd1',
  createdAt: '2026-09-26T09:00:00.000Z',
  kind: 'no_sale',
  reason: 'Change',
  openedBy: 'Ali',
  approvedBy: 'Sara',
  outsideShift: false,
  ...over,
});

const report = (over: Partial<BusinessReport> = {}): BusinessReport => ({
  sinceIso: '2026-09-26T00:00:00.000Z',
  untilIso: '2026-09-27T00:00:00.000Z',
  kpis: kpis(),
  previous: kpis({ netSalesCents: 20000 }),
  byDay: [{ day: '2026-09-26', orderCount: 2, netSalesCents: 21540 }],
  byHour: [{ hour: 20, orderCount: 2, netSalesCents: 21540 }],
  items: [
    { key: 'm1', name: '=HYPERLINK("x")', categoryId: 'c1', categoryName: 'Burgers, large', quantity: 2, salesCents: 15000 },
    { key: 'm2', name: 'Drink "cold"', categoryId: 'c2', categoryName: 'Drinks', quantity: 1, salesCents: 5000 },
  ],
  categories: [],
  channels: [{ channel: 'takeaway', orderCount: 2, netSalesCents: 21540 }],
  staff: [{ key: 'u1', name: '<b>Ali</b>', isWebsite: false, orderCount: 2, netSalesCents: 21540, discountCents: 1000, voidCount: 1, noSaleOpens: 2 }],
  shifts: [],
  discounts: { totalCount: 0, totalCents: 0, byReason: [], byPerson: [], recent: [] },
  refunds: [],
  voids: [],
  drawerOpens: [],
  drawerOpenCount: 0,
  foodCost: { usedCents: 0, wasteCents: 0, hasCosts: false, hasUsage: false, ingredients: [] },
  deliveries: { byRider: [], byArea: [] },
  ...over,
});

describe('CSV for Excel', () => {
  it('quotes, escapes, and defuses formulas; money as plain rupees', () => {
    const csv = toCsv([
      ['a,b', 'say "hi"', '=1+1', '-5', 'line\nbreak'],
      [12, { cents: 123456 }, { cents: -500 }, null],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [first, second] = csv.slice(1).split('\r\n');
    expect(first).toBe(`"a,b","say ""hi""",'=1+1,'-5,"line\nbreak"`);
    expect(second).toBe('12,1234.56,-5.00,');
  });

  it('carries the same figures as the screen', () => {
    const period = periodFor('today', SAT_3PM);
    const csv = buildCsv(report(), period, SAT_3PM);
    expect(csv).toContain('Period,Today: Sat 26 Sep 2026');
    expect(csv).toContain('Compared with,yesterday by this time');
    expect(csv).toContain('"Sales (after discounts and refunds, tax included) Rs",215.40,200.00');
    expect(csv).toContain(`'=HYPERLINK(""x"")`);
    expect(csv).toContain('"Burgers, large"');
    expect(csv).toContain('8 pm,2,215.40');
    // No-sale drawer opens per person, and the list of each one.
    expect(csv).toContain('Cancelled orders,Drawer opened with no sale');
    expect(csv).toMatch(/Ali.*,215\.40,10\.00,1,2\r\n/);
    const withOpen = buildCsv(
      report({
        drawerOpens: [
          {
            id: 'd1',
            createdAt: '2026-09-26T09:00:00.000Z',
            kind: 'no_sale',
            reason: 'Change',
            openedBy: 'Ali',
            approvedBy: 'Sara',
            outsideShift: false,
          },
        ],
      }),
      period,
      SAT_3PM,
    );
    expect(withOpen).toContain('CASH DRAWER OPENED BY HAND (NO SALE)');
    expect(withOpen).toMatch(/No sale,Change,Ali,Sara,Yes/);
    // A busy month: the list stops at the cap, and says so.
    const capped = buildCsv(report({ drawerOpens: [drawerOpen()], drawerOpenCount: 420 }), period, SAT_3PM);
    expect(capped).toContain('CASH DRAWER OPENED BY HAND (NO SALE) — LATEST 1 OF 420');
  });

  it('names the file after the period', () => {
    expect(csvFileName({ firstDay: '2026-09-26', lastDay: '2026-09-26' })).toBe('sales-report-2026-09-26.csv');
    expect(csvFileName({ firstDay: '2026-09-01', lastDay: '2026-09-30' })).toBe('sales-report-2026-09-01-to-2026-09-30.csv');
  });
});

describe('printout', () => {
  it('escapes everything typed at the till', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const html = buildPrintBody(report(), periodFor('today', SAT_3PM), SAT_3PM);
    expect(html).not.toContain('<b>Ali</b>');
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
  });

  it('prints the headline, the comparison and the add-up', () => {
    const html = buildPrintBody(report(), periodFor('today', SAT_3PM), SAT_3PM);
    expect(html).toContain('Sales report — Today');
    expect(html).toContain('Sat 26 Sep 2026');
    expect(html).toContain('compared with yesterday by this time');
    expect(html).toContain('▲ 8%, was Rs 200');
    expect(html).toContain('How the sales add up');
    expect(html).toContain('Cancelled before payment: 1 order');
    expect(html).toContain('No-sale opens');
  });

  it('prints each shift’s cash in/out and no-sale opens, and every hand-opened drawer with who approved it', () => {
    const html = buildPrintBody(
      report({
        shifts: [
          {
            id: 's1',
            openedAt: '2026-09-26T04:00:00.000Z',
            closedAt: '2026-09-26T16:00:00.000Z',
            openedBy: 'Sara',
            closedBy: 'Sara',
            openingCashCents: 500000,
            expectedCashCents: 611540,
            countedCashCents: 611540,
            varianceCents: 0,
            cashInCents: 0,
            cashOutCents: 20000,
            cashMovementCount: 3,
            noSaleOpens: 2,
          },
        ],
        drawerOpens: [
          drawerOpen(),
          drawerOpen({ id: 'd2', kind: 'count', reason: null, openedBy: 'Sara', approvedBy: null }),
          drawerOpen({ id: 'd3', reason: '<i>x</i>', openedBy: 'Owner', approvedBy: null, outsideShift: true }),
        ],
        drawerOpenCount: 3,
      }),
      periodFor('today', SAT_3PM),
      SAT_3PM,
    );
    expect(html).toContain('<th class="r">Cash in/out</th><th class="r">No-sale opens</th>');
    expect(html).toMatch(/Matched<\/td><td class="r">3<\/td><td class="r">2<\/td>/);
    expect(html).toContain('Cash drawer opened by hand — 3 times');
    expect(html).toMatch(/No sale<\/td><td>Change<\/td><td>Ali<\/td><td>Sara<\/td>/);
    expect(html).toMatch(/To count at close<\/td><td>—<\/td><td>Sara<\/td><td>—<\/td>/);
    expect(html).toContain('(no shift open)');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).not.toContain('<i>x</i>');
    expect(html).not.toContain('Showing the latest');
  });

  it('says how many hand opens there were in all when it prints only some', () => {
    const many = Array.from({ length: 30 }, (_, i) => drawerOpen({ id: `d${i}` }));
    const period = periodFor('today', SAT_3PM);
    // More than fit on paper; the Excel file has them all.
    let html = buildPrintBody(report({ drawerOpens: many, drawerOpenCount: 30 }), period, SAT_3PM);
    expect(html).toContain('Cash drawer opened by hand — 30 times');
    expect(html).toContain('Showing the latest 25 of 30. Download for Excel for the full list.');
    // The report itself stopped at its cap: say how many there really were.
    html = buildPrintBody(report({ drawerOpens: many, drawerOpenCount: 420 }), period, SAT_3PM);
    expect(html).toContain('Cash drawer opened by hand — 420 times');
    expect(html).toContain('Showing the latest 25 of 420. Download for Excel for the latest 30.');
    // None: no section.
    expect(buildPrintBody(report(), period, SAT_3PM)).not.toContain('Cash drawer opened by hand');
  });
});
