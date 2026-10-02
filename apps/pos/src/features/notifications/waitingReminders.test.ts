import { describe, expect, it } from 'vitest';
import { DEFAULT_KITCHEN_TIMING, type OrderSource, type OrderStatus, type WatchOrder } from '@cheeseoclock/shared-types';
import {
  BOARD_UNUSED_COUNT,
  NOT_DONE_MIN,
  NOT_STARTED_MIN,
  PIN_REMIND_EVERY_MS,
  REMIND_WINDOW_MIN,
  describeReminders,
  describeSignedOutReminders,
  dueWaitingReminders,
  signedOutDue,
  waitingRuleText,
  type WaitingOrder,
} from './waitingReminders';

const NOW = Date.parse('2026-09-26T14:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000 - 1_000).toISOString();

function o(id: string, status: OrderStatus, ageMin: number, source: OrderSource = 'web'): WaitingOrder {
  return { id, orderNumber: `CO-20260926-${id.padStart(4, '0')}`, status, since: minsAgo(ageMin), source };
}

const none = new Set<string>();
const due = (orders: WaitingOrder[], opts: Partial<{ includeCounter: boolean; reminded: Set<string>; ringing: Set<string> }> = {}) =>
  dueWaitingReminders(orders, NOW, { includeCounter: false, reminded: none, ringing: none, ...opts });

describe('not started after 10 minutes', () => {
  it('reminds once for a website order still in New', () => {
    const r = due([o('1', 'sent_to_kitchen', NOT_STARTED_MIN)]);
    expect(r.due).toEqual([
      expect.objectContaining({ key: '1:10', orderId: '1', kind: 'notStarted', minutes: NOT_STARTED_MIN }),
    ]);
  });

  it('not before 10 minutes', () => {
    expect(due([o('1', 'sent_to_kitchen', NOT_STARTED_MIN - 1)]).due).toEqual([]);
  });

  it('only for orders in New', () => {
    expect(due([o('1', 'preparing', 12), o('2', 'ready', 12), o('3', 'out_for_delivery', 12)]).due).toEqual([]);
  });

  it('never again once given', () => {
    expect(due([o('1', 'sent_to_kitchen', 12)], { reminded: new Set(['1:10']) }).due).toEqual([]);
  });

  it('not while the order is still ringing as a new online order', () => {
    expect(due([o('1', 'sent_to_kitchen', 12)], { ringing: new Set(['1']) }).due).toEqual([]);
  });
});

describe('not done after 30 minutes', () => {
  it('covers New, Preparing and Ready', () => {
    const r = due([o('1', 'sent_to_kitchen', 31), o('2', 'preparing', 31), o('3', 'ready', 35)]);
    expect(r.due.map((d) => d.key)).toEqual(['1:30', '2:30', '3:30']);
    expect(r.due.every((d) => d.kind === 'notDone')).toBe(true);
  });

  it('leaves orders out for delivery alone (the rider has it)', () => {
    expect(due([o('1', 'out_for_delivery', 31)]).due).toEqual([]);
  });
});

describe('never for old, forgotten orders', () => {
  it('only in the 10 minutes after each threshold', () => {
    expect(due([o('1', 'sent_to_kitchen', NOT_STARTED_MIN + REMIND_WINDOW_MIN)]).due).toEqual([]);
    expect(due([o('1', 'preparing', NOT_DONE_MIN + REMIND_WINDOW_MIN)]).due).toEqual([]);
    expect(due([o('1', 'preparing', 60 * 20)]).due).toEqual([]);
  });

  it('a bad date is never late', () => {
    expect(due([{ ...o('1', 'sent_to_kitchen', 12), since: 'not a date' }]).due).toEqual([]);
  });
});

describe('counter orders', () => {
  it('are left out unless the setting says so', () => {
    const counter = [o('1', 'sent_to_kitchen', 12, 'pos')];
    expect(due(counter).due).toEqual([]);
    expect(due(counter, { includeCounter: true }).due.map((d) => d.key)).toEqual(['1:10']);
  });
});

describe('a board nobody moves along', () => {
  it('stays quiet when New is full of old orders', () => {
    const stuck = Array.from({ length: BOARD_UNUSED_COUNT }, (_, i) => o(String(i), 'sent_to_kitchen', 25 + i));
    const r = due([...stuck, o('99', 'sent_to_kitchen', 11)]);
    expect(r.boardUnused).toBe(true);
    expect(r.due).toEqual([]);
  });

  it('a few late orders are still reminded', () => {
    const r = due([o('1', 'sent_to_kitchen', 25), o('2', 'sent_to_kitchen', 11)]);
    expect(r.boardUnused).toBe(false);
    expect(r.due.map((d) => d.key)).toEqual(['2:10']);
  });

  it('counts only the orders reminders are for', () => {
    const counterStuck = Array.from({ length: BOARD_UNUSED_COUNT }, (_, i) => o(String(i), 'sent_to_kitchen', 25, 'pos'));
    expect(due([...counterStuck, o('99', 'sent_to_kitchen', 11)]).boardUnused).toBe(false);
  });
});

describe('describeReminders', () => {
  it('one order', () => {
    const [d] = due([o('42', 'sent_to_kitchen', 11)]).due;
    expect(describeReminders([d!]).title).toBe('Order #0042 not started — 11 min');
    const [late] = due([o('43', 'preparing', 31)]).due;
    expect(describeReminders([late!]).title).toBe('Order #0043 waiting 31 min');
  });

  it('several in one note', () => {
    const r = due([o('40', 'sent_to_kitchen', 11), o('41', 'preparing', 32), o('42', 'ready', 33)]).due;
    const text = describeReminders(r);
    expect(text.title).toBe('3 orders are waiting too long');
    expect(text.description).toBe('not started: #0040 · over 30 min: #0041, #0042. Check them on Live Orders.');
  });
});

// ---------------------------------------------------------------------------
// The PIN screen (nobody signed in): from the watch's minutes, for as long as
// an order is late.

function w(id: string, status: WatchOrder['status'], minutes: number, source: OrderSource = 'web'): WatchOrder {
  return { orderId: id, orderNumber: `CO-20260926-${id.padStart(4, '0')}`, status, source, minutes };
}
const TIMING = { notStartedMin: NOT_STARTED_MIN, notDoneMin: NOT_DONE_MIN };
const signedOut = (orders: WatchOrder[], opts: Partial<{ includeCounter: boolean; ringing: Set<string> }> = {}) =>
  signedOutDue(orders, { includeCounter: false, ringing: none, timing: TIMING, ...opts });

describe('signedOutDue (the PIN screen)', () => {
  it('due at notStartedMin in New and at notDoneMin once started, with no 10-minute cut-off', () => {
    expect(signedOut([w('1', 'sent_to_kitchen', NOT_STARTED_MIN - 1)]).due).toEqual([]);
    expect(signedOut([w('1', 'sent_to_kitchen', NOT_STARTED_MIN)]).due).toEqual([
      { key: '1:10', orderId: '1', orderNumber: 'CO-20260926-0001', kind: 'notStarted', minutes: NOT_STARTED_MIN },
    ]);
    expect(signedOut([w('2', 'preparing', NOT_DONE_MIN - 1)]).due).toEqual([]);
    expect(signedOut([w('2', 'preparing', NOT_DONE_MIN)]).due.map((d) => [d.key, d.kind])).toEqual([['2:30', 'notDone']]);
    // Long past the signed-in reminder's window, still due.
    expect(signedOut([w('1', 'sent_to_kitchen', NOT_STARTED_MIN + REMIND_WINDOW_MIN + 60)]).due).toHaveLength(1);
    expect(signedOut([w('3', 'ready', 170)]).due.map((d) => d.key)).toEqual(['3:30']);
  });

  it('one reminder per order: still in New after half an hour is "not started", under the same key', () => {
    const r = signedOut([w('1', 'sent_to_kitchen', 45)]).due;
    expect(r.map((d) => [d.key, d.kind, d.minutes])).toEqual([['1:10', 'notStarted', 45]]);
  });

  it('leaves out orders still ringing as a new online order, and counter orders unless the setting says so', () => {
    expect(signedOut([w('1', 'sent_to_kitchen', 12)], { ringing: new Set(['1']) }).due).toEqual([]);
    expect(signedOut([w('1', 'sent_to_kitchen', 12, 'pos')]).due).toEqual([]);
    expect(signedOut([w('1', 'sent_to_kitchen', 12, 'pos')], { includeCounter: true }).due).toHaveLength(1);
  });

  it('a board nobody moves along stays quiet here too', () => {
    const stuck = Array.from({ length: BOARD_UNUSED_COUNT }, (_, i) => w(String(i), 'sent_to_kitchen', 25 + i));
    expect(signedOut([...stuck, w('99', 'preparing', 40)])).toEqual({ due: [], boardUnused: true });
    expect(signedOut(stuck.slice(1)).boardUnused).toBe(false);
  });

  it('the owner’s minutes', () => {
    const timing = { notStartedMin: 6, notDoneMin: 25 };
    expect(signedOutDue([w('1', 'sent_to_kitchen', 6), w('2', 'ready', 25)], { includeCounter: false, ringing: none, timing }).due.map((d) => d.key)).toEqual([
      '1:6',
      '2:25',
    ]);
  });
});

describe('describeSignedOutReminders: sends someone to sign in', () => {
  it('one order', () => {
    expect(describeSignedOutReminders(signedOut([w('42', 'sent_to_kitchen', 12)]).due)).toEqual({
      title: 'Order #0042 not started — 12 min',
      detail: 'Sign in and open Live Orders.',
    });
  });

  it('several', () => {
    const r = signedOut([w('40', 'preparing', 31), w('42', 'sent_to_kitchen', 12), w('43', 'sent_to_kitchen', 11)]).due;
    expect(describeSignedOutReminders(r, TIMING)).toEqual({
      title: '3 orders are waiting too long',
      detail: 'Not started: #0042, #0043 · over 30 min: #0040 — sign in and open Live Orders.',
    });
    const late = signedOut([w('40', 'preparing', 31), w('41', 'ready', 40)]).due;
    expect(describeSignedOutReminders(late, TIMING).detail).toBe('Over 30 min: #0040, #0041 — sign in and open Live Orders.');
  });
});

it('Settings → Sounds says the PIN screen keeps the note up and beeps every 5 minutes while a shift is open', () => {
  expect(PIN_REMIND_EVERY_MS).toBe(5 * 60_000);
  expect(waitingRuleText(DEFAULT_KITCHEN_TIMING)).toMatch(
    / With nobody signed in, the note stays on the PIN screen and, while a shift is open, beeps again every 5 minutes until someone signs in\.$/,
  );
});
