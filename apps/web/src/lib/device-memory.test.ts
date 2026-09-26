import { describe, expect, it } from 'vitest';
import {
  CART_TTL_MS,
  LAST_ORDER_TTL_MS,
  REORDER_TTL_MS,
  TRACKABLE_MS,
  isTrackable,
  parseCartSnapshot,
  parseDetails,
  parseLastOrder,
  parseReorder,
  serializeCartSnapshot,
  serializeDetails,
  serializeLastOrder,
  serializeReorder,
} from './device-memory';

const NOW = Date.parse('2026-09-26T18:00:00.000Z');
const ORDER_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const LINES = [{ posItemId: 'fajita-l', quantity: 2, modifierIds: ['no-onion'], notes: 'well done' }];

describe('saved details', () => {
  it('round-trips', () => {
    const d = { name: 'Ahmed Khan', phone: '0300 1234567', address: 'House 12, Street 4', zoneId: 'dha-6' };
    expect(parseDetails(serializeDetails(d))).toEqual(d);
  });

  it('reads nothing from junk, and caps what it reads', () => {
    expect(parseDetails(null)).toBeNull();
    expect(parseDetails('{oops')).toBeNull();
    expect(parseDetails('[1,2]')).toBeNull();
    expect(parseDetails('{}')).toBeNull();
    expect(parseDetails(JSON.stringify({ name: 7, phone: 'x'.repeat(50) }))).toEqual({
      name: '',
      phone: 'x'.repeat(20),
      address: '',
      zoneId: '',
    });
  });
});

describe('cart snapshot', () => {
  it('comes back while fresh', () => {
    expect(parseCartSnapshot(serializeCartSnapshot(LINES, NOW), NOW + 60_000)).toEqual(LINES);
  });

  it('is forgotten once stale, or when stamped in the future', () => {
    expect(parseCartSnapshot(serializeCartSnapshot(LINES, NOW), NOW + CART_TTL_MS + 1)).toEqual([]);
    expect(parseCartSnapshot(serializeCartSnapshot(LINES, NOW + 10 * 60_000), NOW)).toEqual([]);
    expect(parseCartSnapshot('garbage', NOW)).toEqual([]);
  });
});

describe('last order', () => {
  const o = { orderId: ORDER_ID, phone: '+923001234567', placedAt: NOW, fulfilment: 'pickup' as const, lines: LINES };

  it('round-trips and knows when it is still worth tracking', () => {
    const back = parseLastOrder(serializeLastOrder(o), NOW + 1000);
    expect(back).toEqual(o);
    expect(isTrackable(back!, NOW + 1000)).toBe(true);
    expect(isTrackable(back!, NOW + TRACKABLE_MS + 1)).toBe(false);
  });

  it('expires, and refuses a malformed id or missing phone', () => {
    expect(parseLastOrder(serializeLastOrder(o), NOW + LAST_ORDER_TTL_MS + 1)).toBeNull();
    expect(parseLastOrder(serializeLastOrder({ ...o, orderId: '../../etc' }), NOW)).toBeNull();
    expect(parseLastOrder(serializeLastOrder({ ...o, phone: '' }), NOW)).toBeNull();
  });

  it('treats anything but pickup as a delivery', () => {
    const raw = JSON.stringify({ orderId: ORDER_ID, phone: '0300', placedAt: NOW, fulfilment: 'drone' });
    expect(parseLastOrder(raw, NOW)?.fulfilment).toBe('delivery');
  });
});

describe('reorder hand-off', () => {
  it('is picked up only shortly after it was written', () => {
    expect(parseReorder(serializeReorder(LINES, NOW), NOW + 5_000)).toEqual(LINES);
    expect(parseReorder(serializeReorder(LINES, NOW), NOW + REORDER_TTL_MS + 1)).toEqual([]);
  });
});
