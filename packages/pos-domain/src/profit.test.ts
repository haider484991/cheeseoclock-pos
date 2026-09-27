import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_FEES, DEFAULT_FOODPANDA_FEES, DEFAULT_RIDER_COST } from '@cheeseoclock/shared-types';
import { allocateDiscount } from './discount.js';
import { foodpandaOrderMoney } from './foodpanda.js';
import {
  contributionCents,
  isNoRateDelivery,
  knownOrderShare,
  knownShareCents,
  orderSalesExTaxCents,
  perKnownOrderCents,
  paymentFeeCents,
  profitWaterfall,
  riderCost,
  splitOrderLines,
  type WaterfallInput,
} from './profit.js';
import { lineNetsExTax } from './sale-cost.js';

// Every amount is made up (costing spec D11), in paisa.

describe('line allocation (costing spec 4.4)', () => {
  /** Σ nets = sales before tax; each net = line total − its discount share − its refund share; the same as Reports' nets. */
  function checks(lines: number[], disc: number, tot: number, ref: number) {
    const s = splitOrderLines(lines, disc, tot, ref);
    expect(s.nets.reduce((a, b) => a + b, 0)).toBe(s.salesExTaxCents);
    expect(s.discounts).toEqual(allocateDiscount(lines, disc));
    lines.forEach((t, i) => expect(s.nets[i]).toBe(t - s.discounts[i]! - s.refunds[i]!));
    expect(s.refunds.reduce((a, b) => a + b, 0)).toBe(s.refundExTaxCents);
    expect(lineNetsExTax(lines, disc, tot, ref)).toEqual(s.nets);
    const sub = lines.reduce((a, b) => a + b, 0);
    expect(orderSalesExTaxCents({ subtotalCents: sub, discountCents: disc, totalCents: tot, refundedCents: ref })).toBe(s.salesExTaxCents);
    return s;
  }

  it('a 1-paisa remainder goes to one line, and the lines still add up to the order', () => {
    // Rs 1 off three Rs 1 lines: 34 + 33 + 33 — never 33 × 3 (a paisa lost) or 34 × 3 (one invented).
    const s = checks([100, 100, 100], 100, 232, 0);
    expect(s.discounts).toEqual([34, 33, 33]);
    expect(s.nets).toEqual([66, 67, 67]);
    expect(s.salesExTaxCents).toBe(200);
  });

  it('awkward shares: 7 paisa over lines of 3, 5 and 11', () => {
    const s = checks([300, 500, 1_100], 7, 2_200, 0);
    expect(s.discounts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(s.salesExTaxCents).toBe(1_893);
  });

  it('a 100% discount: every line at Rs 0, and nothing left to refund', () => {
    const s = checks([50_000, 30_000], 80_000, 0, 0);
    expect(s.nets).toEqual([0, 0]);
    expect(s.salesExTaxCents).toBe(0);
    // A refund on a Rs 0 bill comes to nothing before tax (the total is 0).
    expect(splitOrderLines([50_000, 30_000], 80_000, 0, 500).refundExTaxCents).toBe(0);
  });

  it('a delivery-charge line takes its share of the discount like any line', () => {
    const s = checks([120_000, 20_000], 14_000, 146_160, 0);
    expect(s.discounts).toEqual([12_000, 2_000]);
    expect(s.nets).toEqual([108_000, 18_000]);
  });

  it('a part refund comes off before tax, shared out the same way', () => {
    // Rs 1,500 of food + 16% tax = Rs 1,740; Rs 50 handed back = round(5,000 × 150,000 ÷ 174,000) = 4,310 before tax.
    const s = checks([100_000, 50_000], 0, 174_000, 5_000);
    expect(s.refundExTaxCents).toBe(4_310);
    expect(s.refunds).toEqual([2_873, 1_437]);
    expect(s.salesExTaxCents).toBe(150_000 - 4_310);
  });

  it('a discount and a part refund on the same order', () => {
    const s = checks([80_000, 45_000, 20_000], 14_500, 151_380, 11_600);
    expect(s.salesExTaxCents).toBe(145_000 - 14_500 - 10_000);
  });
});

describe('foodpanda commission and price uplift: the one per-order rule (foodpanda.ts)', () => {
  // Rs 1,000 at till prices, the shop's Rs 100 of the deal off, 16% tax: Rs 1,044 paid; Rs 900 before tax.
  const order = { subtotalCents: 100_000, discountCents: 10_000, totalCents: 104_400 };

  it('defaults to the suggested 25% of the food after the deal, no fee, no tax, at till prices', () => {
    const m = foodpandaOrderMoney(order, null, DEFAULT_FOODPANDA_FEES);
    expect(m).toMatchObject({ commissionCents: 22_500, foodpandaKeepsCents: 22_500, upliftCents: 0, estimated: true });
  });

  it('with foodpanda 10% dearer: its own uplift, and the commission on the dearer price', () => {
    const m = foodpandaOrderMoney(order, null, { ...DEFAULT_FOODPANDA_FEES, upliftBps: 1000 });
    expect(m.upliftCents).toBe(9_000);
    expect(m.commissionCents).toBe(24_750);
    expect(m.youKeepCents).toBe(90_000 + 9_000 - 24_750);
  });
});

describe('payment fees', () => {
  it('nothing by default; a share of each way of paying when set, net of refunds', () => {
    expect(paymentFeeCents({ cash: 100_000, card: 50_000 }, DEFAULT_CHANNEL_FEES.paymentFeeBps)).toBe(0);
    const bps = { cash: 0, card: 250, foodpanda: 0, transfer: 100 };
    expect(paymentFeeCents({ cash: 100_000, card: 50_000, transfer: 20_050 }, bps)).toBe(1_250 + 201);
    expect(paymentFeeCents({ card: 50_000 - 10_000 }, bps)).toBe(1_000);
  });
});

describe('rider cost (costing spec 4.7)', () => {
  const zone = DEFAULT_RIDER_COST;

  it('by default the zone’s rate, even when the delivery charge was discounted or left off', () => {
    expect(zone).toEqual({ mode: 'zone_rate', fixedCents: 0 });
    expect(riderCost(zone, { delivery: true, zoneFeeCents: 25_000, chargeCents: 20_000 })).toEqual({ cents: 25_000, source: 'zone' });
    expect(riderCost(zone, { delivery: true, zoneFeeCents: 25_000, chargeCents: null })).toEqual({ cents: 25_000, source: 'zone' });
  });

  it('no area recognised: the delivery charge on the bill at menu price', () => {
    expect(riderCost(zone, { delivery: true, zoneFeeCents: null, chargeCents: 20_000 })).toEqual({ cents: 20_000, source: 'charge' });
  });

  it('no area and no delivery charge: Rs 0, and the order is listed', () => {
    const o = { delivery: true, zoneFeeCents: null, chargeCents: null };
    expect(riderCost(zone, o)).toEqual({ cents: 0, source: 'no_rate' });
    expect(isNoRateDelivery(o)).toBe(true);
    expect(isNoRateDelivery({ ...o, chargeCents: 20_000 })).toBe(false);
    expect(isNoRateDelivery({ ...o, delivery: false })).toBe(false);
  });

  it('a fixed amount per trip, or nothing for salaried riders; never for a counter or foodpanda order', () => {
    const o = { delivery: true, zoneFeeCents: 25_000, chargeCents: 20_000 };
    expect(riderCost({ mode: 'fixed', fixedCents: 15_000 }, o)).toEqual({ cents: 15_000, source: 'fixed' });
    expect(riderCost({ mode: 'none', fixedCents: 15_000 }, o)).toEqual({ cents: 0, source: 'none' });
    expect(riderCost(zone, { ...o, delivery: false })).toEqual({ cents: 0, source: 'none' });
  });
});

describe('contribution: a foodpanda order against the same food delivered by the shop', () => {
  // Rs 1,000 of food before tax that cost Rs 300.
  const food = { knownFoodSalesCents: 100_000, foodCostCents: 30_000 };

  it('own delivery keeps the delivery charge and pays the rider; foodpanda takes its commission', () => {
    const own = contributionCents({ ...food, feeSalesCents: 20_000, riderCents: 25_000, commissionCents: 0, paymentFeeCents: 0, upliftCents: 0 });
    const fp = contributionCents({
      ...food,
      feeSalesCents: 0,
      riderCents: 0,
      commissionCents: foodpandaOrderMoney({ subtotalCents: 100_000, discountCents: 0, totalCents: 100_000 }, null, DEFAULT_FOODPANDA_FEES).foodpandaKeepsCents,
      paymentFeeCents: 0,
      upliftCents: 0,
    });
    expect(own).toBe(100_000 - 30_000 + 20_000 - 25_000);
    expect(fp).toBe(100_000 - 30_000 - 25_000);
    expect(own - fp).toBe(20_000);
    // foodpanda 10% dearer: the uplift comes in, and the commission is on the dearer price.
    const up = foodpandaOrderMoney({ subtotalCents: 100_000, discountCents: 0, totalCents: 100_000 }, null, { ...DEFAULT_FOODPANDA_FEES, upliftBps: 1000 });
    expect(
      contributionCents({
        ...food,
        feeSalesCents: 0,
        riderCents: 0,
        commissionCents: up.foodpandaKeepsCents,
        paymentFeeCents: 0,
        upliftCents: up.upliftCents,
      }),
    ).toBe(100_000 - 30_000 - 27_500 + 10_000);
  });
});

describe('an order whose food cost is only partly known (costing spec 4.7: never guessed)', () => {
  it('its commission, rider, fees and charges count in the same share as its food with a known cost', () => {
    // A foodpanda order of Rs 1,800 of food, none of it with a known cost: Rs 450 of commission goes with it, all of it.
    expect(knownShareCents(-45_000, 0, 180_000)).toBe(0);
    // Half its food known: half the commission.
    expect(knownShareCents(-45_000, 90_000, 180_000)).toBe(-22_500);
    // All of it known (or no food at all): all of it.
    expect(knownShareCents(-45_000, 180_000, 180_000)).toBe(-45_000);
    expect(knownShareCents(25_000, 0, 0)).toBe(25_000);
    // Rounded half away from zero, a loss like a gain: −Rs 0.25 × 1/2 → −0.13; +0.25 × 1/2 → +0.13.
    expect(knownShareCents(-25, 1, 2)).toBe(-13);
    expect(knownShareCents(25, 1, 2)).toBe(13);
  });

  it('per order is over the known part of the orders, in thousandths', () => {
    expect(knownOrderShare(0, 180_000)).toBe(0);
    expect(knownOrderShare(60_000, 180_000)).toBe(333);
    expect(knownOrderShare(180_000, 180_000)).toBe(1_000);
    // Rs 1,200 earned on 2 whole orders and a third of another: Rs 514.29 an order.
    expect(perKnownOrderCents(120_000, 2_333)).toBe(51_436);
    expect(perKnownOrderCents(120_000, 0)).toBeNull();
    // −25 paisa over 10 orders is −3 (half away from zero), as +25 is +3.
    expect(perKnownOrderCents(-25, 10_000)).toBe(-3);
    expect(perKnownOrderCents(25, 10_000)).toBe(3);
  });
});

describe('the profit waterfall (costing spec 4.7)', () => {
  const x: WaterfallInput = {
    salesCents: 1_000_000,
    foodCostCents: 280_000,
    unknownSalesCents: 60_000,
    wasteCents: 12_000,
    sentNotPaidCents: 3_000,
    stockLossCents: null,
    commissionCents: 25_000,
    upliftCents: null,
    paymentFeeCents: 1_500,
    riderCents: 40_000,
  };

  it('steps in order, always adding up to profit before overheads', () => {
    const w = profitWaterfall(x);
    expect(w.steps.map((s) => s.key)).toEqual(['sales', 'food_cost', 'unknown_cost', 'waste', 'sent_not_paid', 'commission', 'payment_fees', 'rider']);
    expect(w.steps.reduce((s, st) => s + st.cents, 0)).toBe(w.profitCents);
    expect(w.profitCents).toBe(1_000_000 - 280_000 - 60_000 - 12_000 - 3_000 - 25_000 - 1_500 - 40_000);
  });

  it('sales with an unknown cost are their own bar, set aside — never costed at Rs 0 inside the profit', () => {
    const w = profitWaterfall(x);
    expect(w.steps.find((s) => s.key === 'unknown_cost')?.cents).toBe(-60_000);
    // Were they costed at Rs 0, the profit would be 60,000 higher.
    expect(profitWaterfall({ ...x, unknownSalesCents: 0 }).profitCents - w.profitCents).toBe(60_000);
  });

  it('what goes with the unknown-cost food (its share of commission and rider) is set aside with it, not charged to the rest', () => {
    // Rs 150 of the commission and rider were on those orders' food of unknown cost.
    const w = profitWaterfall({ ...x, unknownOtherCents: -15_000 });
    expect(w.steps.find((s) => s.key === 'unknown_cost')?.cents).toBe(-(60_000 - 15_000));
    // The commission and rider steps stay what was paid.
    expect(w.steps.find((s) => s.key === 'commission')?.cents).toBe(-25_000);
    expect(w.steps.reduce((s, st) => s + st.cents, 0)).toBe(w.profitCents);
    expect(w.profitCents - profitWaterfall(x).profitCents).toBe(15_000);
  });

  it('stock loss only when given (a full-count window); the uplift only when foodpanda is dearer', () => {
    const w = profitWaterfall({ ...x, stockLossCents: 9_000, upliftCents: 4_000 });
    expect(w.steps.map((s) => s.key)).toEqual(['sales', 'food_cost', 'unknown_cost', 'waste', 'sent_not_paid', 'stock_loss', 'commission', 'uplift', 'payment_fees', 'rider']);
    expect(w.steps.find((s) => s.key === 'stock_loss')?.cents).toBe(-9_000);
    expect(w.steps.find((s) => s.key === 'uplift')?.cents).toBe(4_000);
    expect(w.steps.reduce((s, st) => s + st.cents, 0)).toBe(w.profitCents);
    // More on the shelves than expected adds back.
    expect(profitWaterfall({ ...x, stockLossCents: -2_000 }).steps.find((s) => s.key === 'stock_loss')?.cents).toBe(2_000);
  });

  it('an empty period is all zeros (no -0)', () => {
    const z = profitWaterfall({ ...x, salesCents: 0, foodCostCents: 0, unknownSalesCents: 0, wasteCents: 0, sentNotPaidCents: 0, commissionCents: 0, paymentFeeCents: 0, riderCents: 0 });
    expect(z.profitCents).toBe(0);
    for (const s of z.steps) expect(Object.is(s.cents, -0)).toBe(false);
  });
});
