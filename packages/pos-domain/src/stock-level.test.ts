import { describe, expect, it } from 'vitest';
import { formatQty, stockFill, stockStatus, stockUrgency, stockValueCents } from './stock-level.js';

describe('stockStatus', () => {
  it('is out at zero or below', () => {
    expect(stockStatus({ currentQty: 0, lowThreshold: 500 })).toBe('out');
    expect(stockStatus({ currentQty: -20, lowThreshold: 0 })).toBe('out');
  });
  it('is low at or under the low level', () => {
    expect(stockStatus({ currentQty: 500, lowThreshold: 500 })).toBe('low');
    expect(stockStatus({ currentQty: 1, lowThreshold: 500 })).toBe('low');
  });
  it('is fine above it, or with no low level set', () => {
    expect(stockStatus({ currentQty: 501, lowThreshold: 500 })).toBe('ok');
    expect(stockStatus({ currentQty: 3, lowThreshold: 0 })).toBe('ok');
  });
});

describe('stockFill', () => {
  it('puts the low level a third of the way along', () => {
    expect(stockFill({ currentQty: 500, lowThreshold: 500 })).toBeCloseTo(1 / 3);
    expect(stockFill({ currentQty: 1500, lowThreshold: 500 })).toBe(1);
    expect(stockFill({ currentQty: 9000, lowThreshold: 500 })).toBe(1);
  });
  it('is empty when out and full when no low level is set', () => {
    expect(stockFill({ currentQty: 0, lowThreshold: 500 })).toBe(0);
    expect(stockFill({ currentQty: 10, lowThreshold: 0 })).toBe(1);
  });
});

describe('stockUrgency', () => {
  it('orders out, then low (furthest under first), then fine', () => {
    const items = [
      { name: 'fine', currentQty: 5000, lowThreshold: 1000 },
      { name: 'low-half', currentQty: 500, lowThreshold: 1000 },
      { name: 'out', currentQty: 0, lowThreshold: 1000 },
      { name: 'low-edge', currentQty: 1000, lowThreshold: 1000 },
      { name: 'no-level', currentQty: 3, lowThreshold: 0 },
      { name: 'owed', currentQty: -50, lowThreshold: 10 },
    ];
    const sorted = [...items].sort((a, b) => stockUrgency(a) - stockUrgency(b)).map((i) => i.name);
    expect(sorted).toEqual(['owed', 'out', 'low-half', 'low-edge', 'fine', 'no-level']);
  });
});

describe('stockValueCents', () => {
  it('uses the exact pack price when there is one', () => {
    // 3,000 g of a 6,000 g pack that costs Rs 2,250 → Rs 1,125
    expect(stockValueCents({ currentQty: 3000, costPerUnitCents: 38, packSize: 6000, packPriceCents: 225_000 })).toBe(
      112_500,
    );
  });
  it('falls back to the per-unit cost', () => {
    expect(stockValueCents({ currentQty: 12, costPerUnitCents: 4_500, packSize: null, packPriceCents: null })).toBe(
      54_000,
    );
  });
  it('never values stock below zero', () => {
    expect(stockValueCents({ currentQty: -40, costPerUnitCents: 100, packSize: null, packPriceCents: null })).toBe(0);
  });
});

describe('formatQty', () => {
  it('shows grams and ml in kg and litres once there is enough', () => {
    expect(formatQty(12_500, 'g')).toBe('12.5 kg');
    expect(formatQty(1_000, 'g')).toBe('1 kg');
    expect(formatQty(1_234, 'g')).toBe('1.23 kg');
    expect(formatQty(750, 'g')).toBe('750 g');
    expect(formatQty(1_500, 'ml')).toBe('1.5 L');
    expect(formatQty(250, 'ml')).toBe('250 ml');
  });
  it('keeps every other unit as it is, with thousands separators', () => {
    expect(formatQty(1_200, 'pcs')).toBe('1,200 pcs');
    expect(formatQty(3, 'slice')).toBe('3 slice');
  });
  it('keeps the sign of a negative quantity', () => {
    expect(formatQty(-2_500, 'g')).toBe('-2.5 kg');
    expect(formatQty(-5, 'pcs')).toBe('-5 pcs');
  });
});
