/**
 * The owner's foodpanda deal on the cart and at Pay, including when it takes
 * nothing off the shop's bill. Every figure is made up.
 */
import { describe, expect, it } from 'vitest';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { Cents, OrderDiscount } from '@cheeseoclock/shared-types';
import { foodpandaDealLine } from './foodpandaDealLine';

const row = (amount: number, reason: string | null, foodpanda: OrderDiscount['foodpanda']) => ({
  reason,
  amountCents: amount as Cents,
  foodpanda,
});

describe('the foodpanda deal line', () => {
  it('the shop pays it: its own words, nothing to add', () => {
    expect(
      foodpandaDealLine(row(40_000, 'Foodpanda deal 20% off', { dealPercent: 20, shopPercent: 20, dealCents: 40_000, platformCents: 0 }), 200_000),
    ).toEqual({ label: 'Foodpanda deal 20% off', note: null });
  });

  it('shared: foodpanda pays another part on top', () => {
    const line = foodpandaDealLine(
      row(20_000, 'Foodpanda deal 20% off (your part 10%)', { dealPercent: 20, shopPercent: 10, dealCents: 40_000, platformCents: 20_000 }),
      200_000,
    );
    expect(line).toEqual({ label: 'Foodpanda deal 20% off (your part 10%)', note: `foodpanda pays another ${formatCents(20_000)}` });
  });

  it('foodpanda pays all of it: the line still shows, with foodpanda’s part “of the deal”', () => {
    const line = foodpandaDealLine(
      row(0, 'Foodpanda deal 20% off (foodpanda pays it)', { dealPercent: 20, shopPercent: 0, dealCents: 40_000, platformCents: 40_000 }),
      200_000,
    );
    expect(line).toEqual({ label: 'Foodpanda deal 20% off (foodpanda pays it)', note: `foodpanda pays ${formatCents(40_000)} of the deal` });
  });

  it('under the minimum: says from how much food it takes off', () => {
    const fp = { dealPercent: 20, shopPercent: 20, dealCents: 0, platformCents: 0, minOrderCents: 100_000 };
    expect(foodpandaDealLine(row(0, 'Foodpanda deal 20% off', fp), 80_000).note).toBe(`Takes off from ${formatCents(100_000)} of food`);
    // An empty order too; with no minimum there is nothing to say yet.
    expect(foodpandaDealLine(row(0, 'Foodpanda deal 20% off', fp), 0).note).toBe(`Takes off from ${formatCents(100_000)} of food`);
    expect(foodpandaDealLine(row(0, 'Foodpanda deal 20% off', { ...fp, minOrderCents: null }), 0).note).toBeNull();
  });

  it('a deal row an older till wrote (no figures): still named', () => {
    expect(foodpandaDealLine(row(0, null, null), 0)).toEqual({ label: 'Foodpanda deal', note: null });
  });
});
