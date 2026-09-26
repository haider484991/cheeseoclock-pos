import { describe, expect, it } from 'vitest';
import {
  FLAT_PRESETS_RUPEES,
  PERCENT_PRESETS,
  describeDiscount,
  flatChoiceRupees,
  parseDiscountEntry,
  percentChoice,
  previewDiscount,
  sameChoice,
} from './discountPresets';

// Made-up prices: Rs 1,000 + Rs 500 at 16% tax, and a Rs 300 untaxed line.
const lines = [
  { lineTotalCents: 100_000, taxRateBps: 1600 },
  { lineTotalCents: 50_000, taxRateBps: 1600 },
  { lineTotalCents: 30_000, taxRateBps: 0 },
];
const subtotal = 180_000;

describe('discount presets', () => {
  it('offers the owner’s one-tap amounts', () => {
    expect([...PERCENT_PRESETS]).toEqual([10, 20, 25, 50, 100]);
    expect([...FLAT_PRESETS_RUPEES]).toEqual([100, 200, 500]);
    expect(flatChoiceRupees(200)).toEqual({ type: 'flat', value: 20_000 });
  });

  it('describes a discount in plain words', () => {
    expect(describeDiscount(percentChoice(25))).toBe('25% off');
    expect(describeDiscount(flatChoiceRupees(500))).toBe('Rs 500 off');
  });

  it('compares choices by type and value', () => {
    expect(sameChoice(percentChoice(10), { type: 'percent', value: 10 })).toBe(true);
    expect(sameChoice(percentChoice(10), flatChoiceRupees(10))).toBe(false);
    expect(sameChoice(null, percentChoice(10))).toBe(false);
  });
});

describe('parseDiscountEntry', () => {
  it('reads percentages from 0 to 100', () => {
    expect(parseDiscountEntry('percent', '15')).toEqual({ type: 'percent', value: 15 });
    expect(parseDiscountEntry('percent', '12.5')).toEqual({ type: 'percent', value: 12.5 });
    expect(parseDiscountEntry('percent', '100')).toEqual({ type: 'percent', value: 100 });
    expect(parseDiscountEntry('percent', '101')).toBeNull();
  });

  it('turns rupees into whole paisa', () => {
    expect(parseDiscountEntry('flat', '250')).toEqual({ type: 'flat', value: 25_000 });
    expect(parseDiscountEntry('flat', '1,250')).toEqual({ type: 'flat', value: 125_000 });
    expect(parseDiscountEntry('flat', '0.1')).toEqual({ type: 'flat', value: 10 });
    // 19.99 * 100 is 1998.9999… in floating point: still exactly 1999 paisa.
    expect(parseDiscountEntry('flat', '19.99')).toEqual({ type: 'flat', value: 1_999 });
  });

  it('refuses empty, zero, negative and junk', () => {
    for (const bad of ['', '  ', '0', '-5', 'abc', '1e3', '10%', '.']) {
      expect(parseDiscountEntry('flat', bad)).toBeNull();
      expect(parseDiscountEntry('percent', bad)).toBeNull();
    }
  });
});

describe('previewDiscount', () => {
  it('with no discount shows the bill as it stands', () => {
    const p = previewDiscount(lines, subtotal, null);
    expect(p).toEqual({ discountCents: 0, taxCents: 24_000, totalCents: 204_000, needsApproval: false, capped: false });
  });

  it('works out a percentage, tax on what is left of each line', () => {
    // 10% of 1,800 = 180, split 100 / 50 / 30. Tax = 16% of (900 + 450) = 216.
    const p = previewDiscount(lines, subtotal, percentChoice(10));
    expect(p.discountCents).toBe(18_000);
    expect(p.taxCents).toBe(21_600);
    expect(p.totalCents).toBe(180_000 - 18_000 + 21_600);
    expect(p.needsApproval).toBe(false);
  });

  it('needs a manager over 10%', () => {
    expect(previewDiscount(lines, subtotal, percentChoice(20)).needsApproval).toBe(true);
    expect(previewDiscount(lines, subtotal, percentChoice(10)).needsApproval).toBe(false);
  });

  it('a flat amount over 10% of the order needs a manager too', () => {
    // Rs 100 off Rs 1,800 is under 10%; Rs 200 is over.
    expect(previewDiscount(lines, subtotal, flatChoiceRupees(100)).needsApproval).toBe(false);
    expect(previewDiscount(lines, subtotal, flatChoiceRupees(200)).needsApproval).toBe(true);
  });

  it('100% off leaves nothing to pay, tax included', () => {
    const p = previewDiscount(lines, subtotal, percentChoice(100));
    expect(p.discountCents).toBe(subtotal);
    expect(p.taxCents).toBe(0);
    expect(p.totalCents).toBe(0);
  });

  it('a flat amount bigger than the order only takes the order’s worth', () => {
    const small = [{ lineTotalCents: 30_000, taxRateBps: 1600 }];
    const p = previewDiscount(small, 30_000, flatChoiceRupees(500));
    expect(p.capped).toBe(true);
    expect(p.discountCents).toBe(30_000);
    expect(p.totalCents).toBe(0);
  });

  it('never loses a paisa over awkward splits', () => {
    const odd = [
      { lineTotalCents: 33_333, taxRateBps: 1600 },
      { lineTotalCents: 33_333, taxRateBps: 1600 },
      { lineTotalCents: 33_334, taxRateBps: 1600 },
    ];
    const p = previewDiscount(odd, 100_000, flatChoiceRupees(1));
    expect(p.discountCents).toBe(100);
    expect(p.totalCents).toBe(100_000 - 100 + p.taxCents);
    expect(p.taxCents).toBe(15_984);
  });

  it('an empty order has nothing to discount', () => {
    expect(previewDiscount([], 0, percentChoice(50))).toMatchObject({ discountCents: 0, taxCents: 0, totalCents: 0 });
  });
});
