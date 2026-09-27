/**
 * Costing → What-if and the fees (costing spec 4.9, Phase 9), with made-up
 * figures and no till: "Fix all reds" tries only raises, only for dishes
 * over target; the price change list is a handoff (nothing on the till
 * changes) with the dishes whose price was tried — or, with an ingredient
 * price alone, the ingredient and the dishes it moves; the tries stay for
 * the rest of the login when the tab is left; the fees form reads what was
 * typed; the What-if tab is there only for profit.view (the owner's alone
 * since 2026-09-27: not a manager's, never a cashier's); the fees card is
 * read-only for a manager. Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, ChannelFeesView, MenuCostRow, MenuCostsView, UUID, WhatIfResult, WhatIfRow } from '@cheeseoclock/shared-types';
import { DEFAULT_FOODPANDA_DEAL, DEFAULT_FOODPANDA_FEES } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { presetSessionState } from '../../components/list';
import { useSessionStore } from '../../stores/sessionStore';
import { buildPriceChangeCsv, buildPriceChangePrint, costMoveRows, fixAllReds, priceChangeListReady, priceChangeRows } from './whatIfFormat';
import { WhatIfTab, whatIfTriesKeys } from './WhatIfTab';
import { ChannelFeesCard, readChannelFees } from './ChannelFeesCard';
import { CostingPage } from './CostingPage';
import { COSTING_KEY } from './costingQueries';
import { openFoodpandaSettings } from './deepLinks';

const row = (p: Partial<WhatIfRow> & Pick<WhatIfRow, 'menuItemId' | 'name'>): WhatIfRow => ({
  categoryId: 'c1',
  categoryName: 'Pizza',
  basePriceCents: 120_000,
  newBasePriceCents: 120_000,
  priceCents: 120_000,
  newPriceCents: 120_000,
  costCents: 30_000,
  newCostCents: 30_000,
  foodCostBps: 2_500,
  newFoodCostBps: 2_500,
  flag: 'green',
  newFlag: 'green',
  profitCents: 90_000,
  newProfitCents: 90_000,
  soldLast28: 40,
  weeklyUnitsTenths: 100,
  weekCents: 0,
  breakEvenBps: null,
  priceToHitCents: 100_000,
  targetBps: 3_000,
  targetConfirmed: true,
  changed: false,
  ...p,
});

const RESULT: WhatIfResult = {
  rows: [
    row({ menuItemId: 'm1', name: 'Test Fajita <L>', newBasePriceCents: 130_000, newPriceCents: 130_000, weekCents: 100_000, breakEvenBps: -890, changed: true }),
    row({ menuItemId: 'm2', name: 'Test Veggie', newCostCents: 45_000, newFoodCostBps: 3_750, newFlag: 'red', weekCents: -150_000, priceToHitCents: 150_000, changed: true }),
    row({ menuItemId: 'm3', name: 'Test Deal', flag: 'red', newFlag: 'red', priceToHitCents: 110_000 }),
    row({ menuItemId: 'm4', name: 'Test Wings' }),
  ],
  ingredients: [
    { ingredientId: 'i1', name: 'Test cheese', unit: 'g', beforeUnitCostMc: 100_000, afterUnitCostMc: 150_000, changeBps: 5_000, batch: false },
    { ingredientId: 'i2', name: 'Test Cheese Mix', unit: 'g', beforeUnitCostMc: 90_000, afterUnitCostMc: 130_000, changeBps: 4_444, batch: true },
  ],
  totalWeekCents: -50_000,
  priceStepCents: 1_000,
  engine: 'worker',
};

describe('What-if (costing spec 4.9)', () => {
  it('"Fix all reds": the price that brings each red dish to its target — only raises', () => {
    // Veggie is red at the new cost: up to Rs 1,500. The Deal is red but its target price is below today's: left alone.
    expect(fixAllReds(RESULT.rows)).toEqual({ m2: 150_000 });
  });

  it('the price change list: the dishes whose price was tried, as a handoff — nothing on the till changes', () => {
    expect(priceChangeRows(RESULT).map((r) => r.menuItemId)).toEqual(['m1']);
    const csv = buildPriceChangeCsv(RESULT, new Date('2026-09-26T10:00:00.000Z'));
    expect(csv).toContain('Nothing on the till has changed. Change these in the costing sheet, the printed menu and the website.');
    expect(csv).toContain('Test Fajita <L>,Pizza,1200.00,1300.00,100.00,25%,25%,1000.00,Sales could fall 8.9% before this earns less than now');
    expect(csv).toContain('Test Cheese Mix,g,Rs 900 / kg,"Rs 1,300 / kg",Yes (moves with what it is made from)');
    expect(csv).toContain('"All dishes together, per week at the same sales",-500.00');
    const paper = buildPriceChangePrint(RESULT, new Date('2026-09-26T10:00:00.000Z'));
    expect(paper).toContain('<h1>Price change list</h1>');
    expect(paper).toContain('Nothing on the till has changed');
    expect(paper).toContain('Test Fajita &lt;L&gt;');
    expect(paper).not.toContain('Test Fajita <L>');
    expect(paper).toContain('−Rs 500 a week');
  });

  it('a new ingredient price alone prints too: the prices it assumes and the dishes whose cost moves', () => {
    const cheeseOnly: WhatIfResult = { ...RESULT, rows: RESULT.rows.map((r) => (r.menuItemId === 'm1' ? { ...r, newBasePriceCents: r.basePriceCents, newPriceCents: r.priceCents } : r)) };
    expect(priceChangeRows(cheeseOnly)).toEqual([]);
    expect(priceChangeListReady(cheeseOnly)).toBe(true);
    expect(costMoveRows(cheeseOnly).map((r) => r.menuItemId)).toEqual(['m2']);
    const paper = buildPriceChangePrint(cheeseOnly, new Date('2026-09-26T10:00:00.000Z'));
    expect(paper).toContain('No menu price was changed in this what-if.');
    expect(paper).toContain('Ingredient prices this assumes');
    expect(paper).toContain('Dishes whose cost moves');
    expect(paper).toContain('Test Veggie');
    expect(paper).toContain('−Rs 1,500 a week');
    const csv = buildPriceChangeCsv(cheeseOnly, new Date('2026-09-26T10:00:00.000Z'));
    expect(csv).toContain('Dishes whose cost moves (menu price not changed)');
    expect(csv).toContain('Test Veggie,Pizza,300.00,450.00,25%,37.5%,-1500.00');
    // Nothing tried at all: nothing to hand over.
    expect(priceChangeListReady({ rows: RESULT.rows.map((r) => ({ ...r, newBasePriceCents: r.basePriceCents, newCostCents: r.costCents })), ingredients: [] })).toBe(false);
  });
});

describe('card fees and riders (costing spec Phase 9); foodpanda is Settings → foodpanda\'s', () => {
  const typed = {
    payment: { cash: '0', card: '2.5', foodpanda: '0', transfer: '1' },
    riderMode: 'fixed' as const,
    riderFixed: '150',
  };

  it('reads what was typed into the setting, exactly — no foodpanda part', () => {
    expect(readChannelFees(typed)).toEqual({
      ok: true,
      value: {
        fees: { paymentFeeBps: { cash: 0, card: 250, foodpanda: 0, transfer: 100 } },
        riderCost: { mode: 'fixed', fixedCents: 15_000 },
      },
    });
  });

  it('says what is wrong in plain words', () => {
    expect(readChannelFees({ ...typed, payment: { ...typed.payment, card: 'x' } })).toEqual({ ok: false, problem: 'The fee for Card is 0% to 100%.' });
    expect(readChannelFees({ ...typed, riderFixed: 'lots' })).toEqual({ ok: false, problem: 'The rider cost per trip is Rs 0 to Rs 100,000.' });
  });
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('who sees What-if and the fees', () => {
  afterEach(() => useSessionStore.setState({ user: null, status: 'idle' }));

  it('the prices being tried stay for the rest of the login: leaving the tab and coming back keeps them', () => {
    const dish = (menuItemId: string, name: string, basePriceCents: number) =>
      ({ menuItemId, name, basePriceCents, flag: 'green', categoryId: 'c1', categoryName: 'Pizza' }) as unknown as MenuCostRow;
    const view = { rows: [dish('m1', 'Test Fajita', 120_000), dish('m2', 'Test Veggie', 150_000)], summary: {}, amberBps: 500, missingCount: 0 } as unknown as MenuCostsView;
    signIn('admin');
    // What the tab kept when it was left (another dish's "Try a price" adds to these rather than starting again).
    presetSessionState(whatIfTriesKeys('u1').prices, { m1: '1350', m2: '1600' });
    const out = render(<WhatIfTab />, [[[...COSTING_KEY, 'menuCosts'], view]]);
    expect(out).toContain('Test Fajita');
    expect(out).toContain('value="1350"');
    expect(out).toContain('Test Veggie');
    expect(out).toContain('value="1600"');
    expect(out).toContain('Start again');
    // Another login on this till does not see them.
    useSessionStore.setState({ user: { id: 'u2' as UUID, fullName: 'Other', role: 'admin', sessionId: 's2' as UUID }, status: 'authenticated' });
    const other = render(<WhatIfTab />, [[[...COSTING_KEY, 'menuCosts'], view]]);
    expect(other).not.toContain('value="1350"');
    expect(other).toContain('to print the price change list');
  });

  it('What-if is a Costing tab only for a login with profit.view — the owner; a manager has costs but no What-if', () => {
    signIn('admin');
    const owner = render(<CostingPage />);
    expect(owner).toContain('What-if');
    expect(owner).toContain('Targets &amp; fees');
    expect(owner).toContain('what you keep per sale');
    // Owner, 2026-09-27: profit is the owner's alone.
    signIn('manager');
    const manager = render(<CostingPage />);
    expect(manager).not.toContain('What-if');
    expect(manager).not.toContain('what you keep');
    expect(manager).toContain('Targets &amp; fees');
    signIn('cashier');
    expect(render(<CostingPage />)).not.toContain('What-if');
  });

  it('the fees card: the defaults said as such; a manager reads them without foodpanda, only the owner may save', () => {
    const view: ChannelFeesView = {
      fees: { paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 } },
      riderCost: { mode: 'zone_rate', fixedCents: 0 },
      isDefault: true,
      savedAt: null,
      foodpanda: null,
    };
    const manager = render(<ChannelFeesCard canEdit={false} />, [[[...COSTING_KEY, 'channelFees'], view]]);
    expect(manager).toContain('Nothing is saved yet: no card fees');
    expect(manager).toContain('Only the owner can change these.');
    expect(manager).not.toContain('Save the fees');
    // A manager's view has no foodpanda part (the main process leaves it out): no commission at all.
    expect(manager).not.toMatch(/commission/i);
    const owner = render(
      <ChannelFeesCard canEdit />,
      [[[...COSTING_KEY, 'channelFees'], { ...view, foodpanda: { fees: { ...DEFAULT_FOODPANDA_FEES, upliftBps: 1_000 }, carriedOver: false, isDefault: true, deal: { ...DEFAULT_FOODPANDA_DEAL, percent: 20, shopPercent: 10 }, dealToday: true } }]],
    );
    expect(owner).toContain('Save the fees');
    // foodpanda's terms, read-only, with the way to change them.
    expect(owner).toContain('Commission 25% of the food after your part of the deal, before tax — not confirmed yet');
    expect(owner).toContain('Menu 10% above the till');
    expect(owner).toContain('Deal: 20% off, you pay 10%');
    expect(owner).toContain('Change in Settings → foodpanda');
    expect(owner).not.toContain('aria-label="foodpanda commission, %"');
    // The button opens Settings on its foodpanda tab (Settings reads ?tab=).
    const went: string[] = [];
    openFoodpandaSettings((to) => went.push(to));
    expect(went).toEqual(['/settings?tab=foodpanda']);
  });
});
