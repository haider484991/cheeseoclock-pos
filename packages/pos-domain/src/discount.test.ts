import { describe, it, expect } from 'vitest';
import { allocateDiscount, computeDiscountCents, requiresManagerApproval } from './discount.js';

describe('computeDiscountCents', () => {
  it('computes percent discount', () => {
    expect(computeDiscountCents(10_000, { type: 'percent', value: 10 })).toBe(1_000);
    expect(computeDiscountCents(10_000, { type: 'percent', value: 50 })).toBe(5_000);
  });

  it('computes flat discount', () => {
    expect(computeDiscountCents(10_000, { type: 'flat', value: 500 })).toBe(500);
  });

  it('caps discount at subtotal', () => {
    expect(computeDiscountCents(1_000, { type: 'flat', value: 5_000 })).toBe(1_000);
    expect(computeDiscountCents(1_000, { type: 'percent', value: 150 })).toBe(1_000);
  });

  it('returns 0 for non-positive subtotal', () => {
    expect(computeDiscountCents(0, { type: 'percent', value: 10 })).toBe(0);
  });
});

describe('requiresManagerApproval', () => {
  it('flags large percent discounts', () => {
    expect(requiresManagerApproval({ type: 'percent', value: 5 })).toBe(false);
    expect(requiresManagerApproval({ type: 'percent', value: 11 })).toBe(true);
  });

  it('flags large flat discounts', () => {
    expect(requiresManagerApproval({ type: 'flat', value: 10_000 })).toBe(false);
    expect(requiresManagerApproval({ type: 'flat', value: 60_000 })).toBe(true);
  });

  it('flags a flat discount that is more than 10% of the order', () => {
    // Rs 499 off a Rs 600 order: under Rs 500, but 83% off.
    expect(requiresManagerApproval({ type: 'flat', value: 49_900 }, 60_000)).toBe(true);
    // Rs 200 off Rs 2,000 is exactly 10%: no PIN. Rs 201 is over.
    expect(requiresManagerApproval({ type: 'flat', value: 20_000 }, 200_000)).toBe(false);
    expect(requiresManagerApproval({ type: 'flat', value: 20_100 }, 200_000)).toBe(true);
    // Without a subtotal only the Rs 500 cap applies.
    expect(requiresManagerApproval({ type: 'flat', value: 49_900 })).toBe(false);
  });
});

describe('allocateDiscount', () => {
  it('splits Rs 1 over three equal lines without losing a paisa', () => {
    const shares = allocateDiscount([1_000, 1_000, 1_000], 100);
    expect(shares.reduce((s, x) => s + x, 0)).toBe(100);
    expect(shares).toEqual([34, 33, 33]);
  });

  it('always adds up to the discount, never more than a line', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 1_000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 500_000));
      const subtotal = lines.reduce((s, x) => s + x, 0);
      const discount = Math.floor(rnd() * (subtotal + 1));
      const shares = allocateDiscount(lines, discount);
      expect(shares.reduce((s, x) => s + x, 0)).toBe(subtotal > 0 ? discount : 0);
      shares.forEach((x, i) => {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(lines[i]!);
      });
    }
  });

  it('gives nothing when there is no discount or no subtotal', () => {
    expect(allocateDiscount([500, 700], 0)).toEqual([0, 0]);
    expect(allocateDiscount([0, 0], 100)).toEqual([0, 0]);
  });
});
