import { describe, expect, it } from 'vitest';
import type { BatchInputLine, PricedIngredient } from './ingredient-price.js';
import type { PlateGroup } from './plate-cost.js';
import type { RecipeLine } from './recipe-expand.js';
import { weeklyUnitsTenths, whatIfDish, whatIfPrices, whatIfWeekCents, type WhatIfChanges, type WhatIfDishInput } from './what-if.js';

// Every price is made up (costing spec D11): a pack of N grams for P paisa.
const ing = (id: string, size: number, price: number, batchYield: number | null = null): PricedIngredient => ({
  id,
  name: id,
  unit: 'g',
  priceKind: 'set',
  costPerUnitCents: 0,
  packSize: size,
  packPriceCents: price,
  batchYield,
});
const INGREDIENTS: PricedIngredient[] = [
  ing('dough', 1_000, 9_000), // 9 paisa a gram
  ing('cheese', 1_000, 100_000), // 100 paisa a gram
  ing('herbs', 1_000, 50_000),
  ing('onion', 1_000, 15_000),
  ing('pepper', 1_000, 30_000),
  // Made here: 800 g cheese + 200 g herbs → 1,000 g of Cheese Mix (90 paisa a gram today).
  ing('cheeseMix', 1_000, 1, 1_000),
];
const BATCHES = new Map<string, BatchInputLine[]>([
  [
    'cheeseMix',
    [
      { inputId: 'cheese', qty: 800 },
      { inputId: 'herbs', qty: 200 },
    ],
  ],
]);

const line = (ingredientId: string, qtyPerUnit: number, modifierId: string | null = null): RecipeLine => ({ ingredientId, qtyPerUnit, modifierId });

/** A pizza made with the Cheese Mix: 200 g dough (Rs 18) + 100 g mix (Rs 90) = Rs 108 at Rs 1,000. */
const PIZZA: WhatIfDishInput = {
  id: 'pizza',
  basePriceCents: 100_000,
  recipe: [line('dough', 200), line('cheeseMix', 100)],
  groups: [],
  mix: null,
  unitsLast28: 40,
  targetBps: 3_000,
};

/** A veggie pizza with one veggie picked: onion two times in three over the last 4 weeks, pepper once. */
const VEG_GROUP: PlateGroup = {
  id: 'veg',
  name: 'Choose a veggie',
  selectionType: 'single',
  minSelect: 1,
  maxSelect: 1,
  isRequired: true,
  options: [
    { id: 'o', name: 'Onion', priceDeltaCents: 0, removesIngredientId: null },
    { id: 'pp', name: 'Pepper', priceDeltaCents: 0, removesIngredientId: null },
  ],
};
const VEGGIE: WhatIfDishInput = {
  id: 'veggie',
  basePriceCents: 120_000,
  recipe: [line('dough', 200), line('onion', 20, 'o'), line('pepper', 20, 'pp')],
  groups: [VEG_GROUP],
  mix: { units: 30, picks: new Map([['o', 20], ['pp', 10]]), groupUnits: new Map([['veg', 30]]) },
  unitsLast28: 30,
  targetBps: 3_000,
};

const change = (packs: Array<[string, number, number]>, prices: Array<[string, number]> = []): WhatIfChanges => ({
  packs: new Map(packs.map(([id, size, price]) => [id, { size, priceCents: price }])),
  basePrices: new Map(prices),
});

function run(dish: WhatIfDishInput, c: WhatIfChanges) {
  return whatIfDish(dish, whatIfPrices(INGREDIENTS, BATCHES, c.packs), c, 1_000);
}

describe('What-if (costing spec 4.9)', () => {
  it('a dearer cheese flows through the Cheese Mix into every pizza made with it', () => {
    const c = change([['cheese', 1_000, 150_000]]);
    const prices = whatIfPrices(INGREDIENTS, BATCHES, c.packs);
    expect(prices.moved).toEqual(['cheese', 'cheeseMix']);
    // The mix: 800 × 150 + 200 × 50 = Rs 1,300 a kilo (was Rs 900).
    expect(prices.before.get('cheeseMix')!.pack).toEqual({ size: 1_000, priceCents: 90_000 });
    expect(prices.after.get('cheeseMix')!.pack).toEqual({ size: 1_000, priceCents: 130_000 });
    const d = run(PIZZA, c);
    expect(d.before.typicalCostCents).toBe(10_800);
    expect(d.after.typicalCostCents).toBe(14_800);
    expect(d.changed).toBe(true);
    // 40 in 4 weeks = 10 a week, each Rs 40 dearer: Rs 400 a week less.
    expect(d.weeklyUnitsTenths).toBe(100);
    expect(d.weekCents).toBe(-40_000);
    expect(d.breakEvenBps).toBeNull(); // no menu price changed
    // At 30%: Rs 148 ÷ 0.3 = Rs 493.33 → Rs 500 in Rs 10 steps.
    expect(d.priceToHitCents).toBe(50_000);
    // Nothing the what-if does touches the prices it was given.
    expect(INGREDIENTS.find((i) => i.id === 'cheese')!.packPriceCents).toBe(100_000);
  });

  it('uses the last 4 weeks’ picks: an onion rise counts two times in three on the veggie pizza', () => {
    const before = run(VEGGIE, change([]));
    // Dough Rs 18 + onion ⅔ × Rs 3 + pepper ⅓ × Rs 6 = Rs 22.
    expect(before.before.typicalCostCents).toBe(2_200);
    const d = run(VEGGIE, change([['onion', 1_000, 45_000]]));
    // Onion 20 g at 45 paisa = Rs 9, ⅔ of the time: + Rs 4 on a typical plate (Rs 2 → Rs 6).
    expect(d.after.typicalCostCents).toBe(2_600);
    // 30 in 4 weeks = 7.5 a week × Rs 4 = Rs 30 a week less.
    expect(d.weeklyUnitsTenths).toBe(75);
    expect(d.weekCents).toBe(-3_000);
    // Picked half and half instead, the same rise would move it Rs 3 a plate.
    const evenMix = run({ ...VEGGIE, mix: { units: 30, picks: new Map([['o', 15], ['pp', 15]]), groupUnits: new Map([['veg', 30]]) } }, change([['onion', 1_000, 45_000]]));
    expect(evenMix.after.typicalCostCents - evenMix.before.typicalCostCents).toBe(300);
  });

  it('a menu price tried: per week at the same sales, and how far sales could fall before it stops paying', () => {
    const d = run(PIZZA, change([], [['pizza', 110_000]]));
    expect(d.newBasePriceCents).toBe(110_000);
    expect(d.after.typicalPriceCents).toBe(110_000);
    expect(d.weekCents).toBe(100_000); // 10 a week × Rs 100
    // Earns Rs 892 now; Rs 100 more: sales can fall by 100 ÷ 992 = 10.08% before it earns less.
    expect(d.breakEvenBps).toBe(-1_008);
    // Both at once.
    const both = run(PIZZA, change([['cheese', 1_000, 150_000]], [['pizza', 110_000]]));
    expect(both.weekCents).toBe(100_000 - 40_000);
  });

  it('a dish nothing touches is unchanged, and the sums per week round once', () => {
    const d = run(VEGGIE, change([['cheese', 1_000, 150_000]]));
    expect(d.changed).toBe(false);
    expect(d.weekCents).toBe(0);
    expect(whatIfWeekCents(3, { priceMc: 0, costMc: 0 }, { priceMc: 0, costMc: -1_000 })).toBe(1); // 3 × Rs 0.01 ÷ 4 = 0.75 → 1
    expect(weeklyUnitsTenths(0)).toBe(0);
    expect(weeklyUnitsTenths(1)).toBe(3); // 0.25 a week
  });

  it('a typed price for something made here is used as typed', () => {
    const c = change([['cheeseMix', 1_000, 70_000]]);
    const prices = whatIfPrices(INGREDIENTS, BATCHES, c.packs);
    expect(prices.after.get('cheeseMix')!.pack).toEqual({ size: 1_000, priceCents: 70_000 });
    expect(run(PIZZA, c).after.typicalCostCents).toBe(1_800 + 7_000);
  });
});
