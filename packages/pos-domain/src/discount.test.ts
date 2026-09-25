import { describe, it, expect } from 'vitest';
import { computeDiscountCents, requiresManagerApproval } from './discount.js';

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
