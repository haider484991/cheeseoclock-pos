import { describe, expect, it } from 'vitest';
import {
  NOT_ON_VALUE_DEALS,
  PICKUP_DISCOUNT_PERCENT,
  WEBSITE_PICKUP_MAX_PERCENT,
  webOrderPickupPercent,
  type WebFulfilment,
  type WebOrderItem,
} from '@cheeseoclock/shared-types';
import { percentDiscountCents } from './pricing';

/**
 * The till's pickupPercentOf as v0.7.33 released it (apps/pos
 * web-order-age.ts): discount ÷ subtotal. Copied here so this stays the
 * reference after the till starts calling webOrderPickupPercent itself.
 */
function v0733PickupPercentOf(web: { fulfilment?: string; discountCents?: number; subtotalCents: number }): number {
  if (web.fulfilment !== 'pickup') return 0;
  if (typeof web.discountCents !== 'number' || !(web.subtotalCents > 0)) return PICKUP_DISCOUNT_PERCENT;
  const pct = Math.round((web.discountCents * 100) / web.subtotalCents);
  return Math.max(0, Math.min(50, pct));
}

function line(unitPriceCents: number, quantity: number, noDiscount?: boolean): WebOrderItem {
  return {
    posItemId: 'item',
    name: 'Item',
    quantity,
    unitPriceCents,
    modifiers: [],
    notes: null,
    ...(noDiscount === undefined ? {} : { noDiscount }),
  };
}

const sum = (items: readonly WebOrderItem[]) => items.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);

describe('webOrderPickupPercent reads every unflagged order as the v0.7.33 till did', () => {
  it('equals discount ÷ subtotal on 500 seeded orders with no flagged line', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const fulfilments: Array<WebFulfilment | undefined> = ['pickup', 'pickup', 'delivery', undefined];
    const seen = { fallback: 0, clamped: 0, percent: 0 };
    for (let n = 0; n < 500; n++) {
      const items = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        line(Math.floor(rnd() * 900_000) + 1, 1 + Math.floor(rnd() * 4), rnd() < 0.3 ? false : undefined),
      );
      const subtotalCents = sum(items);
      const pick = rnd();
      const discountCents =
        pick < 0.15
          ? undefined
          : pick < 0.6
            ? percentDiscountCents(subtotalCents, Math.floor(rnd() * 51))
            : Math.floor(rnd() * (subtotalCents + 1) * 1.2);
      const order = {
        fulfilment: fulfilments[Math.floor(rnd() * fulfilments.length)],
        discountCents,
        subtotalCents,
        ...(rnd() < 0.1 ? {} : { items }),
      };
      const read = webOrderPickupPercent(order);
      expect(read ?? PICKUP_DISCOUNT_PERCENT).toBe(v0733PickupPercentOf(order));
      if (read === null) seen.fallback++;
      else if (order.fulfilment === 'pickup' && read === 50) seen.clamped++;
      else if (order.fulfilment === 'pickup') seen.percent++;
    }
    // Every branch of the old formula was met.
    expect(seen.fallback).toBeGreaterThan(0);
    expect(seen.clamped).toBeGreaterThan(0);
    expect(seen.percent).toBeGreaterThan(0);
  });
});

describe('webOrderPickupPercent reads a flagged pick-up by the lines it was worked on', () => {
  it('gives back every % from 0 to 50 exactly, the discount worked on the unflagged lines only', () => {
    let seed = 2026;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let p = 0; p <= WEBSITE_PICKUP_MAX_PERCENT; p++) {
      for (let n = 0; n < 40; n++) {
        // At least one line of each; each line at least Rs 1, as on the menu.
        const taken = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () =>
          line(Math.floor(rnd() * 900_000) + 100, 1 + Math.floor(rnd() * 4), rnd() < 0.5 ? false : undefined),
        );
        const flagged = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
          line(Math.floor(rnd() * 900_000) + 100, 1 + Math.floor(rnd() * 4), true),
        );
        const items = rnd() < 0.5 ? [...taken, ...flagged] : [...flagged, ...taken];
        const order = {
          fulfilment: 'pickup' as const,
          subtotalCents: sum(items),
          discountCents: percentDiscountCents(sum(taken), p),
          items,
        };
        expect(webOrderPickupPercent(order)).toBe(p);
      }
    }
  });

  it('reads 10% where discount ÷ subtotal reads 4% (a Rs 2,600 deal and a Rs 1,500 pizza)', () => {
    const order = {
      fulfilment: 'pickup' as const,
      subtotalCents: 410_000,
      discountCents: 15_000,
      items: [line(260_000, 1, true), line(150_000, 1)],
    };
    expect(webOrderPickupPercent(order)).toBe(10);
    expect(v0733PickupPercentOf(order)).toBe(4);
  });

  it('reads 10% off Big Two (marked) + Veggie Lovers Large + Nuggets', () => {
    const items = [line(360_000, 1, true), line(200_000, 1), line(67_000, 1)];
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 627_000, discountCents: 26_700, items })).toBe(10);
  });

  it('counts a line by its unit price (choices included) times its quantity', () => {
    const items = [line(130_000, 2, true), line(75_000, 2)];
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 410_000, discountCents: 15_000, items })).toBe(10);
  });
});

describe('webOrderPickupPercent edges', () => {
  it('gives 0 when every line is flagged', () => {
    const items = [line(360_000, 1, true), line(260_000, 2, true)];
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 880_000, discountCents: 0, items })).toBe(0);
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 880_000, discountCents: 5_000, items })).toBe(0);
  });

  it('gives 0 for a delivery, and for an order from a site that predates pick-up', () => {
    const items = [line(360_000, 1, true), line(150_000, 1), line(20_000, 1)];
    expect(webOrderPickupPercent({ fulfilment: 'delivery', subtotalCents: 530_000, discountCents: 0, items })).toBe(0);
    expect(webOrderPickupPercent({ fulfilment: 'delivery', subtotalCents: 530_000, discountCents: 15_000, items })).toBe(0);
    expect(webOrderPickupPercent({ subtotalCents: 530_000, discountCents: 0, items })).toBe(0);
  });

  it('gives null (the caller applies PICKUP_DISCOUNT_PERCENT) with no discount or no subtotal', () => {
    const items = [line(150_000, 1)];
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 150_000, items })).toBeNull();
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 0, discountCents: 0, items: [] })).toBeNull();
  });

  it('keeps the % to 0–50: subtotal 100 with discount 100 reads 50', () => {
    expect(WEBSITE_PICKUP_MAX_PERCENT).toBe(50);
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 100, discountCents: 100, items: [line(100, 1)] })).toBe(
      WEBSITE_PICKUP_MAX_PERCENT,
    );
    expect(webOrderPickupPercent({ fulfilment: 'pickup', subtotalCents: 100, discountCents: -20, items: [line(100, 1)] })).toBe(0);
  });

  it('reads `noDiscount: false` and a line with no key alike', () => {
    const base = { fulfilment: 'pickup' as const, subtotalCents: 410_000, discountCents: 15_000 };
    expect(webOrderPickupPercent({ ...base, items: [line(260_000, 1, false), line(150_000, 1)] })).toBe(4);
    expect(webOrderPickupPercent({ ...base, items: [line(260_000, 1), line(150_000, 1)] })).toBe(4);
    expect(webOrderPickupPercent(base)).toBe(4);
  });
});

describe('NOT_ON_VALUE_DEALS', () => {
  it("is the owner's words", () => {
    expect(NOT_ON_VALUE_DEALS).toBe('not on value deals');
  });
});
