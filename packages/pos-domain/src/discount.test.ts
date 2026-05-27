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
});
