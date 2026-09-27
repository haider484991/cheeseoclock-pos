/**
 * Stock takes and "used vs should have used" on screen, on paper and in the
 * file (costing spec Phase 8): the owner's words (varianceFormat), the
 * "Between stock takes" period, the Food cost & stock section, the printout
 * and the CSV, and the Dashboard's "Do this" line. Nothing calls the till.
 * Every name, price and quantity is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DoThisItem, ReportFoodCost, ReportFoodStockTab, ReportVariance } from '@cheeseoclock/shared-types';
import { fmtMoment, pickStockTakePair, stockTakesAfterToChange, stockTakesPeriod } from './dateRange';
import { buildPrintEverything, buildTabCsv, buildTabPrintBody } from './exporters';
import { doThisWords } from './ownerWeekFormat';
import { FoodCostStockTab } from './tabs/FoodCostStockTab';
import { VarianceSection } from './tabs/VarianceSection';
import {
  actualCogsText,
  bandTone,
  countLineDifferenceText,
  lineVerdict,
  signedCents,
  signedQty,
  stockCountDifferenceText,
  varianceHeadline,
  varianceWindowText,
} from './varianceFormat';

const html = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const OFF = { on: false, stale: false, lastHeardAt: null };
const S0 = { id: 's0', scope: 'full' as const, finishedAt: '2026-09-21T01:40:00.000Z', countedByName: 'Test Manager' };
const S1 = { id: 's1', scope: 'full' as const, finishedAt: '2026-09-28T02:15:00.000Z', countedByName: 'Test Manager' };

const VARIANCE: ReportVariance = {
  state: 'ok',
  message: null,
  from: S0,
  to: S1,
  sinceIso: S0.finishedAt,
  untilIso: S1.finishedAt,
  foodSalesCents: 1_000_000,
  lines: [
    {
      ingredientId: 'mozz',
      name: 'Test mozzarella',
      unit: 'g',
      opening: 10_000,
      closing: 3_500,
      delivered: 4_000,
      madeHere: 0,
      usedInBatches: 2_000,
      sold: 7_300,
      wasted: 200,
      used: 10_500,
      shouldHaveUsed: 9_300,
      unexplained: 1_000,
      unexplainedCents: 120_000,
      unexplainedBps: 1_075,
      corrections: 0,
      priced: true,
      madeInHouse: false,
    },
    {
      ingredientId: 'mix',
      name: 'Test cheese mix',
      unit: 'g',
      opening: 1_000,
      closing: 3_000,
      delivered: 0,
      madeHere: 0,
      usedInBatches: 0,
      sold: 0,
      wasted: 0,
      used: -2_000,
      shouldHaveUsed: 0,
      unexplained: -2_000,
      unexplainedCents: -80_000,
      unexplainedBps: null,
      corrections: 0,
      priced: true,
      madeInHouse: true,
    },
    {
      ingredientId: 'bottle',
      name: 'Test bottle',
      unit: 'pcs',
      opening: 10,
      closing: 8,
      delivered: 0,
      madeHere: 0,
      usedInBatches: 0,
      sold: 1,
      wasted: 0,
      used: 2,
      shouldHaveUsed: 1,
      unexplained: 1,
      unexplainedCents: 0,
      unexplainedBps: 10_000,
      corrections: 0,
      priced: false,
      madeInHouse: false,
    },
  ],
  notOnBoth: [{ ingredientId: 'new', name: 'Test new sauce' }],
  totalCents: 40_000,
  varianceBps: 400,
  band: 'needs_work',
  pairs: [
    {
      batchId: 'mix',
      batchName: 'Test cheese mix',
      inputs: [{ ingredientId: 'mozz', name: 'Test mozzarella' }],
      noBatchLogged: true,
      warning: 'Test cheese mix went up but no batch was logged: the Test mozzarella difference is probably that batch.',
    },
  ],
  corrections: [{ ingredientId: 'mozz', name: 'Test mozzarella', unit: 'g', qty: 500, at: '2026-09-23T10:00:00.000Z', kind: 'fix', notes: 'Found a bag' }],
  alreadyCounted: [{ ingredientId: 'mozz', name: 'Test mozzarella', unit: 'g', qty: -60, orderId: 'order-1', orderNumber: '0042', at: '2026-09-22T10:00:00.000Z' }],
  actualCogs: {
    openingCents: 1_500_000,
    purchasesCents: 1_200_000,
    closingCents: 1_300_000,
    costCents: 1_400_000,
    foodSalesCents: 1_000_000 * 4,
    actualBps: 3_500,
    shouldHaveBps: 3_100,
    gapBps: 400,
    otherPurchases: [{ ingredientId: 'soap', name: 'Test dish soap', spendCents: 30_000 }],
    otherPurchasesCents: 30_000,
  },
  actualCogsWhyNot: null,
  link: OFF,
  staleSync: false,
  sellingTills: 1,
};

describe('the owner’s words for stock takes', () => {
  it('headlines, verdicts and signs', () => {
    expect(varianceHeadline(VARIANCE)).toBe('Rs 400 more went than sales, batches and logged waste explain: 4% of food sales.');
    expect(varianceHeadline({ ...VARIANCE, totalCents: -40_000, varianceBps: -400 })).toBe('Rs 400 more is on the shelves than the till expected: 4% of food sales.');
    expect(varianceHeadline({ ...VARIANCE, totalCents: 0, varianceBps: 0 })).toBe('Everything that went is explained by sales, batches and logged waste.');
    expect(varianceHeadline({ ...VARIANCE, lines: [] })).toMatch(/^Nothing was counted on both/);
    expect(lineVerdict({ unexplained: 1_250, unit: 'g' })).toBe('1.25 kg more went than should have');
    expect(lineVerdict({ unexplained: -300, unit: 'g' })).toBe('300 g more on the shelf than expected');
    expect(lineVerdict({ unexplained: 0, unit: 'pcs' })).toBe('As expected');
    expect(signedQty(-1_500, 'g')).toBe('−1.5 kg');
    expect(signedQty(20, 'pcs')).toBe('+20 pcs');
    expect(signedCents(-2_400_00)).toBe('−Rs 2,400');
    expect(bandTone('good')).toBe('good');
    expect(bandTone('look_now')).toBe('bad');
    expect(actualCogsText(VARIANCE.actualCogs!)).toBe('Real food cost 35% of food sales. Sales say it should have been 31%, 4 points more.');
    expect(varianceWindowText(VARIANCE)).toBe(`Between ${fmtMoment(S0.finishedAt)} (full stock take) and ${fmtMoment(S1.finishedAt)} (full stock take).`);
    expect(fmtMoment('2026-09-21T01:40:00.000Z')).toBe('Mon 21 Sep 2026, 06:40');
    expect(stockCountDifferenceText({ status: 'done', shortCents: 240_000, overCents: 7_500 })).toBe('Rs 2,400 short, Rs 75 over');
    expect(stockCountDifferenceText({ status: 'done', shortCents: 0, overCents: 0 })).toBe('As expected');
    expect(stockCountDifferenceText({ status: 'open', shortCents: null, overCents: null })).toBe('Being counted');
    expect(countLineDifferenceText({ differenceQty: -140, unit: 'g' })).toBe('140 g less than expected');
  });
});

describe('"Between stock takes"', () => {
  it('runs from just after the earlier stock take to the moment of the later one, and never refreshes itself', () => {
    const p = stockTakesPeriod(S0, S1);
    expect(p).toMatchObject({
      preset: 'stockTakes',
      sinceIso: '2026-09-21T01:40:00.001Z',
      untilIso: '2026-09-28T02:15:00.001Z',
      firstDay: '2026-09-21',
      lastDay: '2026-09-28',
      days: 8,
      isCurrent: false,
      compare: null,
      stockTakes: { fromCountId: 's0', toCountId: 's1' },
      title: 'Between stock takes',
    });
  });

  it('opens on the latest and, before it, a full one or one of the same kind; keeps what was picked when it will do', () => {
    const c = (id: string, scope: string, finishedAt: string) => ({ id, scope, finishedAt });
    const done = [c('k3', 'key_items', '2026-09-28'), c('one', 'custom', '2026-09-25'), c('k2', 'key_items', '2026-09-21'), c('f1', 'full', '2026-09-14')];
    expect(pickStockTakePair(done, null)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
    expect(pickStockTakePair(done, { toCountId: 'k2' })).toMatchObject({ from: { id: 'f1' }, to: { id: 'k2' } });
    expect(pickStockTakePair(done, { fromCountId: 'one', toCountId: 'k3' })).toMatchObject({ from: { id: 'one' }, to: { id: 'k3' } });
    // The earlier one must be earlier.
    expect(pickStockTakePair(done, { fromCountId: 'k3', toCountId: 'k2' })).toMatchObject({ from: { id: 'f1' }, to: { id: 'k2' } });
    expect(pickStockTakePair([done[0]!], null)).toBeNull();
    // The Stock button's one-line count finished last: not what it opens on.
    expect(pickStockTakePair([c('oil', 'custom', '2026-09-29'), ...done], null)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
  });

  it('changing "To" keeps "From" when it is still earlier, else leaves it to the till’s rule (not the one-liner just before)', () => {
    const c = (id: string, scope: string, finishedAt: string) => ({ id, scope, finishedAt });
    const list = [c('k4', 'key_items', '2026-10-05'), c('k3', 'key_items', '2026-09-28'), c('one', 'custom', '2026-09-27'), c('k2', 'key_items', '2026-09-21')];
    // k3 → k4 open; "To" switched to k3: "From" (k3) no longer fits, so the rule picks k2, not the 27 Sep one-liner.
    const picked = stockTakesAfterToChange(list, 'k3', 'k3');
    expect(picked).toEqual({ fromCountId: '', toCountId: 'k3' });
    expect(pickStockTakePair(list, picked)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
    // Still earlier than the new "To": kept.
    expect(stockTakesAfterToChange(list, 'k2', 'k3')).toEqual({ fromCountId: 'k2', toCountId: 'k3' });
  });
});

describe('Food cost & stock: used vs should have used', () => {
  const food = { foodSalesCents: 0, hasUsage: false } as unknown as ReportFoodCost;
  const tab: ReportFoodStockTab = {
    sinceIso: VARIANCE.sinceIso!,
    untilIso: VARIANCE.untilIso!,
    engine: 'worker',
    kpis: { partialRefundCents: 0 },
    foodCost: {
      ...food,
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
      sentNotPaid: { orderCount: 0, costCents: 0, costed: true, orders: [] } as unknown as ReportFoodCost['sentNotPaid'],
      stillOpen: { orderCount: 0, costCents: 0, costed: true, orders: [] } as unknown as ReportFoodCost['stillOpen'],
      hasCosts: false,
    },
    purchases: { spendCents: 0, bills: 0, bySupplier: [], byIngredient: [], byHandCents: 0, byHandEntries: 0 },
  };

  it('shows the figures, the rating, the linked batch warning, the fixes and the real food cost', () => {
    const out = html(<VarianceSection view={{ data: VARIANCE, loading: false, error: null }} />);
    for (const text of [
      'Used vs should have used',
      'Rs 400 more went than sales, batches and logged waste explain',
      'Needs work',
      'Test mozzarella',
      '1 kg more went than should have',
      'Test cheese mix went up but no batch was logged',
      'no batch logged',
      'Found a bag',
      'Order 0042',
      'Test new sauce',
      'Real food cost 35% of food sales',
      'Includes price changes on stock you held',
      'Test dish soap',
      'no price',
    ]) {
      expect(out).toContain(text);
    }
    // No jargon on screen (D15).
    expect(out).not.toMatch(/\bbps\b|variance|ACOGS|COGS/i);
    expect(out).not.toContain("hasn't worked lately");
    expect(html(<VarianceSection view={{ data: { ...VARIANCE, staleSync: true, link: { on: true, stale: true, lastHeardAt: null } }, loading: false, error: null }} />)).toContain(
      "link to the other till hasn&#x27;t worked lately",
    );
  });

  it('switched off, not two stock takes yet, loading, or another period: a sentence', () => {
    const off: ReportVariance = { ...VARIANCE, state: 'other_till_missing', message: "The other till's sales aren't on this till, so…", lines: [], actualCogs: null };
    expect(html(<VarianceSection view={{ data: off, loading: false, error: null }} />)).toContain('The other till&#x27;s sales aren&#x27;t on this till');
    expect(html(<VarianceSection view={{ data: undefined, loading: true, error: null }} />)).toContain('Working it out');
    expect(html(<VarianceSection view={{ data: undefined, loading: false, error: 'Reports over 31 days…' }} />)).toContain('Reports over 31 days');
    expect(html(<VarianceSection view={null} />)).toContain('Between stock takes');
    // In the tab: first when between stock takes, a hint at the end otherwise.
    const between = html(<FoodCostStockTab data={tab} lowStockCount={0} variance={{ data: VARIANCE, loading: false, error: null }} />);
    expect(between.indexOf('Used vs should have used')).toBeLessThan(between.indexOf('Food cost'));
    const other = html(<FoodCostStockTab data={tab} lowStockCount={0} />);
    expect(other.indexOf('Used vs should have used')).toBeGreaterThan(other.indexOf('Purchases'));
  });

  it('goes on paper and in the file with the tab', () => {
    const period = stockTakesPeriod(S0, S1);
    const csv = buildTabCsv('foodStock', tab, period, new Date('2026-09-28T03:00:00.000Z'), { variance: VARIANCE });
    expect(csv).toContain("USED VS SHOULD HAVE USED (EVERY TILL'S STOCK)");
    expect(csv).toContain('Test mozzarella,g,10000,4000,0,3500,10500,7300,2000,9300,200,1000,1200.00,');
    expect(csv).toContain('Real food cost 35% of food sales.');
    expect(csv).toContain('Other things bought (left out) Rs,300.00');
    const paper = buildTabPrintBody('foodStock', tab, period, new Date('2026-09-28T03:00:00.000Z'), { variance: VARIANCE });
    expect(paper).toContain('Used vs should have used');
    expect(paper).toContain('Rating: Needs work.');
    expect(paper.indexOf('Used vs should have used')).toBeLessThan(paper.indexOf('<h2>Food cost'));
    // Without it (another period), nothing about it.
    expect(buildTabCsv('foodStock', tab, period, new Date(), {})).not.toContain('Used vs should have used');
    const everything = buildPrintEverything({ foodStock: tab }, period, new Date(), { variance: VARIANCE });
    expect(everything).toContain('Real food cost');
  });
});

describe('"Do this": stock that doesn\'t add up', () => {
  it('says what and where', () => {
    const item: DoThisItem = {
      kind: 'stock_variance',
      key: 'stock_variance:s1',
      weekCents: 20_000,
      pinned: false,
      cost: true,
      fromCountId: 's0',
      toCountId: 's1',
      varianceBps: 420,
      totalCents: 40_000,
      topIngredient: 'Test mozzarella',
      countedAt: S1.finishedAt,
    };
    const w = doThisWords(item);
    expect(w.title).toBe("Stock doesn't add up: 4.2% of food sales");
    expect(w.detail).toContain('most of it Test mozzarella');
    expect(w.action).toBe('Open used vs should have used');
    expect(w.amount).toMatchObject({ tone: 'loss' });
  });
});
