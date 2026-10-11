/**
 * An order → Money → Change (paymentMethodWords.ts, v0.7.42; 0.7.45 the
 * counter too while the shift is open): who sees it, never foodpanda's, what
 * to hand over, and what the toast says. Every amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { formatCents } from '@cheeseoclock/pos-domain';
import { CHANGE_METHOD_NOTE, changeHandOver, drawerWord, mayChangeMethod, methodChangedToast } from './paymentMethodWords';

describe('who may change how it was paid', () => {
  it('the owner (admin login), on any payment but foodpanda’s', () => {
    expect(mayChangeMethod('admin', 'takeaway', 'cash')).toBe(true);
    expect(mayChangeMethod('admin', 'delivery', 'jazzcash')).toBe(true);
    expect(mayChangeMethod('admin', 'foodpanda', 'foodpanda')).toBe(false);
    expect(mayChangeMethod('admin', 'takeaway', 'foodpanda')).toBe(false);
  });

  it('a manager or a cashier only while the shift that took it is open (the main process checks again)', () => {
    expect(mayChangeMethod('manager', 'takeaway', 'cash')).toBe(false);
    expect(mayChangeMethod('cashier', 'takeaway', 'cash')).toBe(false);
    expect(mayChangeMethod('manager', 'takeaway', 'cash', true)).toBe(true);
    expect(mayChangeMethod('cashier', 'delivery', 'card', true)).toBe(true);
    expect(mayChangeMethod('cashier', 'foodpanda', 'foodpanda', true)).toBe(false);
    expect(mayChangeMethod(null, 'takeaway', 'cash', true)).toBe(false);
  });
});

describe('the words', () => {
  it('the note: the drawer follows, a closed shift too, and the bill is worked out again when its tax depends on the way', () => {
    expect(CHANGE_METHOD_NOTE).toContain('also for a shift that is already closed');
    expect(CHANGE_METHOD_NOTE).toContain('the bill is worked out again');
  });

  it('what to hand over: the cash back and the card taken, the card reversed and the cash taken', () => {
    expect(changeHandOver('cash', 115_000, 'card', 105_000)).toBe(
      `If the customer pays again: hand back ${formatCents(115_000)} cash, then take ${formatCents(105_000)} on the card. If it was only pressed wrong, nothing to hand back. The bill is now ${formatCents(105_000)}: the tax on the card is different.`,
    );
    expect(changeHandOver('card', 105_000, 'cash', 115_000)).toBe(
      `If the customer pays again: reverse the ${formatCents(105_000)} card payment on the machine, then take ${formatCents(115_000)} in cash. If it was only pressed wrong, nothing to hand back. The bill is now ${formatCents(115_000)}: the tax in cash is different.`,
    );
    expect(changeHandOver('jazzcash', 50_000, 'easypaisa', 50_000)).toBe(
      `If the customer pays again: send back the ${formatCents(50_000)} JazzCash payment, then take ${formatCents(50_000)} by EasyPaisa. If it was only pressed wrong, nothing to hand back.`,
    );
  });

  it('the drawer at a close: matches under Re 1 either way, else short or over', () => {
    expect(drawerWord(0)).toBe('matches');
    expect(drawerWord(-99)).toBe('matches');
    expect(drawerWord(-82_800)).toBe(`short ${formatCents(82_800)}`);
    expect(drawerWord(10_000)).toBe(`over ${formatCents(10_000)}`);
  });

  it('the toast: the change; and a closed shift put right with it', () => {
    expect(methodChangedToast('Order #12', 'cash', 'jazzcash', null)).toEqual({ title: 'Order #12: Cash → JazzCash' });
    const t = methodChangedToast('Order #12', 'cash', 'jazzcash', {
      shiftId: 's1',
      openedAt: '2026-10-07T07:58:00.000Z',
      expectedCashCents: 164_000,
      varianceCents: 0,
      previousVarianceCents: -82_800,
    });
    expect(t.title).toBe('Order #12: Cash → JazzCash');
    expect(t.description).toBe(`The shift opened Wed 7 Oct was already closed: its drawer now matches (it was short ${formatCents(82_800)}).`);
  });

  it('the toast: a bill worked out again says what it is now', () => {
    expect(
      methodChangedToast('Order #12', 'cash', 'card', null, { amountBeforeCents: 115_000, amountAfterCents: 105_000, totalBeforeCents: 115_000, totalAfterCents: 105_000 }),
    ).toEqual({ title: 'Order #12: Cash → Card', description: `The bill is now ${formatCents(105_000)} (it was ${formatCents(115_000)}).` });
  });
});
