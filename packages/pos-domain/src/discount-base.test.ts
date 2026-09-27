import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_APPROVAL, isDeliveryChargeLine } from '@cheeseoclock/shared-types';
import { allocateDiscount, computeDiscountCents, requiresManagerApproval } from './discount.js';
import {
  discountBaseCents,
  discountRuleAlsoOffDeliveryCharge,
  discountSkipMask,
  discountWeights,
  lineTakesDiscount,
  parseDiscountBaseRule,
  splitDiscount,
  splitDiscountByMask,
  taxAfterDiscount,
  tillDiscountRule,
  websiteDiscountRule,
} from './discount-base.js';
import { dealAmount, foodpandaDealRule, parseFoodpandaDealRule } from './foodpanda.js';
import { splitOrderLines } from './profit.js';
import { orderFoodCost, type FoodCostLine } from './sale-cost.js';

/**
 * The owner, 28 Sep 2026: "Delivery charges is separate we don't want to add
 * discount to it". Made-up prices throughout: a Rs 1,200 pizza and a Rs 800
 * side at 16%, and a Rs 200 delivery charge at 16%.
 */
const PIZZA = { lineTotalCents: 120_000, menuItemName: 'Test Pizza', taxRateBps: 1600 };
const SIDE = { lineTotalCents: 80_000, menuItemName: 'Test Side', taxRateBps: 1600 };
const CHARGE = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)', taxRateBps: 1600 };
const ORDER = [PIZZA, CHARGE, SIDE];
const FOOD = 200_000;
const SUBTOTAL = 220_000;

describe('which line is a delivery charge: the name it was sold under, one test', () => {
  it('a "Delivery Charge (Rs N)" line is one; food, a missing name and look-alikes are not', () => {
    expect(isDeliveryChargeLine(CHARGE)).toBe(true);
    expect(isDeliveryChargeLine({ menuItemName: '  delivery charge (Rs 150)' })).toBe(true);
    expect(isDeliveryChargeLine(PIZZA)).toBe(false);
    expect(isDeliveryChargeLine({})).toBe(false);
    expect(isDeliveryChargeLine({ menuItemName: null })).toBe(false);
    expect(isDeliveryChargeLine({ menuItemName: 'Free delivery charge promo pizza' })).toBe(false);
  });
});

describe('the base: what a discount is worked on', () => {
  it('the food only, unless the rule says every line (the whole subtotal, as before)', () => {
    expect(discountBaseCents(ORDER, false)).toBe(FOOD);
    expect(discountBaseCents(ORDER, true)).toBe(SUBTOTAL);
    expect(discountWeights(ORDER, false)).toEqual([120_000, 0, 80_000]);
    expect(discountWeights(ORDER, true)).toEqual([120_000, 20_000, 80_000]);
    expect(lineTakesDiscount(CHARGE, false)).toBe(false);
    expect(lineTakesDiscount(CHARGE, true)).toBe(true);
    expect(discountSkipMask(ORDER, false)).toEqual([false, true, false]);
    expect(discountSkipMask(ORDER, true)).toEqual([false, false, false]);
  });

  it('a % is worked on the food only: 10% of Rs 2,000, not of Rs 2,200', () => {
    expect(computeDiscountCents(discountBaseCents(ORDER, false), { type: 'percent', value: 10 })).toBe(20_000);
    expect(computeDiscountCents(discountBaseCents(ORDER, true), { type: 'percent', value: 10 })).toBe(22_000);
  });

  it('a rupee amount bigger than the food is capped at the food', () => {
    expect(computeDiscountCents(discountBaseCents(ORDER, false), { type: 'flat', value: 300_000 })).toBe(FOOD);
    expect(computeDiscountCents(discountBaseCents(ORDER, true), { type: 'flat', value: 300_000 })).toBe(SUBTOTAL);
  });

  it('an order of only a delivery charge has nothing to discount', () => {
    expect(discountBaseCents([CHARGE], false)).toBe(0);
    expect(computeDiscountCents(0, { type: 'percent', value: 50 })).toBe(0);
  });
});

describe('the split: the delivery charge takes none of it', () => {
  it('10%: every paisa on the food, the shares add up to the discount', () => {
    const shares = splitDiscount(ORDER, 20_000, false);
    expect(shares).toEqual([12_000, 0, 8_000]);
    expect(shares.reduce((s, x) => s + x, 0)).toBe(20_000);
  });

  it('awkward paisa never land on the delivery charge (it weighs 0)', () => {
    const odd = [
      { lineTotalCents: 33_333, menuItemName: 'Test A' },
      { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' },
      { lineTotalCents: 33_333, menuItemName: 'Test B' },
      { lineTotalCents: 33_334, menuItemName: 'Test C' },
    ];
    for (const disc of [1, 2, 100, 33_333, 99_999, 100_000]) {
      const shares = splitDiscount(odd, disc, false);
      expect({ disc, charge: shares[1] }).toEqual({ disc, charge: 0 });
      expect(shares.reduce((s, x) => s + x, 0)).toBe(disc);
    }
  });

  it('with the switch on — or a row with no rule — it is today’s allocateDiscount exactly', () => {
    for (const disc of [0, 1, 777, 22_000, SUBTOTAL]) {
      expect(splitDiscount(ORDER, disc, true)).toEqual(allocateDiscount(ORDER.map((l) => l.lineTotalCents), disc));
      expect(splitDiscountByMask(ORDER.map((l) => l.lineTotalCents), disc)).toEqual(allocateDiscount(ORDER.map((l) => l.lineTotalCents), disc));
    }
  });

  it('the mask form (Reports) gives the same shares as the named form (the till)', () => {
    for (const disc of [1, 20_000, 199_999, FOOD]) {
      expect(splitDiscountByMask(ORDER.map((l) => l.lineTotalCents), disc, discountSkipMask(ORDER, false))).toEqual(
        splitDiscount(ORDER, disc, false),
      );
    }
  });

  it('tax: each line on what is left of it; 100% off leaves the delivery charge and its tax to pay', () => {
    // 10% of the food: tax 16% of (1,080 + 200 + 720) = Rs 320.
    expect(taxAfterDiscount(ORDER, 20_000, false)).toEqual({ shares: [12_000, 0, 8_000], taxCents: 32_000 });
    // 100% of the food: only the delivery charge is left, taxed in full.
    const all = taxAfterDiscount(ORDER, FOOD, false);
    expect(all.shares).toEqual([120_000, 0, 80_000]);
    expect(all.taxCents).toBe(3_200);
    expect(SUBTOTAL - FOOD + all.taxCents).toBe(23_200);
    // The switch on: 100% leaves nothing, as before.
    expect(taxAfterDiscount(ORDER, SUBTOTAL, true).taxCents).toBe(0);
  });
});

describe('the approval limit is checked on the same base', () => {
  it('Rs 100 off Rs 800 of food and a Rs 200 delivery charge is 12.5% of the food: a manager (it was 10% of the order)', () => {
    const lines = [
      { lineTotalCents: 80_000, menuItemName: 'Test Pizza' },
      { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' },
    ];
    const d = { type: 'flat' as const, value: 10_000 };
    expect(requiresManagerApproval(d, discountBaseCents(lines, false), DEFAULT_DISCOUNT_APPROVAL)).toBe(true);
    expect(requiresManagerApproval(d, discountBaseCents(lines, true), DEFAULT_DISCOUNT_APPROVAL)).toBe(false);
    // A % is a % whatever the base.
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, discountBaseCents(lines, false), DEFAULT_DISCOUNT_APPROVAL)).toBe(false);
  });
});

describe('the rule frozen on a discount row', () => {
  it('the till’s rule and the website’s read back as written', () => {
    expect(parseDiscountBaseRule(JSON.stringify(tillDiscountRule(false)))).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: false,
      from: 'till',
    });
    expect(parseDiscountBaseRule(JSON.stringify(websiteDiscountRule()))).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: true,
      from: 'website',
    });
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(tillDiscountRule(false)))).toBe(false);
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(tillDiscountRule(true)))).toBe(true);
  });

  it('a row with no rule — or one this version can’t read — is read the old way: over every line', () => {
    for (const json of [null, undefined, '', 'not json', '{}', '[]', '{"kind":"discount_base","v":2,"alsoOffDeliveryCharge":false}', '{"kind":"something_else","v":1}']) {
      expect({ json, also: discountRuleAlsoOffDeliveryCharge(json) }).toEqual({ json, also: true });
    }
  });

  it('the foodpanda deal: its own rule carries it; a deal frozen before 0.7.25 covers every line', () => {
    const deal = { v: 1, percent: 20, shopPercent: 20, minOrderCents: 150_000, maxOffCents: null, startsOn: null, endsOn: null };
    const old = foodpandaDealRule(deal, null, 0);
    expect('alsoOffDeliveryCharge' in old).toBe(false);
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(old))).toBe(true);
    const now = foodpandaDealRule(deal, null, 0, false);
    expect(parseFoodpandaDealRule(JSON.stringify(now))).toEqual(now);
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(now))).toBe(false);
    // Its % and its minimum are on the food: Rs 1,400 of food + a Rs 200 charge is under a Rs 1,500 minimum.
    const lines = [
      { lineTotalCents: 140_000, menuItemName: 'Test Pizza' },
      { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' },
    ];
    expect(dealAmount(now, discountBaseCents(lines, false)).dealCents).toBe(0);
    expect(dealAmount(old, discountBaseCents(lines, true)).dealCents).toBe(32_000);
  });
});

describe('profit and food cost follow the frozen rule', () => {
  it('splitOrderLines: the discount skips the delivery charge; part refunds still spread over every line', () => {
    const totals = ORDER.map((l) => l.lineTotalCents);
    const skips = discountSkipMask(ORDER, false);
    // 10% of the food (Rs 200), tax 16% of Rs 2,000 = Rs 320: total Rs 2,340; Rs 234 refunded.
    const s = splitOrderLines(totals, 20_000, 234_000, 23_400, skips);
    expect(s.discounts).toEqual([12_000, 0, 8_000]);
    expect(s.refunds[1]).toBeGreaterThan(0);
    expect(s.salesExTaxCents).toBe(SUBTOTAL - 20_000 - s.refundExTaxCents);
    // No mask = today's split exactly.
    expect(splitOrderLines(totals, 22_000, 255_200, 0).discounts).toEqual(allocateDiscount(totals, 22_000));
  });

  it('orderFoodCost: the delivery charge is fee sales at its full price when the discount left it alone', () => {
    const line = (l: typeof PIZZA, isFee: boolean, skipsDiscount?: boolean): FoodCostLine => ({
      key: l.menuItemName,
      name: l.menuItemName,
      quantity: 1,
      lineTotalCents: l.lineTotalCents,
      isFee,
      ...(skipsDiscount === undefined ? {} : { skipsDiscount }),
      parts: 1,
      costCents: 1_000,
      status: 'full',
      hasRecipeNow: true,
    });
    const now = orderFoodCost({
      discountCents: 20_000,
      totalCents: 232_000,
      refundedCents: 0,
      lines: [line(PIZZA, false, false), line(CHARGE, true, true), line(SIDE, false, false)],
      estimate: null,
    });
    expect({ food: now.foodSalesCents, fee: now.feeSalesCents }).toEqual({ food: 180_000, fee: 20_000 });
    // A legacy row (no mask): the charge took its 10%, as it was sold.
    const legacy = orderFoodCost({
      discountCents: 22_000,
      totalCents: 229_680,
      refundedCents: 0,
      lines: [line(PIZZA, false), line(CHARGE, true), line(SIDE, false)],
      estimate: null,
    });
    expect({ food: legacy.foodSalesCents, fee: legacy.feeSalesCents }).toEqual({ food: 180_000, fee: 18_000 });
  });
});
