import { describe, expect, it } from 'vitest';
import {
  baseUnitConversion,
  costPerUnitFromPack,
  effectivePack,
  formatPack,
  formatUnitCost,
  lineCostMc,
  mcToCents,
  mulDivRound,
  normalizeUnit,
  shareBps,
  unitCostMc,
  valueCents,
} from './units.js';

describe('normalizeUnit', () => {
  it('folds spellings of the same unit', () => {
    expect(normalizeUnit('Gram')).toBe('g');
    expect(normalizeUnit('grams')).toBe('g');
    expect(normalizeUnit('Each')).toBe('pcs');
    expect(normalizeUnit('Packet')).toBe('pkt');
    expect(normalizeUnit('KG')).toBe('kg');
  });
});

describe('baseUnitConversion', () => {
  it('turns kg and litres into grams and millilitres', () => {
    expect(baseUnitConversion('kg')).toEqual({ unit: 'g', factor: 1000 });
    expect(baseUnitConversion('Litre')).toEqual({ unit: 'ml', factor: 1000 });
  });
  it('leaves base units alone', () => {
    expect(baseUnitConversion('g')).toBeNull();
    expect(baseUnitConversion('pcs')).toBeNull();
  });
});

describe('pack costing', () => {
  it('derives the cost of one gram from the pack, in whole paisa', () => {
    // 4,000 g for Rs 1,500 → Rs 0.375 / g → 38 paisa
    expect(costPerUnitFromPack(150_000, 4000)).toBe(38);
    // 10 kg for Rs 1,900 → Rs 0.19 / g
    expect(costPerUnitFromPack(190_000, 10_000)).toBe(19);
  });
  it('rejects an empty pack', () => {
    expect(() => costPerUnitFromPack(100, 0)).toThrow();
  });
  it('shows the exact per-gram cost from the pack, not the rounded one', () => {
    expect(formatUnitCost({ unit: 'g', costPerUnitCents: 38, packSize: 4000, packPriceCents: 150_000 })).toBe('Rs 0.375 / g');
    expect(formatUnitCost({ unit: 'pcs', costPerUnitCents: 5000, packSize: 1, packPriceCents: 5000 })).toBe('Rs 50 / pcs');
    expect(formatUnitCost({ unit: 'g', costPerUnitCents: 19, packSize: null, packPriceCents: null })).toBe('Rs 0.19 / g');
  });
  it('describes the pack', () => {
    expect(formatPack({ unit: 'g', packSize: 4000, packPriceCents: 150_000 })).toBe('4,000 g for Rs 1,500');
    expect(formatPack({ unit: 'g', packSize: null, packPriceCents: null })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Exact costing (costing spec D1, D10). Every price here is made up.
// -----------------------------------------------------------------------------

describe('effectivePack', () => {
  it('uses the pack when there is one, else a pack of 1 at the stored per-unit cost', () => {
    expect(effectivePack({ costPerUnitCents: 38, packSize: 4000, packPriceCents: 150_000 })).toEqual({ size: 4000, priceCents: 150_000 });
    expect(effectivePack({ costPerUnitCents: 19, packSize: null, packPriceCents: null })).toEqual({ size: 1, priceCents: 19 });
    // half a pack (a size with no price) is no pack
    expect(effectivePack({ costPerUnitCents: 7, packSize: 1000, packPriceCents: null })).toEqual({ size: 1, priceCents: 7 });
  });
});

describe('valueCents', () => {
  const pack = { size: 4000, priceCents: 150_000 }; // Rs 0.375 / g

  it('values from the exact pack, rounded once', () => {
    expect(valueCents(300, pack)).toBe(11_250); // 300 × 37.5 paisa
    expect(valueCents(1, pack)).toBe(38); // 37.5 → 38 (half up)
    expect(valueCents(3, pack)).toBe(113); // 112.5 → 113
  });

  it('is symmetric: value(−q) = −value(q), at the .5 boundaries too', () => {
    for (const q of [1, 3, 5, 7, 300, 4001, 12_345]) {
      expect(valueCents(-q, pack)).toBe(-valueCents(q, pack));
    }
    expect(valueCents(-1, pack)).toBe(-38);
    // a take and the same put-back net to exactly 0
    expect(valueCents(-7, pack) + valueCents(7, pack)).toBe(0);
    expect(valueCents(0, pack)).toBe(0);
  });

  it('never goes through a float: large packs and quantities stay exact', () => {
    const big = { size: 3, priceCents: 999_999_999 };
    expect(valueCents(9_000_000, big)).toBe(2_999_999_997_000_000);
    expect(mulDivRound(2 ** 52, 3, 2)).toBe(6_755_399_441_055_744);
  });
});

describe('unit costs in millicents', () => {
  it('prices one base unit in mc (per gram = paisa per kg)', () => {
    expect(unitCostMc({ size: 4000, priceCents: 150_000 })).toBe(37_500); // Rs 375 / kg
    expect(unitCostMc({ size: 1, priceCents: 19 })).toBe(19_000);
    expect(unitCostMc({ size: 3, priceCents: 100 })).toBe(33_333);
  });
  it('costs a line in mc and turns mc into paisa once', () => {
    expect(lineCostMc(80, { size: 3, priceCents: 100 })).toBe(2_666_667);
    expect(mcToCents(2_666_667)).toBe(2667);
    expect(mcToCents(500)).toBe(1);
    expect(mcToCents(-500)).toBe(-1);
    expect(mcToCents(499)).toBe(0);
  });
  it('gives a share in basis points, or null for nothing', () => {
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(5, 0)).toBeNull();
  });
});
