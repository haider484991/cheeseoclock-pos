import { describe, expect, it } from 'vitest';
import type { PriceKind } from '@cheeseoclock/shared-types';
import { batchClosure, effectivePrices, hasPrice, priceKindAfter, type BatchInputLine, type PricedIngredient } from './ingredient-price.js';
import { lineCostMc, mcToCents } from './units.js';

// Every price here is made up.
function ing(
  id: string,
  price: { pack?: [number, number]; perUnit?: number; kind?: PriceKind; batchYield?: number } = {},
): PricedIngredient {
  return {
    id,
    name: id,
    unit: 'g',
    priceKind: price.kind ?? 'set',
    costPerUnitCents: price.perUnit ?? 0,
    packSize: price.pack?.[0] ?? null,
    packPriceCents: price.pack?.[1] ?? null,
    batchYield: price.batchYield ?? null,
  };
}
const lines = (entries: Record<string, Array<[string, number]>>) =>
  new Map<string, BatchInputLine[]>(
    Object.entries(entries).map(([id, ls]) => [id, ls.map(([inputId, qty]) => ({ inputId, qty }))]),
  );

describe('effectivePrices: the stored price', () => {
  it('a bought-in ingredient keeps its own price and kind', () => {
    const p = effectivePrices([ing('tomato', { pack: [5000, 60_000] }), ing('salt', { kind: 'free' })], new Map());
    expect(p.get('tomato')).toMatchObject({ pack: { size: 5000, priceCents: 60_000 }, kind: 'set', source: 'stored', batch: null });
    expect(p.get('salt')).toMatchObject({ pack: { size: 1, priceCents: 0 }, kind: 'free' });
  });
});

describe('effectivePrices: batch roll-up', () => {
  // Garlic paste (sub-batch): 1,000 g garlic + 200 g oil → 1,100 g.
  // Pizza sauce (batch): 2,500 g tomato + 110 g garlic paste + 30 g salt → 2,000 g.
  const ingredients = [
    ing('garlic', { pack: [1000, 45_000] }), // Rs 450 / kg
    ing('oil', { pack: [3000, 150_000] }), // Rs 1,500 per 3 l
    ing('tomato', { pack: [5000, 60_000] }), // Rs 120 / kg
    ing('salt', { kind: 'free' }),
    ing('paste', { batchYield: 1100, pack: [1100, 1], kind: 'set' }), // the sheet said Re 0.01: ignored once complete
    ing('sauce', { batchYield: 2000, kind: 'unset' }),
  ];
  const batch = lines({
    paste: [['garlic', 1000], ['oil', 200]],
    sauce: [['tomato', 2500], ['paste', 110], ['salt', 30]],
  });

  it('rolls a sub-batch up into the batch that uses it, bottom-up', () => {
    const p = effectivePrices(ingredients, batch);
    // paste: 1,000 g × 45 + 200 g × 50 = 45,000 + 10,000 paisa → 1,100 g for Rs 550
    const paste = p.get('paste')!;
    expect(paste).toMatchObject({ source: 'batch', kind: 'set', pack: { size: 1100, priceCents: 55_000 } });
    expect(paste.batch).toMatchObject({ complete: true, rolledCostCents: 55_000, storedPack: { size: 1100, priceCents: 1 } });
    // sauce: 2,500 g × 12 + 110 g × (55,000 ÷ 1,100 = 50) + salt free = 30,000 + 5,500 = 35,500 paisa per 2,000 g
    const sauce = p.get('sauce')!;
    expect(sauce).toMatchObject({ source: 'batch', kind: 'set', pack: { size: 2000, priceCents: 35_500 } });
    // …which is the formula: round(Σ round(qty × P × 1000 ÷ S) ÷ 1000)
    const expected = mcToCents(
      lineCostMc(2500, { size: 5000, priceCents: 60_000 }) + lineCostMc(110, { size: 1100, priceCents: 55_000 }),
    );
    expect(sauce.pack.priceCents).toBe(expected);
  });

  it('a dearer input shows in the batch at once (sub-batch → batch)', () => {
    const dearer = ingredients.map((i) => (i.id === 'garlic' ? { ...i, packPriceCents: 55_000 } : i));
    const p = effectivePrices(dearer, batch);
    expect(p.get('paste')!.pack.priceCents).toBe(65_000);
    expect(p.get('sauce')!.pack.priceCents).toBe(30_000 + 6_500);
  });

  it('an unpriced input: the batch keeps its stored price and is flagged, and so does the batch above it', () => {
    const unpriced = ingredients.map((i) => (i.id === 'oil' ? { ...i, priceKind: 'unset' as const, packPriceCents: 0 } : i));
    const p = effectivePrices(unpriced, batch);
    const paste = p.get('paste')!;
    expect(paste).toMatchObject({ source: 'stored', kind: 'set', pack: { size: 1100, priceCents: 1 } });
    expect(paste.batch).toMatchObject({ complete: false, unpricedInputIds: ['oil'], rolledCostCents: 45_000 });
    // The sauce reads the paste at its stored ('set') price, so the sauce itself can still roll up.
    expect(p.get('sauce')!.batch!.complete).toBe(true);

    // With the paste's stored price unset too, the sauce cannot be rolled up either.
    const worse = unpriced.map((i) => (i.id === 'paste' ? { ...i, priceKind: 'unset' as const } : i));
    const q = effectivePrices(worse, batch);
    expect(q.get('sauce')).toMatchObject({ source: 'stored', kind: 'unset' });
    expect(q.get('sauce')!.batch).toMatchObject({ complete: false, unpricedInputIds: ['paste'] });
  });

  it('a guessed input makes the batch a guess', () => {
    const guessed = ingredients.map((i) => (i.id === 'tomato' ? { ...i, priceKind: 'estimate' as const } : i));
    const p = effectivePrices(guessed, batch);
    expect(p.get('sauce')).toMatchObject({ kind: 'estimate', source: 'batch' });
    expect(p.get('sauce')!.batch!.estimateInputIds).toEqual(['tomato']);
  });

  it('an input that no longer exists counts as unpriced', () => {
    const p = effectivePrices(ingredients, lines({ paste: [['garlic', 1000], ['gone', 5]] }));
    expect(p.get('paste')!.batch).toMatchObject({ complete: false, unpricedInputIds: ['gone'] });
  });

  it('a loop (A needs B needs A) is guarded, never followed round', () => {
    const loop = [ing('a', { batchYield: 100, pack: [100, 700] }), ing('b', { batchYield: 50, pack: [50, 300] }), ing('c', { pack: [10, 10] })];
    const p = effectivePrices(loop, lines({ a: [['b', 10], ['c', 5]], b: [['a', 20]] }));
    const flagged = ['a', 'b'].filter((id) => p.get(id)!.batch!.loop);
    expect(flagged.length).toBeGreaterThan(0);
    for (const id of flagged) expect(p.get(id)).toMatchObject({ source: 'stored', batch: { complete: false } });
    expect(batchClosure('a', lines({ a: [['b', 10]], b: [['a', 20]] }))).toEqual(new Set(['a', 'b']));
  });

  it('all-free inputs make a free batch', () => {
    const p = effectivePrices([ing('water', { kind: 'free' }), ing('ice', { batchYield: 1000, kind: 'unset' })], lines({ ice: [['water', 1000]] }));
    expect(p.get('ice')).toMatchObject({ kind: 'free', source: 'batch', pack: { size: 1000, priceCents: 0 } });
  });
});

describe('priceKindAfter: what a saved price is', () => {
  it('follows the price when nobody says: Rs 0 is unpriced, a price is set', () => {
    expect(priceKindAfter(null, false)).toBe('unset');
    expect(priceKindAfter(null, true)).toBe('set');
    expect(priceKindAfter('unset', true)).toBe('set');
    expect(priceKindAfter('set', false)).toBe('unset');
  });
  it('a free ingredient stays free at Rs 0; a guess stays a guess until someone says otherwise', () => {
    expect(priceKindAfter('free', false)).toBe('free');
    expect(priceKindAfter('free', true)).toBe('set');
    expect(priceKindAfter('estimate', true)).toBe('estimate');
    expect(priceKindAfter('estimate', true, 'set')).toBe('set');
  });
  it('what was asked wins, but a guess of Rs 0 or a "set" Rs 0 is not a price', () => {
    expect(priceKindAfter('unset', false, 'free')).toBe('free');
    expect(priceKindAfter('set', true, 'estimate')).toBe('estimate');
    expect(priceKindAfter('set', false, 'estimate')).toBe('unset');
    expect(priceKindAfter('free', false, 'set')).toBe('unset');
  });
  it('hasPrice reads the pack when there is one', () => {
    expect(hasPrice({ costPerUnitCents: 0, packSize: 1000, packPriceCents: 40 })).toBe(true); // rounds to 0 paisa / g, still priced
    expect(hasPrice({ costPerUnitCents: 5, packSize: 1000, packPriceCents: 0 })).toBe(false);
    expect(hasPrice({ costPerUnitCents: 5, packSize: null, packPriceCents: null })).toBe(true);
  });
});
