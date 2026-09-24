import { describe, expect, it } from 'vitest';
import { computeDiscountCents } from '../../../../packages/pos-domain/src/discount';
import { computeTax } from '../../../../packages/pos-domain/src/tax';
import { percentDiscountCents, priceOrder, type PricedLine } from './pricing';

/** The till's recomputeOrderTotals (apps/pos order-repo), built from its own pieces. */
function tillTotals(lines: PricedLine[], percent: number) {
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const discount = Math.min(
    computeDiscountCents(subtotal, { type: 'percent', value: percent }) as number,
    subtotal,
  );
  let tax = 0;
  if (subtotal > 0) {
    for (const l of lines) {
      const lineDiscount = Math.round(discount * (l.lineTotalCents / subtotal));
      const net = Math.max(0, l.lineTotalCents - lineDiscount);
      tax += computeTax(net, l.taxRateBps, 'exclusive').taxCents as number;
    }
  }
  return { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: subtotal - discount + tax };
}

describe('priceOrder matches the till', () => {
  it('prices a pickup the way the POS will bill it', () => {
    const lines = [
      { lineTotalCents: 200_000, taxRateBps: 1500 }, // Veggie Lovers Large
      { lineTotalCents: 360_000, taxRateBps: 1500 }, // Big Two
      { lineTotalCents: 67_000, taxRateBps: 1500 }, // Nuggets
    ];
    const t = priceOrder(lines, 10);
    expect(t).toEqual(tillTotals(lines, 10));
    expect(t.discountCents).toBe(62_700);
    expect(t.totalCents).toBe(627_000 - 62_700 + 84_645);
  });

  it('agrees on awkward amounts and mixed tax rates, with and without a discount', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 500; n++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
        lineTotalCents: Math.floor(rnd() * 900_000) + 1,
        taxRateBps: [0, 1300, 1500, 1600][Math.floor(rnd() * 4)]!,
      }));
      for (const pct of [0, 10]) expect(priceOrder(lines, pct)).toEqual(tillTotals(lines, pct));
    }
  });

  it('never discounts below zero', () => {
    expect(percentDiscountCents(0, 10)).toBe(0);
    expect(percentDiscountCents(500, 150)).toBe(500);
    expect(priceOrder([], 10)).toEqual({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 });
  });
});
