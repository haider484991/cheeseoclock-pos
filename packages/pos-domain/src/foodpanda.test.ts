import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  type FoodpandaDeal,
  type FoodpandaFees,
} from '@cheeseoclock/shared-types';
import {
  LEGACY_COMMISSION_BASE_MAP,
  activeFoodpandaDeal,
  atFoodpandaPrices,
  dealAmount,
  expectedTabletCents,
  foodpandaDealLabel,
  foodpandaDealRule,
  foodpandaExample,
  foodpandaFeesFromChannelFees,
  foodpandaOrderMoney,
  foodpandaTerms,
  foodpandaUpliftCents,
  parseFoodpandaDealRule,
  tabletDiffers,
  tabletDifferenceCents,
  tradingDayOfInstant,
} from './foodpanda.js';
import { allocateDiscount } from './discount.js';

/** Made-up figures throughout. */
const deal = (over: Partial<FoodpandaDeal> = {}): FoodpandaDeal => ({ ...DEFAULT_FOODPANDA_DEAL, percent: 20, shopPercent: 20, ...over });
const fees = (over: Partial<FoodpandaFees> = {}): FoodpandaFees => ({ ...DEFAULT_FOODPANDA_FEES, ...over });
const rule = (over: Partial<FoodpandaDeal> = {}) => foodpandaDealRule(deal(over), '2026-09-27T09:00:00.000Z');

describe('the deal an order gets', () => {
  it('the default (0%) is no deal: foodpanda orders stay at full till price', () => {
    expect(activeFoodpandaDeal(DEFAULT_FOODPANDA_DEAL, '2026-09-27T12:00:00.000Z')).toBeNull();
    expect(dealAmount(foodpandaDealRule(DEFAULT_FOODPANDA_DEAL, null), 200_000)).toEqual({ dealCents: 0, shopCents: 0, platformCents: 0 });
  });

  it('runs inside its from / until trading days only (05:00 PKT = 00:00 UTC)', () => {
    const d = deal({ startsOn: '2026-10-01', endsOn: '2026-10-07' });
    expect(activeFoodpandaDeal(d, '2026-09-30T23:59:59.000Z')).toBeNull();
    expect(activeFoodpandaDeal(d, '2026-10-01T00:00:00.000Z')).toBe(d);
    // 04:30 PKT on the 8th is still the 7th's trading night.
    expect(activeFoodpandaDeal(d, '2026-10-07T23:30:00.000Z')).toBe(d);
    expect(activeFoodpandaDeal(d, '2026-10-08T00:00:00.000Z')).toBeNull();
    expect(activeFoodpandaDeal(deal(), 'not a date')).toBeNull();
    expect(tradingDayOfInstant('2026-10-07T23:30:00.000Z')).toBe('2026-10-07');
  });

  it('labels say who pays', () => {
    expect(foodpandaDealLabel(20, 20)).toBe('Foodpanda deal 20% off');
    expect(foodpandaDealLabel(20, 10)).toBe('Foodpanda deal 20% off (your part 10%)');
    expect(foodpandaDealLabel(20, 0)).toBe('Foodpanda deal 20% off (foodpanda pays it)');
  });
});

describe('dealAmount: the rupees, from the frozen rule', () => {
  it('20% of Rs 2,000 that the shop pays: Rs 400 off the bill', () => {
    expect(dealAmount(rule(), 200_000)).toEqual({ dealCents: 40_000, shopCents: 40_000, platformCents: 0 });
  });

  it('the minimum: below it Rs 0, from it on the deal works again (the order of edits does not matter)', () => {
    const r = rule({ minOrderCents: 100_000 });
    expect(dealAmount(r, 99_900).dealCents).toBe(0);
    expect(dealAmount(r, 100_000).dealCents).toBe(20_000);
    expect(dealAmount(r, 150_000).dealCents).toBe(30_000);
  });

  it('the most off caps the whole deal', () => {
    const r = rule({ maxOffCents: 30_000 });
    expect(dealAmount(r, 100_000).dealCents).toBe(20_000);
    expect(dealAmount(r, 500_000)).toEqual({ dealCents: 30_000, shopCents: 30_000, platformCents: 0 });
  });

  it('a shared deal: the shop pays its part of the whole deal, foodpanda the rest, to the paisa', () => {
    const r = rule({ percent: 20, shopPercent: 10 });
    expect(dealAmount(r, 200_000)).toEqual({ dealCents: 40_000, shopCents: 20_000, platformCents: 20_000 });
    // …the cap is on the whole deal, shared the same way.
    expect(dealAmount(rule({ percent: 30, shopPercent: 10, maxOffCents: 30_000 }), 200_000)).toEqual({
      dealCents: 30_000,
      shopCents: 10_000,
      platformCents: 20_000,
    });
    // Odd paisa: the parts still add up.
    const odd = dealAmount(rule({ percent: 15, shopPercent: 7 }), 123_457);
    expect(odd.shopCents + odd.platformCents).toBe(odd.dealCents);
  });

  it('foodpanda pays it all: nothing off the bill', () => {
    expect(dealAmount(rule({ percent: 20, shopPercent: 0 }), 200_000)).toEqual({ dealCents: 40_000, shopCents: 0, platformCents: 40_000 });
  });

  it('never more than the food, never negative', () => {
    expect(dealAmount(rule({ percent: 50, shopPercent: 50 }), 1)).toEqual({ dealCents: 1, shopCents: 1, platformCents: 0 });
    expect(dealAmount(rule(), 0).dealCents).toBe(0);
    expect(dealAmount(rule(), -5).dealCents).toBe(0);
  });

  it('the shop part is an ordinary discount: allocateDiscount spreads it over the lines exactly', () => {
    const { shopCents } = dealAmount(rule({ percent: 15 }), 3 * 33_333);
    expect(allocateDiscount([33_333, 33_333, 33_333], shopCents).reduce((s, x) => s + x, 0)).toBe(shopCents);
  });
});

describe('the frozen rule survives the trip through rule_json', () => {
  it('round-trips', () => {
    const r = rule({ percent: 25, shopPercent: 15, minOrderCents: 80_000, maxOffCents: 50_000 });
    expect(parseFoodpandaDealRule(JSON.stringify(r))).toEqual(r);
  });

  it('anything else is not a deal this version works (the row falls back to its own type and value)', () => {
    for (const bad of [
      null,
      '',
      'not json',
      '{}',
      JSON.stringify({ ...rule(), v: 2 }),
      JSON.stringify({ ...rule(), kind: 'offer' }),
      JSON.stringify({ ...rule(), shopPercent: 30 }),
      JSON.stringify({ ...rule(), dealPercent: 12.5 }),
      JSON.stringify({ ...rule(), minOrderCents: -1 }),
    ]) {
      expect({ bad, rule: parseFoodpandaDealRule(bad) }).toEqual({ bad, rule: null });
    }
  });
});

describe("foodpanda's money on one order", () => {
  it('the owner’s example: Rs 2,000, 20% off he pays, 25% after the deal → foodpanda keeps Rs 400, he keeps Rs 1,200', () => {
    const t = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees());
    expect(t).toMatchObject({ commissionBaseCents: 160_000, commissionCents: 40_000, youKeepCents: 120_000 });
    expect(t.expectedPayoutCents).toBe(185_600 - 40_000);
  });

  it('before the deal, a fee per order and tax on the commission', () => {
    const t = foodpandaTerms(
      { subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 },
      fees({ base: 'before_deal', fixedFeeCents: 3_000, commissionTaxBps: 1_600 }),
    );
    expect(t).toEqual({
      commissionBaseCents: 200_000,
      commissionCents: 50_000,
      commissionTaxCents: 8_000,
      fixedFeeCents: 3_000,
      foodpandaKeepsCents: 61_000,
      upliftCents: 0,
      expectedTabletCents: 185_600,
      expectedPayoutCents: 185_600 - 61_000,
      youKeepCents: 160_000 - 61_000,
    });
  });

  it('foodpanda 10% dearer: the listing, the commission base, the tablet total and the payout all at its prices', () => {
    const up = fees({ upliftBps: 1_000 });
    // Rs 2,000 at the till is Rs 2,200 on the listing; the shop's Rs 400 of the deal is Rs 440 there.
    expect(atFoodpandaPrices(200_000, 1_000)).toBe(220_000);
    const t = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, up);
    expect(t.upliftCents).toBe(16_000);
    expect(t.commissionBaseCents).toBe(176_000);
    expect(t.commissionCents).toBe(44_000);
    expect(t.expectedTabletCents).toBe(204_160);
    expect(t.expectedPayoutCents).toBe(204_160 - 44_000);
    expect(t.youKeepCents).toBe(160_000 + 16_000 - 44_000);
    // Before the deal: the till's Rs 2,000 at foodpanda's prices.
    const before = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, { ...up, base: 'before_deal' });
    expect(before.commissionBaseCents).toBe(220_000);
    // Rounded once, half away from zero; nothing on nothing.
    expect(foodpandaUpliftCents(125, 1_000)).toBe(13);
    expect(foodpandaUpliftCents(0, 1_000)).toBe(0);
    expect(foodpandaUpliftCents(90_000, 0)).toBe(0);
  });

  it('the worked example says the dearer listing', () => {
    expect(foodpandaExample(deal(), fees({ upliftBps: 1_000 }))).toMatchObject({
      orderCents: 200_000,
      listingOrderCents: 220_000,
      billCents: 160_000,
      billAtFoodpandaCents: 176_000,
      commissionBaseCents: 176_000,
      commissionCents: 44_000,
      youKeepCents: 132_000,
    });
  });
});

describe('THE per-order rule every report uses (foodpandaOrderMoney)', () => {
  // Rs 2,000 of food, the shop's Rs 400 of the deal, 16% tax on Rs 1,600: Rs 1,856.
  const order = { subtotalCents: 200_000, discountCents: 40_000, totalCents: 185_600 };

  it('kept at payment with a confirmed commission: the kept figures, final, whatever the fees are now', () => {
    const kept = { confirmed: true, commissionCents: 32_000, fixedFeeCents: 2_000, commissionTaxCents: 5_120, expectedPayoutCents: 185_600 - 39_120 };
    const m = foodpandaOrderMoney(order, kept, fees({ commissionBps: 3_000, confirmed: true, upliftBps: 1_500 }));
    expect(m).toEqual({
      estimated: false,
      commissionCents: 32_000,
      commissionTaxCents: 5_120,
      fixedFeeCents: 2_000,
      foodpandaKeepsCents: 39_120,
      upliftCents: 0,
      expectedTabletCents: 185_600,
      expectedPayoutCents: 185_600 - 39_120,
      youKeepCents: 160_000 - 39_120,
    });
  });

  it('the uplift a confirmed order kept comes back from its payout, exactly with no tax', () => {
    const noTax = { subtotalCents: 200_000, discountCents: 40_000, totalCents: 160_000 };
    const at = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 160_000 }, fees({ upliftBps: 1_000, confirmed: true }));
    const kept = { confirmed: true, commissionCents: at.commissionCents, fixedFeeCents: 0, commissionTaxCents: 0, expectedPayoutCents: at.expectedPayoutCents };
    const m = foodpandaOrderMoney(noTax, kept, fees());
    expect(m.upliftCents).toBe(at.upliftCents);
    expect(m.youKeepCents).toBe(at.youKeepCents);
    expect(m.expectedTabletCents).toBe(at.expectedTabletCents);
    // With tax: within a paisa of the food's share.
    const taxed = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ upliftBps: 1_000 }));
    const m2 = foodpandaOrderMoney(order, { ...kept, commissionCents: taxed.commissionCents, expectedPayoutCents: taxed.expectedPayoutCents }, fees());
    expect(Math.abs(m2.upliftCents - taxed.upliftCents)).toBeLessThanOrEqual(1);
  });

  it('not confirmed at payment, or no terms kept: the fees of now, "estimated"', () => {
    const now = fees({ commissionBps: 2_000, confirmed: true });
    const suggested = { confirmed: false, commissionCents: 40_000, fixedFeeCents: 0, commissionTaxCents: 0, expectedPayoutCents: 145_600 };
    for (const kept of [suggested, null]) {
      const m = foodpandaOrderMoney(order, kept, now);
      expect(m).toMatchObject({ estimated: true, commissionCents: 32_000, foodpandaKeepsCents: 32_000, youKeepCents: 128_000, expectedPayoutCents: 153_600 });
    }
  });

  it("foodpanda's part of the deal is neither added nor lost: the shop is paid on the food after ITS part", () => {
    // 20% deal, foodpanda pays half: the order's stored discount is only the shop's Rs 200.
    const shared = { subtotalCents: 200_000, discountCents: 20_000, totalCents: 208_800 };
    const m = foodpandaOrderMoney(shared, null, fees());
    expect(m.commissionCents).toBe(45_000);
    expect(m.youKeepCents).toBe(180_000 - 45_000);
  });
});

describe("v0.7.20's foodpanda terms, carried over", () => {
  it('commission and fixed fee as typed, confirmed, the base mapped, the uplift kept, no tax', () => {
    expect(foodpandaFeesFromChannelFees({ commissionBps: 2_250, base: 'menu_price', fixedFeeCents: 2_500, upliftBps: 1_000 })).toEqual({
      v: 1,
      commissionBps: 2_250,
      confirmed: true,
      base: 'before_deal',
      fixedFeeCents: 2_500,
      commissionTaxBps: 0,
      upliftBps: 1_000,
    });
    expect(LEGACY_COMMISSION_BASE_MAP).toEqual({ sales_ex_tax: 'after_deal', menu_price: 'before_deal', paid_incl_tax: 'after_deal' });
  });

  it('the worked example follows the values', () => {
    expect(foodpandaExample(deal(), fees())).toMatchObject({
      orderCents: 200_000,
      dealPercent: 20,
      billCents: 160_000,
      commissionBaseCents: 160_000,
      commissionCents: 40_000,
      youKeepCents: 120_000,
    });
    // No deal (the default): the bill is the order.
    expect(foodpandaExample(DEFAULT_FOODPANDA_DEAL, fees())).toMatchObject({ dealPercent: 0, billCents: 200_000, commissionCents: 50_000, youKeepCents: 150_000 });
    // Shared: foodpanda pays its part on top.
    expect(foodpandaExample(deal({ shopPercent: 10 }), fees())).toMatchObject({ shopCents: 20_000, platformCents: 20_000, billCents: 180_000 });
  });
});

describe('the tablet total', () => {
  it("is expected at foodpanda's prices: a dearer listing does not flag every order", () => {
    expect(expectedTabletCents(185_600, 0)).toBe(185_600);
    expect(expectedTabletCents(185_600, 1_000)).toBe(204_160);
    expect(tabletDiffers(expectedTabletCents(185_600, 1_000), 204_160)).toBe(false);
    expect(tabletDiffers(185_600, 204_160)).toBe(true);
  });

  it('more than Rs 1 apart is a mismatch', () => {
    expect(tabletDifferenceCents(184_300, 192_000)).toBe(7_700);
    expect(tabletDiffers(184_300, 192_000)).toBe(true);
    expect(tabletDiffers(184_300, 184_400)).toBe(false);
    expect(tabletDiffers(184_300, 184_401)).toBe(true);
    expect(tabletDiffers(184_300, 184_199)).toBe(true);
  });
});
