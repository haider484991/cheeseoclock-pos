import { describe, expect, it } from 'vitest';
import {
  baseUnitConversion,
  costPerUnitFromPack,
  formatPack,
  formatUnitCost,
  normalizeUnit,
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
