/**
 * A price that includes its tax (0057; the owner's deal menu, 24 Oct 2026: "THE PRICE YOU SEE IS
 * THE PRICE YOU PAY · TAX INCLUDED"): the bill keeps the printed price whatever the rate, and the
 * tax inside it is the paying way's.
 */
import { describe, expect, it } from 'vitest';
import { lineTaxOf, taxAfterDiscount, taxAfterDiscountRows } from './discount-base.js';
import { settledIncludedTax, settleLegs, type MethodQuote } from './settle-legs.js';

const EVERY_LINE = { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false };
const SKIP_DEALS = { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true };

describe('lineTaxOf', () => {
  it('a tax-included line adds nothing and holds price − price/(1 + rate)', () => {
    expect(lineTaxOf({ lineTotalCents: 480_000, taxRateBps: 1500, taxIncluded: true }, 0)).toEqual({ addedCents: 0, includedCents: 62_609 });
    // 8% by card: the same Rs 4,800, less tax inside it.
    expect(lineTaxOf({ lineTotalCents: 480_000, taxRateBps: 800, taxIncluded: true }, 0)).toEqual({ addedCents: 0, includedCents: 35_556 });
  });

  it('a line without the mark is taxed on top, exactly as before', () => {
    expect(lineTaxOf({ lineTotalCents: 200_000, taxRateBps: 1500 }, 0)).toEqual({ addedCents: 30_000, includedCents: 0 });
    expect(lineTaxOf({ lineTotalCents: 200_000, taxRateBps: 1500, taxIncluded: false }, 20_000)).toEqual({ addedCents: 27_000, includedCents: 0 });
  });

  it('every printed deal price is the bill to the paisa, one or many of it (the ÷ 1.15 way was a paisa off)', () => {
    for (const rupees of [4800, 3400, 3500, 2100, 1800, 1300, 1900, 850, 950, 1050, 2000, 1500]) {
      for (const qty of [1, 2, 3, 7]) {
        const line = { lineTotalCents: rupees * 100 * qty, taxRateBps: 1500, taxIncluded: true };
        const t = taxAfterDiscount([line], 0, EVERY_LINE);
        expect(line.lineTotalCents + t.taxCents).toBe(rupees * 100 * qty);
        expect(t.includedTaxCents).toBe(line.lineTotalCents - Math.round((line.lineTotalCents * 10_000) / 11_500));
      }
    }
  });
});

describe('taxAfterDiscount with a tax-included line', () => {
  const deal = { lineTotalCents: 480_000, taxRateBps: 1500, taxIncluded: true, noDiscount: true, menuItemName: 'Mega Cheese Box' };
  const pizza = { lineTotalCents: 200_000, taxRateBps: 1500, menuItemName: 'Fajita Pizza — Large' };
  const fee = { lineTotalCents: 20_000, taxRateBps: 0, menuItemName: 'Delivery Charge (Rs 200)' };

  it('a deal beside a regular pizza and a delivery charge: tax added on the pizza only, the deal’s inside it', () => {
    const t = taxAfterDiscount([deal, pizza, fee], 0, EVERY_LINE);
    expect(t.taxCents).toBe(30_000);
    expect(t.includedTaxCents).toBe(62_609);
    // The bill: Rs 4,800 + Rs 2,000 + 15% of it + Rs 200.
    expect(deal.lineTotalCents + pizza.lineTotalCents + fee.lineTotalCents + t.taxCents).toBe(730_000);
  });

  it('a discount that skips deals leaves the deal’s price and its tax alone', () => {
    const t = taxAfterDiscount([deal, pizza], 20_000, SKIP_DEALS);
    expect(t.shares).toEqual([0, 20_000]);
    expect(t.taxCents).toBe(27_000);
    expect(t.includedTaxCents).toBe(62_609);
  });

  it('a share that does reach it (an older rule over every line) takes the tax inside down with the price', () => {
    const t = taxAfterDiscount([deal], 48_000, EVERY_LINE);
    expect(t.taxCents).toBe(0);
    expect(t.includedTaxCents).toBe(432_000 - Math.round((432_000 * 10_000) / 11_500));
  });

  it('several offers: the same per-line rule', () => {
    const rows = [{ amountCents: 20_000, ruleJson: null }];
    const one = taxAfterDiscountRows([deal, pizza], rows);
    expect(one.taxCents + one.includedTaxCents).toBeGreaterThan(0);
    expect(one.includedTaxCents).toBe(lineTaxOf(deal, one.shares[0] ?? 0).includedCents);
  });

  it('no tax-included line: included 0 and the added tax as before', () => {
    const t = taxAfterDiscount([pizza, fee], 0, EVERY_LINE);
    expect(t).toEqual({ shares: [0, 0], taxCents: 30_000, includedTaxCents: 0 });
  });
});

describe('settledIncludedTax', () => {
  // A Mega Cheese Box alone: Rs 4,800 every way; 15% in cash, 8% by card.
  const quote: MethodQuote = { totalCents: 480_000, digitalTotalCents: 480_000, methodTotalsCents: null, netCents: 480_000 };
  const at = (way: string) => (way === 'cash' ? 62_609 : 35_556);

  it('all cash: the cash figure; all by card: the card figure', () => {
    expect(settledIncludedTax(quote, [{ method: 'cash', amountCents: 480_000 }], 480_000, at)).toEqual({ includedTaxCents: 62_609, digitalIncludedTaxCents: 0 });
    expect(settledIncludedTax(quote, [{ method: 'card', amountCents: 480_000 }], 0, at)).toEqual({ includedTaxCents: 35_556, digitalIncludedTaxCents: 35_556 });
  });

  it('half on the card, half in cash: half of each, and the customer still pays Rs 4,800', () => {
    const legs = [{ method: 'card', amountCents: 240_000 }];
    const s = settleLegs(quote, legs);
    expect(s.ok && s.cashDueCents).toBe(240_000);
    expect(s.ok && s.totalCents).toBe(480_000);
    expect(settledIncludedTax(quote, [...legs, { method: 'cash', amountCents: 240_000 }], 240_000, at)).toEqual({
      includedTaxCents: 31_305 + 17_778,
      digitalIncludedTaxCents: 17_778,
    });
  });

  it('nothing tax-included on the bill: nothing either way', () => {
    expect(settledIncludedTax(quote, [{ method: 'card', amountCents: 100 }], 479_900, () => 0)).toEqual({ includedTaxCents: 0, digitalIncludedTaxCents: 0 });
  });
});
