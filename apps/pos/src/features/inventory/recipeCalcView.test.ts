import { describe, expect, it } from 'vitest';
import type { Category, Ingredient, MenuItem, TypicalPicksView, UUID } from '@cheeseoclock/shared-types';
import {
  batchLine,
  calcRequest,
  calcSearch,
  effectivePortions,
  hasLeaveOuts,
  itemLine,
  lacksLines,
  makeAmounts,
  readCount,
  readLine,
  shortFirst,
  usualPicks,
  withItemLine,
  withRecent,
} from './recipeCalcView';

// Every name and number here is made up.
const cat = (id: string, name: string): Category => ({ id: id as UUID, name } as Category);
const menuItem = (id: string, name: string, categoryId: string, isActive = true): MenuItem =>
  ({ id: id as UUID, name, categoryId: categoryId as UUID, description: null, isActive }) as MenuItem;
const ingredient = (id: string, name: string, batchYield: number | null, unit = 'g', currentQty = 400): Ingredient =>
  ({ id: id as UUID, name, unit, batchYield, currentQty }) as Ingredient;

const CATS = [cat('pizza', 'Pizzas'), cat('burgers', 'Burgers'), cat('dips', 'Dips'), cat('deals', 'Deals')];
const ITEMS = [
  menuItem('fajS', 'Fajita Pizza — Small', 'pizza'),
  menuItem('fajL', 'Fajita Pizza — Large', 'pizza'),
  menuItem('fajM', 'Fajita Pizza — Medium', 'pizza'),
  menuItem('zinger', 'Zinger Burger', 'burgers'),
  menuItem('ranch', 'Ranch Dip', 'dips'),
  menuItem('deal', 'Big Two Deal', 'deals'),
];
const BATCHES = [ingredient('sauce', 'Pizza Sauce', 740), ingredient('ranchMix', 'Ranch Mix', 1000), ingredient('cheese', 'Mozzarella', null)];

describe('the search: what are you making?', () => {
  it('a pizza once, its sizes as buttons in size order — Small left out as the till leaves it out', () => {
    const hits = calcSearch(ITEMS, CATS, BATCHES, 'fajita');
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.kind).toBe('item');
    if (h.kind !== 'item') return;
    expect(h.base).toBe('Fajita Pizza');
    expect(h.categoryName).toBe('Pizzas');
    expect(h.sizes.map((s) => [s.label, s.item.id])).toEqual([
      ['Medium', 'fajM'],
      ['Large', 'fajL'],
    ]);
  });

  it('a dip on the menu and a batch recipe both; a bought-in ingredient is not a recipe', () => {
    const hits = calcSearch(ITEMS, CATS, BATCHES, 'ranch');
    expect(hits.map((h) => (h.kind === 'item' ? h.base : `batch: ${h.ingredient.name}`))).toEqual(['Ranch Dip', 'batch: Ranch Mix']);
    expect(calcSearch(ITEMS, CATS, BATCHES, 'mozzarella')).toEqual([]);
    expect(calcSearch(ITEMS, CATS, BATCHES, '   ')).toEqual([]);
  });

  it('a batch by its name comes before dishes that only mention it, and batches always keep some rows', () => {
    // A made-up menu the size of a real one: every pizza "on rich tomato sauce", in a "Pizza" category.
    const pizzaCat = cat('pz', 'Pizza');
    const pizzas = ['Fajita', 'Crown Crust', 'Classic Supreme', 'Malai Supreme', 'Chicken Tikka', 'Cheesalious', 'Veggie Lovers', 'Pepperoni', 'Shawarma', 'Cheesy Star', 'Meat Lovers', 'Cheetos', 'Tikka Malai', 'Hot Honey'].flatMap((n, i) =>
      ['Medium', 'Large'].map((size) => ({
        ...menuItem(`p${i}${size}`, `${n} Pizza — ${size}`, 'pz'),
        description: `${n} toppings and mozzarella on rich tomato sauce.`,
      })),
    );
    const sauces = ['Pizza Sauce', 'Ranch Sauce', 'Tahini Sauce', 'Malai Sauce', 'Cheese Sauce', 'Shawarma Sauce'].map((n, i) => ingredient(`s${i}`, n, 2000));
    const kitchenBatches = [...sauces, ingredient('dough', 'Pan Pizza Dough', 5000), ingredient('mix', 'Pizza Cheese Mix', 1000)];
    const label = (h: ReturnType<typeof calcSearch>[number]) => (h.kind === 'item' ? h.base : `batch: ${h.ingredient.name}`);

    const pizzaSauce = calcSearch(pizzas, [pizzaCat], kitchenBatches, 'pizza sauce');
    expect(label(pizzaSauce[0]!)).toBe('batch: Pizza Sauce');
    expect(pizzaSauce).toHaveLength(12);

    const sauce = calcSearch(pizzas, [pizzaCat], kitchenBatches, 'sauce').map(label);
    expect(sauce.slice(0, 6)).toEqual(sauces.map((b) => `batch: ${b.name}`));

    // "pizza": the pizzas first, and the dough and cheese mix still on the list.
    const pizza = calcSearch(pizzas, [pizzaCat], kitchenBatches, 'pizza').map(label);
    expect(pizza).toHaveLength(12);
    expect(pizza[0]).toBe('Fajita Pizza');
    expect(pizza).toEqual(expect.arrayContaining(['batch: Pizza Sauce', 'batch: Pan Pizza Dough', 'batch: Pizza Cheese Mix']));
  });

  it('a slip of the finger still finds it', () => {
    expect(calcSearch(ITEMS, CATS, BATCHES, 'zingr').map((h) => (h.kind === 'item' ? h.base : ''))).toEqual(['Zinger Burger']);
  });
});

const DEAL: TypicalPicksView = {
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
      groupId: 'deal2',
      name: 'Deal: 2nd Large pizza',
      kind: 'required',
      selectionType: 'single',
      minSelect: 1,
      maxSelect: 1,
      isRequired: true,
      options: [
        { modifierId: 'd2Fajita', name: '2nd Large: Fajita', leaveOut: false, hasLines: true },
        { modifierId: 'd2Veggie', name: '2nd Large: Veggie', leaveOut: false, hasLines: true },
      ],
    },
    {
      groupId: 'sideDips',
      name: 'Dips on the side',
      kind: 'dips',
      selectionType: 'multi',
      minSelect: 0,
      maxSelect: 1,
      isRequired: false,
      options: [{ modifierId: 'sideRanch', name: 'Side of Ranch', leaveOut: false, hasLines: true }],
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
  mix: { units: 40, picks: { d1Fajita: 30, d1Veggie: 10, d2Fajita: 20, d2Veggie: 20, noOnion: 4 }, groupUnits: { deal1: 40, deal2: 40, leaveOut: 4 } },
};

describe('the usual picks', () => {
  it('the deal’s pizzas as customers pick them, dips on the side at 0, leave-outs never', () => {
    const u = usualPicks(DEAL, 10);
    expect(u.portions).toEqual({ d1Fajita: 8, d1Veggie: 2, d2Fajita: 5, d2Veggie: 5, sideRanch: 0 });
    expect(u.evenGroups).toEqual([]);
    expect(u.sold).toBe(40);
    expect(hasLeaveOuts(DEAL)).toBe(true);
  });

  it('too few sold: spread evenly, and it says which', () => {
    const few = { ...DEAL, mix: { units: 3, picks: { d1Fajita: 3, d2Veggie: 3 }, groupUnits: { deal1: 3, deal2: 3 } } };
    const u = usualPicks(few, 5);
    expect(u.portions).toMatchObject({ d1Fajita: 3, d1Veggie: 2, d2Fajita: 3, d2Veggie: 2 });
    expect(u.evenGroups).toEqual(['Deal: Large pizza', 'Deal: 2nd Large pizza']);
  });

  it('picks set by hand stay, never above the count; the usual ones follow the count', () => {
    const line = { ...itemLine({ id: 'deal', name: 'Big Two Deal' }, 10), portions: { d1Fajita: 12, sideRanch: 3, noOnion: 2 } };
    expect(effectivePortions(line, DEAL, 10)).toEqual({ d1Fajita: 10, d1Veggie: 0, d2Fajita: 0, d2Veggie: 0, sideRanch: 3 });
    const usual = itemLine({ id: 'deal', name: 'Big Two Deal' });
    expect(effectivePortions(usual, DEAL, 20)).toMatchObject({ d1Fajita: 15, d1Veggie: 5 });
  });
});

describe('what is sent', () => {
  it('an item: the count and its choices as explicit counts (nothing sent at 0), once its choices are loaded', () => {
    const line = itemLine({ id: 'deal', name: 'Big Two Deal' }, 10);
    expect(readLine(line, undefined)).toEqual({ ok: false, waiting: true, problem: null });
    const r = readLine(line, DEAL);
    expect(r).toEqual({
      ok: true,
      req: {
        kind: 'item',
        menuItemId: 'deal',
        count: 10,
        portions: [
          { modifierId: 'd1Fajita', count: 8 },
          { modifierId: 'd1Veggie', count: 2 },
          { modifierId: 'd2Fajita', count: 5 },
          { modifierId: 'd2Veggie', count: 5 },
        ],
      },
    });
    expect(readLine({ ...line, countText: '0' }, DEAL)).toMatchObject({ ok: false, problem: 'Type how many, 1 to 10,000.' });
  });

  it('a batch: any amount, 1.5 kg as 1,500 g; a part of a gram refused in plain words', () => {
    const sauce = batchLine(BATCHES[0]!);
    expect(sauce.text).toBe('740');
    expect(readLine({ ...sauce, text: '1.5', inBig: true }, undefined)).toEqual({ ok: true, req: { kind: 'batch', ingredientId: 'sauce', amount: 1500 } });
    expect(readLine({ ...sauce, text: '2 kg' }, undefined)).toMatchObject({ ok: true, req: { amount: 2000 } });
    expect(readLine({ ...sauce, text: '12.5' }, undefined)).toMatchObject({ ok: false, problem: expect.stringMatching(/whole g/) });
    expect(readLine({ ...sauce, text: '20000 kg' }, undefined)).toMatchObject({ ok: false, problem: 'At most 10,000,000 g at once.' });
  });

  it('only the lines that can be read; none at all is no request', () => {
    const good = readLine(itemLine({ id: 'deal', name: 'x' }, 2), DEAL);
    const bad = readLine({ ...itemLine({ id: 'deal', name: 'x' }), countText: 'ten' }, DEAL);
    expect(calcRequest([good, bad])!.lines).toHaveLength(1);
    expect(calcRequest([bad])).toBeNull();
    expect(readCount('1,000')).toBe(1000);
    expect(readCount('10001')).toBeNull();
    expect(readCount('2.5')).toBeNull();
  });
});

describe('the rows', () => {
  it('Make / calculate opens at what is left to make once the shelf is used, or all of it; never past one go', () => {
    // 800 g needed, 400 g on the shelf: make 400 g, or all 800 g fresh.
    expect(makeAmounts({ qty: 800, toMake: 400, maxAmount: 74_000, goes: 1 })).toEqual({ make: 400, all: 800, goes: 1 });
    // Nothing on the shelf: just the one button.
    expect(makeAmounts({ qty: 800, toMake: 800, maxAmount: 74_000, goes: 1 })).toEqual({ make: 800, all: null, goes: 1 });
    // Enough on the shelf: nothing to make (all of it only if wanted anyway).
    expect(makeAmounts({ qty: 800, toMake: 0, maxAmount: 74_000, goes: 1 })).toEqual({ make: null, all: 800, goes: 1 });
    expect(makeAmounts({ qty: 80_000, toMake: 80_000, maxAmount: 74_000, goes: 2 })).toEqual({ make: 74_000, all: null, goes: 2 });
  });

  it('"Calculate" on a dish adds it to what is being worked out — never replaces it — and a dish already there stays once', () => {
    const fajita = itemLine({ id: 'fajL', name: 'Fajita Pizza — Large' }, 10);
    const sauce = batchLine(BATCHES[0]!);
    const added = withItemLine([fajita, sauce], { id: 'zinger', name: 'Zinger Burger' });
    expect(added.lines.map((l) => l.name)).toEqual(['Fajita Pizza — Large', 'Pizza Sauce', 'Zinger Burger']);
    expect(added.key).toBe(added.lines[2]!.key);
    const again = withItemLine(added.lines, { id: 'fajL', name: 'Fajita Pizza — Large' });
    expect(again.lines).toEqual(added.lines);
    expect(again.key).toBe(fajita.key);
    expect(withItemLine(undefined, { id: 'deal', name: 'Big Two Deal' }).lines.map((l) => l.name)).toEqual(['Big Two Deal']);
  });

  it('a choice with no recipe lines beside ones that have them is marked (it counts nothing)', () => {
    const deal1 = DEAL.groups[0]!;
    const crown = { modifierId: 'd1Crown', name: 'Large: Crown Crust', leaveOut: false, hasLines: false };
    const g = { ...deal1, options: [...deal1.options, crown] };
    expect(lacksLines(g, crown)).toBe(true);
    expect(lacksLines(g, deal1.options[0]!)).toBe(false);
    // A group where no choice has lines (a drink's flavour, the bottle on the item): nothing to mark.
    expect(lacksLines({ ...g, options: [crown] }, crown)).toBe(false);
  });

  it('short rows first; recent picks each once, newest first', () => {
    expect(shortFirst([{ shortBy: 0, n: 1 }, { shortBy: 5, n: 2 }, { shortBy: 0, n: 3 }]).map((r) => r.n)).toEqual([2, 1, 3]);
    const r = withRecent([{ kind: 'item', id: 'a', name: 'A' }, { kind: 'batch', id: 'b', name: 'B' }], { kind: 'batch', id: 'b', name: 'B' });
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
