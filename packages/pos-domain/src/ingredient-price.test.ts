import { describe, expect, it } from 'vitest';
import type { PriceKind } from '@cheeseoclock/shared-types';
import {
  batchClosure,
  batchesUsing,
  convertedStoredPrice,
  effectivePrices,
  hasPrice,
  priceChangeBps,
  knownPriceInForce,
  priceInForce,
  priceKindAfter,
  sameStoredPrice,
  storedPriceOf,
  type BatchInputLine,
  type PricedIngredient,
} from './ingredient-price.js';
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

// ---------------------------------------------------------------------------
// Costing Phase 4: the price as the ingredient keeps it, the price history
// ---------------------------------------------------------------------------

describe('storedPriceOf: one rule for every way a price is written', () => {
  it('an exact pack decides the whole-paisa cost kept for older screens', () => {
    expect(storedPriceOf({ costPerUnitCents: 0, packSize: 6000, packPriceCents: 225_000 }, 'unset')).toEqual({
      costPerUnitCents: 38,
      packSize: 6000,
      packPriceCents: 225_000,
      priceKind: 'set',
    });
  });
  it('half a pack is no pack; a per-unit cost stays as typed', () => {
    expect(storedPriceOf({ costPerUnitCents: 40, packSize: 100, packPriceCents: null }, 'set')).toEqual({
      costPerUnitCents: 40,
      packSize: null,
      packPriceCents: null,
      priceKind: 'set',
    });
  });
  it('free is Rs 0 with no pack; Rs 0 is unset unless free; a guess stays a guess', () => {
    expect(storedPriceOf({ costPerUnitCents: 0, packSize: 100, packPriceCents: 500 }, 'set', 'free')).toEqual({
      costPerUnitCents: 0,
      packSize: null,
      packPriceCents: null,
      priceKind: 'free',
    });
    expect(storedPriceOf({ costPerUnitCents: 0, packSize: null, packPriceCents: null }, 'set').priceKind).toBe('unset');
    expect(storedPriceOf({ costPerUnitCents: 0, packSize: null, packPriceCents: null }, 'free').priceKind).toBe('free');
    expect(storedPriceOf({ costPerUnitCents: 15, packSize: null, packPriceCents: null }, 'estimate').priceKind).toBe('estimate');
  });
  it('sameStoredPrice compares column for column', () => {
    const a = storedPriceOf({ costPerUnitCents: 0, packSize: 1000, packPriceCents: 15_500 }, 'set');
    expect(sameStoredPrice(a, { ...a })).toBe(true);
    expect(sameStoredPrice(a, { ...a, priceKind: 'estimate' })).toBe(false);
    expect(sameStoredPrice(a, { ...a, packSize: 2000, packPriceCents: 31_000 })).toBe(false); // the same price per gram, another pack
  });
});

describe('convertedStoredPrice: a Convert keeps the price exactly', () => {
  it('a price typed per kg becomes a pack of 1,000 g, never 38 paisa a gram', () => {
    expect(convertedStoredPrice({ costPerUnitCents: 37_500, packSize: null, packPriceCents: null, priceKind: 'set' }, 1000)).toEqual({
      costPerUnitCents: 38,
      packSize: 1000,
      packPriceCents: 37_500,
      priceKind: 'set',
    });
  });
  it('a pack holds 1,000× as many grams for the same money; a guess stays a guess', () => {
    expect(convertedStoredPrice({ costPerUnitCents: 37_500, packSize: 6, packPriceCents: 225_000, priceKind: 'estimate' }, 1000)).toEqual({
      costPerUnitCents: 38,
      packSize: 6000,
      packPriceCents: 225_000,
      priceKind: 'estimate',
    });
  });
  it('nothing to scale on an unpriced or free ingredient', () => {
    for (const priceKind of ['unset', 'free'] as const) {
      expect(convertedStoredPrice({ costPerUnitCents: 0, packSize: null, packPriceCents: null, priceKind }, 1000)).toEqual({
        costPerUnitCents: 0,
        packSize: null,
        packPriceCents: null,
        priceKind,
      });
    }
  });
});

describe('priceInForce: the price at a time, from the history', () => {
  const h = [
    { effectiveAt: '2026-09-01T00:00:00.000Z', p: 'seed' },
    { effectiveAt: '2026-09-10T00:00:00.000Z', p: 'a' },
    { effectiveAt: '2026-09-10T00:00:00.000Z', p: 'b' }, // written after a, in the same moment
    { effectiveAt: '2026-09-20T00:00:00.000Z', p: 'c' },
  ];
  it('the latest at or before the time, the later of two written together', () => {
    expect(priceInForce(h, '2026-09-05T00:00:00.000Z')?.p).toBe('seed');
    expect(priceInForce(h, '2026-09-10T00:00:00.000Z')?.p).toBe('b');
    expect(priceInForce(h, '2026-09-19T23:59:59.999Z')?.p).toBe('b');
    expect(priceInForce(h, '2027-01-01T00:00:00.000Z')?.p).toBe('c');
  });
  it('anything older than the history is priced at its first price (the starting price)', () => {
    expect(priceInForce(h, '2025-01-01T00:00:00.000Z')?.p).toBe('seed');
  });
  it('no history: nothing', () => {
    expect(priceInForce([], '2026-09-10T00:00:00.000Z')).toBeUndefined();
  });
});

describe('knownPriceInForce: the price a take is valued at ("no price yet" is no price)', () => {
  // The bottle had no price when the history started (seed 'unset'), got one on 5 Oct, lost it by mistake, got one again.
  const h = [
    { effectiveAt: '1970-01-01T00:00:00.000Z', kind: 'unset' as PriceKind, p: 'seed' },
    { effectiveAt: '2026-10-05T00:00:00.000Z', kind: 'set' as PriceKind, p: 'first' },
    { effectiveAt: '2026-10-10T00:00:00.000Z', kind: 'unset' as PriceKind, p: 'cleared' },
    { effectiveAt: '2026-10-12T00:00:00.000Z', kind: 'free' as PriceKind, p: 'free' },
  ];
  it('a take from before the first known price is valued at that first price, never "not priced" for good', () => {
    expect(knownPriceInForce(h, '2026-08-15T00:00:00.000Z')?.p).toBe('first');
    expect(knownPriceInForce(h, '2026-10-01T00:00:00.000Z')?.p).toBe('first');
  });
  it('while the price was cleared, the last known one stands; free is a known price', () => {
    expect(knownPriceInForce(h, '2026-10-11T00:00:00.000Z')?.p).toBe('first');
    expect(knownPriceInForce(h, '2026-10-13T00:00:00.000Z')?.p).toBe('free');
  });
  it('no known price at all: nothing (the caller falls back to the price now)', () => {
    expect(knownPriceInForce(h.filter((x) => x.kind === 'unset'), '2026-10-11T00:00:00.000Z')).toBeUndefined();
  });
});

describe('priceChangeBps: up or down against the price before', () => {
  it('in basis points of the old price; nothing to compare with when there was none (or it was free)', () => {
    expect(priceChangeBps(37_500, 41_250)).toBe(1_000); // 10% dearer
    expect(priceChangeBps(40_000, 30_000)).toBe(-2_500);
    expect(priceChangeBps(40_000, 40_000)).toBe(0);
    expect(priceChangeBps(null, 40_000)).toBeNull();
    expect(priceChangeBps(0, 40_000)).toBeNull();
  });
});

describe('batchesUsing: which batches a price change rolls up into, bottom-up', () => {
  // mozzarella → cheese mix → pizza topping; tomato → sauce → pizza topping.
  const bl = lines({
    mix: [['mozzarella', 800], ['cheddar', 200]],
    sauce: [['tomato', 2500]],
    topping: [['mix', 500], ['sauce', 500]],
    garnish: [['topping', 10], ['mix', 5]],
  });
  it('every batch made from it, each after the batches it is made from', () => {
    expect(batchesUsing(['mozzarella'], bl)).toEqual(['mix', 'topping', 'garnish']);
    expect(batchesUsing(['tomato'], bl)).toEqual(['sauce', 'topping', 'garnish']);
    expect(batchesUsing(['mozzarella', 'tomato'], bl)).toEqual(['mix', 'sauce', 'topping', 'garnish']);
    expect(batchesUsing(['salt'], bl)).toEqual([]);
  });
  it('leaves the changed ones out unless one is made from another', () => {
    expect(batchesUsing(['mix'], bl)).toEqual(['topping', 'garnish']);
    expect(batchesUsing(['mix', 'mozzarella'], bl)).toEqual(['mix', 'topping', 'garnish']);
  });
  it('a loop (A needs B needs A) is walked once, never round', () => {
    const loop = lines({ a: [['b', 1], ['mozzarella', 1]], b: [['a', 1]] });
    expect(batchesUsing(['mozzarella'], loop).sort()).toEqual(['a', 'b']);
  });
});
