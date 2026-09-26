import { describe, expect, it } from 'vitest';
import { hasCapability } from '@cheeseoclock/shared-types';
import {
  FREE_CASHIER_REPRINTS,
  REPRINT_ANY_CAPABILITY,
  REPRINT_FREE_WINDOW_MS,
  isCurrentOrder,
  reprintApproval,
  type ReprintApprovalInput,
} from './reprint-policy.js';

const NOW = Date.parse('2026-09-26T15:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** A cashier asking for the paid receipt of an order paid 5 minutes ago, printed once automatically. */
const ask = (extra: Partial<ReprintApprovalInput> = {}): ReprintApprovalInput => ({
  role: 'cashier',
  document: 'receipt',
  copy: 'customer',
  status: 'paid',
  lastActivityAt: minutesAgo(5),
  nowMs: NOW,
  priorManual: 0,
  priorAll: 1,
  fbrCopy: false,
  orderLabel: 'Order #0042',
  ...extra,
});

describe('who may print a customer paper again without a manager', () => {
  it('a manager or the owner is never asked', () => {
    for (const role of ['manager', 'admin'] as const) {
      for (const extra of [
        { priorManual: 5, priorAll: 6 },
        { lastActivityAt: minutesAgo(600) },
        { status: 'refunded' as const },
        { copy: 'shop' as const },
      ]) {
        expect(reprintApproval(ask({ role, ...extra })).approval).toBe(false);
      }
    }
  });

  it('a cashier does not hold the "reprint anything" capability (fails if cashier rights ever widen)', () => {
    expect(hasCapability('cashier', REPRINT_ANY_CAPABILITY)).toBe(false);
    expect(hasCapability('manager', REPRINT_ANY_CAPABILITY)).toBe(true);
    expect(hasCapability('admin', REPRINT_ANY_CAPABILITY)).toBe(true);
  });

  it('the first paper of a current order is free, and so is one copy by hand', () => {
    expect(reprintApproval(ask({ priorAll: 0 })).approval).toBe(false);
    expect(reprintApproval(ask({ priorAll: 1, priorManual: 0 })).approval).toBe(false);
    expect(FREE_CASHIER_REPRINTS).toBe(1);
  });

  it('the second copy by hand needs a manager, and says why', () => {
    const r = reprintApproval(ask({ priorAll: 2, priorManual: 1 }));
    expect(r.approval).toBe(true);
    expect(r.why).toBe("Order #0042's receipt was already printed 2 times. A manager's PIN or password is needed for another copy.");
  });

  it('printer retries do not use up the cashier’s copy (only presses count)', () => {
    expect(reprintApproval(ask({ priorAll: 4, priorManual: 0 })).approval).toBe(false);
  });

  it('an order paid more than 30 minutes ago needs a manager — even for its first paper', () => {
    const old = ask({ lastActivityAt: new Date(NOW - REPRINT_FREE_WINDOW_MS - 1).toISOString() });
    expect(reprintApproval(old).approval).toBe(true);
    expect(reprintApproval({ ...old, priorAll: 0 }).approval).toBe(true);
    expect(reprintApproval(old).why).toMatch(/more than 30 minutes ago/);
    // Still on the board (e.g. out for delivery for an hour): current.
    expect(reprintApproval({ ...old, status: 'out_for_delivery' }).approval).toBe(false);
  });

  it('a refunded order and the shop copy always need a manager', () => {
    expect(reprintApproval(ask({ status: 'refunded' }))).toMatchObject({ approval: true });
    expect(reprintApproval(ask({ status: 'refunded' })).why).toMatch(/was refunded/);
    expect(reprintApproval(ask({ copy: 'shop', priorAll: 0 }))).toMatchObject({ approval: true });
  });

  it('a bill (NOT PAID) and a cancelled-order slip are free: nothing of cash value on them', () => {
    for (const document of ['bill', 'void'] as const) {
      expect(reprintApproval(ask({ document, priorAll: 5, priorManual: 4, lastActivityAt: minutesAgo(600) })).approval).toBe(false);
    }
  });

  it('the first paper carrying the FBR number is free', () => {
    expect(reprintApproval(ask({ fbrCopy: true, priorManual: 1, priorAll: 2 })).approval).toBe(false);
  });
});

describe('isCurrentOrder', () => {
  it('the board, or paid / taken within the window; never a cancelled or refunded one', () => {
    expect(isCurrentOrder('preparing', minutesAgo(300), NOW)).toBe(true);
    expect(isCurrentOrder('paid', minutesAgo(29), NOW)).toBe(true);
    expect(isCurrentOrder('paid', minutesAgo(31), NOW)).toBe(false);
    expect(isCurrentOrder('void', minutesAgo(1), NOW)).toBe(false);
    expect(isCurrentOrder('refunded', minutesAgo(1), NOW)).toBe(false);
    expect(isCurrentOrder('paid', 'not a date', NOW)).toBe(false);
  });
});
