import { describe, expect, it } from 'vitest';
import type { BusinessReport, CashCount, DrawerLogPage, ReportFoodCost, ReportKpis, ReportShiftLine } from '@cheeseoclock/shared-types';
import { periodFor } from './dateRange';
import {
  TEAM_EXTRA_UNREAD,
  buildPrintEverything,
  buildTabCsv,
  buildTabPrintBody,
  csvFileName,
  escapeHtml,
  toCsv,
  type SomeReportTabs,
} from './exporters';
import { fetchTeamExtras, teamExtrasFailedText } from './teamExtras';
import {
  MISSING_COST_WHY,
  WASTE_REASON_LABEL,
  cancelledWasteText,
  changeOf,
  costingStartText,
  coverageText,
  daySeries,
  estimatedText,
  fmtAgo,
  fmtMinutes,
  fmtWhen,
  byHandText,
  foodCostHeadline,
  hasPurchases,
  hourLabel,
  hourSeries,
  menuPriceLine,
  percentOf,
  purchaseBillsText,
  purchaseHeadline,
  shiftCashOutParts,
  shiftCountedNotes,
  shiftCountedNotesText,
  shiftDetailLines,
  shiftResultOf,
  stockCellText,
  unpaidFoodText,
  websiteVsTill,
  weekdayAverages,
} from './reportFormat';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');

describe('website vs till', () => {
  it('splits the order types into website orders and the rest, adding up to the sales', () => {
    const split = websiteVsTill([
      { channel: 'takeaway', orderCount: 5, netSalesCents: 50_000 },
      { channel: 'web_delivery', orderCount: 2, netSalesCents: 30_000 },
      { channel: 'web_pickup', orderCount: 1, netSalesCents: 9_000 },
      { channel: 'foodpanda', orderCount: 3, netSalesCents: 40_000 },
      { channel: 'delivery', orderCount: 1, netSalesCents: 12_000 },
    ]);
    expect(split).toEqual({ website: { orderCount: 3, netSalesCents: 39_000 }, till: { orderCount: 9, netSalesCents: 102_000 } });
    expect(websiteVsTill([])).toEqual({ website: { orderCount: 0, netSalesCents: 0 }, till: { orderCount: 0, netSalesCents: 0 } });
  });
});

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

  it('says how long ago a shift was opened', () => {
    const now = new Date('2026-09-27T10:00:00.000Z');
    expect(fmtAgo('2026-09-27T09:59:30.000Z', now)).toBe('just now');
    // A till clock a little behind the one that wrote it.
    expect(fmtAgo('2026-09-27T10:02:00.000Z', now)).toBe('just now');
    expect(fmtAgo('not a date', now)).toBe('just now');
    expect(fmtAgo('2026-09-27T09:35:00.000Z', now)).toBe('25 min ago');
    expect(fmtAgo('2026-09-27T04:50:00.000Z', now)).toBe('5 h 10 min ago');
    expect(fmtAgo('2026-09-26T10:00:00.000Z', now)).toBe('1 day ago');
    expect(fmtAgo('2026-09-25T07:00:00.000Z', now)).toBe('2 days 3 h ago');
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

/** A made-up food cost: nothing sold, nothing wasted, unless overridden. */
const food = (over: Partial<ReportFoodCost> = {}): ReportFoodCost => ({
  foodSalesCents: 0,
  feeSalesCents: 0,
  costOfSalesCents: 0,
  knownSalesCents: 0,
  knownCostCents: 0,
  foodCostBps: null,
  knownMenuSalesCents: 0,
  menuFoodCostBps: null,
  coverageBps: null,
  estimatedOrders: 0,
  estimatedCostCents: 0,
  costingStartedAt: null,
  missingSales: [],
  missingSalesCents: 0,
  wasteCents: 0,
  wasteByReason: [],
  wasteIngredients: [],
  cancelledWasteCents: 0,
  cancelledOrderCount: 0,
  putBackAfterCookingCount: 0,
  sentNotPaid: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  stillOpen: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  hasCosts: false,
  hasUsage: false,
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
  foodCost: food(),
  deliveries: { byRider: [], byArea: [] },
  ...over,
});

/** A made-up Profit tab (costing spec Phase 9): Rs 1,000 of sales, Rs 300 of food cost. */
function profitTabOf(base: { sinceIso: string; untilIso: string; engine: 'worker' }): NonNullable<SomeReportTabs['profit']> {
  return {
    ...base,
    steps: [
      { key: 'sales', cents: 100_000 },
      { key: 'food_cost', cents: -30_000 },
      { key: 'unknown_cost', cents: 0 },
      { key: 'waste', cents: 0 },
      { key: 'sent_not_paid', cents: 0 },
      { key: 'commission', cents: 0 },
      { key: 'payment_fees', cents: 0 },
      { key: 'rider', cents: 0 },
    ],
    profitCents: 70_000,
    wasteByReason: [],
    sentNotPaid: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
    stockLoss: { state: 'not_between', cents: null, scopes: null, message: 'Stock that went missing is taken off only for "Between stock takes".' },
    channels: [],
    categories: [],
    unknownSalesCents: 0,
    coverageBps: 10_000,
    estimatedOrders: 0,
    costingStartedAt: null,
    fees: {
      foodpanda: { v: 1, commissionBps: 2500, confirmed: false, base: 'after_deal', fixedFeeCents: 0, commissionTaxBps: 0, upliftBps: 0, paymentFeeBps: 0 },
      paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 },
    },
    riderCost: { mode: 'zone_rate', fixedCents: 0 },
    noRateCount: 0,
  };
}

/** The report split into its tabs, as the tab channels hand them over. Without its food cost: no Food cost & stock tab. */
function tabsOf(r: BusinessReport): SomeReportTabs {
  const base = { sinceIso: r.sinceIso, untilIso: r.untilIso, engine: 'worker' as const };
  const k = r.kpis;
  return {
    overview: { ...base, kpis: k, previous: r.previous, channels: r.channels },
    when: {
      ...base,
      kpis: { orderCount: k.orderCount, netSalesCents: k.netSalesCents },
      byDay: r.byDay,
      byHour: r.byHour,
      heatmap: { dayCounts: [0, 0, 0, 0, 0, 0, 0], closedDays: 0, hours: [], cells: [] },
      dayparts: { lines: [], other: null, isDefault: true },
      dayNotes: [],
    },
    menu: { ...base, kpis: { menuSalesCents: k.menuSalesCents, itemCount: k.itemCount }, items: r.items, categories: r.categories, costs: null },
    channels: {
      ...base,
      kpis: { orderCount: k.orderCount, netSalesCents: k.netSalesCents, avgOrderCents: k.avgOrderCents },
      channels: r.channels,
      deliveries: r.deliveries,
      areas: [],
      noRateDeliveries: [],
      noRateCount: 0,
      profit: null,
    },
    // Profit (costing spec Phase 9) goes with costs: a login without them has no Profit tab either.
    ...(r.foodCost ? { profit: profitTabOf(base) } : {}),

    ...(r.foodCost
      ? {
          foodStock: {
            ...base,
            kpis: { partialRefundCents: k.partialRefundCents },
            foodCost: r.foodCost,
            purchases: { spendCents: 0, bills: 0, bySupplier: [], byIngredient: [], byHandCents: 0, byHandEntries: 0 },
          },
        }
      : {}),
    team: {
      ...base,
      kpis: {
        netSalesCents: k.netSalesCents,
        menuSalesCents: k.menuSalesCents,
        partialRefundCents: k.partialRefundCents,
        fullRefundCents: k.fullRefundCents,
        voidCount: k.voidCount,
        voidCents: k.voidCents,
      },
      staff: r.staff,
      shifts: r.shifts,
      discounts: r.discounts,
      refunds: r.refunds,
      voids: r.voids,
      drawerOpens: r.drawerOpens,
      drawerOpenCount: r.drawerOpenCount,
      foodCost: r.foodCost ? { hasCosts: r.foodCost.hasCosts } : null,
    },
  };
}

/** One tab's CSV / printout of a made-up report. */
const tabCsv = (tab: keyof SomeReportTabs, r: BusinessReport, period = periodFor('today', SAT_3PM)) =>
  buildTabCsv(tab, tabsOf(r)[tab] as never, period, SAT_3PM);
const tabPrint = (tab: keyof SomeReportTabs, r: BusinessReport, period = periodFor('today', SAT_3PM)) =>
  buildTabPrintBody(tab, tabsOf(r)[tab] as never, period, SAT_3PM);

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

  it('carries the same figures as the screen, each tab in its own file', () => {
    const period = periodFor('today', SAT_3PM);
    const overview = tabCsv('overview', report(), period);
    expect(overview).toContain('Sales report,Overview');
    expect(overview).toContain('Period,Today: Sat 26 Sep 2026');
    expect(overview).toContain('Compared with,yesterday by this time');
    expect(overview).toContain('"Sales (after discounts and refunds, tax included) Rs",215.40,200.00');
    expect(overview).toContain('"Till (counter, phone, Foodpanda)",2,215.40');
    const menu = tabCsv('menu', report(), period);
    expect(menu).toContain(`'=HYPERLINK(""x"")`);
    expect(menu).toContain('"Burgers, large"');
    // Only the Overview says what the period is compared with.
    expect(menu).not.toContain('Compared with');
    expect(tabCsv('when', report(), period)).toContain('8 pm,2,215.40');
    // No-sale drawer opens per person, and the list of each one.
    const team = tabCsv('team', report(), period);
    expect(team).toContain('Cancelled orders,Drawer opened with no sale');
    // …then every drawer open (0042): none on this made-up line.
    expect(team).toMatch(/Ali.*,215\.40,10\.00,1,2,\r\n/);
    const withOpen = tabCsv(
      'team',
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
    );
    expect(withOpen).toContain('CASH DRAWER OPENED BY HAND (NO SALE, COUNT, TEST)');
    expect(withOpen).toMatch(/No sale,Change,Ali,Sara,Yes/);
    // A busy month: the list stops at the cap, and says so.
    const capped = tabCsv('team', report({ drawerOpens: [drawerOpen()], drawerOpenCount: 420 }), period);
    expect(capped).toContain('CASH DRAWER OPENED BY HAND (NO SALE, COUNT, TEST) — LATEST 1 OF 420');
  });

  it('names the file after the tab and the period', () => {
    expect(csvFileName({ firstDay: '2026-09-26', lastDay: '2026-09-26' })).toBe('sales-report-2026-09-26.csv');
    expect(csvFileName({ firstDay: '2026-09-01', lastDay: '2026-09-30' })).toBe('sales-report-2026-09-01-to-2026-09-30.csv');
    expect(csvFileName({ firstDay: '2026-09-26', lastDay: '2026-09-26' }, 'menu')).toBe('sales-report-menu-2026-09-26.csv');
    expect(csvFileName({ firstDay: '2026-01-01', lastDay: '2026-12-31' }, 'foodStock')).toBe(
      'sales-report-food-cost-stock-2026-01-01-to-2026-12-31.csv',
    );
  });

  it('each tab\'s file holds that tab only (costing spec Phase 3)', () => {
    // Every section heading of every tab, and the tab it belongs to.
    const HEADINGS: Record<keyof SomeReportTabs, string[]> = {
      overview: ['SUMMARY', 'WEBSITE VS TILL'],
      when: ['SALES BY DAY', 'SALES BY HOUR'],
      menu: ['ITEMS SOLD', 'CATEGORIES'],
      channels: ['ORDER TYPES', 'DELIVERIES BY RIDER', 'DELIVERIES BY AREA'],
      foodStock: ['FOOD COST', 'WASTE BY REASON', 'SALES WITH MISSING COSTS', 'INGREDIENTS WASTED', 'PURCHASES'],
      team: ['STAFF', 'SHIFTS', 'DISCOUNTS BY REASON', 'DISCOUNTS BY PERSON', 'EACH DISCOUNT', 'REFUNDS', 'CANCELLED BEFORE PAYMENT', 'CASH DRAWER OPENED BY HAND'],
      profit: ['FROM SALES TO PROFIT BEFORE OVERHEADS', 'WHAT EACH ORDER TYPE EARNS', 'PROFIT BY CATEGORY'],
    };
    const r = report({ foodCost: food({ hasCosts: true, hasUsage: true, foodSalesCents: 10_000 }) });
    for (const tab of Object.keys(HEADINGS) as Array<keyof SomeReportTabs>) {
      const lines = tabCsv(tab, r).split('\r\n');
      // A heading is the line after a blank one (the file's own layout).
      const headings = lines.filter((_, i) => i > 0 && lines[i - 1] === '').map((l) => l.replace(/^"|"$/g, ''));
      for (const own of HEADINGS[tab]) expect({ tab, own, found: headings.some((h) => h.startsWith(own)) }).toEqual({ tab, own, found: true });
      for (const [other, theirs] of Object.entries(HEADINGS)) {
        if (other === tab) continue;
        for (const h of theirs) {
          expect({ tab, foreign: h, found: headings.some((x) => x.startsWith(h)) }).toEqual({ tab, foreign: h, found: false });
        }
      }
    }
  });
});

describe('purchases on paper and in the file (costing spec Phase 5)', () => {
  it('by supplier and by ingredient, with the latest price and its change; made-up figures', () => {
    const r = report({ foodCost: food({ hasCosts: true, hasUsage: true, foodSalesCents: 10_000 }) });
    const tab = tabsOf(r).foodStock!;
    const withPurchases = {
      ...tab,
      purchases: {
        spendCents: 1_300_000,
        bills: 3,
        byHandCents: 50_000,
        byHandEntries: 2,
        bySupplier: [
          { key: 's1', from: 'supplier' as const, name: 'Test Dairy', bills: 2, spendCents: 1_000_000 },
          { key: 'no_supplier', from: 'no_supplier' as const, name: 'No supplier named', bills: 1, spendCents: 250_000 },
          { key: 'by_hand', from: 'by_hand' as const, name: 'Booked in by hand (no bill)', bills: 0, spendCents: 50_000 },
        ],
        byIngredient: [
          { ingredientId: 'i1', name: 'Test cheese', unit: 'g', qty: 8_000, times: 2, spendCents: 1_000_000, lastUnitCostMc: 125_000, prevUnitCostMc: 112_500 },
        ],
      },
    };
    const period = periodFor('today', SAT_3PM);
    const csv = buildTabCsv('foodStock', withPurchases, period, SAT_3PM);
    expect(csv).toContain('PURCHASES (THIS TILL, AT THE BILLS)');
    expect(csv).toContain('Test Dairy,2,10000.00');
    // Stock booked in by hand has no bills: an empty Bills cell, and not in the total's count.
    expect(csv).toContain('Booked in by hand (no bill),,500.00');
    expect(csv).toContain('Total,3,13000.00');
    expect(csv).toContain('"Of it: booked in by hand 2 times, no bill (at the price then)",,500.00');
    expect(csv).toContain('Test cheese,g,8000,2,10000.00,1250.00,kg,▲ 11.1%');
    const html = buildTabPrintBody('foodStock', withPurchases, period, SAT_3PM);
    expect(html).toContain('Rs 13,000 spent on stock, 3 bills.');
    expect(html).toContain('No supplier named');
    expect(html).toContain('<td>Booked in by hand (no bill)</td><td class="r">—</td>');
  });

  it('bills are purchases: stock booked in by hand is said once, never counted as a bill', () => {
    const hand = { key: 'by_hand', from: 'by_hand' as const, name: 'Booked in by hand (no bill)', bills: 0, spendCents: 80_000 };
    const onlyByHand = { spendCents: 80_000, bills: 0, bySupplier: [hand], byHandCents: 80_000, byHandEntries: 12 };
    expect(hasPurchases(onlyByHand)).toBe(true);
    expect(purchaseHeadline(onlyByHand)).toBe('Rs 800 of stock booked in, no bills.');
    expect(purchaseBillsText(hand)).toBe('—');
    expect(purchaseBillsText({ from: 'supplier', bills: 14 })).toBe('14');
    expect(byHandText(onlyByHand)).toBe('Rs 800 of it was stock booked in by hand 12 times, with no bill (valued at the price then).');
    expect(byHandText({ byHandCents: 4_000, byHandEntries: 1 })).toMatch(/by hand once,/);
    expect(byHandText({ byHandCents: 0, byHandEntries: 0 })).toBeNull();
    // A Rs 0 bill is still a purchase: something came in.
    const sample = { spendCents: 0, bills: 1, bySupplier: [{ key: 's1', from: 'supplier' as const, name: 'Test Dairy', bills: 1, spendCents: 0 }] };
    expect(hasPurchases(sample)).toBe(true);
    expect(purchaseHeadline(sample)).toBe('Rs 0 spent on stock, 1 bill.');
    expect(purchaseHeadline({ spendCents: 0, bills: 0, bySupplier: [] })).toBe('No stock bought in this period.');
  });
});

describe('printout', () => {
  it('escapes everything typed at the till', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const html = tabPrint('team', report());
    expect(html).not.toContain('<b>Ali</b>');
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
  });

  it('prints the headline, the comparison and the add-up', () => {
    const html = tabPrint('overview', report());
    expect(html).toContain('Overview — Today');
    expect(html).toContain('Sat 26 Sep 2026');
    expect(html).toContain('compared with yesterday by this time');
    expect(html).toContain('▲ 8%, was Rs 200');
    expect(html).toContain('How the sales add up');
    expect(html).toContain('Cancelled before payment: 1 order');
    expect(html).toContain('Website vs till');
    expect(tabPrint('team', report())).toContain('No-sale opens');
  });

  it('prints a tab on its own, and everything in the page\'s order', () => {
    const r = report({ foodCost: food({ hasCosts: true, hasUsage: true, foodSalesCents: 100_000, foodCostBps: 3_000, coverageBps: 10_000 }) });
    const menu = tabPrint('menu', r);
    expect(menu).toContain('Top items');
    expect(menu).not.toContain('How the sales add up');
    expect(menu).not.toContain('Food cost');
    expect(menu).not.toContain('compared with');
    const when = tabPrint('when', r);
    expect(when).toContain('Sales by hour (Pakistan time)');
    expect(when).toContain('<td>8 pm</td><td class="r">2</td><td class="r">Rs 215.40</td>');

    const all = buildPrintEverything(tabsOf(r), periodFor('today', SAT_3PM), SAT_3PM);
    expect(all).toContain('Sales report — Today');
    const order = ['Overview', 'When', 'Menu', 'Channels &amp; delivery', 'Food cost &amp; stock', 'Team &amp; leakage'].map((t) =>
      all.indexOf(`<div class="tab-title">${t}</div>`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A login without costs is handed no Food cost & stock tab: nothing of it prints.
    const noCosts = buildPrintEverything(tabsOf(report({ foodCost: null })), periodFor('today', SAT_3PM), SAT_3PM);
    expect(noCosts).not.toContain('Food cost');
    expect(noCosts).toContain('Team &amp; leakage');
  });

  it('prints each shift’s cash in/out and no-sale opens, and every hand-opened drawer with who approved it', () => {
    const html = tabPrint(
      'team',
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
            openingNote: 'Morning shift, <b>Ali</b> on register',
            closingNote: 'Rs 200 paid for gas, receipt in the drawer',
            carriedUnpaidCount: 0,
            carryOverReason: null,
          },
        ],
        drawerOpens: [
          drawerOpen(),
          drawerOpen({ id: 'd2', kind: 'count', reason: null, openedBy: 'Sara', approvedBy: null }),
          drawerOpen({ id: 'd3', reason: '<i>x</i>', openedBy: 'Owner', approvedBy: null, outsideShift: true }),
        ],
        drawerOpenCount: 3,
      }),
    );
    expect(html).toContain('<th class="r">Cash in/out</th><th class="r">No-sale opens</th><th>Notes</th>');
    expect(html).toMatch(/Matched<\/td><td class="r">3<\/td><td class="r">2<\/td>/);
    // The opening and the closing note, each on its own line, escaped like everything else.
    expect(html).toContain(
      '<td>Opening note: Morning shift, &lt;b&gt;Ali&lt;/b&gt; on register<br>Closing note: Rs 200 paid for gas, receipt in the drawer</td>',
    );
    expect(html).toContain('Cash drawer opened by hand (no sale, count, test) — 3 times');
    expect(html).toMatch(/No sale<\/td><td>Change<\/td><td>Ali<\/td><td>Sara<\/td>/);
    expect(html).toMatch(/To count at close<\/td><td>—<\/td><td>Sara<\/td><td>—<\/td>/);
    expect(html).toContain('(no shift open)');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).not.toContain('<i>x</i>');
    expect(html).not.toContain('Showing the latest');
  });

  it('the paisa rule: under Re 1 either way is Matched with its paisa under it on the A4 paper; Re 1 is Over or Short; the file keeps the exact figure', () => {
    const shift = (id: string, varianceCents: number) => ({
      id,
      openedAt: '2026-10-02T05:00:00.000Z',
      closedAt: '2026-10-02T10:30:00.000Z',
      openedBy: 'Sara',
      closedBy: 'Sara',
      openingCashCents: 500000,
      expectedCashCents: 551750,
      countedCashCents: 551750 + varianceCents,
      varianceCents,
      cashInCents: 0,
      cashOutCents: 0,
      cashMovementCount: 0,
      noSaleOpens: 0,
      openingNote: null,
      closingNote: null,
      carriedUnpaidCount: 0,
      carryOverReason: null,
    });
    expect(shiftResultOf(null)).toBeNull();
    expect(shiftResultOf(0)).toEqual({ verdict: 'matched', words: 'Matched', paisa: null });
    expect(shiftResultOf(50)).toEqual({ verdict: 'matched', words: 'Matched', paisa: 'Paisa difference Rs 0.50' });
    expect(shiftResultOf(-99)).toEqual({ verdict: 'matched', words: 'Matched', paisa: 'Paisa difference Rs 0.99' });
    expect(shiftResultOf(-100)).toEqual({ verdict: 'short', words: 'Short Rs 1', paisa: null });
    expect(shiftResultOf(100)).toEqual({ verdict: 'over', words: 'Over Rs 1', paisa: null });
    expect(shiftResultOf(-10_050)).toEqual({ verdict: 'short', words: 'Short Rs 100.50', paisa: null });

    const shifts = [shift('s1', 50), shift('s2', -100)];
    const html = tabPrint('team', report({ shifts }));
    expect(html).toMatch(/Matched<br><span class="muted">Paisa difference Rs 0\.50<\/span><\/td><td class="r">0<\/td>/);
    expect(html).toMatch(/Short Rs 1<\/td><td class="r">0<\/td>/);
    const rows = tabCsv('team', report({ shifts })).split(/\r?\n/);
    expect(rows).toContainEqual(expect.stringMatching(/,5517\.50,5518\.00,0\.50,/));
    expect(rows).toContainEqual(expect.stringMatching(/,5517\.50,5516\.50,-1\.00,/));
  });

  it('the CSV has each shift’s opening and closing note in columns of their own; a shift with none leaves them empty', () => {
    const shift = (id: string, openingNote: string | null, closingNote: string | null) => ({
      id,
      openedAt: '2026-09-26T04:00:00.000Z',
      closedAt: '2026-09-26T16:00:00.000Z',
      openedBy: 'Sara',
      closedBy: 'Sara',
      openingCashCents: 500000,
      expectedCashCents: 600000,
      countedCashCents: 590000,
      varianceCents: -10000,
      cashInCents: 0,
      cashOutCents: 0,
      cashMovementCount: 0,
      noSaleOpens: 0,
      openingNote,
      closingNote,
      carriedUnpaidCount: 0,
      carryOverReason: null,
    });
    const csv = tabCsv('team', report({ shifts: [shift('s1', 'Morning, Ali on register', 'Rs 100 short, change given wrong'), shift('s2', null, null)] }));
    const rows = csv.split(/\r?\n/);
    // Right after the drawer columns (anything the sheet adds later comes after them).
    expect(rows).toContainEqual(expect.stringMatching(/,Cash in\/out entries,Drawer opened with no sale,Opening note,Closing note(,|$)/));
    expect(rows).toContainEqual(expect.stringMatching(/,-100\.00,0,0,"Morning, Ali on register","Rs 100 short, change given wrong"(,|$)/));
    expect(rows).toContainEqual(expect.stringMatching(/,-100\.00,0,0,,(,|$)/));
  });

  it('the shift CSV has the drawer log and deleted-test columns, in order, after the ones 0.7.21 shipped', () => {
    const shift = (id: string, more: Record<string, unknown>) => ({
      id,
      openedAt: '2026-09-26T04:00:00.000Z',
      closedAt: '2026-09-26T16:00:00.000Z',
      openedBy: 'Sara',
      closedBy: 'Sara',
      openingCashCents: 500000,
      expectedCashCents: 600000,
      countedCashCents: 600000,
      varianceCents: 0,
      cashInCents: 0,
      cashOutCents: 0,
      cashMovementCount: 0,
      noSaleOpens: 0,
      openingNote: null,
      closingNote: null,
      carriedUnpaidCount: 2,
      carryOverReason: 'Rider still out',
      ...more,
    });
    const csv = tabCsv(
      'team',
      report({
        shifts: [
          // Used 7 times; Rs 1,250 of its test orders deleted after it closed; 1 of the 2 it carried over later deleted as a test.
          shift('s1', { drawerOpenCount: 7, testDeletedCashCents: 125_000, carriedTestDeletedCount: 1 }),
          // A shift from before the drawer log / the test-order delete: the three cells stay empty.
          shift('s2', {}),
        ],
      } as never),
    );
    const rows = csv.split(/\r?\n/);
    // The header: 0.7.21's last two columns, then the three new ones, in this order; only
    // v0.7.35's "Counted by note" comes after them, last.
    expect(rows).toContainEqual(
      expect.stringMatching(
        /,Unpaid orders carried over,Carry-over reason,Drawer used \(all\),Test orders deleted after close Rs,"Carried over, later deleted as tests",Counted by note$/,
      ),
    );
    // Each shift's figures under them, in the same order (neither was counted by note: the last cell is empty).
    expect(rows).toContainEqual(expect.stringMatching(/,2,Rider still out,7,1250\.00,1,$/));
    expect(rows).toContainEqual(expect.stringMatching(/,2,Rider still out,,,,$/));
  });

  it('the shift CSV has "To riders Rs" right after "Cash taken out Rs", which is the rest of the cash taken out (v0.7.34)', () => {
    const shift = (id: string, more: Record<string, unknown>) => ({
      id,
      openedAt: '2026-09-26T04:00:00.000Z',
      closedAt: '2026-09-26T16:00:00.000Z',
      openedBy: 'Sara',
      closedBy: 'Sara',
      openingCashCents: 500000,
      expectedCashCents: 600000,
      countedCashCents: 600000,
      varianceCents: 0,
      cashInCents: 10_000,
      // All the cash taken out: Rs 50 typed by hand, Rs 30 of rider tips, and (s1) Rs 400 to outside riders.
      cashOutCents: 48_000,
      cashMovementCount: 2,
      noSaleOpens: 0,
      openingNote: null,
      closingNote: null,
      carriedUnpaidCount: 0,
      carryOverReason: null,
      ...more,
    });
    const csv = tabCsv(
      'team',
      report({
        shifts: [
          // Rs 200 kept by an outside rider and a Rs 200 trip paid.
          shift('s1', { riderChargesCents: 40_000 }),
          // A shift with no rider figure (before 0.7.34): all of it stays under Cash taken out.
          shift('s2', {}),
        ],
      } as never),
    );
    const rows = csv.split(/\r?\n/);
    // The header: the new column straight after the cash taken out, the rest as before.
    expect(rows).toContainEqual(
      expect.stringMatching(/,Float Rs,Cash put in Rs,Cash taken out Rs,To riders Rs,Expected Rs,Counted Rs,Short \(-\) \/ over \(\+\) Rs,Cash in\/out entries,/),
    );
    // s1: Rs 80 taken out (Rs 480 less the Rs 400 to riders), then Rs 400.
    expect(rows).toContainEqual(expect.stringMatching(/,5000\.00,100\.00,80\.00,400\.00,6000\.00,6000\.00,0\.00,2,0,/));
    // s2: Rs 480 taken out, nothing to riders.
    expect(rows).toContainEqual(expect.stringMatching(/,5000\.00,100\.00,480\.00,0\.00,6000\.00,6000\.00,0\.00,2,0,/));
  });

  it('a shift’s cash taken out in two parts: To riders, and Taken out = the rest (v0.7.34)', () => {
    expect(shiftCashOutParts({ cashOutCents: 48_000, riderChargesCents: 40_000 })).toEqual({ takenOutCents: 8_000, toRidersCents: 40_000 });
    // Only riders: nothing else was taken out.
    expect(shiftCashOutParts({ cashOutCents: 20_000, riderChargesCents: 20_000 })).toEqual({ takenOutCents: 0, toRidersCents: 20_000 });
    // No rider figure (a shift line from before 0.7.34), or none paid: everything under Taken out.
    expect(shiftCashOutParts({ cashOutCents: 20_000 })).toEqual({ takenOutCents: 20_000, toRidersCents: 0 });
    expect(shiftCashOutParts({ cashOutCents: 20_000, riderChargesCents: 0 })).toEqual({ takenOutCents: 20_000, toRidersCents: 0 });
  });

  it('the drawer counted by note (v0.7.35): first of a shift’s lines, first in the A4 Notes column, and the last column of the file', () => {
    // The owner's example, Rs 14,275: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and Rs 35 in coins.
    const counted: CashCount = {
      notes: [
        { faceCents: 500_000, count: 2 },
        { faceCents: 100_000, count: 3 },
        { faceCents: 50_000, count: 1 },
        { faceCents: 10_000, count: 7 },
        { faceCents: 5_000, count: 0 },
        { faceCents: 2_000, count: 0 },
        { faceCents: 1_000, count: 4 },
      ],
      otherCents: 3_500,
    };
    const NOTES = '5,000 × 2 · 1,000 × 3 · 500 × 1 · 100 × 7 · 10 × 4 · coins and other Rs 35';
    const shift = (id: string, more: Partial<ReportShiftLine>): ReportShiftLine => ({
      id,
      openedAt: '2026-09-26T04:00:00.000Z',
      closedAt: '2026-09-26T16:00:00.000Z',
      openedBy: 'Sara',
      closedBy: 'Sara',
      openingCashCents: 500000,
      expectedCashCents: 1_427_500,
      countedCashCents: 1_427_500,
      varianceCents: 0,
      cashInCents: 0,
      cashOutCents: 0,
      cashMovementCount: 0,
      noSaleOpens: 0,
      openingNote: 'Morning, Ali on register',
      closingNote: 'All good',
      carriedUnpaidCount: 1,
      carryOverReason: 'Rider still out',
      ...more,
    });
    const byNote = shift('s1', { countedNotes: counted });
    const typed = shift('s2', { countedNotes: null });

    expect(shiftCountedNotes(byNote)).toBe(NOTES);
    expect(shiftCountedNotesText(byNote)).toBe(`Counted by note: ${NOTES}`);
    // Typed as one figure, a line from a till before 0050 (no key), or nothing above 0: none.
    expect(shiftCountedNotesText(typed)).toBeNull();
    expect(shiftCountedNotesText({})).toBeNull();
    expect(shiftCountedNotesText({ countedNotes: { notes: counted.notes.map((n) => ({ ...n, count: 0 })), otherCents: 0 } })).toBeNull();
    // A newer till's row the list lacks (read leniently) still says itself.
    expect(shiftCountedNotes({ countedNotes: { notes: [{ faceCents: 7_500, count: 1 }], otherCents: 0 } })).toBe('75 × 1');

    // First of the shift's lines, then its notes and its carry-over as before.
    const after = ['Opening note: Morning, Ali on register', 'Closing note: All good', '1 unpaid order carried over — Rider still out — approved by Sara'];
    expect(shiftDetailLines(byNote)).toEqual([`Counted by note: ${NOTES}`, ...after]);
    expect(shiftDetailLines(typed)).toEqual(after);
    expect(shiftDetailLines(shift('s3', { openingNote: null, closingNote: null, carriedUnpaidCount: 0, countedNotes: counted }))).toEqual([
      `Counted by note: ${NOTES}`,
    ]);

    // The A4 paper: the Notes column, the count on the first line.
    const html = tabPrint('team', report({ shifts: [byNote, typed] }));
    expect(html).toContain(`<td>Counted by note: ${NOTES}<br>Opening note: Morning, Ali on register<br>Closing note: All good<br>1 unpaid order carried over`);
    expect(html).toContain('<td>Opening note: Morning, Ali on register<br>Closing note: All good<br>1 unpaid order carried over');
    expect(html.match(/Counted by note:/g)).toHaveLength(1);

    // The file: UTF-8 with its BOM, "Counted by note" the last column, the count quoted (it has commas); empty for the typed close.
    const csv = tabCsv('team', report({ shifts: [byNote, typed] }));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.split(/\r?\n/);
    expect(rows).toContainEqual(expect.stringMatching(/,"Carried over, later deleted as tests",Counted by note$/));
    expect(rows).toContainEqual(expect.stringMatching(new RegExp(`,1,Rider still out,,,,"${NOTES}"$`)));
    expect(rows).toContainEqual(expect.stringMatching(/,1,Rider still out,,,,$/));
    // The counted cash is the figure saved at close, in its own column, as before.
    expect(rows.filter((r) => r.includes(',5000.00,0.00,0.00,0.00,14275.00,14275.00,0.00,0,0,'))).toHaveLength(2);
  });

  it('says how many hand opens there were in all when it prints only some', () => {
    const many = Array.from({ length: 30 }, (_, i) => drawerOpen({ id: `d${i}` }));
    const period = periodFor('today', SAT_3PM);
    // More than fit on paper; the Excel file has them all.
    let html = tabPrint('team', report({ drawerOpens: many, drawerOpenCount: 30 }), period);
    expect(html).toContain('Cash drawer opened by hand (no sale, count, test) — 30 times');
    expect(html).toContain('Showing the latest 25 of 30. Download for Excel for the full list.');
    // The report itself stopped at its cap: say how many there really were.
    html = tabPrint('team', report({ drawerOpens: many, drawerOpenCount: 420 }), period);
    expect(html).toContain('Cash drawer opened by hand (no sale, count, test) — 420 times');
    expect(html).toContain('Showing the latest 25 of 420. Download for Excel for the latest 30.');
    // None: no section.
    expect(tabPrint('team', report(), period)).not.toContain('Cash drawer opened by hand');
  });
});

describe('stock after a cancel or refund', () => {
  it('says what happened to the stock, with rupees only when prices are set', () => {
    expect(stockCellText(null, true)).toBe('—');
    expect(stockCellText({ outcome: 'wasted', answer: 'made', wasteCents: 18_000, statusBefore: 'ready', flagged: false }, true)).toBe('Wasted · Rs 180');
    expect(stockCellText({ outcome: 'wasted', answer: 'made', wasteCents: 18_000, statusBefore: 'ready', flagged: false }, false)).toBe('Wasted');
    expect(stockCellText({ outcome: 'wasted', answer: 'made', wasteCents: 0, statusBefore: null, flagged: false }, true)).toBe('Wasted');
    expect(stockCellText({ outcome: 'returned', answer: 'not_made', wasteCents: 0, statusBefore: 'sent_to_kitchen', flagged: false }, true)).toBe('Put back');
    // Worth a look: put back after cooking was marked.
    expect(stockCellText({ outcome: 'returned', answer: 'not_made', wasteCents: 0, statusBefore: 'ready', flagged: true }, true)).toBe('Put back · was Ready');
    expect(stockCellText({ outcome: 'returned', answer: 'not_made', wasteCents: 0, statusBefore: 'preparing', flagged: true }, true)).toBe(
      'Put back · was being cooked',
    );
    // "Made", but only sealed drinks moved (back in the fridge): no false alarm.
    expect(stockCellText({ outcome: 'returned', answer: 'made', wasteCents: 0, statusBefore: 'ready', flagged: false }, true)).toBe(
      'Made · drinks put back',
    );
  });

  it('under the Wasted tile: how much of it came from cancelled orders', () => {
    expect(cancelledWasteText({ cancelledWasteCents: 54_000, cancelledOrderCount: 3, hasCosts: true })).toBe(
      'Rs 540 of it from 3 cancelled orders',
    );
    expect(cancelledWasteText({ cancelledWasteCents: 0, cancelledOrderCount: 1, hasCosts: false })).toBe('Some of it from 1 cancelled order');
  });

  it('the Excel file and the printout carry the Stock column', () => {
    const r = report({
      voids: [
        {
          orderId: 'o9',
          orderNumber: '20260926-0009',
          createdAt: '2026-09-26T09:00:00.000Z',
          voidedAt: '2026-09-26T09:10:00.000Z',
          amountCents: 100_000,
          reason: 'Not collected',
          approvedBy: 'Sara',
          takenBy: 'Ali',
          stock: { outcome: 'wasted', answer: 'made', wasteCents: 18_000, statusBefore: 'ready', flagged: false },
        },
      ],
      foodCost: food({
        wasteCents: 18_000,
        wasteByReason: [{ reason: 'cancelled_made', times: 1, cents: 18_000 }],
        cancelledWasteCents: 18_000,
        cancelledOrderCount: 1,
        hasCosts: true,
        hasUsage: true,
      }),
    });
    const csv = tabCsv('team', r);
    expect(csv).toContain('Cancelled,Order,Value Rs,Reason,Stock,Approved by,Taken by');
    expect(csv).toContain('Not collected,Wasted · Rs 180,Sara,Ali');
    const foodCsv = tabCsv('foodStock', r);
    expect(foodCsv).toContain('Of the waste: food made for cancelled orders,1,180.00');
    // Counted in orders (one here), not in its ingredient rows.
    expect(foodCsv).toContain('Reason,Times,Cost Rs');
    expect(foodCsv).toContain('Cancelled after cooking,1,180.00');
    expect(tabPrint('team', r)).toContain('<td>Wasted · Rs 180</td>');
    // A login without costs: its Team tab says "Wasted", no rupees.
    const noCosts = tabsOf(report({ ...r, foodCost: null, voids: r.voids.map((v) => ({ ...v, stock: v.stock && { ...v.stock, wasteCents: 0 } })) }));
    expect(buildTabCsv('team', noCosts.team!, periodFor('today', SAT_3PM), SAT_3PM)).toContain('Not collected,Wasted,Sara,Ali');
  });
});

describe('food cost, in plain words', () => {
  it('"costs known for 94% of sales": rounded down, never "100%" while one is missing', () => {
    expect(coverageText({ coverageBps: 9_460 })).toBe('costs known for 94% of sales');
    expect(coverageText({ coverageBps: 9_999 })).toBe('costs known for 99% of sales');
    expect(coverageText({ coverageBps: 10_000 })).toBe('costs known for all sales');
    expect(coverageText({ coverageBps: 40 })).toBe('costs known for under 1% of sales');
    expect(coverageText({ coverageBps: 0 })).toBe('no sale has a known cost yet');
    expect(coverageText({ coverageBps: null })).toBe('');
  });

  it('the headline, and the line that reconciles it with the Costing page', () => {
    expect(foodCostHeadline({ foodCostBps: 2_940, foodSalesCents: 1 })).toBe('Food cost 29.4% of food sales');
    expect(foodCostHeadline({ foodCostBps: null, foodSalesCents: 1 })).toBe('Food cost not known yet');
    expect(foodCostHeadline({ foodCostBps: null, foodSalesCents: 0 })).toBe('No food sales in this period');
    expect(menuPriceLine({ foodCostBps: 2_890, menuFoodCostBps: 2_710 })).toBe(
      'At menu prices 27.1% → after discounts 28.9% (discounts and refunds cost you 1.8 points)',
    );
    expect(menuPriceLine({ foodCostBps: 2_900, menuFoodCostBps: 2_900 })).toBe('');
  });

  it('estimated orders and when costs started being kept', () => {
    expect(estimatedText({ estimatedOrders: 212 })).toBe("Includes 212 orders estimated at the prices of the time.");
    expect(estimatedText({ estimatedOrders: 1 })).toBe("Includes 1 order estimated at the prices of the time.");
    expect(estimatedText({ estimatedOrders: 0 })).toBe('');
    expect(costingStartText('2026-10-03T07:00:00.000Z')).toBe(
      "From Sat 3 Oct 2026 every sale keeps its cost; older or unrecorded orders are estimated from what they took from stock at the prices of the time.",
    );
    expect(costingStartText(null)).toMatch(/^From the next order sent to the kitchen/);
  });

  it('waste reasons and missing-cost reasons have plain labels', () => {
    expect(WASTE_REASON_LABEL.cancelled_made).toBe('Cancelled after cooking');
    expect(WASTE_REASON_LABEL.staff_meal).toBe('Staff meal');
    expect(MISSING_COST_WHY.no_price).toBe('An ingredient has no price');
    expect(unpaidFoodText({ orderCount: 2, costCents: 54_000 })).toBe('2 orders · Rs 540');
    expect(unpaidFoodText({ orderCount: 0, costCents: 0 })).toBe('—');
  });

  it('the Excel file and the printout carry the food cost only when the report has it', () => {
    const period = periodFor('today', SAT_3PM);
    const withFood = report({
      foodCost: food({
        foodSalesCents: 100_000,
        costOfSalesCents: 30_000,
        knownSalesCents: 94_000,
        knownCostCents: 28_200,
        foodCostBps: 3_000,
        coverageBps: 9_400,
        estimatedOrders: 3,
        estimatedCostCents: 4_000,
        missingSales: [{ key: 'm9', name: 'Test Wings', why: 'no_recipe', quantity: 2, salesCents: 6_000 }],
        missingSalesCents: 6_000,
        hasCosts: true,
        hasUsage: true,
      }),
    });
    const csv = tabCsv('foodStock', withFood, period);
    expect(csv).toContain('FOOD COST (THIS TILL; SALES BEFORE TAX, AFTER DISCOUNTS)');
    expect(csv).toContain('Food cost (sales with a known cost),,,30%');
    expect(csv).toContain('Costs known for,,940.00,94%');
    expect(csv).toContain('Estimated at the prices of the time,3,40.00,');
    expect(csv).toContain('Test Wings,No recipe,2,60.00');
    const html = tabPrint('foodStock', withFood, period);
    expect(html).toContain('Food cost 30% of food sales');
    expect(html).toContain('costs known for 94% of sales');
    expect(html).toContain('Includes 3 orders estimated at the prices of the time.');

    // No other tab carries it, so a login without costs (no Food cost & stock tab) gets none.
    const without = report({ foodCost: null });
    for (const tab of ['overview', 'when', 'menu', 'channels', 'team'] as const) {
      expect(tabCsv(tab, without, period)).not.toContain('FOOD COST');
      expect(tabPrint(tab, without, period)).not.toContain('Food cost');
    }
    expect(buildPrintEverything(tabsOf(without), period, SAT_3PM)).not.toContain('Food cost');
  });
});

describe('Team & leakage in the file and on paper: the drawer log and the deleted test orders (0042 / 0043)', () => {
  const extras = {
    drawerLog: {
      rows: Array.from({ length: 30 }, (_, i) => ({
        id: `d${i}`,
        createdAt: new Date(Date.parse('2026-09-26T09:00:00.000Z') + i * 60_000).toISOString(),
        till: 'this' as const,
        kind: i === 0 ? 'refund' : 'sale',
        orderNumber: `20260926-${String(i).padStart(4, '0')}`,
        orderDeletedAsTest: i === 1,
        amountCents: i === 0 ? -20_000 : 125_000,
        reason: null,
        openedBy: 'Ali',
        approvedBy: i === 0 ? 'Sara' : null,
        outcome: i === 2 ? 'not_opened' : 'opened',
        outcomeNote: i === 2 ? 'The printer is off' : null,
        outsideShift: false,
        shiftId: 's1',
      })),
      counts: { total: 30, byKind: { sale: 29, refund: 1 }, byOutcome: { opened: 29, not_opened: 1 } },
      logSince: '2026-09-26T08:00:00.000Z',
    },
    deletedTests: {
      total: 1,
      totalCents: 125_000,
      rows: [
        {
          orderId: 'o9',
          orderNumber: '20260926-0099',
          mode: 'takeaway' as const,
          status: 'paid' as const,
          totalCents: 125_000,
          takenAt: '2026-09-26T09:30:00.000Z',
          takenBy: 'Ali',
          deletedAt: '2026-09-26T10:00:00.000Z',
          deletedBy: 'Owner',
          reason: 'Printer test',
          paidCents: 125_000,
          paidMethods: ['cash' as const],
          deleteStock: 'put_back' as const,
          wasteCents: 0,
          itemsSummary: '1× Test Pizza',
        },
      ],
    },
  };

  it('Excel: the whole log with its columns, and the deleted test orders', () => {
    const period = periodFor('today', SAT_3PM);
    const csv = buildTabCsv('team', tabsOf(report()).team as never, period, SAT_3PM, extras);
    expect(csv).toContain('CASH DRAWER LOG — USED 30 TIMES');
    expect(csv).toContain('When,Till,Why,Order,Cash Rs,By,Approved by,Result,Note');
    expect(csv).toContain(',This till,Refund — Order #0000,20260926-0000,-200.00,Ali,Sara,Opened,');
    expect(csv).toContain('Cash sale — Order #0001 (deleted test order)');
    expect(csv).toContain('Did not open — key used?,The printer is off');
    // All thirty, not only the latest few.
    expect(csv.split('\r\n').filter((l) => l.includes(',This till,'))).toHaveLength(30);
    expect(csv).toContain('DELETED TEST ORDERS — 1 (RS 1,250)');
    expect(csv).toContain('20260926-0099,1× Test Pizza');
    expect(csv).toContain('Printer test,1250.00,"Rs 1,250 Cash",Put back');
    // The hand-opened list keeps its own section, named for what it holds.
    expect(csv).toContain('CASH DRAWER OPENED BY HAND (NO SALE, COUNT, TEST)');
  });

  it('paper: the counts and the latest 25, and where the rest is', () => {
    const period = periodFor('today', SAT_3PM);
    const html = buildTabPrintBody('team', tabsOf(report()).team as never, period, SAT_3PM, extras);
    expect(html).toContain('Cash drawer log — used 30 times');
    expect(html).toContain('Cash sales 29 · Refunds 1 · Did not open 1');
    expect(html).toContain('The latest 25 of 30. The full log is in the Excel file.');
    expect(html.split('Cash sale — Order #').length - 1).toBe(24);
    expect(html).toContain('Test orders deleted — 1 (Rs 1,250)');
    // Print everything carries them too.
    expect(buildPrintEverything(tabsOf(report()), period, SAT_3PM, extras)).toContain('Cash drawer log — used 30 times');
    // Without them (not asked for) the tab still prints.
    expect(buildTabPrintBody('team', tabsOf(report()).team as never, period, SAT_3PM)).not.toContain('Cash drawer log');
  });

  it('a list that stopped short says "The latest X of N"; one that could not be read says so in its place', () => {
    const period = periodFor('today', SAT_3PM);
    const short = {
      drawerLog: { ...extras.drawerLog, counts: { ...extras.drawerLog.counts, total: 14_000 } },
      deletedTests: { ...extras.deletedTests, total: 700 },
    };
    const csv = buildTabCsv('team', tabsOf(report()).team as never, period, SAT_3PM, short);
    expect(csv).toContain('CASH DRAWER LOG — USED 14000 TIMES');
    expect(csv).toContain('The latest 30 of 14000 — narrow the dates for the rest.');
    expect(csv).toContain('The latest 1 of 700 — narrow the dates for the rest.');
    const paper = buildTabPrintBody('team', tabsOf(report()).team as never, period, SAT_3PM, short);
    expect(paper).toContain('The latest 25 of 14000. The Excel file holds the latest 30 — narrow the dates for the rest.');
    // The whole list: no such line.
    expect(buildTabCsv('team', tabsOf(report()).team as never, period, SAT_3PM, extras)).not.toContain('narrow the dates');

    const unread = { drawerLog: null, deletedTests: null };
    const csv2 = buildTabCsv('team', tabsOf(report()).team as never, period, SAT_3PM, unread);
    expect(csv2).toContain('CASH DRAWER LOG');
    expect(csv2).toContain('DELETED TEST ORDERS');
    expect(csv2.split(TEAM_EXTRA_UNREAD).length - 1).toBe(2);
    const paper2 = buildTabPrintBody('team', tabsOf(report()).team as never, period, SAT_3PM, unread);
    expect(paper2.split(TEAM_EXTRA_UNREAD).length - 1).toBe(2);
  });
});

describe('Team & leakage for paper and file: every page read, nothing dropped without a word', () => {
  const logPage = (n: number, from: number, nextCursor: string | null, total: number): DrawerLogPage => ({
    rows: Array.from({ length: n }, (_, i) => ({
      id: `d${from + i}`,
      createdAt: '2026-09-26T09:00:00.000Z',
      till: 'this' as const,
      kind: 'sale',
      orderNumber: null,
      orderDeletedAsTest: false,
      amountCents: 100,
      reason: null,
      openedBy: 'Ali',
      approvedBy: null,
      outcome: 'opened' as const,
      outcomeNote: null,
      outsideShift: false,
      shiftId: 's1',
    })),
    nextCursor,
    counts: { total, byKind: { sale: total }, byOutcome: { opened: total } },
    logSince: null,
  });
  const period = { sinceIso: '2026-01-01T00:00:00.000Z', untilIso: '2027-01-01T00:00:00.000Z' };
  const noTests = () => Promise.resolve({ rows: [], total: 0, totalCents: 0 });

  it('reads the drawer log to the end (a year is more than 10,000 opens) and the deleted tests past 500', async () => {
    const cursors: Array<string | undefined> = [];
    const pages = 72; // 14,400 opens at 200 a read
    const got = await fetchTeamExtras(period, {
      drawerLog: (q) => {
        cursors.push(q.cursor);
        const i = cursors.length - 1;
        return Promise.resolve(logPage(200, i * 200, i + 1 < pages ? `c${i + 1}` : null, pages * 200));
      },
      deletedTests: (q) =>
        Promise.resolve({
          rows: Array.from({ length: Math.min(q.limit, 700 - q.offset) }, (_, i) => ({ orderId: `o${q.offset + i}` }) as never),
          total: 700,
          totalCents: 70_000,
        }),
    });
    expect(got.failed).toEqual([]);
    expect(got.drawerLog?.rows).toHaveLength(14_400);
    expect(cursors.slice(0, 3)).toEqual([undefined, 'c1', 'c2']);
    expect(got.deletedTests).toMatchObject({ total: 700, totalCents: 70_000 });
    expect(got.deletedTests?.rows).toHaveLength(700);
  });

  it('a read that fails is named (for the screen) and left null (for the file); a stuck cursor stops', async () => {
    const got = await fetchTeamExtras(period, {
      drawerLog: () => Promise.reject(new Error('Sign in again')),
      deletedTests: () => Promise.reject(new Error('Sign in again')),
    });
    expect(got).toEqual({ drawerLog: null, deletedTests: null, failed: ['the cash drawer log', 'the deleted test orders'] });
    expect(teamExtrasFailedText(got.failed)).toBe(
      'Could not read the cash drawer log or the deleted test orders; the paper or file says so where the list would be. Try again in a moment.',
    );
    expect(teamExtrasFailedText([])).toBeNull();

    let reads = 0;
    const stuck = await fetchTeamExtras(period, {
      drawerLog: () => {
        reads += 1;
        return Promise.resolve(logPage(200, 0, 'same', 5_000));
      },
      deletedTests: noTests,
    });
    expect(reads).toBe(2);
    expect(stuck.drawerLog?.rows).toHaveLength(400);
  });
});

describe('the automatic offers on paper and in the file, as on the screen (review 28 Sep)', () => {
  const period = periodFor('today', SAT_3PM);
  const r = report();
  const tabs = tabsOf(r);
  const channels = {
    ...tabs.channels!,
    cameBy: [
      { cameBy: 'whatsapp' as const, orderCount: 3, netSalesCents: 60_000, offerCount: 3, offerCents: 6_000 },
      { cameBy: 'not_asked' as const, orderCount: 1, netSalesCents: 20_000, offerCount: 0, offerCents: 0 },
    ],
  };
  const team = {
    ...tabs.team!,
    staff: [{ ...r.staff[0]!, counterOrders: 4, phoneOrWhatsapp: 3, offerCount: 3, offerCents: 6_000, flags: ['phone_share' as const] }],
    offerCheck: { counterOrders: 10, phoneOrWhatsapp: 3, offerOrders: 3, offerCents: 6_000, phoneShareBps: 3_000, offerCentsPerOrder: 600, factorPct: 150, minMarked: 2 },
    offerRepeats: [{ day: '2026-09-26', offerName: 'Test once a day', phoneEnds: '4567', orderNumbers: ['20260926-0003', '20260926-0009'], amountCents: 4_000 }],
    discounts: {
      ...r.discounts,
      totalCount: 2,
      totalCents: 5_000,
      byReason: [{ reason: 'Staff', count: 1, amountCents: 1_000 }],
      byPerson: [{ name: 'Test Cashier', count: 1, amountCents: 1_000, approvedCount: 0 }],
      standing: [{ name: 'Test WhatsApp 10% (automatic offer)', count: 2, amountCents: 4_000 }],
    },
  };

  it('Channels: "How orders came in" prints too', () => {
    const html = buildTabPrintBody('channels', channels as never, period, SAT_3PM);
    expect(html).toContain('<h2>How orders came in</h2>');
    expect(html).toContain('WhatsApp');
    expect(html).toContain('Not asked');
  });

  it('Team & leakage: "Came by & offers" with its flag and note, the once-a-day repeats, and the standing offers apart from who gave discounts', () => {
    const html = buildTabPrintBody('team', team as never, period, SAT_3PM);
    expect(html).toContain('<h2>Came by &amp; offers</h2>');
    expect(html).toContain('<b>Phone / WhatsApp</b>');
    expect(html).toContain('on at least 2 such orders');
    expect(html).toContain('<h2>Once a customer a day, given more than once</h2>');
    expect(html).toContain('ends 4567');
    expect(html).toContain('20260926-0003, 20260926-0009');
    // The automatic offer is not listed under "Given by" with the staff.
    const who = html.slice(html.indexOf('<h2>Discounts — who</h2>'), html.indexOf('<h2>Standing offers</h2>'));
    expect(who).toContain('Test Cashier');
    expect(who).not.toContain('automatic offer');
    expect(html.slice(html.indexOf('<h2>Standing offers</h2>'))).toContain('Test WhatsApp 10% (automatic offer)');

    const csv = buildTabCsv('team', team as never, period, SAT_3PM);
    expect(csv).toContain('ONCE A CUSTOMER A DAY, GIVEN MORE THAN ONCE');
    expect(csv).toContain('2026-09-26,Test once a day,ends 4567,"20260926-0003, 20260926-0009",40.00');
    expect(csv).toContain('Taken by,Orders asked,Phone or WhatsApp,With an offer,Offers took off Rs,Flag');
  });
});
