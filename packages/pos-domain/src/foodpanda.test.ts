import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  type FoodpandaDeal,
  type FoodpandaFees,
} from '@cheeseoclock/shared-types';
import {
  LEGACY_COMMISSION_BASE_MAP,
  LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES,
  activeFoodpandaDeal,
  atFoodpandaPrices,
  atTillPrices,
  dealAmount,
  dealMinTillCents,
  expectedTabletCents,
  foodpandaDealLabel,
  foodpandaDealRule,
  foodpandaExample,
  foodpandaFeesFromChannelFees,
  foodpandaOrderMoney,
  foodpandaTerms,
  foodpandaUpliftCents,
  parseFoodpandaDealRule,
  type KeptFoodpandaTerms,
  tabletDiffers,
  tabletDifferenceCents,
  tradingDayOfInstant,
} from './foodpanda.js';
import { allocateDiscount } from './discount.js';

/** Made-up figures throughout. */
const deal = (over: Partial<FoodpandaDeal> = {}): FoodpandaDeal => ({ ...DEFAULT_FOODPANDA_DEAL, percent: 20, shopPercent: 20, ...over });
const fees = (over: Partial<FoodpandaFees> = {}): FoodpandaFees => ({ ...DEFAULT_FOODPANDA_FEES, ...over });
const rule = (over: Partial<FoodpandaDeal> = {}, upliftBps = 0) => foodpandaDealRule(deal(over), '2026-09-27T09:00:00.000Z', upliftBps);
/** Terms kept at payment (order_channel_terms), with what a row of this version always has. */
const keptTerms = (over: Partial<KeptFoodpandaTerms> = {}): KeptFoodpandaTerms => ({
  confirmed: true,
  commissionCents: 0,
  fixedFeeCents: 0,
  commissionTaxCents: 0,
  paymentFeeCents: 0,
  expectedPayoutCents: null,
  upliftBps: 0,
  ...over,
});

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

describe("dealAmount when foodpanda's menu is dearer: the minimum and the most-off at foodpanda's prices", () => {
  // Made-up: a 20% deal the shop pays half of, at most Rs 300 off, foodpanda's menu 10% above the till's.
  const capped = rule({ percent: 20, shopPercent: 10, maxOffCents: 30_000 }, 1_000);

  it("the most-off binds where foodpanda's does, and the till's total at foodpanda's prices is foodpanda's own", () => {
    // Rs 2,500 at the till is Rs 2,750 on foodpanda: 20% would be Rs 550, so foodpanda takes Rs 300 off
    // (the shop's part Rs 150) and the order is worth Rs 2,600 there. At the till: Rs 300 at foodpanda's prices.
    const a = dealAmount(capped, 250_000);
    expect(a.dealCents).toBe(atTillPrices(30_000, 1_000));
    expect(a.shopCents + a.platformCents).toBe(a.dealCents);
    const value = 250_000 - a.shopCents;
    expect(Math.abs(atFoodpandaPrices(value, 1_000) - (275_000 - 15_000))).toBeLessThanOrEqual(1);
    // With 16% tax the tablet Pay expects is within a paisa of foodpanda's Rs 3,016: no warning.
    const total = value + Math.round(value * 0.16);
    expect(Math.abs(expectedTabletCents(total, 1_000) - 301_600)).toBeLessThanOrEqual(1);
    expect(tabletDiffers(expectedTabletCents(total, 1_000), 301_600)).toBe(false);
    // ...and the commission is on foodpanda's Rs 2,600 (to the paisa), not Rs 15 less.
    const t = foodpandaTerms({ subtotalCents: 250_000, shopDiscountCents: a.shopCents, totalCents: total }, fees({ upliftBps: 1_000 }));
    expect(Math.abs(t.commissionBaseCents - 260_000)).toBeLessThanOrEqual(1);
  });

  it("below the cap the deal is the plain % at the till, as at the till's prices", () => {
    expect(dealAmount(capped, 100_000)).toEqual({ dealCents: 20_000, shopCents: 10_000, platformCents: 10_000 });
  });

  it("the minimum, typed as foodpanda shows it, is met at foodpanda's prices", () => {
    const min = rule({ minOrderCents: 150_000 }, 1_000);
    // Rs 1,400 at the till is Rs 1,540 on foodpanda: foodpanda gives the deal, so the till does.
    expect(dealAmount(min, 140_000).dealCents).toBe(28_000);
    // The smallest till subtotal that reaches Rs 1,500 there, and a paisa less does not.
    const from = dealMinTillCents(min);
    expect(from).toBe(136_364);
    expect(dealAmount(min, 136_364).dealCents).toBeGreaterThan(0);
    expect(dealAmount(min, 136_363).dealCents).toBe(0);
    // At the till's prices nothing is converted.
    expect(dealMinTillCents(rule({ minOrderCents: 150_000 }))).toBe(150_000);
    expect(dealMinTillCents(rule())).toBeNull();
  });

  it("at the till's prices (the default uplift 0) the rupees are what they always were", () => {
    for (const sub of [99_900, 150_000, 250_000, 500_000]) {
      const r = { percent: 20, shopPercent: 10, minOrderCents: 100_000, maxOffCents: 30_000 };
      expect(dealAmount(rule(r, 0), sub)).toEqual(dealAmount({ ...rule(r), upliftBps: undefined }, sub));
    }
    expect(atTillPrices(30_000, 0)).toBe(30_000);
    expect(atTillPrices(33_000, 1_000)).toBe(30_000);
  });
});

describe('the frozen rule survives the trip through rule_json', () => {
  it('round-trips, with the uplift it was frozen at', () => {
    const r = rule({ percent: 25, shopPercent: 15, minOrderCents: 80_000, maxOffCents: 50_000 }, 1_250);
    expect(r.upliftBps).toBe(1_250);
    expect(parseFoodpandaDealRule(JSON.stringify(r))).toEqual(r);
  });

  it("a rule written without the uplift was frozen at the till's prices", () => {
    const { upliftBps: _drop, ...older } = rule({ maxOffCents: 30_000 });
    expect(parseFoodpandaDealRule(JSON.stringify(older))?.upliftBps).toBe(0);
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
      JSON.stringify({ ...rule(), upliftBps: -100 }),
      JSON.stringify({ ...rule(), upliftBps: 12.5 }),
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
      paymentFeeCents: 0,
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

  it("foodpanda's fee on the order's total: a % of what the tablet shows, tax included, at its prices", () => {
    const t = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ paymentFeeBps: 200 }));
    expect(t.paymentFeeCents).toBe(3_712);
    expect(t.foodpandaKeepsCents).toBe(40_000 + 3_712);
    expect(t.expectedPayoutCents).toBe(185_600 - 43_712);
    const dearer = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ paymentFeeBps: 200, upliftBps: 1_000 }));
    expect(dearer.paymentFeeCents).toBe(Math.round(204_160 * 0.02));
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
    const kept = keptTerms({ commissionCents: 32_000, fixedFeeCents: 2_000, commissionTaxCents: 5_120, expectedPayoutCents: 185_600 - 39_120 });
    const m = foodpandaOrderMoney(order, kept, fees({ commissionBps: 3_000, confirmed: true, upliftBps: 1_500, paymentFeeBps: 300 }));
    expect(m).toEqual({
      estimated: false,
      commissionCents: 32_000,
      commissionTaxCents: 5_120,
      fixedFeeCents: 2_000,
      paymentFeeCents: 0,
      foodpandaKeepsCents: 39_120,
      upliftCents: 0,
      expectedTabletCents: 185_600,
      expectedPayoutCents: 185_600 - 39_120,
      youKeepCents: 160_000 - 39_120,
    });
  });

  it('a row kept without its uplift: the uplift comes back from its payout, exactly with no tax', () => {
    const noTax = { subtotalCents: 200_000, discountCents: 40_000, totalCents: 160_000 };
    const at = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 160_000 }, fees({ upliftBps: 1_000, confirmed: true }));
    const kept = keptTerms({ commissionCents: at.commissionCents, expectedPayoutCents: at.expectedPayoutCents, upliftBps: null });
    const m = foodpandaOrderMoney(noTax, kept, fees());
    expect(m.upliftCents).toBe(at.upliftCents);
    expect(m.youKeepCents).toBe(at.youKeepCents);
    expect(m.expectedTabletCents).toBe(at.expectedTabletCents);
    // With tax: within a paisa of the food's share.
    const taxed = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ upliftBps: 1_000 }));
    const m2 = foodpandaOrderMoney(order, { ...kept, commissionCents: taxed.commissionCents, expectedPayoutCents: taxed.expectedPayoutCents }, fees());
    expect(Math.abs(m2.upliftCents - taxed.upliftCents)).toBeLessThanOrEqual(1);
  });

  it('a row kept with its uplift: the tablet total and the uplift are exactly those of payment', () => {
    const at = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ upliftBps: 1_000 }));
    const kept = keptTerms({ commissionCents: at.commissionCents, expectedPayoutCents: at.expectedPayoutCents, upliftBps: 1_000 });
    const m = foodpandaOrderMoney(order, kept, fees({ upliftBps: 500 }));
    expect(m).toMatchObject({ upliftCents: at.upliftCents, expectedTabletCents: at.expectedTabletCents, youKeepCents: at.youKeepCents });
  });

  it('not confirmed at payment, or no terms kept: the fees of now, "estimated"', () => {
    const now = fees({ commissionBps: 2_000, confirmed: true });
    const suggested = keptTerms({ confirmed: false, commissionCents: 40_000, expectedPayoutCents: 145_600 });
    for (const kept of [suggested, null]) {
      const m = foodpandaOrderMoney(order, kept, now);
      expect(m).toMatchObject({ estimated: true, commissionCents: 32_000, foodpandaKeepsCents: 32_000, youKeepCents: 128_000, expectedPayoutCents: 153_600 });
    }
  });

  it('a paid order never moves with a later uplift, even while its commission is only suggested', () => {
    // Paid at the till's prices with the suggested 25%: the tablet showed the till's Rs 1,856, Pay stored no difference.
    const atPay = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees());
    const kept = keptTerms({ confirmed: false, commissionCents: atPay.commissionCents, expectedPayoutCents: atPay.expectedPayoutCents });
    // Later the owner says foodpanda is 10% dearer, and confirms a 20% commission.
    const now = fees({ upliftBps: 1_000, commissionBps: 2_000, confirmed: true });
    const m = foodpandaOrderMoney(order, kept, now);
    expect(m.expectedTabletCents).toBe(185_600);
    expect(m.upliftCents).toBe(0);
    // Only the commission is worked again, on the order at the prices it was paid at.
    expect(m).toMatchObject({ estimated: true, commissionCents: 32_000, youKeepCents: 160_000 - 32_000, expectedPayoutCents: 185_600 - 32_000 });
    // The same with the row's uplift worked back from its payout (a row kept without uplift_bps).
    expect(foodpandaOrderMoney(order, { ...kept, upliftBps: null }, now)).toEqual(m);
    // And the other way: paid at 10% dearer, the uplift put back to 0 later: still 10% for this order.
    const dearer = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ upliftBps: 1_000 }));
    const keptDearer = keptTerms({ confirmed: false, commissionCents: dearer.commissionCents, expectedPayoutCents: dearer.expectedPayoutCents, upliftBps: 1_000 });
    expect(foodpandaOrderMoney(order, keptDearer, fees()).expectedTabletCents).toBe(204_160);
  });

  it("part refunds leave foodpanda's order too: commission, tax, the % of the total, the uplift and the payout, not the fee per order", () => {
    // Rs 2,000 of food, no tax, 25% confirmed at 10% dearer; half handed back later.
    const noTax = { subtotalCents: 200_000, discountCents: 0, totalCents: 200_000 };
    const at = foodpandaTerms(
      { subtotalCents: 200_000, shopDiscountCents: 0, totalCents: 200_000 },
      fees({ upliftBps: 1_000, fixedFeeCents: 1_000, paymentFeeBps: 200 }),
    );
    const kept = keptTerms({
      commissionCents: at.commissionCents,
      fixedFeeCents: at.fixedFeeCents,
      paymentFeeCents: at.paymentFeeCents,
      expectedPayoutCents: at.expectedPayoutCents,
      upliftBps: 1_000,
    });
    expect(at).toMatchObject({ commissionCents: 55_000, upliftCents: 20_000, paymentFeeCents: 4_400 });
    const m = foodpandaOrderMoney({ ...noTax, refundedCents: 100_000 }, kept, fees());
    // v0.7.20 took its commission after part refunds too: Rs 275 and Rs 100 here.
    expect(m).toMatchObject({ commissionCents: 27_500, upliftCents: 10_000, fixedFeeCents: 1_000, paymentFeeCents: 2_200 });
    expect(m.foodpandaKeepsCents).toBe(27_500 + 1_000 + 2_200);
    expect(m.youKeepCents).toBe(100_000 + 10_000 - 30_700);
    expect(m.expectedPayoutCents).toBe(110_000 - 30_700);
    // The tablet Pay checked is the one of payment.
    expect(m.expectedTabletCents).toBe(220_000);
    // No refund: nothing changes; all of it handed back: foodpanda keeps only the fee per order.
    expect(foodpandaOrderMoney({ ...noTax, refundedCents: 0 }, kept, fees())).toEqual(foodpandaOrderMoney(noTax, kept, fees()));
    expect(foodpandaOrderMoney({ ...noTax, refundedCents: 200_000 }, kept, fees())).toMatchObject({
      foodpandaKeepsCents: 1_000,
      upliftCents: 0,
      youKeepCents: -1_000,
    });
  });

  it("foodpanda's fee on the total: kept when confirmed, worked out on the tablet total at payment's prices when not", () => {
    const at = foodpandaTerms({ subtotalCents: 200_000, shopDiscountCents: 40_000, totalCents: 185_600 }, fees({ paymentFeeBps: 200, upliftBps: 1_000 }));
    const kept = keptTerms({
      confirmed: false,
      commissionCents: at.commissionCents,
      paymentFeeCents: at.paymentFeeCents,
      expectedPayoutCents: at.expectedPayoutCents,
      upliftBps: 1_000,
    });
    // Fee put up to 3% later: an unconfirmed order is worked again with it, on its own tablet total.
    expect(foodpandaOrderMoney(order, kept, fees({ paymentFeeBps: 300 })).paymentFeeCents).toBe(Math.round(204_160 * 0.03));
    expect(foodpandaOrderMoney(order, { ...kept, confirmed: true }, fees({ paymentFeeBps: 300 })).paymentFeeCents).toBe(at.paymentFeeCents);
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
  const card = { cash: 0, card: 0, foodpanda: 0, transfer: 0 };

  it('what the owner typed: as typed, confirmed, the base mapped, the uplift kept, no tax', () => {
    expect(
      foodpandaFeesFromChannelFees({
        foodpanda: { commissionBps: 2_250, base: 'menu_price', fixedFeeCents: 2_500, upliftBps: 1_000 },
        paymentFeeBps: card,
      }),
    ).toEqual({
      v: 1,
      commissionBps: 2_250,
      confirmed: true,
      base: 'before_deal',
      fixedFeeCents: 2_500,
      commissionTaxBps: 0,
      upliftBps: 1_000,
      paymentFeeBps: 0,
    });
    expect(LEGACY_COMMISSION_BASE_MAP).toEqual({ sales_ex_tax: 'after_deal', menu_price: 'before_deal', paid_incl_tax: 'after_deal' });
  });

  it("v0.7.20's own 25% (saved with every save of the card fees) is not a confirmation: nothing is carried", () => {
    expect(foodpandaFeesFromChannelFees({ foodpanda: { ...LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES }, paymentFeeBps: card })).toBeNull();
    expect(foodpandaFeesFromChannelFees({ paymentFeeBps: { ...card, card: 150 } })).toBeNull();
  });

  it("'paid_incl_tax' maps to the food after the deal, so it is carried over NOT confirmed", () => {
    const f = foodpandaFeesFromChannelFees({
      foodpanda: { commissionBps: 2_500, base: 'paid_incl_tax', fixedFeeCents: 0, upliftBps: 0 },
      paymentFeeBps: card,
    });
    expect(f).toMatchObject({ base: 'after_deal', commissionBps: 2_500, confirmed: false });
  });

  it("its Foodpanda payment fee becomes foodpanda's fee on the total, the default commission still only suggested", () => {
    expect(
      foodpandaFeesFromChannelFees({ foodpanda: { ...LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES }, paymentFeeBps: { ...card, foodpanda: 200 } }),
    ).toEqual({ ...DEFAULT_FOODPANDA_FEES, paymentFeeBps: 200 });
    expect(
      foodpandaFeesFromChannelFees({
        foodpanda: { commissionBps: 3_000, base: 'sales_ex_tax', fixedFeeCents: 0, upliftBps: 0 },
        paymentFeeBps: { ...card, foodpanda: 150 },
      }),
    ).toMatchObject({ commissionBps: 3_000, confirmed: true, paymentFeeBps: 150 });
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

  it("the owner's tolerance moves the line: Rs 0 flags a paisa, Rs 10 lets Rs 10 through (either way)", () => {
    expect(tabletDiffers(184_300, 184_301, 0)).toBe(true);
    expect(tabletDiffers(184_300, 184_300, 0)).toBe(false);
    expect(tabletDiffers(184_300, 184_800, 500)).toBe(false);
    expect(tabletDiffers(184_300, 184_801, 500)).toBe(true);
    expect(tabletDiffers(184_300, 185_300, 1_000)).toBe(false);
    expect(tabletDiffers(184_300, 183_300, 1_000)).toBe(false);
    expect(tabletDiffers(184_300, 185_301, 1_000)).toBe(true);
    // With no tolerance to hand: the released Rs 1.
    expect(tabletDiffers(184_300, 184_400)).toBe(tabletDiffers(184_300, 184_400, 100));
  });
});
