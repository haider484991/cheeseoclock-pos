/**
 * Inventory → Recipe calculator renders what the till sends: a smoke render
 * (react-dom/server, no browser) of a deal worked out for 10 — with costs
 * hidden (the quantities alone, not one rupee) and for the owner (what it
 * costs) — and the Batch calculator button on Inventory → Recipes. The data
 * is seeded straight into React Query's cache; nothing calls the till.
 * Every name and number is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AuthenticatedUser,
  Category,
  CostedRecipeCalc,
  Ingredient,
  MenuItem,
  RecipeCalc,
  TypicalPicksView,
  UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { presetSessionState, readSessionState } from '../../components/list';
import { presetRecipeCalculator } from '../costing/deepLinks';
import { useSessionStore } from '../../stores/sessionStore';
import { CalcResult, RecipeCalculatorTab, recipeCalcQueryKey, typicalPicksKey } from './RecipeCalculator';
import { CALC_LINES_KEY, calcRequest, itemLine, readLine, type CalcLine } from './recipeCalcView';
import { RecipesTab } from './RecipesTab';

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

const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => useSessionStore.setState({ user: null, status: 'idle' }));

const PICKS: TypicalPicksView = {
  menuItemId: 'deal',
  name: 'Big Two Deal',
  groups: [
    {
      groupId: 'deal1',
      name: 'Deal: Large pizza',
      kind: 'required',
      selectionType: 'single',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      options: [
        { modifierId: 'd1Fajita', name: 'Large: Fajita', leaveOut: false, hasLines: true },
        { modifierId: 'd1Veggie', name: 'Large: Veggie', leaveOut: false, hasLines: true },
      ],
    },
    {
      groupId: 'leaveOut',
      name: 'Leave out',
      kind: 'leave-out',
      selectionType: 'multi',
      minSelect: 0,
      maxSelect: 1,
      isRequired: false,
      options: [{ modifierId: 'noOnion', name: 'No onion', leaveOut: true, hasLines: false }],
    },
  ],
  mix: { units: 143, picks: { d1Fajita: 100, d1Veggie: 43 }, groupUnits: { deal1: 143 } },
};

const CALC: RecipeCalc = {
  lines: [
    {
      kind: 'item',
      id: 'deal',
      name: 'Big Two Deal',
      count: 10,
      unit: null,
      batchesText: null,
      picks: [
        { modifierId: 'd1Fajita', name: 'Large: Fajita', groupName: 'Deal: Large pizza', count: 7 },
        { modifierId: 'd1Veggie', name: 'Large: Veggie', groupName: 'Deal: Large pizza', count: 3 },
      ],
      warnings: [],
      hasRecipe: true,
      uses: [],
    },
  ],
  batches: [
    {
      ingredientId: 'sauce',
      name: 'Pizza Sauce',
      unit: 'g',
      qty: 800,
      inStock: 400,
      shortBy: 400,
      packSize: null,
      batchYield: 740,
      direct: 800,
      asked: 0,
      fromShelf: 400,
      toMake: 400,
      batchesText: '0.54 of a batch',
      maxAmount: 74_000,
      goes: 1,
      tree: {
        ingredientId: 'sauce',
        name: 'Pizza Sauce',
        unit: 'g',
        amount: 400,
        batchYield: 740,
        batchesText: '0.54 of a batch',
        lines: [
          { ingredientId: 'tomato', name: 'Tomato', unit: 'g', qty: 486, inStock: 5000, shortBy: 0, packSize: null, perBatchQty: 900, exactHundredths: 48_649, madeOf: null, loop: false },
        ],
      },
    },
    // Enough on the shelf: nothing to make.
    {
      ingredientId: 'dough',
      name: 'Pan Pizza Dough',
      unit: 'g',
      qty: 3_000,
      inStock: 6_000,
      shortBy: 0,
      packSize: null,
      batchYield: 5_000,
      direct: 3_000,
      asked: 0,
      fromShelf: 3_000,
      toMake: 0,
      batchesText: null,
      maxAmount: 500_000,
      goes: 1,
      tree: null,
    },
  ],
  fromStock: [
    { ingredientId: 'cheese', name: 'Mozzarella', unit: 'g', qty: 4_500, inStock: 2_000, shortBy: 2_500, packSize: 2_000 },
    { ingredientId: 'box', name: 'Pizza box, large', unit: 'pcs', qty: 10, inStock: 40, shortBy: 0, packSize: null },
  ],
  fromScratch: [
    { ingredientId: 'cheese', name: 'Mozzarella', unit: 'g', qty: 4_500, inStock: 2_000, shortBy: 2_500, packSize: 2_000 },
    { ingredientId: 'box', name: 'Pizza box, large', unit: 'pcs', qty: 10, inStock: 40, shortBy: 0, packSize: null },
    { ingredientId: 'tomato', name: 'Tomato', unit: 'g', qty: 486, inStock: 5000, shortBy: 0, packSize: null },
  ],
  warnings: [],
};

const DEAL_ITEM = { id: 'deal' as UUID, name: 'Big Two Deal', categoryId: 'deals' as UUID, isActive: true } as MenuItem;

/** The screen as it opens on "Calculate" for the deal: 10, the usual picks. */
function seedFor(costed: boolean, answer: RecipeCalc | CostedRecipeCalc): Array<[readonly unknown[], unknown]> {
  const line = itemLine(DEAL_ITEM, 10);
  presetSessionState(CALC_LINES_KEY, [line] satisfies CalcLine[]);
  const req = calcRequest([readLine(line, PICKS)]);
  return [
    [['menu', 'items', 'all'], [DEAL_ITEM]],
    [['menu', 'categories', 'all'], [{ id: 'deals', name: 'Deals' } as Category]],
    [['inventory', 'ingredients', 'all'], [{ id: 'sauce', name: 'Pizza Sauce', unit: 'g', batchYield: 740, currentQty: 400 } as Ingredient]],
    [typicalPicksKey('deal'), PICKS],
    [recipeCalcQueryKey(costed, JSON.stringify(req)), answer],
  ];
}

describe('Inventory → Recipe calculator', () => {
  it('costs hidden: 10 deals — the usual picks, the sauce to make first with Make / calculate, from stock, short — and not one rupee', () => {
    signIn('cashier'); // a login without COST_CAPABILITY: what a manager would see if costs were hidden
    const html = render(<RecipeCalculatorTab />, seedFor(false, CALC));
    for (const text of [
      'Recipe calculator',
      'Big Two Deal',
      'How many?',
      'value="10"',
      'Using the till&#x27;s usual picks (last 28 days, 143 sold)',
      '7 × Large: Fajita, 3 × Large: Veggie',
      'Change',
      'Batches in it — make these first',
      'Pizza Sauce',
      '= 0.54 of a batch of 740 g',
      'in stock here 400 g',
      'short 400 g',
      'Make / calculate 400 g',
      'or all 800 g',
      // The dough is on the shelf: said, with no Make button for it.
      'Pan Pizza Dough',
      'in stock here 6 kg',
      'enough, no need to make',
      'make 3 kg anyway',
      'Straight from stock',
      '4.5 kg',
      '2 packs of 2 kg + 500 g',
      'short 2.5 kg',
      'Everything from scratch (3 ingredients, 1 short)',
      'Print prep list',
      'Copy as text',
      'Add another recipe',
      'Batch calculator',
      'Leave-outs (&quot;No onion&quot;) are not counted: they only use less.',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/Rs\s?\d/);
    expect(html).not.toContain('costs');
    expect(html).not.toContain('Make / calculate 3 kg');
  });

  it('with costs: what 10 of it cost to make, and each', () => {
    signIn('admin');
    const costed: CostedRecipeCalc = {
      ...CALC,
      costs: {
        totalCostCents: 609_400,
        complete: true,
        unpriced: [],
        estimates: [],
        perLine: [{ costCents: 609_400, eachCents: 60_940, complete: true, unpriced: [] }],
        perRow: {
          sauce: { costCents: 14_250, complete: true },
          dough: { costCents: 15_000, complete: true },
          cheese: { costCents: 540_000, complete: true },
          box: { costCents: 40_000, complete: true },
        },
      },
    };
    const html = render(<RecipeCalculatorTab />, seedFor(true, costed));
    expect(html).toContain('costs <b class="font-mono text-base">Rs 6,094</b> to make (Rs 609.40 each)');
    expect(html).toContain('Rs 142.50');
    expect(html).toContain('Rs 150');
  });

  it('a batch that only goes into other batches has no cost of its own (its cost is in theirs), so the column adds up', () => {
    const paste = { ...CALC.batches[0]!, ingredientId: 'paste', name: 'Garlic Paste', direct: 0, qty: 65 };
    const html = renderToStaticMarkup(
      <CalcResult
        calc={{ ...CALC, batches: [paste] }}
        costs={{ totalCostCents: 100, complete: true, unpriced: [], estimates: [], perLine: [{ costCents: 100, eachCents: 10, complete: true, unpriced: [] }], perRow: {} }}
        onMake={() => {}}
        canMake
      />,
    );
    expect(html).toContain('Garlic Paste');
    expect(html).toContain('>—<');
  });

  it('prices missing: "at least", and which', () => {
    const html = renderToStaticMarkup(
      <CalcResult
        calc={CALC}
        costs={{ totalCostCents: 100, complete: false, unpriced: ['Tomato'], estimates: [], perLine: [{ costCents: 100, eachCents: 10, complete: false, unpriced: ['Tomato'] }], perRow: {} }}
        onMake={() => {}}
        canMake
      />,
    );
    expect(html).toContain('at least Rs 1');
    expect(html).toContain('Tomato has no price yet: counted as Rs 0.');
  });

  it('nothing picked yet: the big search box', () => {
    signIn('manager');
    presetSessionState(CALC_LINES_KEY, []);
    const html = render(<RecipeCalculatorTab />, []);
    expect(html).toContain('What are you making?');
    expect(html).toContain('placeholder="Fajita pizza, zinger burger, ranch dip, pizza sauce…"');
  });
});

describe('"Calculate" on a dish (recipe card, cost sheet)', () => {
  it('adds the dish to the list being worked out — the lines already there stay — and opens the calculator', () => {
    const fajita = itemLine({ id: 'fajL', name: 'Fajita Pizza — Large' }, 10);
    presetSessionState(CALC_LINES_KEY, [fajita] satisfies CalcLine[]);
    presetSessionState('inv.tab', 'recipes');
    presetRecipeCalculator({ id: 'cheesalious', name: 'Cheesalious — Large' });
    expect(readSessionState<string>('inv.tab')).toBe('calculator');
    expect(readSessionState<CalcLine[]>(CALC_LINES_KEY)!.map((l) => l.name)).toEqual(['Fajita Pizza — Large', 'Cheesalious — Large']);
    // Again on one already there: the list as it is.
    presetRecipeCalculator({ id: 'fajL', name: 'Fajita Pizza — Large' });
    expect(readSessionState<CalcLine[]>(CALC_LINES_KEY)!.map((l) => l.name)).toEqual(['Fajita Pizza — Large', 'Cheesalious — Large']);
    // The Dashboard tile (no dish): as it was left.
    presetRecipeCalculator();
    expect(readSessionState<CalcLine[]>(CALC_LINES_KEY)).toHaveLength(2);
  });
});

describe('Inventory → Recipes', () => {
  it('the Batch calculator is one tap away, whichever list is open', () => {
    signIn('manager');
    presetSessionState('inv.rec.mode', 'items');
    expect(render(<RecipesTab />, [])).toContain('Batch calculator');
    presetSessionState('inv.rec.mode', 'batches');
    expect(render(<RecipesTab />, [])).toContain('Batch calculator');
  });
});
