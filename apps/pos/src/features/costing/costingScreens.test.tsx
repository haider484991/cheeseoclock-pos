/**
 * The Costing screens render what the till sends, in plain words: a smoke
 * render (react-dom/server, no browser) of Menu costs, Missing costs, the
 * Targets form for the owner and for a manager, and the batch breakdown.
 * The data is seeded straight into React Query's cache; nothing calls the
 * till. Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, BatchCalc, CostingTargetsView, MenuCostRow, MenuCostsView, MissingCosts, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { MenuCostsTab } from './MenuCostsTab';
import { MissingCostsTab } from './MissingCostsTab';
import { TargetsTab } from './TargetsTab';
import { BatchBreakdown } from './BatchBreakdown';

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (p: Partial<MenuCostRow> & Pick<MenuCostRow, 'menuItemId' | 'name'>): MenuCostRow => ({
  categoryId: 'pizza',
  categoryName: 'Pizza',
  isActive: true,
  basePriceCents: 120_000,
  priceCents: 120_000,
  costCents: 30_000,
  minCostCents: 30_000,
  maxCostCents: 30_000,
  profitCents: 90_000,
  foodCostBps: 2500,
  targetBps: 3000,
  targetConfirmed: true,
  flag: 'green',
  hasRecipe: true,
  missingLines: 0,
  missingIngredients: [],
  estimateLines: 0,
  soldLast28: 12,
  ...p,
});

afterEach(() => useSessionStore.setState({ user: null, status: 'idle' }));

// React warns that layout effects (the router's, Radix's) do nothing in a server render: expected here.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

describe('Costing screens', () => {
  it('Menu costs: the summary, sizes under their name, worst first; not-food lines left out', () => {
    signIn('manager');
    const view: MenuCostsView = {
      rows: [
        row({ menuItemId: 'm1', name: 'Test Fajita — Medium' }),
        row({ menuItemId: 'm2', name: 'Test Fajita — Large', flag: 'red', foodCostBps: 3900, costCents: 60_000, profitCents: 90_000 }),
        row({ menuItemId: 'm3', name: 'Test Cola', flag: 'grey', foodCostBps: null, missingLines: 1, missingIngredients: ['Test bottle'], categoryId: 'drinks', categoryName: 'Drinks' }),
        row({ menuItemId: 'm4', name: 'Test Delivery', flag: 'nonfood', categoryId: 'fees', categoryName: 'Delivery Charges' }),
      ],
      summary: { items: 3, onTarget: 1, close: 0, over: 1, cantCost: 1, notConfirmed: 0 },
      amberBps: 500,
      missingCount: 1,
    };
    const html = render(<MenuCostsTab onShowMissing={() => {}} onShowTargets={() => {}} />, [[['costing', 'menuCosts'], view]]);
    expect(html).toContain('3 items: 1 on target, 1 over, 1 can&#x27;t be costed yet');
    expect(html).toContain('Test Fajita');
    expect(html.indexOf('Large')).toBeLessThan(html.indexOf('Medium')); // the red size first
    expect(html).toContain('39%');
    expect(html).toContain('price missing');
    expect(html).not.toContain('Test Delivery');
  });

  it('Missing costs: each list with the step that fixes it', () => {
    signIn('manager');
    const m: MissingCosts = {
      unpriced: [{ ingredientId: 'i1', name: 'Test bottle', unit: 'pcs', items: ['Test Cola'], salesShareBps: 420, costPerUnitCents: 0 }],
      noRecipe: [{ menuItemId: 'm9', name: 'Test Wings', categoryName: 'Wings', soldLast28: 3 }],
      guessed: [{ ingredientId: 'i2', name: 'Test breading', unit: 'g', items: ['Test Burger'], salesShareBps: null, costPerUnitCents: 15 }],
      roundedPerGram: [],
      batches: [
        {
          ingredientId: 'i3',
          name: 'Test sauce',
          unpricedInputs: [
            { ingredientId: 'i4', name: 'Test garlic', gone: false },
            { ingredientId: 'i5', name: 'Test deleted', gone: true },
          ],
          loop: false,
        },
      ],
      total: 4,
    };
    const html = render(<MissingCostsTab />, [[['costing', 'missing'], m]]);
    for (const text of ['Ingredients with no price', 'Set price', 'Mark free', 'Used in Test Cola · 4.2% of the last 28 days&#x27; sales', 'Food items with no recipe', 'Open recipe', 'Prices that are a guess', 'Batches with inputs that have no price', 'No price yet: Test garlic, Test deleted', 'Set price: Test garlic', 'Open batch recipe']) {
      expect(html).toContain(text);
    }
    // an input deleted since cannot be priced: only the batch recipe can fix it
    expect(html).not.toContain('Set price: Test deleted');
    expect(render(<MissingCostsTab />, [[['costing', 'missing'], { ...m, unpriced: [], noRecipe: [], guessed: [], batches: [], total: 0 }]])).toContain('Nothing missing');
  });

  const TARGETS: CostingTargetsView = {
    defaultBps: 3000,
    amberBps: 500,
    priceStepCents: 1000,
    categories: [
      { categoryId: 'pizza', name: 'Pizza', bps: 3000, suggestedBps: 3000, confirmed: false, nonFood: false, itemCount: 8 },
      { categoryId: 'fees', name: 'Delivery Charges', bps: 3000, suggestedBps: 3000, confirmed: false, nonFood: true, itemCount: 1 },
    ],
    anyUnconfirmed: true,
    savedAt: null,
  };

  it('Targets: the owner gets "Use these"; a manager sees them, locked', () => {
    signIn('admin');
    const owner = render(<TargetsTab />, [[['costing', 'targets'], TARGETS]]);
    expect(owner).toContain('Use these');
    expect(owner).toContain('These are the till&#x27;s suggestions');
    expect(owner).not.toContain('Only the owner can change the targets.');
    signIn('manager');
    const manager = render(<TargetsTab />, [[['costing', 'targets'], TARGETS]]);
    expect(manager).toContain('Only the owner can change the targets.');
    expect(manager).not.toContain('Use these');
  });

  it('the batch breakdown: exact amount, what stock moves, price, cost and share', () => {
    const calc: BatchCalc = {
      ingredientId: 'b1',
      name: 'Test sauce',
      unit: 'g',
      batchYield: 2000,
      amount: 200,
      lines: [
        { inputId: 't', name: 'Test tomato', unit: 'g', perBatchQty: 2500, scaledHundredths: 25_000, stockQty: 250, unitCostMc: 12_000, costMc: 3_000_000, costCents: 3000, shareBps: 8421, priceKind: 'set', madeInHouse: false, madeOf: null },
        { inputId: 'g', name: 'Test garlic', unit: 'g', perBatchQty: 125, scaledHundredths: 1_250, stockQty: 13, unitCostMc: 45_000, costMc: 562_500, costCents: 563, shareBps: 1579, priceKind: 'estimate', madeInHouse: false, madeOf: null },
      ],
      totalCostMc: 3_562_500,
      totalCostCents: 3563,
      perUnitMc: 17_813,
      complete: true,
      unpricedInputs: [],
      estimateInputs: ['Test garlic'],
      roundedAway: [],
      inStock: 0,
      maxAmount: 200_000,
    };
    const html = renderToStaticMarkup(<BatchBreakdown calc={calc} showStock />);
    for (const text of ['From stock', '12.5 g', '13 g', 'Rs 120 / kg', 'Rs 5.63', '84.2%', 'a guess']) expect(html).toContain(text);
  });
});
