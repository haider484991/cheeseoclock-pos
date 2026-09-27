/**
 * Profit on screen, on paper and in the file (costing spec Phase 9), with
 * made-up figures and no till: the plain words (profitFormat); the Profit
 * tab only for profit.view; the waterfall, what each order type earns and
 * the menu map rendered; and — a login without profit.view — Menu, Channels
 * and the weekly sheet with no profit column on screen, in the CSV or on
 * paper (the main process leaves the figures out; paper and file follow the
 * data). Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  OwnerWeek,
  ReportChannelsTab,
  ReportLineCost,
  ReportMenuMap,
  ReportMenuTab,
  ReportProfitTab,
} from '@cheeseoclock/shared-types';
import { periodFor, stockTakesPeriod } from './dateRange';
import { buildPrintEverything, buildTabCsv, buildTabPrintBody } from './exporters';
import { tabRequest, visibleReportTabs } from './reportTabs';
import { buildWeeklySheet } from './WeeklySheet';
import {
  PROFIT_STEP_LABEL,
  stepLabel,
  stockGainNote,
  breakEvenText,
  commissionText,
  menuMapAdvice,
  profitHeadline,
  riderText,
  unknownCostNote,
  weekText,
} from './profitFormat';
import { ProfitTab } from './tabs/ProfitTab';
import { MenuTab, type MenuMapView } from './tabs/MenuTab';
import { ChannelsTab } from './tabs/ChannelsTab';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');
const base = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z', engine: 'worker' as const };
const period = periodFor('today', SAT_3PM);
const html = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const FEES = {
  foodpanda: { v: 1, commissionBps: 2500, confirmed: false, base: 'after_deal' as const, fixedFeeCents: 0, commissionTaxBps: 0, upliftBps: 0, paymentFeeBps: 0 },
  paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 },
};

const PROFIT: ReportProfitTab = {
  ...base,
  steps: [
    { key: 'sales', cents: 1_000_000 },
    { key: 'food_cost', cents: -280_000 },
    { key: 'unknown_cost', cents: -60_000 },
    { key: 'waste', cents: -12_000 },
    { key: 'sent_not_paid', cents: -3_000 },
    { key: 'commission', cents: -25_000 },
    { key: 'payment_fees', cents: 0 },
    { key: 'rider', cents: -40_000 },
  ],
  profitCents: 580_000,
  wasteByReason: [{ reason: 'burnt', times: 2, cents: 12_000 }],
  sentNotPaid: { orderCount: 1, costCents: 3_000, estimatedOrders: 0 },
  stockLoss: { state: 'not_between', cents: null, scopes: null, message: 'Stock that went missing is taken off only for "Between stock takes", when both were full counts.' },
  channels: [
    {
      channel: 'delivery',
      orderCount: 4,
      salesCents: 500_000,
      feeSalesCents: 40_000,
      knownFoodSalesCents: 460_000,
      foodCostCents: 140_000,
      unknownSalesCents: 0,
      commissionCents: 0,
      upliftCents: 0,
      paymentFeeCents: 0,
      riderCents: 80_000,
      setAsideCents: 0,
      contributionCents: 280_000,
      contributionPerOrderCents: 70_000,
    },
    {
      channel: 'foodpanda',
      orderCount: 2,
      salesCents: 100_000,
      feeSalesCents: 0,
      knownFoodSalesCents: 100_000,
      foodCostCents: 30_000,
      unknownSalesCents: 0,
      commissionCents: 25_000,
      upliftCents: 0,
      paymentFeeCents: 0,
      riderCents: 0,
      setAsideCents: 0,
      contributionCents: 45_000,
      contributionPerOrderCents: 22_500,
    },
  ],
  categories: [
    { categoryId: 'c1', name: 'Pizza', units: 10, salesCents: 800_000, knownUnits: 10, knownSalesCents: 800_000, costCents: 240_000, foodCostBps: 3_000, coverageBps: 10_000, profitCents: 560_000, profitPerSaleCents: 56_000 },
  ],
  unknownSalesCents: 60_000,
  coverageBps: 9_400,
  estimatedOrders: 0,
  costingStartedAt: '2026-09-20T07:00:00.000Z',
  fees: FEES,
  riderCost: { mode: 'zone_rate', fixedCents: 0 },
  noRateCount: 1,
};

describe('profit in plain words (costing spec D15)', () => {
  it('the waterfall, its headline and the notes under it', () => {
    expect(PROFIT_STEP_LABEL.unknown_cost).toBe('Sales with an unknown cost (left out)');
    expect(profitHeadline(PROFIT)).toBe('Profit before overheads: Rs 5,800 — 58% of sales.');
    expect(profitHeadline({ ...PROFIT, profitCents: -5_000 })).toBe('Before overheads this period lost Rs 50.');
    expect(unknownCostNote(PROFIT)).toBe(
      'Rs 600 of sales have an unknown cost (no recipe, or an ingredient with no price): they are left out of the profit, never counted as free. Costs are known for 94% of food sales.',
    );
    expect(unknownCostNote({ ...PROFIT, unknownSalesCents: 0, steps: PROFIT.steps.map((s) => (s.key === 'unknown_cost' ? { ...s, cents: 0 } : s)) })).toBeNull();
    // What went with those sales on their orders (commission, rider…) is left out with them, and the note says so.
    expect(unknownCostNote({ ...PROFIT, steps: PROFIT.steps.map((s) => (s.key === 'unknown_cost' ? { ...s, cents: -45_000 } : s)) })).toBe(
      "Rs 600 of sales have an unknown cost (no recipe, or an ingredient with no price): they are left out of the profit, with their share of their orders' commission, delivery charges, rider and card fees, never counted as free. Costs are known for 94% of food sales.",
    );
  });

  it('the stock-loss step says which way the stock went', () => {
    expect(stepLabel('stock_loss', -18_000)).toBe('Stock that went missing');
    // More on the shelves than the till expected adds to profit: said as such, with the usual cause.
    expect(stepLabel('stock_loss', 400_000)).toBe('More stock on the shelves than expected');
    const gained = { ...PROFIT, stockLoss: { state: 'counted' as const, cents: -400_000, scopes: { from: 'full' as const, to: 'full' as const }, message: null } };
    expect(stockGainNote(gained)).toBe(
      'The stock takes found Rs 4,000 more on the shelves than the till expected. The usual cause is a delivery that was not recorded as a purchase: until it is, this profit is too high.',
    );
    expect(stockGainNote({ ...gained, stockLoss: { ...gained.stockLoss, cents: 18_000 } })).toBeNull();
    expect(stockGainNote(PROFIT)).toBeNull();
    const withGain = { ...gained, steps: [...PROFIT.steps.slice(0, 5), { key: 'stock_loss' as const, cents: 400_000 }, ...PROFIT.steps.slice(5)], profitCents: 980_000 };
    const out = html(<ProfitTab data={withGain} />);
    expect(out).toContain('More stock on the shelves than expected');
    expect(out).not.toContain('Stock that went missing');
    expect(out).toContain('a delivery that was not recorded as a purchase');
    expect(buildTabCsv('profit', withGain, period, SAT_3PM)).toContain('More stock on the shelves than expected,4000.00');
    expect(buildTabPrintBody('profit', withGain, period, SAT_3PM)).toContain('More stock on the shelves than expected');
  });

  it('the waterfall wraps its long labels rather than cutting the words in brackets off, and carries them whole as a tooltip', () => {
    const out = html(<ProfitTab data={PROFIT} />);
    expect(out).toContain('title="Sales with an unknown cost (left out)"');
    expect(out).not.toMatch(/class="[^"]*truncate[^"]*"[^>]*>Sales with an unknown cost/);
  });

  it('foodpanda and the rider, as the owner answered (or the defaults)', () => {
    expect(commissionText(FEES)).toBe(
      'foodpanda commission: 25% (not confirmed yet) of the food after your part of the deal, before tax. foodpanda orders are at till prices. Orders paid with a confirmed commission keep the terms they were paid with; the rest use these (Settings → foodpanda).',
    );
    const typed = { v: 1, commissionBps: 2200, confirmed: true, base: 'before_deal' as const, fixedFeeCents: 2_500, commissionTaxBps: 1_600, upliftBps: 1000, paymentFeeBps: 0 };
    expect(commissionText({ foodpanda: typed })).toBe(
      "foodpanda commission: 22% of the food before the deal, before tax, plus Rs 25 an order and 16% tax on the commission. foodpanda's menu is 10% above the till's: the difference is its own line, and the commission is on the dearer price. Orders paid with a confirmed commission keep the terms they were paid with; the rest use these (Settings → foodpanda).",
    );
    // foodpanda's fee on the total (Settings → foodpanda; v0.7.20's "Foodpanda" payment fee) is said with the rest.
    expect(commissionText({ foodpanda: { ...typed, paymentFeeBps: 200 } })).toContain("plus Rs 25 an order, 16% tax on the commission and 2% of each order's total.");
    expect(riderText({ mode: 'zone_rate', fixedCents: 0 })).toContain("the rider service's rate for each area");
    expect(riderText({ mode: 'fixed', fixedCents: 15_000 })).toBe('Rider cost: Rs 150 a trip.');
  });

  it('break-even and per week (costing spec 4.8, 4.9)', () => {
    expect(breakEvenText(-2_500)).toBe('Sales could fall 25% before this earns less than now');
    expect(breakEvenText(5_000)).toBe('Sales must grow 50% to earn as much as now');
    expect(breakEvenText(null)).toBe('No amount of extra sales makes up for this price');
    expect(weekText(100_000)).toBe('+Rs 1,000 a week');
    expect(weekText(-40_000)).toBe('−Rs 400 a week');
  });

  it('the menu map in the owner\'s words, the textbook term only beside it', () => {
    expect(menuMapAdvice({ class: 'plowhorse', belowAverageCents: 5_500, raiseToAverageCents: 6_000 }, 'Pizza')).toBe(
      'Popular, low profit: earns Rs 55 less than your average pizza; Rs 60 more on the price, or Rs 60 less cost, brings it to your average.',
    );
    expect(menuMapAdvice({ class: 'star', belowAverageCents: null, raiseToAverageCents: null }, 'Pizza')).toBe('Popular & profitable: Keep it. Check the portions stay right.');
    expect(menuMapAdvice({ class: 'puzzle', belowAverageCents: null, raiseToAverageCents: null }, 'Pizza')).toContain('Suggest it at the counter');
    expect(menuMapAdvice({ class: 'dog', belowAverageCents: 1_000, raiseToAverageCents: null }, 'Pizza')).toContain('Rework it or drop it');
    for (const t of ['Star', 'Plowhorse', 'Puzzle', 'Dog']) {
      expect(menuMapAdvice({ class: 'plowhorse', belowAverageCents: 5_500, raiseToAverageCents: 6_000 }, 'Pizza')).not.toContain(t);
    }
  });
});

describe('the Profit tab (costing spec Phase 9)', () => {
  it('only for a login with profit.view and costs, last in the page\'s order', () => {
    expect(visibleReportTabs(true, true)).toEqual(['overview', 'when', 'menu', 'channels', 'foodStock', 'team', 'profit']);
    expect(visibleReportTabs(true, false)).not.toContain('profit');
    expect(visibleReportTabs(false, true)).not.toContain('profit');
  });

  it('asks for the two stock takes "Between stock takes"; no other tab does', () => {
    const between = stockTakesPeriod({ id: 'a', finishedAt: '2026-09-21T06:00:00.000Z' }, { id: 'b', finishedAt: '2026-09-28T06:00:00.000Z' });
    expect(tabRequest('profit', between)).toMatchObject({ stockTakes: { fromCountId: 'a', toCountId: 'b' } });
    expect(tabRequest('menu', between)).not.toHaveProperty('stockTakes');
    expect(tabRequest('profit', period)).not.toHaveProperty('stockTakes');
  });

  it('renders the waterfall, the unknown-cost bar set aside, and what each order type earns', () => {
    const out = html(<ProfitTab data={PROFIT} />);
    expect(out).toContain('What you keep');
    expect(out).toContain('Profit before overheads: Rs 5,800');
    expect(out).toContain('Sales with an unknown cost (left out)');
    expect(out).toContain('never counted as free');
    expect(out).toContain('What each order type earns');
    expect(out).toContain('Delivery (phone)');
    expect(out).toContain('Rs 2,800');
    // Its sales are before tax — the table above it on Channels is with tax — and its fees are card fees.
    expect(out).toContain('Sales before tax');
    expect(out).toContain('Card fees');
    expect(out).toContain('Profit by category');
    expect(out).toContain('1 delivery has no area and no delivery charge');
    // No textbook words on screen.
    expect(out).not.toMatch(/contribution|COGS|bps/i);
  });

  it('test orders the owner deleted (0043): their food is Waste on a line of its own, as on Food cost & stock — on screen and in the file', () => {
    const withTests: ReportProfitTab = {
      ...PROFIT,
      wasteByReason: [
        { reason: 'test_order', times: 2, cents: 8_000 },
        { reason: 'burnt', times: 2, cents: 4_000 },
      ],
    };
    const out = html(<ProfitTab data={withTests} />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(out).toContain('Test orders (deleted) · 2× Rs 80');
    expect(out).toContain('Burnt · 2× Rs 40');
    const csv = buildTabCsv('profit', withTests, period, SAT_3PM);
    expect(csv).toContain('Test orders (deleted),2,80.00');
  });

  it('prints and exports on its own', () => {
    const csv = buildTabCsv('profit', PROFIT, period, SAT_3PM);
    expect(csv).toContain('FROM SALES TO PROFIT BEFORE OVERHEADS (THIS TILL)');
    expect(csv).toContain('Sales before tax,10000.00');
    expect(csv).toContain('Profit before overheads,5800.00');
    expect(csv).toContain('Delivery (phone),4,5000.00');
    const paper = buildTabPrintBody('profit', PROFIT, period, SAT_3PM);
    expect(paper).toContain('Profit — Today');
    expect(paper).toContain('−Rs 2,800');
    expect(paper).toContain('What each order type earns');
  });
});

const cost = (over: Partial<ReportLineCost> = {}): ReportLineCost => ({
  units: 4,
  salesCents: 300_000,
  knownUnits: 4,
  knownSalesCents: 300_000,
  costCents: 90_000,
  foodCostBps: 3_000,
  coverageBps: 10_000,
  profitCents: 210_000,
  profitPerSaleCents: 52_500,
  ...over,
});

const MENU = (withProfit: boolean): ReportMenuTab => ({
  ...base,
  kpis: { menuSalesCents: 300_000, itemCount: 4 },
  items: [{ key: 'm1', name: 'Test Pizza', categoryId: 'c1', categoryName: 'Pizzas', quantity: 4, salesCents: 300_000 }],
  categories: [{ categoryId: 'c1', name: 'Pizzas', quantity: 4, salesCents: 300_000 }],
  costs: {
    items: { m1: withProfit ? cost() : cost({ profitCents: null, profitPerSaleCents: null }) },
    categories: { c1: withProfit ? cost() : cost({ profitCents: null, profitPerSaleCents: null }) },
    costingStartedAt: '2026-09-20T07:00:00.000Z',
  },
});

const MAP: ReportMenuMap = {
  sinceIso: '2026-08-29T10:00:00.000Z',
  untilIso: SAT_3PM.toISOString(),
  lastDays: true,
  engine: 'worker',
  priceStepCents: 1_000,
  costingStartedAt: null,
  categories: [
    {
      categoryId: 'c1',
      name: 'Pizzas',
      state: 'ok',
      units: 300,
      items: [
        { menuItemId: 'm1', name: 'Test Pizza', units: 200, mixBps: 6_667, profitPerSaleCents: 45_000, priceCents: 70_000, costCents: 25_000, popular: true, profitable: false, class: 'plowhorse', belowAverageCents: 5_500, raiseToAverageCents: 6_000 },
        { menuItemId: 'm2', name: 'Test Special', units: 60, mixBps: 2_000, profitPerSaleCents: 70_000, priceCents: 95_000, costCents: 25_000, popular: false, profitable: true, class: 'puzzle', belowAverageCents: null, raiseToAverageCents: null },
        { menuItemId: 'm3', name: 'Test Plain', units: 40, mixBps: 1_333, profitPerSaleCents: 30_000, priceCents: 50_000, costCents: 20_000, popular: false, profitable: false, class: 'dog', belowAverageCents: 20_500, raiseToAverageCents: null },
      ],
      cantPlace: [{ menuItemId: 'm4', name: 'Test New', units: 12, costedShareBps: 5_000 }],
      notSold: [{ menuItemId: 'm5', name: 'Test Retired' }],
      popularLineBps: 2_333,
      averageProfitCents: 50_500,
    },
    { categoryId: 'c2', name: 'Burgers', state: 'few_sales', units: 120, items: [], cantPlace: [], notSold: [], popularLineBps: null, averageProfitCents: null },
  ],
};
const mapView = (data: ReportMenuMap | undefined): MenuMapView => ({ data, loading: false, error: null, lastDays: true, setLastDays: () => {} });

describe('Menu with costs, profit and the menu map', () => {
  it('profit.view: food cost, profit and the menu map in plain words', () => {
    const out = html(<MenuTab data={MENU(true)} menuMap={mapView(MAP)} />);
    expect(out).toContain('Food cost');
    expect(out).toContain('Per sale');
    expect(out).toContain('Rs 525');
    expect(out).toContain('Menu map');
    expect(out).toContain('Popular, low profit: earns Rs 55 less than your average pizzas; Rs 60 more on the price');
    expect(out).toContain('(Plowhorse)');
    // The chart's dots carry their number in the table, never a name that could print over the next one.
    expect(out).toMatch(/<text[^>]*>1<\/text>/);
    expect(out).not.toMatch(/<text[^>]*>Test Pizza<\/text>/);
    expect(out).toContain('1. Test Pizza: 200 sold');
    expect(out).toContain('Not enough sales yet: 120 sold, it needs 200');
    expect(out).toContain('Can&#x27;t place yet');
    expect(out).toContain('Not sold in these days: Test Retired.');
    const csv = buildTabCsv('menu', MENU(true), period, SAT_3PM, { menuMap: MAP });
    expect(csv).toContain('Profit Rs (before channel costs)');
    expect(csv).toContain('MENU MAP (THE LAST 28 DAYS');
    expect(buildTabPrintBody('menu', MENU(true), period, SAT_3PM, { menuMap: MAP })).toContain('Menu map (the last 28 days)');
  });

  it('without profit.view (the main process left profit out): costs yes, no profit column anywhere', () => {
    const out = html(<MenuTab data={MENU(false)} menuMap={null} />);
    expect(out).toContain('Food cost');
    expect(out).not.toContain('Per sale');
    expect(out).not.toContain('Menu map');
    const csv = buildTabCsv('menu', MENU(false), period, SAT_3PM);
    expect(csv).toContain('Food cost (known sales)');
    expect(csv).not.toMatch(/profit/i);
    const paper = buildTabPrintBody('menu', MENU(false), period, SAT_3PM);
    expect(paper).toContain('Food cost');
    expect(paper).not.toMatch(/profit/i);
  });

  it('without costs: no cost columns at all', () => {
    const out = html(<MenuTab data={{ ...MENU(false), costs: null }} />);
    expect(out).not.toContain('Food cost');
    expect(buildTabCsv('menu', { ...MENU(false), costs: null }, period, SAT_3PM)).not.toMatch(/food cost|profit/i);
  });
});

const CHANNELS = (withProfit: boolean): ReportChannelsTab => ({
  ...base,
  kpis: { orderCount: 6, netSalesCents: 600_000, avgOrderCents: 100_000 },
  channels: [{ channel: 'delivery', orderCount: 4, netSalesCents: 500_000 }, { channel: 'foodpanda', orderCount: 2, netSalesCents: 100_000 }],
  deliveries: { byRider: [{ riderId: 'r1', name: 'Test Rider', deliveries: 4, netSalesCents: 500_000, avgMinutesOut: 25 }], byArea: [] },
  areas: [
    {
      key: 'zone:dha-6',
      area: 'DHA Phase 6',
      zoneId: 'dha-6',
      orderCount: 4,
      netSalesCents: 500_000,
      avgOrderCents: 125_000,
      feesCollectedCents: 40_000,
      avgMinutesOut: 25,
      customers: 3,
      repeatCustomers: 1,
      repeatRateBps: 3_333,
      riderCents: withProfit ? 80_000 : null,
      contributionPerOrderCents: withProfit ? 70_000 : null,
    },
  ],
  noRateDeliveries: [{ orderId: 'o9', orderNumber: '042', createdAt: '2026-09-26T09:00:00.000Z', area: 'Gulshan', channel: 'delivery' }],
  noRateCount: 1,
  profit: withProfit ? { channels: PROFIT.channels, fees: FEES, riderCost: { mode: 'zone_rate', fixedCents: 0 } } : null,
});

describe('Channels & delivery with profit and delivery areas', () => {
  it('profit.view: what each order type earns, and the rider and earnings per area', () => {
    const out = html(<ChannelsTab data={CHANNELS(true)} />);
    expect(out).toContain('What each order type earns');
    expect(out).toContain('DHA Phase 6');
    expect(out).toContain('1 of 3');
    expect(out).toContain('Earns / order');
    expect(out).toContain('Charges before tax');
    expect(out).toContain('2 or more orders of any kind in the 90 days');
    expect(out).toContain('1 delivery has no area recognised and no delivery charge');
    const csv = buildTabCsv('channels', CHANNELS(true), period, SAT_3PM);
    expect(csv).toContain('WHAT EACH ORDER TYPE EARNS');
    expect(csv).toContain('Earns per order Rs');
  });

  it("foodpanda once: the table's \"foodpanda kept\" and the foodpanda block's are the same figure (one per-order rule)", () => {
    const withBlock: ReportChannelsTab = {
      ...CHANNELS(true),
      foodpanda: {
        orderCount: 2,
        tillPriceSalesCents: 110_000,
        shopDealCents: 10_000,
        foodpandaDealCents: 0,
        taxCents: 16_000,
        commissionCents: 25_000,
        feeCents: 0,
        commissionTaxCents: 0,
        foodpandaKeepsCents: 25_000,
        upliftCents: 0,
        partRefundCents: 0,
        youKeepCents: 75_000,
        expectedPayoutCents: 91_000,
        estimatedOrders: 0,
        commissionSuggested: false,
        unconfirmedCommissionBps: null,
        foodCost: null,
        toCheck: [],
        missingCodeCount: 0,
        tabletDiffCount: 0,
      },
    };
    const out = html(<ChannelsTab data={withBlock} />);
    // The same words and the same rupees in both places; no second "Commission" column meaning something else.
    expect(out.match(/foodpanda kept/g)?.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('Rs 250');
    expect(out).not.toContain('>Commission<');
    expect(out).toContain('Settings → foodpanda');
  });

  it('without profit.view: the areas without rider or earnings, on screen, in the file and on paper', () => {
    const out = html(<ChannelsTab data={CHANNELS(false)} />);
    expect(out).not.toContain('What each order type earns');
    expect(out).not.toContain('Earns / order');
    expect(out).toContain('DHA Phase 6');
    const csv = buildTabCsv('channels', CHANNELS(false), period, SAT_3PM);
    expect(csv).not.toContain('WHAT EACH ORDER TYPE EARNS');
    expect(csv).not.toContain('Rider Rs');
    expect(csv).toContain('DELIVERIES WITH NO AREA AND NO DELIVERY CHARGE (1)');
    const paper = buildTabPrintBody('channels', CHANNELS(false), period, SAT_3PM);
    expect(paper).not.toContain('What each order type earns');
    expect(paper).not.toContain('Earns / order');
    // "Print everything" for such a login: no Profit tab was handed over, so none prints.
    expect(buildPrintEverything({ channels: CHANNELS(false) }, period, SAT_3PM)).not.toMatch(/profit before overheads/i);
  });
});

describe('the weekly sheet\'s profit (costing spec §5)', () => {
  const week = {
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
    previous: null,
    change: { sales: { kind: 'noData' }, orders: { kind: 'noData' }, avgOrder: { kind: 'noData' } },
    costs: { foodCostBps: 3_050, coverageBps: 10_000, wasteCents: 240_000, hasCosts: true },
    doThis: [],
    doThisMore: 0,
    doThisFailed: [],
    sheet: {
      earnsMost: [{ menuItemId: 'm2', name: 'Test Large Fajita', soldThisWeek: 30, foodCostBps: 2_500, profitPerSaleCents: 90_000 }],
      earnsLeast: [],
      wasteByReason: [],
      previousCosts: null,
      lastStockTake: null,
      profit: { profitCents: 2_500_000, unknownSalesCents: 60_000, previousProfitCents: 2_000_000 },
    },
  } satisfies OwnerWeek;

  it('profit before overheads and what a sale earns, for profit.view only', () => {
    const out = buildWeeklySheet(week, { canSeeCosts: true, canSeeProfit: true, madeAt: SAT_3PM });
    expect(out).toContain('<span>Profit before overheads</span><b>Rs 25,000</b>');
    expect(out).toContain('Rs 600 of sales with an unknown cost left out, was Rs 20,000');
    expect(out).toContain('Earns a sale');
    expect(out).toContain('Rs 900');
    const lean = buildWeeklySheet(week, { canSeeCosts: true, madeAt: SAT_3PM });
    expect(lean).not.toMatch(/profit|earns a sale/i);
  });
});
