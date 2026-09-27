import { describe, expect, it } from 'vitest';
import {
  baseUnitConversion,
  convertPack,
  costPerUnitFromPack,
  effectivePack,
  formatPack,
  formatUnitCost,
  lineCostMc,
  mcToCents,
  mulDivRound,
  normalizeUnit,
  packInUnit,
  priceEntryChoices,
  shareBps,
  thousandSize,
  thousandWord,
  typedPricePack,
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

// ---------------------------------------------------------------------------
// Costing Phase 4: prices as typed, and prices across a Convert. Made-up prices.
// ---------------------------------------------------------------------------

describe('typedPricePack: a price as it is bought, kept exactly', () => {
  it('Rs 155 per kg values 1,000 g at exactly Rs 155 (a per-gram price in whole paisa would say Rs 160)', () => {
    const pack = typedPricePack({ per: 'thousand', priceCents: 15_500 }, 'g');
    expect(pack).toEqual({ size: 1000, priceCents: 15_500 });
    expect(valueCents(1000, pack)).toBe(15_500);
    expect(valueCents(1000, effectivePack({ costPerUnitCents: costPerUnitFromPack(15_500, 1000), packSize: null, packPriceCents: null }))).toBe(16_000);
    // …and every part of a kilo is exact too: 250 g is Rs 38.75.
    expect(valueCents(250, pack)).toBe(3_875);
  });

  it('per litre in ml; per kg or litre for an ingredient still counted in kg / litres', () => {
    expect(typedPricePack({ per: 'thousand', priceCents: 42_000 }, 'ml')).toEqual({ size: 1000, priceCents: 42_000 });
    expect(typedPricePack({ per: 'thousand', priceCents: 37_500 }, 'kg')).toEqual({ size: 1, priceCents: 37_500 });
    expect(typedPricePack({ per: 'thousand', priceCents: 30_000 }, 'Litres')).toEqual({ size: 1, priceCents: 30_000 });
  });

  it('per pack of N, and per piece', () => {
    expect(typedPricePack({ per: 'pack', priceCents: 225_000, packSize: 6000 }, 'g')).toEqual({ size: 6000, priceCents: 225_000 });
    expect(typedPricePack({ per: 'pack', priceCents: 500, packSize: 100 }, 'pcs')).toEqual({ size: 100, priceCents: 500 });
    expect(typedPricePack({ per: 'piece', priceCents: 4_000 }, 'pcs')).toEqual({ size: 1, priceCents: 4_000 });
    expect(typedPricePack({ per: 'piece', priceCents: 1_500 }, 'slice')).toEqual({ size: 1, priceCents: 1_500 });
  });

  it('refuses, in plain words, a way of pricing that does not fit the unit', () => {
    expect(() => typedPricePack({ per: 'piece', priceCents: 100 }, 'g')).toThrow(/Per piece does not fit something counted in g: use per kg or per pack/);
    expect(() => typedPricePack({ per: 'piece', priceCents: 100 }, 'ml')).toThrow(/use per litre/);
    expect(() => typedPricePack({ per: 'thousand', priceCents: 100 }, 'pcs')).toThrow(/only fits something weighed or measured/);
    expect(() => typedPricePack({ per: 'pack', priceCents: 100 }, 'g')).toThrow(/how much one pack holds/);
    expect(() => typedPricePack({ per: 'pack', priceCents: 100, packSize: 2.5 }, 'g')).toThrow(/how much one pack holds/);
    expect(() => typedPricePack({ per: 'thousand', priceCents: 10.5 }, 'g')).toThrow(/whole number/);
    expect(() => typedPricePack({ per: 'thousand', priceCents: -1 }, 'g')).toThrow(/below Rs 0/);
  });

  it('offers per kg / litre for weighed units and per piece otherwise, with per pack for all', () => {
    expect(priceEntryChoices('g')).toEqual(['thousand', 'pack']);
    expect(priceEntryChoices('kg')).toEqual(['thousand', 'pack']);
    expect(priceEntryChoices('pcs')).toEqual(['piece', 'pack']);
    expect([thousandWord('g'), thousandWord('ml'), thousandWord('l'), thousandWord('pcs')]).toEqual(['kg', 'litre', 'litre', null]);
    expect([thousandSize('g'), thousandSize('kg'), thousandSize('portion')]).toEqual([1000, 1, null]);
  });
});

describe('unit_cost_mc is exact for pack prices', () => {
  it('Rs 2,250 for 6,000 g is exactly Rs 375 per kg (37,500 mc a gram), never 38 paisa a gram', () => {
    expect(unitCostMc({ size: 6000, priceCents: 225_000 })).toBe(37_500);
    expect(unitCostMc({ size: 1000, priceCents: 15_500 })).toBe(15_500);
    expect(unitCostMc({ size: 12, priceCents: 1_000 })).toBe(83_333); // 12 cups for Rs 10: 83.333 paisa each
    expect(costPerUnitFromPack(225_000, 6000)).toBe(38); // the old whole-paisa figure, kept only for older screens
  });
});

describe('Convert leaves every value unchanged', () => {
  const packs = [
    { size: 1, priceCents: 37_500 }, // Rs 375 per kg, typed per kg
    { size: 6, priceCents: 225_000 }, // a 6 kg bag
    { size: 1, priceCents: 19 }, // an odd one: 19 paisa a kg
    { size: 3, priceCents: 1_000 },
  ];
  it('the pack holds 1,000× as many grams for the same money: every quantity is worth what it was', () => {
    for (const pack of packs) {
      const g = convertPack(pack, 1000);
      expect(g).toEqual({ size: pack.size * 1000, priceCents: pack.priceCents });
      for (const q of [1, 2, 3, 7, 10, 125, 999, 1_000, 12_345, -4, -1_001]) expect(valueCents(q * 1000, g)).toBe(valueCents(q, pack));
    }
  });

  it('packInUnit turns a price kept in one unit into the other, both ways, exactly', () => {
    const perKg = { size: 1, priceCents: 37_500 };
    expect(packInUnit(perKg, 'kg', 'g')).toEqual({ size: 1000, priceCents: 37_500 });
    const perGram = { size: 1000, priceCents: 37_500 };
    const inKg = packInUnit(perGram, 'g', 'kg')!;
    expect(inKg).toEqual({ size: 1000, priceCents: 37_500_000 });
    expect(valueCents(2, inKg)).toBe(valueCents(2000, perGram));
    expect(packInUnit(perGram, 'g', 'g')).toBe(perGram);
    expect(packInUnit(perGram, 'g', 'pcs')).toBeNull();
  });
});
