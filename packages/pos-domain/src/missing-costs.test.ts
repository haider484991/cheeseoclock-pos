import { describe, expect, it } from 'vitest';
import type { PriceKind } from '@cheeseoclock/shared-types';
import { effectivePrices, type BatchInputLine, type PricedIngredient } from './ingredient-price.js';
import { findMissingCosts, isRoundedPerGram, type CostingMenuItem } from './missing-costs.js';

// A made-up shop, prices invented.
function ing(id: string, kind: PriceKind, extra: Partial<PricedIngredient> = {}): PricedIngredient {
  return {
    id,
    name: id,
    unit: 'g',
    priceKind: kind,
    costPerUnitCents: kind === 'unset' || kind === 'free' ? 0 : 5,
    packSize: kind === 'unset' || kind === 'free' ? null : 1000,
    packPriceCents: kind === 'unset' || kind === 'free' ? null : 5000,
    batchYield: null,
    ...extra,
  };
}
const INGREDIENTS: PricedIngredient[] = [
  ing('dough', 'set'),
  ing('bottle', 'unset', { unit: 'pcs' }),
  ing('dip-mix', 'unset'),
  ing('breading', 'estimate'),
  ing('salt', 'free'),
  ing('pepper', 'set', { packSize: null, packPriceCents: null, costPerUnitCents: 38 }), // Rs 0.38 / g, rounded
  ing('tomato', 'unset'),
  ing('sauce', 'set', { batchYield: 1000 }),
  ing('unused', 'unset'),
];
const BATCH = new Map<string, BatchInputLine[]>([['sauce', [{ inputId: 'tomato', qty: 1200 }, { inputId: 'salt', qty: 10 }]]]);
const item = (id: string, categoryId: string, ingredientIds: string[], salesCents: number): CostingMenuItem => ({
  id,
  name: id,
  categoryId,
  ingredientIds,
  salesCents,
});
const ITEMS: CostingMenuItem[] = [
  item('pizza', 'food', ['dough', 'sauce', 'pepper', 'salt'], 60_000),
  item('cola', 'drinks', ['bottle'], 20_000),
  item('dip', 'food', ['dip-mix'], 10_000),
  item('wings', 'food', ['breading'], 10_000),
  item('baked-wings', 'food', [], 0),
  item('delivery', 'fees', [], 5_000),
];

function run(ingredients = INGREDIENTS, items = ITEMS) {
  return findMissingCosts({
    ingredients,
    prices: effectivePrices(ingredients, BATCH),
    batchLines: BATCH,
    items,
    nonFoodCategoryIds: new Set(['fees']),
  });
}

describe('findMissingCosts', () => {
  it('(a) unpriced ingredients used in recipes — directly or through a batch — biggest sales first', () => {
    const m = run();
    expect(m.unpriced.map((r) => r.ingredientId)).toEqual(['tomato', 'bottle', 'dip-mix']);
    // tomato is only in the sauce, which is on the pizza: 60% of 100,000 food sales
    expect(m.unpriced[0]).toMatchObject({ itemIds: ['pizza'], salesShareBps: 6000 });
    expect(m.unpriced[1]).toMatchObject({ itemIds: ['cola'], salesShareBps: 2000 });
    // an unpriced ingredient no recipe uses is not listed
    expect(m.unpriced.find((r) => r.ingredientId === 'unused')).toBeUndefined();
  });

  it('(b) food items with no recipe; delivery charges are not food', () => {
    expect(run().noRecipe).toEqual(['baked-wings']);
  });

  it('(c) guessed prices and (d) per-gram prices rounded to whole paisa', () => {
    const m = run();
    expect(m.guessed.map((r) => r.ingredientId)).toEqual(['breading']);
    expect(m.roundedPerGram.map((r) => r.ingredientId)).toEqual(['pepper']);
  });

  it('(e) a batch with an unpriced input', () => {
    expect(run().batches).toEqual([{ ingredientId: 'sauce', unpricedInputIds: ['tomato'], loop: false }]);
  });

  it('a known Rs 0 ("free") is never missing: marking the bottle free takes it off', () => {
    const fixed = INGREDIENTS.map((i) => (i.id === 'bottle' ? { ...i, priceKind: 'free' as const } : i));
    expect(run(fixed).unpriced.map((r) => r.ingredientId)).toEqual(['tomato', 'dip-mix']);
  });

  it('with every price in, only what is really missing remains', () => {
    const priced = INGREDIENTS.map((i) =>
      i.priceKind === 'unset' ? { ...i, priceKind: 'set' as const, packSize: 1000, packPriceCents: 9000 } : i,
    );
    const m = run(priced);
    expect(m.unpriced).toEqual([]);
    expect(m.batches).toEqual([]);
  });

  it('a dish off the menu (hidden, not sold in the window) counts nowhere, so the lists can reach zero', () => {
    const retired = ITEMS.map((i) => (i.id === 'baked-wings' || i.id === 'cola' ? { ...i, onMenu: false, salesCents: 0 } : i));
    const m = run(INGREDIENTS, retired);
    expect(m.noRecipe).toEqual([]);
    // the bottle is only in the retired cola: no longer something to price
    expect(m.unpriced.map((r) => r.ingredientId)).toEqual(['tomato', 'dip-mix']);
    // …while a hidden dish that still sold stays in (the till counts it as on the menu)
    const hiddenButSold = ITEMS.map((i) => (i.id === 'baked-wings' ? { ...i, onMenu: true } : i));
    expect(run(INGREDIENTS, hiddenButSold).noRecipe).toEqual(['baked-wings']);
  });

  it('isRoundedPerGram: only a per-gram (per-ml) price with no pack', () => {
    expect(isRoundedPerGram({ unit: 'g', packSize: null, packPriceCents: null, costPerUnitCents: 38 })).toBe(true);
    expect(isRoundedPerGram({ unit: 'ml', packSize: 1000, packPriceCents: 37_500, costPerUnitCents: 38 })).toBe(false);
    expect(isRoundedPerGram({ unit: 'pcs', packSize: null, packPriceCents: null, costPerUnitCents: 4000 })).toBe(false);
    expect(isRoundedPerGram({ unit: 'g', packSize: null, packPriceCents: null, costPerUnitCents: 0 })).toBe(false);
  });
});
