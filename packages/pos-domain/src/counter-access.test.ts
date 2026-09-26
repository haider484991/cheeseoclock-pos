import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@cheeseoclock/shared-types';
import {
  BOARD_STATUSES,
  COUNTER_ORDER_WINDOW_MS,
  KITCHEN_TICKET_STATUSES,
  counterOrderAccess,
  counterPhoneLookup,
  counterOrderNumber,
  counterOrderScope,
} from './counter-access.js';

const NOW = Date.parse('2026-09-26T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const order = (status: OrderStatus, shiftId: string, createdAt: string) => ({ status, shiftId, createdAt });

const ALL: OrderStatus[] = [
  'open',
  'sent_to_kitchen',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'served',
  'paid',
  'void',
  'refunded',
];
const FINISHED: OrderStatus[] = ['delivered', 'served', 'paid', 'void', 'refunded'];

describe('counterOrderScope', () => {
  it('an order of a shift still open, from a few hours ago', () => {
    expect(counterOrderScope(order('paid', 's1', at(3 * HOUR)), true, NOW)).toBe('ok');
  });

  it('never once that shift is closed', () => {
    expect(counterOrderScope(order('paid', 's1', at(10 * 60_000)), false, NOW)).toBe('earlier_shift');
  });

  it('taken with no shift open: only within the window', () => {
    expect(counterOrderScope(order('paid', '', at(HOUR)), false, NOW)).toBe('ok');
    expect(counterOrderScope(order('paid', '', at(30 * HOUR)), false, NOW)).toBe('too_old');
  });

  it('a shift nobody closed does not open up days of history', () => {
    expect(counterOrderScope(order('paid', 's1', at(COUNTER_ORDER_WINDOW_MS - 1)), true, NOW)).toBe('ok');
    expect(counterOrderScope(order('paid', 's1', at(COUNTER_ORDER_WINDOW_MS + 1)), true, NOW)).toBe('too_old');
  });

  it('a date ahead of the clock (a fast clock put back mid-shift) is still this shift', () => {
    for (const ahead of [2 * 60_000, HOUR, 3 * 24 * HOUR]) {
      expect(counterOrderScope(order('paid', 's1', at(-ahead)), true, NOW)).toBe('ok');
      expect(counterOrderScope(order('paid', '', at(-ahead)), false, NOW)).toBe('ok');
    }
    // …but never lets a closed shift back in.
    expect(counterOrderScope(order('paid', 's1', at(-HOUR)), false, NOW)).toBe('earlier_shift');
  });

  it('a date that cannot be read is never "this shift"', () => {
    expect(counterOrderScope(order('paid', 's1', 'yesterday'), true, NOW)).toBe('too_old');
    expect(counterOrderScope(order('paid', '', ''), true, NOW)).toBe('too_old');
  });
});

describe('counterOrderAccess — open (look at the order)', () => {
  it('the draft being rung up, and every board order, even from a closed shift days ago', () => {
    expect(counterOrderAccess(order('open', 's1', at(HOUR)), 'open', true, NOW)).toBe('ok');
    for (const s of BOARD_STATUSES) {
      expect(counterOrderAccess(order(s, 'old', at(72 * HOUR)), 'open', false, NOW)).toBe('ok');
    }
  });

  it('a finished order: this shift yes, an earlier shift no', () => {
    for (const s of FINISHED) {
      expect(counterOrderAccess(order(s, 's1', at(HOUR)), 'open', true, NOW)).toBe('ok');
      expect(counterOrderAccess(order(s, 's0', at(HOUR)), 'open', false, NOW)).toBe('earlier_shift');
      expect(counterOrderAccess(order(s, '', at(30 * HOUR)), 'open', false, NOW)).toBe('too_old');
    }
  });
});

describe('counterOrderAccess — receipt', () => {
  it('no bill for a draft', () => {
    expect(counterOrderAccess(order('open', 's1', at(60_000)), 'receipt', true, NOW)).toBe('not_sent');
  });

  it('board orders and this shift, not an earlier shift', () => {
    expect(counterOrderAccess(order('out_for_delivery', 's0', at(40 * HOUR)), 'receipt', false, NOW)).toBe('ok');
    expect(counterOrderAccess(order('paid', 's1', at(HOUR)), 'receipt', true, NOW)).toBe('ok');
    expect(counterOrderAccess(order('paid', 's0', at(HOUR)), 'receipt', false, NOW)).toBe('earlier_shift');
  });
});

describe('counterOrderAccess — kitchen ticket', () => {
  it('only while the kitchen still has the order, whatever the shift', () => {
    for (const s of ALL) {
      const want = s === 'open' ? 'not_sent' : KITCHEN_TICKET_STATUSES.includes(s) ? 'ok' : 'left_kitchen';
      expect(counterOrderAccess(order(s, 's1', at(HOUR)), 'kitchen', true, NOW)).toBe(want);
    }
  });

  it('out with the rider or handed over: the kitchen is done with it', () => {
    expect(counterOrderAccess(order('out_for_delivery', 's1', at(60_000)), 'kitchen', true, NOW)).toBe('left_kitchen');
    expect(counterOrderAccess(order('paid', 's1', at(60_000)), 'kitchen', true, NOW)).toBe('left_kitchen');
  });
});

describe('counterPhoneLookup', () => {
  it('a whole mobile number in any usual form is looked up as the stored form', () => {
    for (const typed of ['03001234567', '0300 1234567', '+92 300 1234567', '0092-300-1234567', '300 1234567']) {
      expect(counterPhoneLookup(typed)).toEqual({ stage: 'complete', canonical: '+923001234567' });
    }
  });

  it('a Karachi landline with its 021 is whole too', () => {
    expect(counterPhoneLookup('021 3587 1234')).toEqual({ stage: 'complete', canonical: '+922135871234' });
  });

  it('part of a number, or a name, is never looked up', () => {
    for (const typed of ['0', '03', '0300', '0300 12345', '1234567', '3587 1234', 'Ali']) {
      expect(counterPhoneLookup(typed)).toEqual({ stage: 'typing', canonical: null });
    }
    expect(counterPhoneLookup('   ')).toEqual({ stage: 'empty', canonical: null });
  });

  it('enough digits that are not a number the shop can match: saved as typed, not looked up', () => {
    expect(counterPhoneLookup('+44 7700 900123')).toEqual({ stage: 'unknown', canonical: null });
    expect(counterPhoneLookup('030012345678')).toEqual({ stage: 'unknown', canonical: null });
  });
});

describe('counterOrderNumber', () => {
  it('the number people say, with or without #, is the day number padded as the till prints it', () => {
    for (const typed of ['1043', '#1043', '# 1043', ' 1043 ']) {
      expect(counterOrderNumber(typed)).toEqual({ suffix: '1043' });
    }
    expect(counterOrderNumber('43')).toEqual({ suffix: '0043' });
    expect(counterOrderNumber('0043')).toEqual({ suffix: '0043' });
    expect(counterOrderNumber('10432')).toEqual({ suffix: '10432' });
  });

  it('the full number off the receipt is matched exactly', () => {
    expect(counterOrderNumber('20260926-1043')).toEqual({ full: '20260926-1043' });
    expect(counterOrderNumber('#20260926-1043')).toEqual({ full: '20260926-1043' });
  });

  it('anything else is no number at all — never a part or a pattern', () => {
    for (const typed of ['', '   ', '#', '0', '104%', '10_3', '1043-', '2026-1043', 'Ayesha', '0300 1234567', '1234567']) {
      expect({ typed, n: counterOrderNumber(typed) }).toEqual({ typed, n: null });
    }
  });
});
