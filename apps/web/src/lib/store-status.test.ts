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
