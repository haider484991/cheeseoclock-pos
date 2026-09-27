import { describe, expect, it } from 'vitest';
import type { RecipeCalc } from '@cheeseoclock/shared-types';
import { expandRecipe, totalsByIngredient, type PickedChoice, type RecipeLine } from './recipe-expand.js';
import { scaleBatch } from './batch-scale.js';
import {
  addQtyLines,
  apportion,
  batchStockNote,
  batchTree,
  choiceWithoutLinesText,
  explodeNeeds,
  goesFor,
  isRealPack,
  itemFirstLevel,
  kitchenQty,
  makeBatchLookup,
  packsText,
  packsToBuy,
  portionProblem,
  portionProblemText,
  prepListDocument,
  prepListText,
  shortOf,
  typicalPortions,
  type PortionGroup,
} from './recipe-calc.js';

// Every recipe, amount and name here is made up.

/** A deal: two pizza slots (one pick each), a paid side dip, a leave-out. */
const DEAL: RecipeLine[] = [
  { ingredientId: 'box', qtyPerUnit: 2, modifierId: null },
  { ingredientId: 'dough', qtyPerUnit: 300, modifierId: 'd1Fajita' },
  { ingredientId: 'sauce', qtyPerUnit: 80, modifierId: 'd1Fajita' },
  { ingredientId: 'chicken', qtyPerUnit: 60, modifierId: 'd1Fajita' },
  { ingredientId: 'onion', qtyPerUnit: 15, modifierId: 'd1Fajita' },
  { ingredientId: 'dough', qtyPerUnit: 300, modifierId: 'd1Veggie' },
  { ingredientId: 'sauce', qtyPerUnit: 80, modifierId: 'd1Veggie' },
  { ingredientId: 'pepper', qtyPerUnit: 15, modifierId: 'd1Veggie' },
  { ingredientId: 'dough', qtyPerUnit: 300, modifierId: 'd2Fajita' },
  { ingredientId: 'sauce', qtyPerUnit: 80, modifierId: 'd2Fajita' },
  { ingredientId: 'chicken', qtyPerUnit: 60, modifierId: 'd2Fajita' },
  { ingredientId: 'dough', qtyPerUnit: 300, modifierId: 'd2Veggie' },
  { ingredientId: 'sauce', qtyPerUnit: 80, modifierId: 'd2Veggie' },
  { ingredientId: 'ranch', qtyPerUnit: 25, modifierId: 'sideRanch' },
];

const group = (id: string, options: string[], over: Partial<PortionGroup> = {}): PortionGroup => ({
  id,
  selectionType: 'single',
  minSelect: 1,
  maxSelect: 1,
  isRequired: true,
  options: options.map((o) => ({ id: o })),
  ...over,
});

describe('itemFirstLevel: what N of an item use, first level', () => {
  it('every sale’s lines × N, and each choice’s lines × the number that get it', () => {
    const lines = itemFirstLevel(
      DEAL,
      [
        { modifierId: 'd1Fajita', count: 7 },
        { modifierId: 'd1Veggie', count: 3 },
        { modifierId: 'd2Fajita', count: 4 },
        { modifierId: 'd2Veggie', count: 6 },
        { modifierId: 'sideRanch', count: 0 },
      ],
      10,
    );
    expect(Object.fromEntries(lines.map((l) => [l.ingredientId, l.qty]))).toEqual({
      box: 20,
      dough: 6000, // 20 pizzas
      sauce: 1600,
      chicken: 660, // 11 Fajitas
      onion: 105, // only the first slot's Fajita has onion
      pepper: 45,
    });
  });

  it('is exactly expandRecipe, the rule the stock takes by, when every unit has the same picks', () => {
    const picks: PickedChoice[] = ['d1Veggie', 'd2Fajita', 'sideRanch'].map((m) => ({ modifierId: m, priceDeltaCents: 0, removesIngredientId: null }));
    const expected = totalsByIngredient(expandRecipe(DEAL, picks, 12));
    const got = itemFirstLevel(DEAL, picks.map((p) => ({ modifierId: p.modifierId, count: 12 })), 12);
    expect(new Map(got.map((l) => [l.ingredientId, l.qty]))).toEqual(expected);
  });

  it('adds up across lines, first seen first', () => {
    expect(addQtyLines([{ ingredientId: 'a', qty: 1 }], [{ ingredientId: 'b', qty: 2 }, { ingredientId: 'a', qty: 3 }])).toEqual([
      { ingredientId: 'a', qty: 4 },
      { ingredientId: 'b', qty: 2 },
    ]);
  });
});

describe('typicalPortions: the till’s usual picks for N', () => {
  it('an optional group (extras, dips on the side) has none: they count only when chosen', () => {
    expect(typicalPortions(group('extras', ['x'], { isRequired: false, minSelect: 0, maxSelect: 2, selectionType: 'multi' }), null, 10)).toBeNull();
  });

  it('a deal slot with enough sales: shared as customers picked, whole pizzas, adding up to the count', () => {
    const mix = { units: 40, picks: new Map([['d1Fajita', 30], ['d1Veggie', 10]]), groupUnits: new Map([['deal1', 40]]) };
    const t = typicalPortions(group('deal1', ['d1Fajita', 'd1Veggie']), mix, 10)!;
    expect(t.basis).toBe('observed');
    // 7.5 and 2.5: the tie goes to the first.
    expect(t.portions).toEqual([
      { modifierId: 'd1Fajita', count: 8 },
      { modifierId: 'd1Veggie', count: 2 },
    ]);
  });

  it('a "choose up to 5" group: as many picks per pizza as customers make, never more than one of a veggie each', () => {
    const g = group('veg', ['onion', 'pepper', 'olive', 'mushroom'], { selectionType: 'multi', maxSelect: 5 });
    const mix = { units: 20, picks: new Map([['onion', 20], ['pepper', 15], ['olive', 10], ['mushroom', 5]]), groupUnits: new Map([['veg', 20]]) };
    expect(typicalPortions(g, mix, 4)!.portions.map((p) => p.count)).toEqual([4, 3, 2, 1]);
  });

  it('too few sold (or picks from before the group was required): spread evenly, most picks each', () => {
    const few = { units: 9, picks: new Map([['d1Fajita', 9]]), groupUnits: new Map([['deal1', 9]]) };
    const t = typicalPortions(group('deal1', ['d1Fajita', 'd1Veggie']), few, 5)!;
    expect(t.basis).toBe('even');
    expect(t.portions.map((p) => p.count)).toEqual([3, 2]);
    // 20 units, but only 5 picks between them: not trusted.
    const thin = { units: 20, picks: new Map([['d1Fajita', 5]]), groupUnits: new Map([['deal1', 20]]) };
    expect(typicalPortions(group('deal1', ['d1Fajita', 'd1Veggie']), thin, 5)!.basis).toBe('even');
    // Veggie Lovers: 5 each, over 7 veggies.
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(typicalPortions(group('veg', seven, { selectionType: 'multi', maxSelect: 5 }), null, 2)!.portions.map((p) => p.count)).toEqual([
      2, 2, 2, 1, 1, 1, 1,
    ]);
    // Up to 5 of only 3: never two of one on a pizza.
    expect(typicalPortions(group('veg', ['a', 'b', 'c'], { selectionType: 'multi', maxSelect: 5 }), null, 2)!.portions.map((p) => p.count)).toEqual([2, 2, 2]);
  });

  it('apportion: largest remainder, none above the cap, the rest to the others', () => {
    expect(apportion(10, [1, 1, 1], 10)).toEqual([4, 3, 3]);
    expect(apportion(10, [9, 1], 6)).toEqual([6, 4]);
    expect(apportion(5, [0, 1], 10)).toEqual([0, 5]);
    expect(apportion(50, [1, 1], 10)).toEqual([10, 10]);
    expect(apportion(0, [1, 2], 10)).toEqual([0, 0]);
  });
});

describe('portionProblem: picks that do not cover the count', () => {
  const deal1 = group('deal1', ['d1Fajita', 'd1Veggie']);
  it('too few: the dough would be counted short, so it says how many more to pick', () => {
    const p = portionProblem(deal1, (id) => (id === 'd1Fajita' ? 7 : 0), 12)!;
    expect(p).toEqual({ groupId: 'deal1', picked: 7, min: 12, max: 12 });
    expect(portionProblemText('Deal: Large pizza', p, 12)).toBe('Deal: Large pizza — 7 picked for 12, pick 5 more');
  });

  it('a counted choice with no recipe lines of its own: said, with how many it leaves out', () => {
    expect(choiceWithoutLinesText('Large: Crown Crust', 3)).toBe(
      '"Large: Crown Crust" has no recipe lines yet, so the 3 counted add nothing: add its lines in Inventory → Recipes.',
    );
    expect(choiceWithoutLinesText('Large: Crown Crust', 1)).toMatch(/so the 1 counted adds nothing/);
  });

  it('too many, and just right', () => {
    const p = portionProblem(deal1, () => 7, 12)!;
    expect(portionProblemText('Deal: Large pizza', p, 12)).toBe('Deal: Large pizza — 14 picked for 12, 2 too many (at most 1 each)');
    expect(portionProblem(deal1, (id) => (id === 'd1Fajita' ? 5 : 7), 12)).toBeNull();
    const extras = group('extras', ['x'], { isRequired: false, minSelect: 0 });
    expect(portionProblem(extras, () => 0, 12)).toBeNull();
  });
});

// A made-up kitchen: a pizza sauce made with a garlic paste (itself a batch),
// a dough made with a cheese mix (a batch the pizzas also use on their own).
const YIELDS = new Map<string, number | null>([
  ['sauce', 740],
  ['paste', 60],
  ['dough', 5000],
  ['cheeseMix', 1000],
  ['tomato', null],
  ['oldBatch', 500], // a yield, but every input was deleted: bought in
]);
const INPUTS = new Map([
  ['sauce', [{ inputId: 'tomato', qty: 900 }, { inputId: 'paste', qty: 60 }, { inputId: 'salt', qty: 10 }]],
  ['paste', [{ inputId: 'garlic', qty: 50 }, { inputId: 'oil', qty: 10 }]],
  ['dough', [{ inputId: 'flour', qty: 3000 }, { inputId: 'water', qty: 1800 }, { inputId: 'cheeseMix', qty: 200 }]],
  ['cheeseMix', [{ inputId: 'mozz', qty: 700 }, { inputId: 'cheddar', qty: 300 }]],
]);
const kitchen = makeBatchLookup(YIELDS, INPUTS);

describe('explodeNeeds: every batch made once, everything from scratch', () => {
  const pizzas = [
    { ingredientId: 'sauce', qty: 800 },
    { ingredientId: 'dough', qty: 3000 },
    { ingredientId: 'cheeseMix', qty: 900 },
    { ingredientId: 'box', qty: 10 },
    { ingredientId: 'oldBatch', qty: 40 },
  ];

  it('in the order to make them, each batch’s need added up from everything above it first', () => {
    const e = explodeNeeds(pizzas, kitchen);
    expect(e.batches.map((b) => [b.id, b.need, b.direct])).toEqual([
      ['paste', 65, 0], // 60 × 800 ÷ 740 = 64.86 → 65 g
      ['sauce', 800, 800],
      ['cheeseMix', 1020, 900], // 900 on the pizzas + 120 in the dough: made once
      ['dough', 3000, 3000],
    ]);
    expect(e.loops).toEqual([]);
    expect(Object.fromEntries(e.raw.map((r) => [r.ingredientId, r.qty]))).toEqual({
      box: 10,
      oldBatch: 40, // no input left: bought in
      flour: 1800,
      water: 1080,
      mozz: 714,
      cheddar: 306,
      tomato: 973,
      salt: 11,
      garlic: 54, // 50 × 65 ÷ 60 = 54.17
      oil: 11,
    });
  });

  it('each batch takes exactly what "Make" (scaleBatch, whole units, half up) takes for that amount', () => {
    const e = explodeNeeds(pizzas, kitchen);
    for (const b of e.batches) {
      const made = scaleBatch(kitchen(b.id)!.batchYield, kitchen(b.id)!.inputs.map((i) => ({ ...i, pack: null, kind: 'missing' as const })), b.need);
      expect(b.scaled!.lines.map((l) => l.stockQty)).toEqual(made.lines.map((l) => l.stockQty));
      expect(b.toMake).toBe(b.need); // nothing on the shelf: all of it is made
    }
  });

  it('an input too small to take at this amount is not taken (and a batch only it would need is not made)', () => {
    const lookup = makeBatchLookup(
      new Map([['sauce', 2000], ['herbMix', 100]]),
      new Map([
        ['sauce', [{ inputId: 'tomato', qty: 2500 }, { inputId: 'bay', qty: 3 }, { inputId: 'herbMix', qty: 2 }]],
        ['herbMix', [{ inputId: 'oregano', qty: 100 }]],
      ]),
    );
    const e = explodeNeeds([{ ingredientId: 'sauce', qty: 200 }], lookup);
    expect(e.batches.map((b) => b.id)).toEqual(['sauce']);
    expect(e.batches[0]!.scaled!.roundedAwayIds).toEqual(['bay', 'herbMix']);
    expect(e.raw).toEqual([{ ingredientId: 'tomato', qty: 250 }]);
  });

  it('a loop (A needs B needs A, through the second till) is guarded: noted, and taken from stock, never made round', () => {
    const lookup = makeBatchLookup(
      new Map([['a', 100], ['b', 100]]),
      new Map([
        ['a', [{ inputId: 'b', qty: 50 }, { inputId: 'flour', qty: 50 }]],
        ['b', [{ inputId: 'a', qty: 20 }, { inputId: 'salt', qty: 80 }]],
      ]),
    );
    const e = explodeNeeds([{ ingredientId: 'a', qty: 200 }], lookup);
    expect(e.loops).toEqual([{ batchId: 'b', inputId: 'a' }]);
    expect(e.batches.map((b) => [b.id, b.need])).toEqual([
      ['b', 100],
      ['a', 200],
    ]);
    expect(Object.fromEntries(e.raw.map((r) => [r.ingredientId, r.qty]))).toEqual({ flour: 100, a: 20, salt: 80 });
    // The tree shows it and stops.
    const tree = batchTree('a', 200, lookup, { droppedEdges: e.droppedEdges })!;
    const bLine = tree.lines.find((l) => l.inputId === 'b')!;
    expect(bLine.madeOf!.lines.find((l) => l.inputId === 'a')).toMatchObject({ loop: true, madeOf: null, qty: 20 });
  });
});

describe('explodeNeeds: what is already made on the shelf is used first', () => {
  const pizzas = [
    { ingredientId: 'sauce', qty: 800 },
    { ingredientId: 'dough', qty: 3000 },
    { ingredientId: 'cheeseMix', qty: 900 },
    { ingredientId: 'box', qty: 10 },
    { ingredientId: 'oldBatch', qty: 40 },
  ];
  const shelf = (stock: Record<string, number>) => (id: string) => stock[id] ?? 0;

  it('a sauce with enough on the shelf is not made — nor the paste only it would use, nor their tomatoes and garlic; a dough partly there is made for the rest', () => {
    const e = explodeNeeds(pizzas, kitchen, { stockOf: shelf({ sauce: 6_000, dough: 1_000, paste: 500 }) });
    expect(e.batches.map((b) => [b.id, b.need, b.fromShelf, b.toMake])).toEqual([
      ['sauce', 800, 800, 0], // enough: listed, nothing made
      ['cheeseMix', 980, 0, 980], // 900 on the pizzas + 80 in the 2 kg of dough made
      ['dough', 3000, 1000, 2000],
    ]);
    expect(e.batches[0]!.scaled).toBeNull();
    // Make takes, for the 2 kg of dough, exactly what scaleBatch says for 2 kg.
    const dough = e.batches[2]!;
    expect(dough.scaled!.lines.map((l) => [l.inputId, l.stockQty])).toEqual([
      ['flour', 1200],
      ['water', 720],
      ['cheeseMix', 80],
    ]);
    // From scratch: only what is left to make. No tomato, salt, garlic or oil: the sauce is on the shelf.
    expect(Object.fromEntries(e.raw.map((r) => [r.ingredientId, r.qty]))).toEqual({
      box: 10,
      oldBatch: 40,
      flour: 1200,
      water: 720,
      mozz: 686,
      cheddar: 294,
    });
  });

  it('a batch asked for by name is made in full; what is on the shelf covers only what the dishes need', () => {
    const asked = new Map([['sauce', 2000]]);
    const onlyAsked = explodeNeeds([{ ingredientId: 'sauce', qty: 2000 }], kitchen, { stockOf: shelf({ sauce: 5_000, paste: 500 }), asked });
    expect(onlyAsked.batches.map((b) => [b.id, b.need, b.asked, b.fromShelf, b.toMake])).toEqual([
      ['paste', 162, 0, 162, 0], // 60 × 2,000 ÷ 740: on the shelf
      ['sauce', 2000, 2000, 0, 2000],
    ]);
    expect(Object.fromEntries(onlyAsked.raw.map((r) => [r.ingredientId, r.qty]))).toEqual({ tomato: 2432, salt: 27 });
    // The same 2 kg asked, and 800 g for the pizzas with 500 g on the shelf: 2,000 + 300 made.
    const both = explodeNeeds([{ ingredientId: 'sauce', qty: 2_800 }], kitchen, { stockOf: shelf({ sauce: 500 }), asked });
    expect(both.batches.find((b) => b.id === 'sauce')).toMatchObject({ need: 2_800, asked: 2_000, fromShelf: 500, toMake: 2_300 });
  });

  it('stock below zero is none; without stockOf every batch is made in full', () => {
    const minus = explodeNeeds([{ ingredientId: 'sauce', qty: 800 }], kitchen, { stockOf: shelf({ sauce: -50 }) });
    expect(minus.batches.find((b) => b.id === 'sauce')).toMatchObject({ fromShelf: 0, toMake: 800 });
    const plain = explodeNeeds([{ ingredientId: 'sauce', qty: 800 }], kitchen);
    expect(plain.batches.map((b) => [b.id, b.fromShelf, b.toMake])).toEqual([
      ['paste', 0, 65],
      ['sauce', 0, 800],
    ]);
  });
});

describe('batchTree: what an amount of a batch takes, opened up', () => {
  it('nested batches open for the amount they take, to a set depth', () => {
    const t = batchTree('sauce', 800, kitchen)!;
    expect(t.lines.map((l) => [l.inputId, l.qty, l.hundredths])).toEqual([
      ['tomato', 973, 97_297],
      ['paste', 65, 6_486],
      ['salt', 11, 1_081],
    ]);
    expect(t.lines[1]!.madeOf!.lines.map((l) => [l.inputId, l.qty])).toEqual([
      ['garlic', 54],
      ['oil', 11],
    ]);
    expect(batchTree('sauce', 800, kitchen, { maxDepth: 1 })!.lines[1]!.madeOf).toBeNull();
    expect(batchTree('tomato', 800, kitchen)).toBeNull();
  });

  it('goes: more than 100 batches is made in more than one go', () => {
    expect(goesFor(74_000, 74_000)).toBe(1);
    expect(goesFor(74_001, 74_000)).toBe(2);
  });
});

describe('kitchen units', () => {
  it('amounts as they are weighed, exact to the gram', () => {
    expect(kitchenQty(1250, 'g')).toBe('1.25 kg');
    expect(kitchenQty(1234, 'g')).toBe('1.234 kg');
    expect(kitchenQty(12_000, 'g')).toBe('12 kg');
    expect(kitchenQty(750, 'g')).toBe('750 g');
    expect(kitchenQty(1500, 'ml')).toBe('1.5 L');
    expect(kitchenQty(1200, 'pcs')).toBe('1,200 pcs');
  });

  it('packs only for a real pack, never the 1,000 g a price per kg is kept as', () => {
    expect(isRealPack('g', 2000)).toBe(true);
    expect(isRealPack('g', 1000)).toBe(false);
    expect(isRealPack('ml', 1000)).toBe(false);
    expect(isRealPack('pcs', 50)).toBe(true);
    expect(isRealPack('pcs', 1)).toBe(false);
    expect(isRealPack('pcs', null)).toBe(false);
    expect(packsText(4500, 'g', 2000)).toBe('2 packs of 2 kg + 500 g');
    expect(packsText(2000, 'g', 2000)).toBe('1 pack of 2 kg');
    expect(packsText(500, 'g', 2000)).toBeNull();
    expect(packsText(4500, 'g', 1000)).toBeNull();
    expect(packsToBuy(2500, 'g', 2000)).toBe(2);
    expect(packsToBuy(2500, 'g', 1000)).toBeNull();
    expect(packsToBuy(0, 'pcs', 50)).toBeNull();
  });

  it('short: what is needed less what is on the shelf; stock below zero is none', () => {
    expect(shortOf(800, 400)).toBe(400);
    expect(shortOf(800, 900)).toBe(0);
    expect(shortOf(800, -50)).toBe(800);
  });
});

describe('the prep list', () => {
  const calc: RecipeCalc = {
    lines: [
      {
        kind: 'item',
        id: 'deal',
        name: 'Big Two Deal',
        count: 10,
        unit: null,
        batchesText: null,
        picks: [{ modifierId: 'd1Fajita', name: 'Large: Fajita', groupName: 'Deal: Large pizza', count: 10 }],
        warnings: ['Deal: 2nd Large pizza — 0 picked for 10, pick 10 more'],
        hasRecipe: true,
        uses: [],
      },
    ],
    batches: [
      // Enough on the shelf: not made, and nothing of it counted from scratch.
      {
        ingredientId: 'paste',
        name: 'Garlic Paste',
        unit: 'g',
        qty: 65,
        inStock: 200,
        shortBy: 0,
        packSize: null,
        batchYield: 60,
        direct: 65,
        asked: 0,
        fromShelf: 65,
        toMake: 0,
        batchesText: null,
        maxAmount: 6_000,
        goes: 1,
        tree: null,
      },
      // 800 g needed, 500 g on the shelf: make the 300 g short.
      {
        ingredientId: 'sauce',
        name: 'Pizza Sauce',
        unit: 'g',
        qty: 800,
        inStock: 500,
        shortBy: 300,
        packSize: null,
        batchYield: 740,
        direct: 800,
        asked: 0,
        fromShelf: 500,
        toMake: 300,
        batchesText: '0.41 of a batch',
        maxAmount: 74_000,
        goes: 1,
        tree: {
          ingredientId: 'sauce',
          name: 'Pizza Sauce',
          unit: 'g',
          amount: 300,
          batchYield: 740,
          batchesText: '0.41 of a batch',
          lines: [
            { ingredientId: 'tomato', name: 'Tomato', unit: 'g', qty: 365, inStock: 5000, shortBy: 0, packSize: null, perBatchQty: 900, exactHundredths: 36_486, madeOf: null, loop: false },
            { ingredientId: 'bay', name: 'Bay leaf', unit: 'pcs', qty: 0, inStock: 3, shortBy: 0, packSize: null, perBatchQty: 1, exactHundredths: 41, madeOf: null, loop: false },
          ],
        },
      },
    ],
    fromStock: [{ ingredientId: 'box', name: 'Pizza box, large', unit: 'pcs', qty: 20, inStock: 16, shortBy: 4, packSize: 50 }],
    fromScratch: [
      { ingredientId: 'tomato', name: 'Tomato', unit: 'g', qty: 365, inStock: 5000, shortBy: 0, packSize: null },
      { ingredientId: 'box', name: 'Pizza box, large', unit: 'pcs', qty: 20, inStock: 16, shortBy: 4, packSize: 50 },
    ],
    warnings: [],
  };

  it('what was asked, only the batches still to make with what each takes, from stock, from scratch — SHORT marked, no prices', () => {
    const doc = prepListDocument(calc, { when: '27 Sep 2026, 14:05', by: 'Test Manager' });
    expect(doc.title).toBe('PREP LIST');
    expect(doc.sections.map((s) => s.heading)).toEqual(['FOR', 'MAKE FIRST', 'FROM STOCK', 'EVERYTHING FROM SCRATCH']);
    const text = prepListText(doc, 32);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(32);
    for (const want of [
      '10 x Big Two Deal',
      '  10 x Large: Fajita',
      'pick 10 more',
      'Pizza Sauce',
      '0.41 of a batch of 740 g',
      '  Bay leaf',
      'not taken',
      'SHORT 4 pcs (in stock 16 pcs)',
      'buy 1 pack of 50 pcs',
    ]) {
      expect(text).toContain(want);
    }
    // The sauce: only what the shelf does not hold is made, and the paper says so.
    expect(text).toMatch(/^Pizza Sauce\s+300 g$/m);
    expect(prepListText(doc, null)).toContain('  needs 800 g: 500 g in stock here, make the rest');
    // The paste is on the shelf: never under MAKE FIRST, and said to be enough.
    const make = doc.sections[1]!.rows.map((r) => r.text);
    expect(make).toEqual(['Pizza Sauce', 'Tomato', 'Bay leaf']);
    expect(doc.sections[2]!.rows[0]).toEqual({ text: 'Garlic Paste', qty: '65 g', notes: ['enough in stock here (200 g): no need to make'] });
    // Short first in "everything from scratch".
    const scratch = doc.sections[3]!.rows.map((r) => r.text);
    expect(scratch).toEqual(['Pizza box, large', 'Tomato']);
    expect(doc.sections[3]!.note).toBe('for what is left to make: batches in stock here used first');
    expect(text).not.toMatch(/Rs\b/);
  });

  it('nothing to make: no MAKE FIRST at all, the batches under FROM STOCK', () => {
    const all = { ...calc, batches: [calc.batches[0]!], fromStock: [] };
    const doc = prepListDocument(all, { when: 'today' });
    expect(doc.sections.map((s) => s.heading)).toEqual(['FOR', 'FROM STOCK', 'EVERYTHING FROM SCRATCH']);
    expect(prepListText(doc, null)).toContain('Garlic Paste: 65 g\n  enough in stock here (200 g): no need to make');
  });

  it('batchStockNote: enough, part from the shelf, or nothing on it', () => {
    const b = { qty: 5_900, unit: 'g', inStock: 3_000 };
    expect(batchStockNote({ ...b, fromShelf: 3_000, toMake: 2_900 })).toBe('needs 5.9 kg: 3 kg in stock here, make the rest');
    expect(batchStockNote({ ...b, inStock: 6_000, fromShelf: 5_900, toMake: 0 })).toBe('enough in stock here (6 kg): no need to make');
    expect(batchStockNote({ ...b, inStock: 0, fromShelf: 0, toMake: 5_900 })).toBeNull();
  });

  it('as a message: one line each, no padding', () => {
    const text = prepListText(prepListDocument(calc, { when: 'today' }), null);
    expect(text).toContain('Pizza Sauce: 300 g');
    expect(text).toContain('  Tomato: 365 g');
    expect(text).not.toContain('  '.repeat(8));
  });
});
