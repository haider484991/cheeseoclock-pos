import { describe, expect, it } from 'vitest';
import { isStaleWebOrder } from './web-order-age.js';

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
