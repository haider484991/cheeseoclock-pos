import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  type FoodpandaDeal,
  type FoodpandaFees,
} from '@cheeseoclock/shared-types';
import {
  activeFoodpandaDeal,
  dealAmount,
  foodpandaDealLabel,
  foodpandaDealRule,
  foodpandaExample,
  foodpandaTerms,
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
      expectedPayoutCents: 185_600 - 61_000,
      youKeepCents: 160_000 - 61_000,
    });
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
  it('more than Rs 1 apart is a mismatch', () => {
    expect(tabletDifferenceCents(184_300, 192_000)).toBe(7_700);
    expect(tabletDiffers(184_300, 192_000)).toBe(true);
    expect(tabletDiffers(184_300, 184_400)).toBe(false);
    expect(tabletDiffers(184_300, 184_401)).toBe(true);
    expect(tabletDiffers(184_300, 184_199)).toBe(true);
  });
});
