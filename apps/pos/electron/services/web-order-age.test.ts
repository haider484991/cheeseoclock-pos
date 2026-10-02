import { describe, expect, it } from 'vitest';
import { PICKUP_DISCOUNT_PERCENT } from '@cheeseoclock/shared-types';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBSITE_UNCONFIRMED_TTL_MS, isStaleWebOrder, pickupPercentOf } from './web-order-age.js';

const NOW = Date.parse('2026-09-16T18:00:00.000Z');
const MAX = 45 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('isStaleWebOrder', () => {
  it('refuses an order older than the limit and keeps a younger one', () => {
    expect(isStaleWebOrder(ago(MAX + 1_000), MAX, NOW)).toBe(true);
    expect(isStaleWebOrder(ago(MAX - 1_000), MAX, NOW)).toBe(false);
    expect(isStaleWebOrder(ago(0), MAX, NOW)).toBe(false);
  });

  it('a site clock slightly ahead of ours is a fresh order, not a stale one', () => {
    expect(isStaleWebOrder(new Date(NOW + 30_000).toISOString(), MAX, NOW)).toBe(false);
  });

  it('never calls an order stale on an unparseable timestamp', () => {
    expect(isStaleWebOrder('not-a-date', MAX, NOW)).toBe(false);
  });
});

describe('pickupPercentOf', () => {
  it('reads the percent the site showed off the order', () => {
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 627_000, discountCents: 62_700 })).toBe(10);
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 200_000, discountCents: 30_000 })).toBe(15);
  });
  it('is 0 for a delivery and for a pickup the site gave nothing off', () => {
    expect(pickupPercentOf({ fulfilment: 'delivery', subtotalCents: 200_000, discountCents: 0 })).toBe(0);
    expect(pickupPercentOf({ subtotalCents: 200_000 })).toBe(0);
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 200_000, discountCents: 0 })).toBe(0);
  });
  it('falls back to the till constant for a site that sends no discount, and caps nonsense', () => {
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 200_000 })).toBe(PICKUP_DISCOUNT_PERCENT);
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 100, discountCents: 100 })).toBe(50);
  });
  it('reads the % off the lines it was worked on: a flagged deal is left out of the base (not Rs 150 of Rs 4,100 = 4%)', () => {
    const deal = { unitPriceCents: 260_000, quantity: 1, noDiscount: true };
    const pizza = { unitPriceCents: 150_000, quantity: 1 };
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 410_000, discountCents: 15_000, items: [deal, pizza] })).toBe(10);
    // The same order from a website older than the mark (no flag) was discounted over every line.
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 410_000, discountCents: 41_000, items: [{ ...deal, noDiscount: undefined }, pizza] })).toBe(10);
  });
  it('is 0 for a pick-up of flagged lines only (no discount row), never the till constant', () => {
    const items = [
      { unitPriceCents: 260_000, quantity: 1, noDiscount: true },
      { unitPriceCents: 120_000, quantity: 2, noDiscount: true },
    ];
    expect(pickupPercentOf({ fulfilment: 'pickup', subtotalCents: 500_000, discountCents: 0, items })).toBe(0);
  });
});

describe('WEBSITE_UNCONFIRMED_TTL_MS', () => {
  it('is the website’s own 45-minute cancel of unconfirmed orders (apps/web store-status.ts)', () => {
    expect(WEBSITE_UNCONFIRMED_TTL_MS).toBe(45 * 60_000);
    const site = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../web/src/lib/store-status.ts'),
      'utf8',
    );
    expect(site).toMatch(/export const UNCONFIRMED_ORDER_TTL_MS = 45 \* 60_000;/);
  });
});
