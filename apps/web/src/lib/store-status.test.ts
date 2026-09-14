import { describe, expect, it } from 'vitest';
import { CLOSED, HEARTBEAT_STALE_MS, evaluateStatus } from './store-status';

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
