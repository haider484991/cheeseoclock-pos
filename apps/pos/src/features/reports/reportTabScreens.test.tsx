/**
 * The Reports tabs render what their channel sends (costing spec Phase 3):
 * a smoke render (react-dom/server, no browser) of each tab with made-up
 * figures, and the Team tab as a login without costs sees it. Nothing calls
 * the till. Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ReportFoodCost, ReportKpis, ReportPurchases, ReportTabData, ReportTrends } from '@cheeseoclock/shared-types';
import { periodFor } from './dateRange';
import { OverviewTab } from './tabs/OverviewTab';
import { WhenTab } from './tabs/WhenTab';
import { MenuTab } from './tabs/MenuTab';
import { ChannelsTab } from './tabs/ChannelsTab';
import { FoodCostStockTab } from './tabs/FoodCostStockTab';
import { TeamLeakageTab } from './tabs/TeamLeakageTab';
import { DayNotesPanel, type DayNoteEditor } from './tabs/WhenExtras';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');
const base = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z', engine: 'worker' as const };
const NO_PURCHASES: ReportPurchases = { spendCents: 0, bills: 0, bySupplier: [], byIngredient: [], byHandCents: 0, byHandEntries: 0 };

const kpis: ReportKpis = {
  orderCount: 3,
  itemCount: 4,
  menuSalesCents: 300_000,
  discountCents: 0,
  discountedOrderCount: 0,
  taxCents: 0,
  billedCents: 300_000,
  partialRefundCents: 0,
  partialRefundOrderCount: 0,
  netSalesCents: 300_000,
  avgOrderCents: 100_000,
  fullRefundCount: 0,
  fullRefundCents: 0,
  voidCount: 1,
  voidCents: 80_000,
  unpaidCount: 0,
  unpaidCents: 0,
  payments: { cash: 200_000, card: 0, foodpanda: 0, transfer: 100_000 },
  unrecordedPaymentCents: 0,
};

const food: ReportFoodCost = {
  foodSalesCents: 290_000,
  feeSalesCents: 10_000,
  costOfSalesCents: 87_000,
  knownSalesCents: 290_000,
  knownCostCents: 87_000,
  foodCostBps: 3_000,
  knownMenuSalesCents: 290_000,
  menuFoodCostBps: 3_000,
  coverageBps: 10_000,
  estimatedOrders: 0,
  estimatedCostCents: 0,
  costingStartedAt: '2026-09-20T07:00:00.000Z',
  missingSales: [],
  missingSalesCents: 0,
  wasteCents: 18_000,
  wasteByReason: [{ reason: 'cancelled_made', times: 1, cents: 18_000 }],
  wasteIngredients: [],
  cancelledWasteCents: 18_000,
  cancelledOrderCount: 1,
  putBackAfterCookingCount: 0,
  sentNotPaid: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  stillOpen: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  hasCosts: true,
  hasUsage: true,
};

const team = (withCosts: boolean): ReportTabData['team'] => ({
  ...base,
  kpis: { netSalesCents: 300_000, menuSalesCents: 300_000, partialRefundCents: 0, fullRefundCents: 0, voidCount: 1, voidCents: 80_000 },
  staff: [{ key: 'u1', name: 'Ali', isWebsite: false, orderCount: 3, netSalesCents: 300_000, discountCents: 0, voidCount: 1, noSaleOpens: 0, reprints: 0 }],
  shifts: [],
  discounts: { totalCount: 0, totalCents: 0, byReason: [], byPerson: [], recent: [] },
  refunds: [],
  voids: [
    {
      orderId: 'o9',
      orderNumber: '20260926-0009',
      createdAt: '2026-09-26T09:00:00.000Z',
      voidedAt: '2026-09-26T09:10:00.000Z',
      amountCents: 80_000,
      reason: 'Not collected',
      approvedBy: 'Sara',
      takenBy: 'Ali',
      stock: { outcome: 'wasted', answer: 'made', wasteCents: withCosts ? 18_000 : 0, statusBefore: 'ready', flagged: false },
      billPrinted: false,
    },
  ],
  drawerOpens: [],
  drawerOpenCount: 0,
  foodCost: withCosts ? { hasCosts: true } : null,
});

// Team & leakage reads its drawer log and deleted test orders itself (nothing is fetched in a static render).
const queries = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={queries}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('the Reports tabs render their own figures', () => {
  it('Overview: the headline, how customers paid, and website vs till', () => {
    const out = html(
      <OverviewTab
        data={{
          ...base,
          kpis,
          previous: null,
          channels: [
            { channel: 'takeaway', orderCount: 2, netSalesCents: 200_000 },
            { channel: 'web_delivery', orderCount: 1, netSalesCents: 100_000 },
          ],
        }}
      />,
    );
    expect(out).toContain('How customers paid');
    expect(out).toContain('Website vs till');
    expect(out).toContain('Website (pick-up and delivery)');
    // While the first figures load, the tiles are there (loading).
    expect(html(<OverviewTab data={undefined} />)).toContain('Average order');
  });

  it('Overview, Phase 7: the trend strip and the 12 months; each month’s food cost only when sent', () => {
    const figures = (net: number, orders: number) => ({ netSalesCents: net, orderCount: orders, avgOrderCents: Math.round(net / orders) });
    const span = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-26T10:00:00.000Z' };
    const trends: ReportTrends = {
      nowIso: '2026-09-26T10:00:00.000Z',
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
      recentDays: Array.from({ length: 56 }, (_, i) => ({ day: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, orderCount: 1, netSalesCents: 10_000 + i })),
      months: ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) => ({
        month,
        sinceIso: `${month}-01T00:00:00.000Z`,
        untilIso: `${month}-28T00:00:00.000Z`,
        netSalesCents: i < 3 ? 0 : 1_000_000 + i,
        orderCount: i < 3 ? 0 : 10,
        avgOrderCents: i < 3 ? 0 : 100_000,
        hadData: i > 3,
      })),
      monthCosts: null,
      partial: false,
    };
    const lean = html(<OverviewTab data={undefined} trends={{ data: trends, error: null }} />);
    expect(lean).toContain('How the shop is trending');
    expect(lean).toContain('Today so far');
    expect(lean).toContain('vs same day last week');
    expect(lean).toContain('▲ 33%');
    expect(lean).toContain('No data then');
    expect(lean).toContain('The last 12 months');
    expect(lean).not.toContain('food cost');
    const withCosts = html(
      <OverviewTab
        data={undefined}
        trends={{ data: { ...trends, monthCosts: trends.months.map((m) => ({ month: m.month, foodCostBps: 2_910, coverageBps: 9_000 })) }, error: null }}
      />,
    );
    expect(withCosts).toContain('Food cost as Food cost &amp; stock works it out.');
    expect(withCosts).toContain('29.1%');
    // Every month's figures on the screen itself (a touch screen has no hover), newest first, this month "so far".
    expect(lean).toContain('<th');
    expect(lean.lastIndexOf('Sep 2026')).toBeLessThan(lean.lastIndexOf('Aug 2026'));
    expect(lean).toContain(' · so far');
    expect(lean).toContain(' · no data then');
    expect(lean).toContain('Rs 10,000.11');
    expect(lean).toContain('This month is so far (the hollow bar).');
    // Worked out on the till itself: it says so.
    expect(html(<OverviewTab data={undefined} trends={{ data: { ...trends, partial: true, months: [] }, error: null }} />)).toContain('only stretches of 31 days or less');
  });

  it('When, Menu, Channels & delivery', () => {
    // A week: the heatmap shows once it averages a week of whole days or more.
    const period = periodFor('last7', SAT_3PM);
    const whenData: ReportTabData['when'] = {
      ...base,
      kpis: { orderCount: 3, netSalesCents: 300_000 },
      byDay: [{ day: '2026-09-26', orderCount: 3, netSalesCents: 300_000 }],
      byHour: [{ hour: 20, orderCount: 3, netSalesCents: 300_000 }],
      // Costing spec Phase 7: weekday × hour, the parts of the day, notes on days.
      heatmap: {
        dayCounts: [1, 1, 1, 1, 1, 1, 1],
        closedDays: 0,
        hours: [20],
        cells: [0, 1, 2, 3, 4, 5, 6].map((w) => ({
          weekday: w,
          hour: 20,
          orderCount: w === 5 ? 3 : 0,
          netSalesCents: w === 5 ? 300_000 : 0,
          avgNetSalesCents: w === 5 ? 300_000 : 0,
          avgOrdersTenths: w === 5 ? 30 : 0,
        })),
      },
      dayparts: {
        lines: [
          { name: 'Lunch', fromHour: 12, toHour: 15, orderCount: 0, netSalesCents: 0, avgOrderCents: 0, shareBps: 0 },
          { name: 'Dinner', fromHour: 19, toHour: 22, orderCount: 3, netSalesCents: 300_000, avgOrderCents: 100_000, shareBps: 10_000 },
        ],
        other: null,
        isDefault: true,
      },
      dayNotes: [{ id: 'n1', day: '2026-09-26', tag: 'rain', note: 'Heavy rain after 8', excludeFromForecast: false, addedBy: 'Test Manager', createdAt: '2026-09-26T16:00:00.000Z' }],
    };
    const when = html(<WhenTab data={whenData} period={period} now={SAT_3PM} />);
    expect(when).toContain('When you sell');
    expect(when).toContain('An average day, by weekday and hour');
    // Every square can be tapped for its figures, and the shading has its key.
    expect(when).toContain('Tap a square to see its figures.');
    expect(when).toContain('aria-label="Sat 8 pm: Rs 3,000 and 3 orders on an average Saturday (1 of them counted)"');
    expect(when).toMatch(/Quiet.*Busy/);
    // "Last 7 days" with today left out until it is over: six whole days, too few for an average weekday.
    const short = html(
      <WhenTab data={{ ...whenData, heatmap: { ...whenData.heatmap, dayCounts: [1, 1, 1, 1, 1, 0, 1] } }} period={period} now={SAT_3PM} />,
    );
    expect(short).not.toContain('Tap a square');
    expect(short).toContain('This needs a week of whole days. Today is left out until it is over');
    expect(when).toContain('Parts of the day');
    expect(when).toContain('7 pm – 10:59 pm');
    expect(when).toContain('Rain · Heavy rain after 8');
    const menu = html(
      <MenuTab
        data={{
          ...base,
          kpis: { menuSalesCents: 300_000, itemCount: 4 },
          items: [{ key: 'm1', name: 'Test Pizza', categoryId: 'c1', categoryName: 'Pizzas', quantity: 4, salesCents: 300_000 }],
          categories: [{ categoryId: 'c1', name: 'Pizzas', quantity: 4, salesCents: 300_000 }],
          costs: null,
        }}
      />,
    );
    expect(menu).toContain('What sells');
    expect(menu).toContain('Test Pizza');
    const channels = html(
      <ChannelsTab
        data={{
          ...base,
          kpis: { orderCount: 3, netSalesCents: 300_000, avgOrderCents: 100_000 },
          channels: [{ channel: 'delivery', orderCount: 3, netSalesCents: 300_000 }],
          deliveries: { byRider: [{ riderId: 'r1', name: 'Bilal', deliveries: 3, netSalesCents: 300_000, avgMinutesOut: 25 }], byArea: [] },
          areas: [],
          noRateDeliveries: [],
          noRateCount: 0,
          profit: null,
        }}
      />,
    );
    expect(channels).toContain('Where orders come from');
    expect(channels).toContain('Bilal');
  });

  it('Channels & delivery: the deliveries say they cover own riders and outside riders sent out, and list them on their own line (v0.7.34)', () => {
    const out = html(
      <ChannelsTab
        data={{
          ...base,
          kpis: { orderCount: 3, netSalesCents: 300_000, avgOrderCents: 100_000 },
          channels: [{ channel: 'delivery', orderCount: 3, netSalesCents: 300_000 }],
          deliveries: {
            byRider: [
              { riderId: null, name: 'Outside riders (sent out)', deliveries: 2, netSalesCents: 200_000, avgMinutesOut: 30 },
              { riderId: 'r1', name: 'Bilal', deliveries: 1, netSalesCents: 100_000, avgMinutesOut: 25 },
            ],
            byArea: [],
          },
          areas: [],
          noRateDeliveries: [],
          noRateCount: 0,
          profit: null,
        }}
      />,
    );
    expect(out).toContain('Phone and website deliveries — your own riders and outside riders you sent out. Foodpanda brings its own.');
    expect(out).not.toContain('Your own riders — phone and website deliveries.');
    expect(out).toContain('Outside riders (sent out)');
    expect(out).toContain('Bilal');
  });

  it('Food cost & stock, and the ingredients running low', () => {
    const out = html(<FoodCostStockTab data={{ ...base, kpis: { partialRefundCents: 0 }, foodCost: food, purchases: NO_PURCHASES }} lowStockCount={2} />);
    expect(out).toContain('Food cost');
    expect(out).toContain('30%');
    expect(out).toContain('2 ingredients are running low right now.');
    expect(out).toContain('No stock bought in this period.');
  });

  it('Food cost & stock: purchases by supplier and by ingredient, with the price change (made-up figures)', () => {
    const purchases: ReportPurchases = {
      spendCents: 1_300_000,
      bills: 3,
      byHandCents: 50_000,
      byHandEntries: 2,
      bySupplier: [
        { key: 's1', from: 'supplier', name: 'Test Dairy', bills: 2, spendCents: 1_000_000 },
        { key: 'no_supplier', from: 'no_supplier', name: 'No supplier named', bills: 1, spendCents: 250_000 },
        { key: 'by_hand', from: 'by_hand', name: 'Booked in by hand (no bill)', bills: 0, spendCents: 50_000 },
      ],
      byIngredient: [
        { ingredientId: 'i1', name: 'Test cheese', unit: 'g', qty: 8_000, times: 2, spendCents: 1_000_000, lastUnitCostMc: 125_000, prevUnitCostMc: 112_500 },
        { ingredientId: 'i2', name: 'Test onion', unit: 'g', qty: 10_000, times: 1, spendCents: 250_000, lastUnitCostMc: 25_000, prevUnitCostMc: null },
      ],
    };
    const out = html(<FoodCostStockTab data={{ ...base, kpis: { partialRefundCents: 0 }, foodCost: food, purchases }} lowStockCount={0} />);
    expect(out).toContain('Rs 13,000 spent on stock, 3 bills.');
    expect(out).toContain('Test Dairy');
    expect(out).toContain('No supplier named');
    expect(out).toContain('Rs 1,250 / kg');
    expect(out).toContain('▲ 11.1%');
    expect(out).toContain('Rs 500 of it was stock booked in by hand 2 times, with no bill');
    expect(out).toContain('Booked in by hand (no bill)');
  });

  it('Team & leakage: waste rupees on the Stock column only for a login with costs', () => {
    const withCosts = html(<TeamLeakageTab data={team(true)} />);
    expect(withCosts).toContain('Staff and cash drawer');
    expect(withCosts).toContain('Refunds and cancelled orders');
    expect(withCosts).toContain('Wasted · Rs 180');
    const without = html(<TeamLeakageTab data={team(false)} />);
    expect(without).toContain('Wasted');
    expect(without).not.toContain('Rs 180');
  });
});

describe('notes on days (When)', () => {
  const editor = (defaultDay: string): DayNoteEditor => ({
    add: () => Promise.resolve(true),
    remove: () => Promise.resolve(true),
    busy: false,
    defaultDay,
    maxDay: '2027-09-30',
  });
  const note = { id: 'n1', day: '2026-09-25', tag: 'closed' as const, note: 'Eid', excludeFromForecast: true, addedBy: 'Test Owner', createdAt: '2026-09-25T10:00:00.000Z' };
  const lastWeek = { firstDay: '2026-09-21', lastDay: '2026-09-27' };

  it('taking a note off asks first, on the screen (no one-tap removal), with a finger-sized button', () => {
    const out = html(<DayNotesPanel notes={[note]} editor={editor('2026-09-27')} period={lastWeek} />);
    expect(out).toMatch(/<button[^>]*class="[^"]*h-10 w-10[^"]*"[^>]*aria-label="Take off the note for Fri 25 Sep 2026"/);
    // The question and its buttons come only after the tap on the bin.
    expect(out).not.toContain('Take this note off?');
    expect(out).not.toContain('Take it off');
  });

  it('a day outside the dates picked above: the form says the note is kept, and where it shows', () => {
    expect(html(<DayNotesPanel notes={[]} editor={editor('2026-09-27')} period={lastWeek} />)).not.toContain('is not in the dates picked above');
    expect(html(<DayNotesPanel notes={[]} editor={editor('2026-10-20')} period={lastWeek} />)).toContain(
      'Tue 20 Oct 2026 is not in the dates picked above. The note is kept, and shows here when you pick dates that include it.',
    );
  });
});
