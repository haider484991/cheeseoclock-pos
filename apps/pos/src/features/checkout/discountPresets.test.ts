import { describe, expect, it } from 'vitest';
import {
  FLAT_PRESETS_RUPEES,
  PERCENT_PRESETS,
  describeDiscount,
  describePreview,
  discountBaseNow,
  discountBaseText,
  discountDialogPrimary,
  discountDialogStart,
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

describe('the Discount dialog on an order with the owner’s foodpanda deal', () => {
  const deal = { discountType: 'percent' as const, value: 20, reason: 'Foodpanda deal 20% off', source: 'foodpanda' };

  it('opens on nothing: the deal’s own % is never re-applied as a staff discount, and its label is not a reason', () => {
    expect(discountDialogStart(deal)).toEqual({ picked: null, reason: '' });
    // A staff discount opens on itself, as before.
    expect(discountDialogStart({ discountType: 'percent', value: 10, reason: 'Regular customer', source: null })).toEqual({
      picked: { type: 'percent', value: 10 },
      reason: 'Regular customer',
    });
    expect(discountDialogStart({ discountType: 'flat', value: 20_000, reason: null })).toEqual({ picked: { type: 'flat', value: 20_000 }, reason: '' });
    expect(discountDialogStart(null)).toEqual({ picked: null, reason: '' });
  });

  it('× on the deal line, a manager’s PIN, Enter: the deal comes off (it is not put back as a staff 20%)', () => {
    const start = discountDialogStart(deal);
    expect(discountDialogPrimary({ dealOn: true, intent: 'removeDeal', hasChoice: start.picked !== null })).toBe('remove');
    // The manager picks what the tablet shows instead: Enter applies that.
    expect(discountDialogPrimary({ dealOn: true, intent: 'removeDeal', hasChoice: true })).toBe('apply');
  });

  it('opened to change it (F3, the deal line): Enter applies a choice and never takes the deal off by itself', () => {
    expect(discountDialogPrimary({ dealOn: true, intent: 'change', hasChoice: false })).toBe('apply');
    expect(discountDialogPrimary({ dealOn: true, intent: 'change', hasChoice: true })).toBe('apply');
    // No deal on the order: the × intent means nothing.
    expect(discountDialogPrimary({ dealOn: false, intent: 'removeDeal', hasChoice: false })).toBe('apply');
  });
});

describe('previewDiscount on an order with a delivery charge (the owner, 28 Sep 2026: no discount on it)', () => {
  // Made-up: a Rs 1,000 pizza and a Rs 800 side (Rs 1,800 of food) and a Rs 200 delivery charge, all at 16%.
  const withCharge = [
    { lineTotalCents: 100_000, taxRateBps: 1600, menuItemName: 'Test Pizza' },
    { lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' },
    { lineTotalCents: 80_000, taxRateBps: 1600, menuItemName: 'Test Side' },
  ];
  const sub = 200_000;
  const foodOnly = { approval: { percentOver: 10, flatOverCents: 50_000 }, alsoOffDeliveryCharge: false };
  const everyLine = { ...foodOnly, alsoOffDeliveryCharge: true };

  it('a % is of the food; the delivery charge is taxed in full', () => {
    // 10% of Rs 1,800 = Rs 180; tax 16% of (900 + 200 + 720) = Rs 291.20.
    expect(previewDiscount(withCharge, sub, percentChoice(10), foodOnly)).toEqual({
      discountCents: 18_000,
      taxCents: 29_120,
      totalCents: 211_120,
      needsApproval: false,
      capped: false,
    });
    expect(discountBaseText(discountBaseNow(withCharge, sub, foodOnly), sub)).toBe(
      'Food Rs 1,800 before tax · delivery charge Rs 200 not discounted',
    );
  });

  it('100% off leaves the delivery charge and its tax to pay', () => {
    expect(previewDiscount(withCharge, sub, percentChoice(100), foodOnly)).toMatchObject({ discountCents: 180_000, taxCents: 3_200, totalCents: 23_200 });
  });

  it('rupees are capped at the food, and it says so', () => {
    const p = previewDiscount(withCharge, sub, flatChoiceRupees(5_000), foodOnly);
    expect(p).toMatchObject({ discountCents: 180_000, capped: true, totalCents: 23_200 });
    expect(describePreview(flatChoiceRupees(5_000), p, discountBaseNow(withCharge, sub, foodOnly))).toBe('Rs 5,000 off food (all the food)');
    expect(describePreview(percentChoice(10), previewDiscount(withCharge, sub, percentChoice(10), foodOnly), discountBaseNow(withCharge, sub, foodOnly))).toBe(
      '10% off food',
    );
  });

  it('the lock is on the food: Rs 190 off is over 10% of Rs 1,800 (it was under 10% of Rs 2,000)', () => {
    expect(previewDiscount(withCharge, sub, flatChoiceRupees(190), foodOnly).needsApproval).toBe(true);
    expect(previewDiscount(withCharge, sub, flatChoiceRupees(190), everyLine).needsApproval).toBe(false);
  });

  it('the owner’s switch on: the old maths, exactly as a till before 0.7.25', () => {
    const legacyLines = withCharge.map(({ lineTotalCents, taxRateBps }) => ({ lineTotalCents, taxRateBps }));
    for (const choice of [percentChoice(10), percentChoice(100), flatChoiceRupees(5_000), flatChoiceRupees(1)]) {
      expect(previewDiscount(withCharge, sub, choice, everyLine)).toEqual(previewDiscount(legacyLines, sub, choice, everyLine));
    }
    expect(previewDiscount(withCharge, sub, percentChoice(10), everyLine)).toMatchObject({ discountCents: 20_000, taxCents: 28_800 });
    expect(discountBaseText(discountBaseNow(withCharge, sub, everyLine), sub)).toBe('Order Rs 2,000 before tax');
  });
});
