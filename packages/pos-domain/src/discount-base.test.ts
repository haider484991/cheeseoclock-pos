import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOUNT_APPROVAL, isDeliveryChargeLine } from '@cheeseoclock/shared-types';
import { allocateDiscount, computeDiscountCents, requiresManagerApproval, weightsThatCarry } from './discount.js';
import {
  discountBaseCents,
  discountRuleAlsoOffDeliveryCharge,
  discountRuleScope,
  discountSkipMask,
  discountWeights,
  lineTakesDiscount,
  parseDiscountBaseRule,
  reworkedDiscountCents,
  splitDiscount,
  splitDiscountByMask,
  storedDiscountAlsoOffDeliveryCharge,
  storedDiscountScope,
  storedDiscountSkips,
  taxAfterDiscount,
  tillDiscountRule,
  websiteDiscountRule,
  type DiscountScope,
  type TaxedDiscountLine,
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
/** The two scopes every discount before 0.7.34 was worked on: value deals not told apart. */
const FOOD_ONLY: DiscountScope = { alsoOffDeliveryCharge: false, skipsNoDiscountLines: false };
const EVERY_LINE: DiscountScope = { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false };

describe('which line is a delivery charge: the name it was sold under, one test', () => {
  it('a "Delivery Charge (Rs N)" line is one; food, a missing name and look-alikes are not', () => {
    expect(isDeliveryChargeLine(CHARGE)).toBe(true);
    expect(isDeliveryChargeLine({ menuItemName: '  delivery charge (Rs 150)' })).toBe(true);
    expect(isDeliveryChargeLine(PIZZA)).toBe(false);
    expect(isDeliveryChargeLine({})).toBe(false);
    expect(isDeliveryChargeLine({ menuItemName: null })).toBe(false);
    expect(isDeliveryChargeLine({ menuItemName: 'Free delivery charge promo pizza' })).toBe(false);
  });

  it('Settings step 3: a line of one of the areas’ fee items is one too, by id — and the name alone still decides history', () => {
    const FEE_IDS = new Set(['fee-item-300']);
    // Sold under a name that does not say it (an older till renamed the item): the id tells.
    const renamed = { lineTotalCents: 30_000, menuItemName: 'Rider fee', menuItemId: 'fee-item-300', taxRateBps: 1600 };
    expect(isDeliveryChargeLine(renamed, FEE_IDS)).toBe(true);
    expect(isDeliveryChargeLine(renamed)).toBe(false);
    // By name, with or without ids.
    expect(isDeliveryChargeLine({ ...CHARGE, menuItemId: 'legacy-200' }, FEE_IDS)).toBe(true);
    expect(isDeliveryChargeLine({ ...PIZZA, menuItemId: 'pizza' }, FEE_IDS)).toBe(false);
    // The v0.7.26 rule on the discount base: the fee line takes none of it, by id or by name.
    const order = [{ ...PIZZA, menuItemId: 'pizza' }, renamed, { ...CHARGE, menuItemId: 'legacy-200' }];
    expect(discountBaseCents(order, FOOD_ONLY, FEE_IDS)).toBe(120_000);
    expect(discountBaseCents(order, FOOD_ONLY)).toBe(150_000);
    expect(discountBaseCents(order, EVERY_LINE, FEE_IDS)).toBe(170_000);
    expect(lineTakesDiscount(renamed, FOOD_ONLY, FEE_IDS)).toBe(false);
    expect(splitDiscount(order, 12_000, FOOD_ONLY, FEE_IDS)).toEqual([12_000, 0, 0]);
  });
});

describe('the base: what a discount is worked on', () => {
  it('the food only, unless the rule says every line (the whole subtotal, as before)', () => {
    expect(discountBaseCents(ORDER, FOOD_ONLY)).toBe(FOOD);
    expect(discountBaseCents(ORDER, EVERY_LINE)).toBe(SUBTOTAL);
    expect(discountWeights(ORDER, FOOD_ONLY)).toEqual([120_000, 0, 80_000]);
    expect(discountWeights(ORDER, EVERY_LINE)).toEqual([120_000, 20_000, 80_000]);
    expect(lineTakesDiscount(CHARGE, FOOD_ONLY)).toBe(false);
    expect(lineTakesDiscount(CHARGE, EVERY_LINE)).toBe(true);
    expect(discountSkipMask(ORDER, FOOD_ONLY)).toEqual([false, true, false]);
    expect(discountSkipMask(ORDER, EVERY_LINE)).toEqual([false, false, false]);
  });

  it('a % is worked on the food only: 10% of Rs 2,000, not of Rs 2,200', () => {
    expect(computeDiscountCents(discountBaseCents(ORDER, FOOD_ONLY), { type: 'percent', value: 10 })).toBe(20_000);
    expect(computeDiscountCents(discountBaseCents(ORDER, EVERY_LINE), { type: 'percent', value: 10 })).toBe(22_000);
  });

  it('a rupee amount bigger than the food is capped at the food', () => {
    expect(computeDiscountCents(discountBaseCents(ORDER, FOOD_ONLY), { type: 'flat', value: 300_000 })).toBe(FOOD);
    expect(computeDiscountCents(discountBaseCents(ORDER, EVERY_LINE), { type: 'flat', value: 300_000 })).toBe(SUBTOTAL);
  });

  it('an order of only a delivery charge has nothing to discount', () => {
    expect(discountBaseCents([CHARGE], FOOD_ONLY)).toBe(0);
    expect(computeDiscountCents(0, { type: 'percent', value: 50 })).toBe(0);
  });
});

describe('the split: the delivery charge takes none of it', () => {
  it('10%: every paisa on the food, the shares add up to the discount', () => {
    const shares = splitDiscount(ORDER, 20_000, FOOD_ONLY);
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
      const shares = splitDiscount(odd, disc, FOOD_ONLY);
      expect({ disc, charge: shares[1] }).toEqual({ disc, charge: 0 });
      expect(shares.reduce((s, x) => s + x, 0)).toBe(disc);
    }
  });

  it('with the switch on — or a row with no rule — it is today’s allocateDiscount exactly', () => {
    for (const disc of [0, 1, 777, 22_000, SUBTOTAL]) {
      expect(splitDiscount(ORDER, disc, EVERY_LINE)).toEqual(allocateDiscount(ORDER.map((l) => l.lineTotalCents), disc));
      expect(splitDiscountByMask(ORDER.map((l) => l.lineTotalCents), disc)).toEqual(allocateDiscount(ORDER.map((l) => l.lineTotalCents), disc));
    }
  });

  it('the mask form (Reports) gives the same shares as the named form (the till)', () => {
    for (const disc of [1, 20_000, 199_999, FOOD]) {
      expect(splitDiscountByMask(ORDER.map((l) => l.lineTotalCents), disc, discountSkipMask(ORDER, FOOD_ONLY))).toEqual(
        splitDiscount(ORDER, disc, FOOD_ONLY),
      );
    }
  });

  it('tax: each line on what is left of it; 100% off leaves the delivery charge and its tax to pay', () => {
    // 10% of the food: tax 16% of (1,080 + 200 + 720) = Rs 320.
    expect(taxAfterDiscount(ORDER, 20_000, FOOD_ONLY)).toEqual({ shares: [12_000, 0, 8_000], taxCents: 32_000 });
    // 100% of the food: only the delivery charge is left, taxed in full.
    const all = taxAfterDiscount(ORDER, FOOD, FOOD_ONLY);
    expect(all.shares).toEqual([120_000, 0, 80_000]);
    expect(all.taxCents).toBe(3_200);
    expect(SUBTOTAL - FOOD + all.taxCents).toBe(23_200);
    // The switch on: 100% leaves nothing, as before.
    expect(taxAfterDiscount(ORDER, SUBTOTAL, EVERY_LINE).taxCents).toBe(0);
  });
});

describe('the approval limit is checked on the same base', () => {
  it('Rs 100 off Rs 800 of food and a Rs 200 delivery charge is 12.5% of the food: a manager (it was 10% of the order)', () => {
    const lines = [
      { lineTotalCents: 80_000, menuItemName: 'Test Pizza' },
      { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' },
    ];
    const d = { type: 'flat' as const, value: 10_000 };
    expect(requiresManagerApproval(d, discountBaseCents(lines, FOOD_ONLY), DEFAULT_DISCOUNT_APPROVAL)).toBe(true);
    expect(requiresManagerApproval(d, discountBaseCents(lines, EVERY_LINE), DEFAULT_DISCOUNT_APPROVAL)).toBe(false);
    // A % is a % whatever the base.
    expect(requiresManagerApproval({ type: 'percent', value: 10 }, discountBaseCents(lines, FOOD_ONLY), DEFAULT_DISCOUNT_APPROVAL)).toBe(false);
  });
});

describe('the rule frozen on a discount row', () => {
  it('the till’s rule and the website’s read back as written', () => {
    expect(parseDiscountBaseRule(JSON.stringify(tillDiscountRule(false, false)))).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: false,
      from: 'till',
    });
    expect(parseDiscountBaseRule(JSON.stringify(websiteDiscountRule(false)))).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: true,
      from: 'website',
    });
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(tillDiscountRule(false, false)))).toBe(false);
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(tillDiscountRule(true, false)))).toBe(true);
  });

  it('a row with no rule — or one this version can’t read — is read the old way: over every line', () => {
    for (const json of [null, undefined, '', 'not json', '{}', '[]', '{"kind":"discount_base","v":2,"alsoOffDeliveryCharge":false}', '{"kind":"something_else","v":1}']) {
      expect({ json, also: discountRuleAlsoOffDeliveryCharge(json) }).toEqual({ json, also: true });
    }
  });

  it('the foodpanda deal: its own rule carries it; a deal frozen before 0.7.26 covers every line', () => {
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
    expect(dealAmount(now, discountBaseCents(lines, FOOD_ONLY)).dealCents).toBe(0);
    expect(dealAmount(old, discountBaseCents(lines, EVERY_LINE)).dealCents).toBe(32_000);
  });
});

describe('profit and food cost follow the frozen rule', () => {
  it('splitOrderLines: the discount skips the delivery charge; part refunds still spread over every line', () => {
    const totals = ORDER.map((l) => l.lineTotalCents);
    const skips = discountSkipMask(ORDER, FOOD_ONLY);
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

/**
 * Both tills not yet on the same version: a till older than the rule (0.7.25
 * or before) re-works an open order's food-only discount over every line on
 * a cart change, and leaves the row's rule saying "food only". Readers then
 * follow the STORED bill (it is never recomputed), so the FBR invoice, profit
 * and the refund still add up to it.
 */
describe('a food-only discount an older till re-worked over every line', () => {
  const food = tillDiscountRule(false, false);
  const foodJson = JSON.stringify(food);
  /** What a till before the rule stores: the discount over the subtotal, the tax on its every-line split. */
  const olderTill = (lines: typeof ORDER, d: { type: 'percent' | 'flat'; value: number }) => {
    const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
    const discountCents = computeDiscountCents(subtotal, d) as number;
    return { discountCents, taxCents: taxAfterDiscount(lines, discountCents, EVERY_LINE).taxCents };
  };

  it('100% off (Rs 2,200: more than the food): split over every line, never capped at the food', () => {
    const { discountCents, taxCents } = olderTill(ORDER, { type: 'percent', value: 100 });
    expect({ discountCents, taxCents }).toEqual({ discountCents: SUBTOTAL, taxCents: 0 });
    expect(storedDiscountAlsoOffDeliveryCharge(false, ORDER, discountCents, taxCents)).toBe(true);
    expect(storedDiscountAlsoOffDeliveryCharge(false, ORDER, discountCents)).toBe(true);
    // Even a reader that is handed the food-only rule adds up to the stored discount.
    expect(splitDiscount(ORDER, discountCents, FOOD_ONLY)).toEqual([120_000, 20_000, 80_000]);
    expect(splitDiscountByMask(ORDER.map((l) => l.lineTotalCents), discountCents, [false, true, false])).toEqual([120_000, 20_000, 80_000]);
    expect(taxAfterDiscount(ORDER, discountCents, FOOD_ONLY).taxCents).toBe(0);
    const s = splitOrderLines(ORDER.map((l) => l.lineTotalCents), discountCents, 0, 0, [false, true, false]);
    expect(s.salesExTaxCents).toBe(0);
    expect(s.discounts).toEqual([120_000, 20_000, 80_000]);
    // The food-only weights carry up to their sum (whole paisa); one paisa more and every line takes a share.
    expect(weightsThatCarry([1, 2, 3], [1, 0, 3], 4)).toEqual([1, 0, 3]);
    expect(weightsThatCarry([1, 2, 3], [1, 0, 3], 4.4)).toEqual([1, 0, 3]);
    expect(weightsThatCarry([1, 2, 3], [1, 0, 3], 5)).toEqual([1, 2, 3]);
  });

  it('10% with the delivery charge at another tax rate: the stored tax tells the two splits apart', () => {
    const charge5 = { ...CHARGE, taxRateBps: 500 };
    const lines = [PIZZA, charge5, SIDE];
    const { discountCents, taxCents } = olderTill(lines, { type: 'percent', value: 10 });
    // Rs 220 over every line: food 16% of Rs 1,800 = Rs 288, the charge 5% of Rs 180 = Rs 9.
    expect({ discountCents, taxCents }).toEqual({ discountCents: 22_000, taxCents: 29_700 });
    expect(taxAfterDiscount(lines, discountCents, FOOD_ONLY).taxCents).toBe(29_480);
    expect(storedDiscountAlsoOffDeliveryCharge(false, lines, discountCents, taxCents)).toBe(true);
    expect(storedDiscountSkips(foodJson, lines, discountCents, taxCents)).toEqual([false, false, false]);
    // Without the tax to go by, the frozen rule stands (Rs 220 is under the food).
    expect(storedDiscountAlsoOffDeliveryCharge(false, lines, discountCents)).toBe(false);
  });

  it('what this version stores is always read by its frozen rule', () => {
    for (const d of [
      { type: 'percent' as const, value: 10 },
      { type: 'percent' as const, value: 100 },
      { type: 'flat' as const, value: 33_333 },
      { type: 'flat' as const, value: 300_000 },
    ]) {
      for (const lines of [ORDER, [PIZZA, { ...CHARGE, taxRateBps: 500 }, SIDE]]) {
        const discountCents = computeDiscountCents(discountBaseCents(lines, FOOD_ONLY), d) as number;
        const { taxCents } = taxAfterDiscount(lines, discountCents, FOOD_ONLY);
        expect({ d, food: storedDiscountAlsoOffDeliveryCharge(false, lines, discountCents, taxCents) }).toEqual({ d, food: false });
        expect(storedDiscountSkips(foodJson, lines, discountCents, taxCents)).toEqual([false, true, false]);
      }
    }
  });

  it('a rule that covers every line, a row with no rule, no discount or no delivery charge: nothing to tell apart', () => {
    expect(storedDiscountAlsoOffDeliveryCharge(true, ORDER, 22_000, 31_680)).toBe(true);
    expect(storedDiscountSkips(null, ORDER, 22_000, 31_680)).toEqual([false, false, false]);
    expect(storedDiscountAlsoOffDeliveryCharge(false, ORDER, 0, 35_200)).toBe(false);
    expect(storedDiscountAlsoOffDeliveryCharge(false, [PIZZA, SIDE], 20_000, 28_800)).toBe(false);
  });
});

/**
 * The owner, 2 Oct 2026: value deals never get any discount. A line carries
 * its own frozen mark (order_items.no_discount → `noDiscount`) and the rule
 * frozen on the discount row says whether it skips them
 * (skipsNoDiscountLines). Made-up names and prices: a Rs 1,500 pizza, a
 * Rs 3,600 deal and a Rs 200 delivery charge, at 15%.
 */
describe('value deals never get a discount', () => {
  const PIZZA_15 = { lineTotalCents: 150_000, menuItemName: 'Test Pizza', taxRateBps: 1500 };
  const DEAL = { lineTotalCents: 360_000, menuItemName: 'Test Deal for Two', taxRateBps: 1500, noDiscount: true };
  const CHARGE_15 = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)', taxRateBps: 1500 };
  const MIXED = [PIZZA_15, DEAL, CHARGE_15];
  const FOOD_NO_DEALS: DiscountScope = { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true };
  const ALL_BUT_DEALS: DiscountScope = { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true };

  it('the base: the food without the deal, the deal in too, the delivery charge in too', () => {
    expect(discountBaseCents(MIXED, FOOD_NO_DEALS)).toBe(150_000);
    expect(discountBaseCents(MIXED, FOOD_ONLY)).toBe(510_000);
    expect(discountBaseCents(MIXED, ALL_BUT_DEALS)).toBe(170_000);
    expect(discountBaseCents(MIXED, EVERY_LINE)).toBe(530_000);
    expect(discountWeights(MIXED, FOOD_NO_DEALS)).toEqual([150_000, 0, 0]);
    expect(lineTakesDiscount(DEAL, FOOD_NO_DEALS)).toBe(false);
    expect(lineTakesDiscount(DEAL, ALL_BUT_DEALS)).toBe(false);
    expect(discountSkipMask(MIXED, FOOD_NO_DEALS)).toEqual([false, true, true]);
    expect(discountSkipMask(MIXED, ALL_BUT_DEALS)).toEqual([false, true, false]);
  });

  it('10% is Rs 150, all of it on the pizza; tax on what is left of each line; a flat Rs 3,000 is capped at Rs 1,500', () => {
    const tenPct = computeDiscountCents(discountBaseCents(MIXED, FOOD_NO_DEALS), { type: 'percent', value: 10 }) as number;
    expect(tenPct).toBe(15_000);
    expect(splitDiscount(MIXED, tenPct, FOOD_NO_DEALS)).toEqual([15_000, 0, 0]);
    // 15% of Rs 1,350 + Rs 3,600 + Rs 200.
    expect(taxAfterDiscount(MIXED, tenPct, FOOD_NO_DEALS)).toEqual({ shares: [15_000, 0, 0], taxCents: 20_250 + 54_000 + 3_000 });
    expect(computeDiscountCents(discountBaseCents(MIXED, FOOD_NO_DEALS), { type: 'flat', value: 300_000 })).toBe(150_000);
    // The mask form (Reports) agrees with the named form.
    expect(splitDiscountByMask(MIXED.map((l) => l.lineTotalCents), tenPct, discountSkipMask(MIXED, FOOD_NO_DEALS))).toEqual([15_000, 0, 0]);
  });

  it('every line a deal: nothing to work on, nothing off, no share anywhere', () => {
    const deals = [DEAL, { ...DEAL, lineTotalCents: 480_000, menuItemName: 'Test Deal for Four' }];
    for (const scope of [FOOD_NO_DEALS, ALL_BUT_DEALS]) {
      const base = discountBaseCents(deals, scope);
      expect(base).toBe(0);
      const off = computeDiscountCents(base, { type: 'percent', value: 10 }) as number;
      expect(off).toBe(0);
      expect(splitDiscount(deals, off, scope)).toEqual([0, 0]);
      expect(taxAfterDiscount(deals, off, scope).shares).toEqual([0, 0]);
    }
  });

  it('a delivery of deals only and its "Delivery Charge (Rs 200)": base 0 on the food, and the charge takes no share', () => {
    const delivery = [DEAL, CHARGE_15];
    expect(discountBaseCents(delivery, FOOD_NO_DEALS)).toBe(0);
    expect(lineTakesDiscount(CHARGE_15, FOOD_NO_DEALS)).toBe(false);
    const off = computeDiscountCents(discountBaseCents(delivery, FOOD_NO_DEALS), { type: 'percent', value: 10 }) as number;
    expect(off).toBe(0);
    const shares = splitDiscount(delivery, off, FOOD_NO_DEALS);
    expect(shares[1]).toBe(0);
    expect(shares).toEqual([0, 0]);
  });

  it('the mark is ignored when the rule does not skip deals (the foodpanda deal, a rule from before 0.7.34)', () => {
    expect(discountWeights(MIXED, FOOD_ONLY)).toEqual([150_000, 360_000, 0]);
    expect(discountWeights(MIXED, EVERY_LINE)).toEqual([150_000, 360_000, 20_000]);
    expect(lineTakesDiscount(DEAL, FOOD_ONLY)).toBe(true);
    expect(discountSkipMask(MIXED, FOOD_ONLY)).toEqual([false, false, true]);
    // The same order without the mark splits exactly the same.
    const unmarked = [PIZZA_15, { ...DEAL, noDiscount: false }, CHARGE_15];
    for (const disc of [1, 15_000, 51_000, 510_000]) {
      expect(splitDiscount(MIXED, disc, FOOD_ONLY)).toEqual(splitDiscount(unmarked, disc, FOOD_ONLY));
      expect(taxAfterDiscount(MIXED, disc, EVERY_LINE)).toEqual(taxAfterDiscount(unmarked, disc, EVERY_LINE));
    }
  });

  it('the rule: skipsNoDiscountLines is written only when true, and reads back', () => {
    // A rule that does not skip is the JSON every till wrote before 0.7.34, byte for byte.
    expect(JSON.stringify(tillDiscountRule(false, false))).toBe('{"kind":"discount_base","v":1,"alsoOffDeliveryCharge":false,"from":"till"}');
    expect(JSON.stringify(tillDiscountRule(true, false))).toBe('{"kind":"discount_base","v":1,"alsoOffDeliveryCharge":true,"from":"till"}');
    expect(JSON.stringify(websiteDiscountRule(false))).toBe('{"kind":"discount_base","v":1,"alsoOffDeliveryCharge":true,"from":"website"}');
    expect('skipsNoDiscountLines' in tillDiscountRule(false, false)).toBe(false);
    for (const rule of [tillDiscountRule(false, true), tillDiscountRule(true, true), websiteDiscountRule(true)]) {
      expect(rule.skipsNoDiscountLines).toBe(true);
      expect(parseDiscountBaseRule(JSON.stringify(rule))).toEqual(rule);
    }
    expect(parseDiscountBaseRule(JSON.stringify(tillDiscountRule(false, true)))).toEqual({
      kind: 'discount_base',
      v: 1,
      alsoOffDeliveryCharge: false,
      from: 'till',
      skipsNoDiscountLines: true,
    });
    // Anything but an exact true is a rule from before 0.7.34.
    for (const v of [false, 'yes', 1, null]) {
      const json = JSON.stringify({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till', skipsNoDiscountLines: v });
      expect({ v, rule: parseDiscountBaseRule(json) }).toEqual({ v, rule: { kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till' } });
      expect(discountRuleScope(json)).toEqual(FOOD_ONLY);
    }
  });

  it('discountRuleScope: the frozen rule; the foodpanda deal never skips; no rule is every line', () => {
    expect(discountRuleScope(JSON.stringify(tillDiscountRule(false, true)))).toEqual(FOOD_NO_DEALS);
    expect(discountRuleScope(JSON.stringify(tillDiscountRule(true, true)))).toEqual(ALL_BUT_DEALS);
    expect(discountRuleScope(JSON.stringify(tillDiscountRule(false, false)))).toEqual(FOOD_ONLY);
    expect(discountRuleScope(JSON.stringify(websiteDiscountRule(true)))).toEqual(ALL_BUT_DEALS);
    expect(discountRuleScope(JSON.stringify(websiteDiscountRule(false)))).toEqual(EVERY_LINE);
    const deal = { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null };
    expect(discountRuleScope(JSON.stringify(foodpandaDealRule(deal, null, 0, false)))).toEqual(FOOD_ONLY);
    expect(discountRuleScope(JSON.stringify(foodpandaDealRule(deal, null, 0)))).toEqual(EVERY_LINE);
    // Even a foodpanda rule that somehow carries the field covers the deals (it must match the tablet).
    expect(discountRuleScope(JSON.stringify({ ...foodpandaDealRule(deal, null, 0, false), skipsNoDiscountLines: true }))).toEqual(FOOD_ONLY);
    for (const json of [null, undefined, '', 'not json', '{}', '{"kind":"discount_base","v":2,"alsoOffDeliveryCharge":false}']) {
      expect({ json, scope: discountRuleScope(json) }).toEqual({ json, scope: EVERY_LINE });
    }
    // The old reader is its first answer.
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(tillDiscountRule(false, true)))).toBe(false);
    expect(discountRuleAlsoOffDeliveryCharge(JSON.stringify(websiteDiscountRule(true)))).toBe(true);
  });
});

/**
 * storedDiscountScope reads the stored bill against the rule frozen on its
 * row. With no value deal skipped it must answer exactly as
 * storedDiscountAlsoOffDeliveryCharge did before 0.7.34: this is that
 * function as it was, on the same base maths.
 */
function storedAlsoOffBefore0734(frozen: boolean, lines: ReadonlyArray<TaxedDiscountLine>, discountCents: number, taxCents?: number): boolean {
  if (frozen || !(discountCents > 0)) return frozen;
  if (!lines.some((l) => isDeliveryChargeLine(l) && l.lineTotalCents > 0)) return frozen;
  if (discountCents > discountBaseCents(lines, FOOD_ONLY)) return true;
  if (taxCents === undefined) return false;
  if (taxAfterDiscount(lines, discountCents, FOOD_ONLY).taxCents === taxCents) return false;
  return taxAfterDiscount(lines, discountCents, EVERY_LINE).taxCents === taxCents;
}

describe('storedDiscountScope: the stored bill against the frozen rule', () => {
  const PIZZA_15 = { lineTotalCents: 150_000, menuItemName: 'Test Pizza', taxRateBps: 1500 };
  const DEAL = { lineTotalCents: 360_000, menuItemName: 'Test Deal for Two', taxRateBps: 1500, noDiscount: true };
  const CHARGE_15 = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)', taxRateBps: 1500 };
  const MIXED = [PIZZA_15, DEAL, CHARGE_15];
  const FOOD_NO_DEALS: DiscountScope = { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true };

  it('2,000 made-up orders with no deal skipped: the same answer as before 0.7.34, case for case', () => {
    let seed = 20261002;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    let differs = 0;
    for (let n = 0; n < 2_000; n++) {
      const lines: TaxedDiscountLine[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => {
        const charge = rnd() < 0.3;
        const total = rnd() < 0.05 ? -Math.floor(rnd() * 5_000) : rnd() < 0.08 ? 0 : Math.floor(rnd() * 500_000);
        return {
          lineTotalCents: total,
          menuItemName: charge ? `Delivery Charge (Rs ${pick([150, 200, 250])})` : `Test Item ${i}`,
          taxRateBps: pick([0, 500, 1500, 1600]),
          ...(rnd() < 0.4 ? { noDiscount: rnd() < 0.7 } : {}),
        };
      });
      const subtotal = lines.reduce((s, l) => s + Math.max(0, l.lineTotalCents), 0);
      const discountCents = pick([
        0,
        -100,
        Math.floor(rnd() * (subtotal + 1)),
        Math.floor(rnd() * (subtotal + 1)),
        subtotal,
        subtotal + 1 + Math.floor(rnd() * 10_000),
        discountBaseCents(lines, FOOD_ONLY),
        discountBaseCents(lines, FOOD_ONLY) + 1,
      ]);
      const taxCents = pick([
        undefined,
        taxAfterDiscount(lines, discountCents, FOOD_ONLY).taxCents,
        taxAfterDiscount(lines, discountCents, EVERY_LINE).taxCents,
        Math.floor(rnd() * 100_000),
      ]);
      const frozen = rnd() < 0.5;
      const before = storedAlsoOffBefore0734(frozen, lines, discountCents, taxCents);
      if (before !== frozen) differs++;
      expect({ n, alsoOff: storedDiscountAlsoOffDeliveryCharge(frozen, lines, discountCents, taxCents) }).toEqual({ n, alsoOff: before });
      expect({ n, scope: storedDiscountScope({ alsoOffDeliveryCharge: frozen, skipsNoDiscountLines: false }, lines, discountCents, taxCents) }).toEqual({
        n,
        scope: { alsoOffDeliveryCharge: before, skipsNoDiscountLines: false },
      });
    }
    // The made-up orders do reach the older till's re-work, not only the frozen answer.
    expect(differs).toBeGreaterThan(50);
  });

  it('what this version stores is always read by its frozen scope', () => {
    for (const d of [
      { type: 'percent' as const, value: 10 },
      { type: 'percent' as const, value: 100 },
      { type: 'flat' as const, value: 33_333 },
      { type: 'flat' as const, value: 300_000 },
    ]) {
      for (const lines of [MIXED, [PIZZA_15, { ...DEAL, taxRateBps: 500 }, { ...CHARGE_15, taxRateBps: 500 }]]) {
        const discountCents = computeDiscountCents(discountBaseCents(lines, FOOD_NO_DEALS), d) as number;
        const { taxCents } = taxAfterDiscount(lines, discountCents, FOOD_NO_DEALS);
        expect({ d, scope: storedDiscountScope(FOOD_NO_DEALS, lines, discountCents, taxCents) }).toEqual({ d, scope: FOOD_NO_DEALS });
        expect(storedDiscountSkips(JSON.stringify(tillDiscountRule(false, true)), lines, discountCents, taxCents)).toEqual([false, true, true]);
        // …and by its own terms too.
        const terms = { discountType: d.type, value: d.value, source: null, ruleJson: JSON.stringify(tillDiscountRule(false, true)) };
        expect({ d, scope: storedDiscountScope(FOOD_NO_DEALS, lines, discountCents, taxCents, terms) }).toEqual({ d, scope: FOOD_NO_DEALS });
      }
    }
  });

  it('a stored discount above the food without the deal (an older till re-worked it over the deal) falls back to not skipping', () => {
    // A 0.7.33 till re-works 50% over the deal too: Rs 2,550, more than the Rs 1,500 of pizza.
    const discountCents = computeDiscountCents(discountBaseCents(MIXED, FOOD_ONLY), { type: 'percent', value: 50 }) as number;
    const { taxCents } = taxAfterDiscount(MIXED, discountCents, FOOD_ONLY);
    expect(discountCents).toBe(255_000);
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, discountCents, taxCents)).toEqual(FOOD_ONLY);
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, discountCents)).toEqual(FOOD_ONLY);
    expect(storedDiscountSkips(JSON.stringify(tillDiscountRule(false, true)), MIXED, discountCents, taxCents)).toEqual([false, false, true]);
    // A till older still (0.7.25) re-worked 100% over every line: only every line carries it.
    const everything = discountBaseCents(MIXED, EVERY_LINE);
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, everything, 0)).toEqual(EVERY_LINE);
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, everything + 500)).toEqual(EVERY_LINE);
  });

  it('a stored tax that only the split over the deal gives picks it', () => {
    // The deal at a made-up 5%: the split decides the tax.
    const lines = [PIZZA_15, { ...DEAL, taxRateBps: 500 }, CHARGE_15];
    const discountCents = computeDiscountCents(discountBaseCents(lines, FOOD_ONLY), { type: 'percent', value: 10 }) as number;
    const { taxCents } = taxAfterDiscount(lines, discountCents, FOOD_ONLY);
    expect(discountCents).toBe(51_000);
    expect(discountCents).toBeLessThanOrEqual(discountBaseCents(lines, FOOD_NO_DEALS));
    expect(taxAfterDiscount(lines, discountCents, FOOD_NO_DEALS).taxCents).not.toBe(taxCents);
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, discountCents, taxCents)).toEqual(FOOD_ONLY);
    // Without the tax to go by, the frozen rule stands (Rs 510 is under the pizza).
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, discountCents)).toEqual(FOOD_NO_DEALS);
  });

  /** A till discount's own terms as stored (order_discounts): 10% off. */
  const TEN_PERCENT = { discountType: 'percent' as const, value: 10, source: null };
  const skipsJson = JSON.stringify(tillDiscountRule(false, true));

  it('one tax rate on every line (the shop’s 15%): a 0.7.33 re-work over the deal is told by its amount, not its tax', () => {
    for (const rateBps of [1500, 0, 1600]) {
      const pizza = { ...PIZZA_15, taxRateBps: rateBps };
      const deal = { ...DEAL, taxRateBps: rateBps };
      const charge = { ...CHARGE_15, taxRateBps: rateBps };
      for (const lines of [[pizza, deal], [pizza, deal, charge]] as TaxedDiscountLine[][]) {
        // The 0.7.33 till: 10% over the pizza and the deal (Rs 510), the row's rule left saying "not on value deals".
        const reworked = computeDiscountCents(discountBaseCents(lines, FOOD_ONLY), { type: 'percent', value: 10 }) as number;
        const { taxCents } = taxAfterDiscount(lines, reworked, FOOD_ONLY);
        expect(reworked).toBe(51_000);
        // The tax can't tell: both splits give the same tax at one rate.
        expect(taxAfterDiscount(lines, reworked, FOOD_NO_DEALS).taxCents).toBe(taxCents);
        expect({ rateBps, n: lines.length, scope: storedDiscountScope(FOOD_NO_DEALS, lines, reworked, taxCents) }).toEqual({ rateBps, n: lines.length, scope: FOOD_NO_DEALS });
        // The row's terms can: 10% of the pizza alone is Rs 150, not Rs 510.
        const terms = { ...TEN_PERCENT, ruleJson: skipsJson };
        expect(storedDiscountScope(FOOD_NO_DEALS, lines, reworked, taxCents, terms)).toEqual(FOOD_ONLY);
        expect(storedDiscountScope(FOOD_NO_DEALS, lines, reworked, undefined, terms)).toEqual(FOOD_ONLY);
        expect(storedDiscountSkips(skipsJson, lines, reworked, taxCents, TEN_PERCENT)).toEqual(lines.map((l) => isDeliveryChargeLine(l)));
        expect(splitDiscount(lines, reworked, FOOD_ONLY).slice(0, 2)).toEqual([15_000, 36_000]);
        // What this version stores (Rs 150 off the pizza) still reads by its frozen scope.
        const own = computeDiscountCents(discountBaseCents(lines, FOOD_NO_DEALS), { type: 'percent', value: 10 }) as number;
        const ownTax = taxAfterDiscount(lines, own, FOOD_NO_DEALS).taxCents;
        expect(own).toBe(15_000);
        expect(storedDiscountScope(FOOD_NO_DEALS, lines, own, ownTax, terms)).toEqual(FOOD_NO_DEALS);
        expect(storedDiscountSkips(skipsJson, lines, own, ownTax, TEN_PERCENT)).toEqual(lines.map((l) => l.noDiscount === true || isDeliveryChargeLine(l)));
      }
    }
  });

  it('a rupee amount is the same over any lines that carry it: the tax decides, else the frozen scope stands (the stored totals are the same either way)', () => {
    const lines = [PIZZA_15, DEAL];
    const flat = { discountType: 'flat' as const, value: 10_000, source: null, ruleJson: skipsJson };
    const { taxCents } = taxAfterDiscount(lines, 10_000, FOOD_ONLY);
    expect(taxAfterDiscount(lines, 10_000, FOOD_NO_DEALS).taxCents).toBe(taxCents);
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, 10_000, taxCents, flat)).toEqual(FOOD_NO_DEALS);
    // Rs 2,000 is capped at the Rs 1,500 of pizza here; an older till's Rs 2,000 is more than the pizza carries.
    const big = { ...flat, value: 200_000 };
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, 150_000, taxAfterDiscount(lines, 150_000, FOOD_NO_DEALS).taxCents, big)).toEqual(FOOD_NO_DEALS);
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, 200_000, taxAfterDiscount(lines, 200_000, FOOD_ONLY).taxCents, big)).toEqual(FOOD_ONLY);
  });

  it('an automatic offer and the foodpanda deal are re-worked from their own frozen terms', () => {
    const terms = {
      v: 1 as const,
      id: 'test-offer',
      name: 'Test offer 10% off',
      type: 'percent' as const,
      value: 10,
      minOrderCents: null,
      maxOffCents: null,
      cameBy: 'any' as const,
      orderTypes: ['takeaway' as const, 'delivery' as const],
      oncePerCustomerPerDay: false,
      settingsAt: null,
    };
    const offerJson = JSON.stringify({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till', skipsNoDiscountLines: true, offer: terms });
    const offer = { discountType: 'percent' as const, value: 10, source: 'offer', ruleJson: offerJson };
    const lines = [PIZZA_15, DEAL, CHARGE_15];
    // A 0.7.33 till re-works the offer over the deal too: Rs 510.
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, 51_000, taxAfterDiscount(lines, 51_000, FOOD_ONLY).taxCents, offer)).toEqual(FOOD_ONLY);
    expect(storedDiscountScope(FOOD_NO_DEALS, lines, 15_000, taxAfterDiscount(lines, 15_000, FOOD_NO_DEALS).taxCents, offer)).toEqual(FOOD_NO_DEALS);
    // Its minimum is measured on the food the scope leaves: "from Rs 2,000" is not reached on Rs 1,500 of pizza.
    const fromTwoThousand = { ...offer, ruleJson: JSON.stringify({ ...JSON.parse(offerJson), offer: { ...terms, minOrderCents: 200_000 } }) };
    expect(reworkedDiscountCents(fromTwoThousand, lines, FOOD_NO_DEALS)).toBe(0);
    expect(reworkedDiscountCents(fromTwoThousand, lines, FOOD_ONLY)).toBe(51_000);
    // Taken off by the cashier: Rs 0 under any scope.
    const declined = { ...offer, discountType: 'flat' as const, value: 0, ruleJson: JSON.stringify({ ...JSON.parse(offerJson), offer: { ...terms, declined: true } }) };
    expect(reworkedDiscountCents(declined, lines, EVERY_LINE)).toBe(0);

    // The foodpanda deal (20%, food only) a 0.7.25 till re-worked over every line, the charge at the food's 15%.
    const deal = { v: 1, percent: 20, shopPercent: 20, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null };
    const dealJson = JSON.stringify(foodpandaDealRule(deal, null, 0, false));
    const dealTerms = { discountType: 'percent' as const, value: 20, source: 'foodpanda', ruleJson: dealJson };
    const pizzaAndCharge = [PIZZA_15, CHARGE_15];
    const overEvery = dealAmount(parseFoodpandaDealRule(dealJson)!, discountBaseCents(pizzaAndCharge, EVERY_LINE)).shopCents;
    const tax = taxAfterDiscount(pizzaAndCharge, overEvery, EVERY_LINE).taxCents;
    expect(overEvery).toBe(34_000);
    expect(taxAfterDiscount(pizzaAndCharge, overEvery, FOOD_ONLY).taxCents).toBe(tax);
    expect(storedDiscountAlsoOffDeliveryCharge(false, pizzaAndCharge, overEvery, tax)).toBe(false);
    expect(storedDiscountAlsoOffDeliveryCharge(false, pizzaAndCharge, overEvery, tax, dealTerms)).toBe(true);
    // The deal as this version works it (on the food): read as frozen.
    expect(storedDiscountAlsoOffDeliveryCharge(false, pizzaAndCharge, 30_000, taxAfterDiscount(pizzaAndCharge, 30_000, FOOD_ONLY).taxCents, dealTerms)).toBe(false);
  });

  it('reworkedDiscountCents: recomputeOrderTotals’ maths for each kind of row, one scope at a time', () => {
    expect(reworkedDiscountCents({ ...TEN_PERCENT, ruleJson: skipsJson }, MIXED, FOOD_NO_DEALS)).toBe(15_000);
    expect(reworkedDiscountCents({ ...TEN_PERCENT, ruleJson: skipsJson }, MIXED, FOOD_ONLY)).toBe(51_000);
    expect(reworkedDiscountCents({ ...TEN_PERCENT, ruleJson: skipsJson }, MIXED, EVERY_LINE)).toBe(53_000);
    // Rupees: capped at the base.
    expect(reworkedDiscountCents({ discountType: 'flat', value: 300_000, source: null, ruleJson: null }, MIXED, FOOD_NO_DEALS)).toBe(150_000);
    expect(reworkedDiscountCents({ discountType: 'flat', value: 300_000, source: null, ruleJson: null }, MIXED, FOOD_ONLY)).toBe(300_000);
    // A deal or offer row whose rule this version can't read: its type and value on the base.
    expect(reworkedDiscountCents({ discountType: 'percent', value: 10, source: 'foodpanda', ruleJson: 'not json' }, MIXED, FOOD_ONLY)).toBe(51_000);
    expect(reworkedDiscountCents({ discountType: 'percent', value: 10, source: 'offer', ruleJson: '{}' }, MIXED, FOOD_NO_DEALS)).toBe(15_000);
  });

  it('no deal on the order, or no discount: the frozen scope stands', () => {
    expect(storedDiscountScope(FOOD_NO_DEALS, [PIZZA_15, CHARGE_15], 15_000, 20_250 + 3_000)).toEqual(FOOD_NO_DEALS);
    // More than the food with no deal to tell apart: only the delivery charge can carry it.
    expect(storedDiscountScope(FOOD_NO_DEALS, [PIZZA_15, CHARGE_15], 160_000)).toEqual({ alsoOffDeliveryCharge: true, skipsNoDiscountLines: true });
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, 0, 81_000)).toEqual(FOOD_NO_DEALS);
    expect(storedDiscountScope(FOOD_NO_DEALS, MIXED, -5, 81_000)).toEqual(FOOD_NO_DEALS);
  });
});
