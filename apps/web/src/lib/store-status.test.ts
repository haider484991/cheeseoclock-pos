import { describe, expect, it } from 'vitest';
import {
  CLOSED,
  HEARTBEAT_STALE_MS,
  UNCONFIRMED_ORDER_TTL_MS,
  blockPickupOf,
  evaluateStatus,
  unconfirmedOrderCutoff,
} from './store-status';

const NOW = Date.parse('2026-09-14T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('evaluateStatus', () => {
  it('is open only when the till says yes and said so recently', () => {
    const s = evaluateStatus({ accepting_orders: true, updated_at: ago(30_000) }, NOW);
    expect(s.acceptingOrders).toBe(true);
    expect(s.stale).toBe(false);
  });

  it('is closed when the till says no, however fresh the beat', () => {
    const s = evaluateStatus({ accepting_orders: false, updated_at: ago(1_000) }, NOW);
    expect(s.acceptingOrders).toBe(false);
    expect(s.posAcceptingOrders).toBe(false);
    expect(s.stale).toBe(false);
  });

  it('closes when the till goes quiet — a shut laptop cannot send "no"', () => {
    const fresh = evaluateStatus(
      { accepting_orders: true, updated_at: ago(HEARTBEAT_STALE_MS - 1_000) },
      NOW,
    );
    expect(fresh.acceptingOrders).toBe(true);

    const gone = evaluateStatus(
      { accepting_orders: true, updated_at: ago(HEARTBEAT_STALE_MS + 1_000) },
      NOW,
    );
    expect(gone.acceptingOrders).toBe(false);
    expect(gone.stale).toBe(true);
    // The last thing it said is still reported, for diagnostics.
    expect(gone.posAcceptingOrders).toBe(true);
  });

  it('a till that has never reported is closed, not open', () => {
    expect(evaluateStatus(null, NOW)).toEqual(CLOSED);
    expect(CLOSED.acceptingOrders).toBe(false);
  });

  it('accepts a Date as well as a string, and survives a bad timestamp', () => {
    const asDate = evaluateStatus(
      { accepting_orders: true, updated_at: new Date(NOW - 5_000) },
      NOW,
    );
    expect(asDate.acceptingOrders).toBe(true);
    expect(evaluateStatus({ accepting_orders: true, updated_at: 'not-a-date' }, NOW)).toEqual(
      CLOSED,
    );
  });

  it('a clock slightly ahead of ours still counts as a live beat', () => {
    const ahead = evaluateStatus(
      { accepting_orders: true, updated_at: new Date(NOW + 30_000).toISOString() },
      NOW,
    );
    expect(ahead.acceptingOrders).toBe(true);
  });
});

describe('unconfirmedOrderCutoff', () => {
  it('expires orders older than 45 minutes and keeps younger ones', () => {
    expect(UNCONFIRMED_ORDER_TTL_MS).toBe(45 * 60_000);
    const cutoff = Date.parse(unconfirmedOrderCutoff(NOW));
    expect(cutoff).toBe(NOW - UNCONFIRMED_ORDER_TTL_MS);
    // The sweep is `created_at < cutoff`: 46 minutes old goes, 44 stays.
    expect(NOW - 46 * 60_000 < cutoff).toBe(true);
    expect(NOW - 44 * 60_000 < cutoff).toBe(false);
  });
});

describe('pick-up from the owner’s settings block', () => {
  const beat = { accepting_orders: true, updated_at: ago(5_000), pickup: true, pickup_discount_pct: 15 };

  it('with no block, the heartbeat decides, as before', () => {
    expect(evaluateStatus(beat, NOW)).toMatchObject({ pickupAvailable: true, pickupDiscountPercent: 15 });
    expect(evaluateStatus({ ...beat, settings_pickup: null }, NOW)).toMatchObject({ pickupAvailable: true, pickupDiscountPercent: 15 });
  });

  it('with a block, its % wins and its switch must be on', () => {
    expect(evaluateStatus({ ...beat, settings_pickup: { offered: true, percent: 20 } }, NOW)).toMatchObject({
      pickupAvailable: true,
      pickupDiscountPercent: 20,
    });
    expect(evaluateStatus({ ...beat, settings_pickup: { offered: false, percent: 20 } }, NOW).pickupAvailable).toBe(false);
    // …but the till must still be able to import one, and be listening.
    expect(evaluateStatus({ ...beat, pickup: false, settings_pickup: { offered: true, percent: 20 } }, NOW).pickupAvailable).toBe(false);
    expect(evaluateStatus({ ...beat, updated_at: ago(HEARTBEAT_STALE_MS + 1_000), settings_pickup: { offered: true, percent: 20 } }, NOW).pickupAvailable).toBe(false);
  });

  it('an unreadable block is no block', () => {
    expect(blockPickupOf('{"offered":true,"percent":20}')).toEqual({ offered: true, percent: 20 });
    expect(blockPickupOf({ offered: true, percent: 60 })).toBeNull();
    expect(blockPickupOf({ offered: 'yes', percent: 10 })).toBeNull();
    expect(blockPickupOf('not json')).toBeNull();
    expect(evaluateStatus({ ...beat, settings_pickup: { offered: true, percent: 12.5 } }, NOW).pickupDiscountPercent).toBe(15);
  });
});

describe('the website % off a delivery’s food (v0.7.37, WEBSITE DELIVERY DISCOUNT)', () => {
  const beat = { accepting_orders: true, updated_at: ago(5_000), pickup: true, pickup_discount_pct: 10, delivery_discount: true };
  const on = { offered: true, percent: 10, alsoDelivery: true };

  it('only when the owner’s block says so AND the listening till bills it AND the shop is open', () => {
    expect(evaluateStatus({ ...beat, settings_pickup: on }, NOW).deliveryDiscountPercent).toBe(10);
    // Pick-up switched off does not switch the delivery % off: they are separate choices.
    expect(evaluateStatus({ ...beat, settings_pickup: { ...on, offered: false } }, NOW)).toMatchObject({
      pickupAvailable: false,
      deliveryDiscountPercent: 10,
    });
    expect(evaluateStatus({ ...beat, settings_pickup: { offered: true, percent: 10 } }, NOW).deliveryDiscountPercent).toBe(0);
    expect(evaluateStatus({ ...beat, delivery_discount: false, settings_pickup: on }, NOW).deliveryDiscountPercent).toBe(0);
    expect(evaluateStatus({ ...beat, delivery_discount: null, settings_pickup: on }, NOW).deliveryDiscountPercent).toBe(0);
    expect(evaluateStatus({ ...beat, accepting_orders: false, settings_pickup: on }, NOW).deliveryDiscountPercent).toBe(0);
    expect(evaluateStatus({ ...beat, updated_at: ago(HEARTBEAT_STALE_MS + 1_000), settings_pickup: on }, NOW).deliveryDiscountPercent).toBe(0);
    // No block at all (the heartbeat alone never turns it on).
    expect(evaluateStatus(beat, NOW).deliveryDiscountPercent).toBe(0);
    expect(evaluateStatus(null, NOW).deliveryDiscountPercent).toBe(0);
  });

  it('the block reader keeps alsoDelivery only as an exact true', () => {
    expect(blockPickupOf(on)).toEqual(on);
    expect(blockPickupOf({ ...on, alsoDelivery: 'yes' })).toEqual({ offered: true, percent: 10 });
    expect(blockPickupOf({ ...on, alsoDelivery: false })).toEqual({ offered: true, percent: 10 });
    expect(evaluateStatus({ ...beat, settings_pickup: { ...on, alsoDelivery: 1 } }, NOW).deliveryDiscountPercent).toBe(0);
  });
});

describe('a category’s own % (v0.7.50, WEBSITE DISCOUNT BY CATEGORY)', () => {
  const beat = {
    accepting_orders: true,
    updated_at: ago(5_000),
    pickup: true,
    pickup_discount_pct: 10,
    delivery_discount: true,
    category_discount: true,
  };
  const cats = [{ categoryId: 'cat-pizza', percent: 20 }];
  const on = { offered: true, percent: 10, alsoDelivery: true, categoryPercents: cats };

  it('only when the owner’s block names them AND the listening till bills the parts AND the shop is open', () => {
    expect(evaluateStatus({ ...beat, settings_pickup: on }, NOW)).toMatchObject({
      pickupDiscountPercent: 10,
      deliveryDiscountPercent: 10,
      pickupCategoryPercents: cats,
      deliveryCategoryPercents: cats,
    });
    // A till that cannot bill the parts (before 0.7.50), a closed shop, a quiet till: none at all.
    for (const row of [
      { ...beat, category_discount: false },
      { ...beat, category_discount: null },
      { ...beat, category_discount: undefined },
      { ...beat, accepting_orders: false },
      { ...beat, updated_at: ago(HEARTBEAT_STALE_MS + 1_000) },
    ]) {
      const s = evaluateStatus({ ...row, settings_pickup: on }, NOW);
      expect(s).not.toHaveProperty('pickupCategoryPercents');
      expect(s).not.toHaveProperty('deliveryCategoryPercents');
    }
    // A delivery's only where the delivery % applies.
    for (const row of [
      { ...beat, settings_pickup: { ...on, alsoDelivery: false } },
      { ...beat, delivery_discount: false, settings_pickup: on },
    ]) {
      const s = evaluateStatus(row, NOW);
      expect(s.pickupCategoryPercents).toEqual(cats);
      expect(s).not.toHaveProperty('deliveryCategoryPercents');
    }
  });

  it('a block without them (or no block): the status is exactly as before, no new key', () => {
    const before = evaluateStatus({ ...beat, settings_pickup: { offered: true, percent: 10, alsoDelivery: true } }, NOW);
    expect(Object.keys(before).sort()).toEqual(
      ['acceptingOrders', 'deliveryDiscountPercent', 'pickupAvailable', 'pickupDiscountPercent', 'posAcceptingOrders', 'stale', 'updatedAt'].sort(),
    );
    expect(Object.keys(evaluateStatus(beat, NOW))).toEqual(Object.keys(before));
    expect(evaluateStatus({ ...beat, settings_pickup: { ...on, categoryPercents: [] } }, NOW)).toEqual(before);
  });

  it('the block reader keeps only good rows: each category once (the first), a whole % from 1 to 50, at most 10', () => {
    expect(blockPickupOf(JSON.stringify(on))).toEqual(on);
    expect(blockPickupOf({ offered: true, percent: 10, categoryPercents: [] })).toEqual({ offered: true, percent: 10 });
    expect(blockPickupOf({ offered: true, percent: 10, categoryPercents: 'Pizza 20%' })).toEqual({ offered: true, percent: 10 });
    expect(
      blockPickupOf({
        offered: true,
        percent: 10,
        categoryPercents: [
          { categoryId: 'a', percent: 0 },
          { categoryId: 'b', percent: 51 },
          { categoryId: 'c', percent: 12.5 },
          { categoryId: '', percent: 20 },
          { categoryId: 'd', percent: 20 },
          { categoryId: 'd', percent: 30 },
          null,
        ],
      }),
    ).toEqual({ offered: true, percent: 10, categoryPercents: [{ categoryId: 'd', percent: 20 }] });
    const twelve = Array.from({ length: 12 }, (_, i) => ({ categoryId: `cat-${i}`, percent: 20 }));
    expect(blockPickupOf({ offered: true, percent: 10, categoryPercents: twelve })?.categoryPercents).toHaveLength(10);
  });
});
