/**
 * Order History → an order → Money → Change (paymentMethodWords.ts, v0.7.42):
 * the owner's alone, never foodpanda's, and what the toast says. Every
 * amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { formatCents } from '@cheeseoclock/pos-domain';
import { CHANGE_METHOD_NOTE, drawerWord, mayChangeMethod, methodChangedToast } from './paymentMethodWords';

describe('who may change how it was paid', () => {
  it('the owner (admin login), on any payment but foodpanda’s', () => {
    expect(mayChangeMethod('admin', 'takeaway', 'cash')).toBe(true);
    expect(mayChangeMethod('admin', 'delivery', 'jazzcash')).toBe(true);
    expect(mayChangeMethod('admin', 'foodpanda', 'foodpanda')).toBe(false);
    expect(mayChangeMethod('admin', 'takeaway', 'foodpanda')).toBe(false);
  });

  it('never a manager or a cashier (the main process refuses them too)', () => {
    expect(mayChangeMethod('manager', 'takeaway', 'cash')).toBe(false);
    expect(mayChangeMethod('cashier', 'takeaway', 'cash')).toBe(false);
    expect(mayChangeMethod(null, 'takeaway', 'cash')).toBe(false);
  });
});

describe('the words', () => {
  it('the note: only the method changes, the drawer follows, a closed shift too', () => {
    expect(CHANGE_METHOD_NOTE).toContain('the amount and the bill stay as they are');
    expect(CHANGE_METHOD_NOTE).toContain('also for a shift that is already closed');
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
});
