import { describe, expect, it } from 'vitest';
import type { OrderSource, OrderStatus } from '@cheeseoclock/shared-types';
import { DEFAULT_KITCHEN_TIMING, DEFAULT_STAFF_TIMING } from '@cheeseoclock/shared-types';
import { LATE_AFTER_MIN, WARN_AFTER_MIN, ageTone, boardColoursText, lateCountText } from '../orders/boardLogic';
import {
  BOARD_UNUSED_COUNT,
  BOARD_UNUSED_MIN,
  NOT_DONE_MIN,
  NOT_STARTED_MIN,
  boardUnusedMin,
  boardUnusedText,
  describeReminders,
  dueWaitingReminders,
  waitingRuleText,
  type WaitingOrder,
} from './waitingReminders';
import { planWaitingReminders } from './eventTones';
import { DEFAULT_ALERT_SOUND_SETTINGS } from '@cheeseoclock/shared-types';
import { stepInHeldText } from '../shell/stepInClock';

/**
 * Settings → Staff & kitchen timing on the counter: the Live Orders colours,
 * the "waiting too long" reminders and the words on Sounds and the step-in
 * box, built from the owner's values (checkout:getRules / the login). With
 * nothing saved, today's numbers and today's words exactly. Made-up orders.
 */
const NOW = Date.parse('2026-09-28T14:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000 - 1_000).toISOString();
const o = (id: string, status: OrderStatus, ageMin: number, source: OrderSource = 'web'): WaitingOrder => ({
  id,
  orderNumber: `CO-20260928-${id.padStart(4, '0')}`,
  status,
  createdAt: minsAgo(ageMin),
  source,
});
const due = (orders: WaitingOrder[], timing?: { notStartedMin: number; notDoneMin: number }) =>
  dueWaitingReminders(orders, NOW, { includeCounter: false, reminded: new Set(), ringing: new Set(), ...(timing ? { timing } : {}) });

describe('nothing saved: today’s numbers', () => {
  it('amber 15, red 30; reminders at 10 and 30; the board is "unused" after 20', () => {
    expect([WARN_AFTER_MIN, LATE_AFTER_MIN]).toEqual([DEFAULT_KITCHEN_TIMING.amberMin, DEFAULT_KITCHEN_TIMING.redMin]);
    expect([WARN_AFTER_MIN, LATE_AFTER_MIN, NOT_STARTED_MIN, NOT_DONE_MIN, BOARD_UNUSED_MIN]).toEqual([15, 30, 10, 30, 20]);
    expect(boardUnusedMin()).toBe(20);
  });

  it('today’s words, word for word', () => {
    expect(waitingRuleText(DEFAULT_KITCHEN_TIMING)).toBe(
      'A soft beep and a note when a website order is still not started 10 minutes after it came in, or not done after 30. Once per order, at most one beep every 5 minutes. With nobody signed in, the note stays on the PIN screen and, while a shift is open, beeps again every 5 minutes until someone signs in.',
    );
    expect(boardUnusedText(DEFAULT_KITCHEN_TIMING)).toBe(
      `${BOARD_UNUSED_COUNT} or more have sat in New for over 20 minutes, so the "waiting too long" reminder stays quiet. Tap each order's next step as you go.`,
    );
    expect(lateCountText(3, DEFAULT_KITCHEN_TIMING)).toBe('3 waiting over 30 min');
    expect(stepInHeldText(undefined)).toBe(
      'A cashier was using this till, so your login stops after 10 minutes. Type your PIN or password to keep working. Nothing on the screen is lost.',
    );
    expect(DEFAULT_STAFF_TIMING.stepInMin).toBe(10);
  });
});

describe('the owner’s kitchen minutes', () => {
  const timing = { amberMin: 8, redMin: 20, notStartedMin: 6, notDoneMin: 25 };

  it('colour the cards', () => {
    expect([7, 8, 19, 20].map((m) => ageTone(m, timing))).toEqual(['ok', 'warn', 'warn', 'late']);
    // …where today's would still say ok / warn.
    expect([ageTone(8), ageTone(20)]).toEqual(['ok', 'warn']);
    expect(lateCountText(2, timing)).toBe('2 waiting over 20 min');
    expect(boardColoursText(timing)).toBe('A card turns amber after 8 minutes and red after 20.');
  });

  it('time the reminders, once per order, each in its own window', () => {
    expect(due([o('1', 'sent_to_kitchen', 5)], timing).due).toEqual([]);
    expect(due([o('1', 'sent_to_kitchen', 6)], timing).due).toEqual([
      expect.objectContaining({ key: '1:6', kind: 'notStarted', minutes: 6 }),
    ]);
    // Today's minutes would not have reminded yet.
    expect(due([o('1', 'sent_to_kitchen', 6)]).due).toEqual([]);
    expect(due([o('2', 'preparing', 25)], timing).due).toEqual([expect.objectContaining({ key: '2:25', kind: 'notDone' })]);
    expect(due([o('2', 'preparing', 24)], timing).due).toEqual([]);
    // Past its window: quiet (never yesterday's orders).
    expect(due([o('3', 'sent_to_kitchen', 16)], timing).due).toEqual([]);
    const reminded = dueWaitingReminders([o('1', 'sent_to_kitchen', 7)], NOW, {
      includeCounter: false,
      reminded: new Set(['1:6']),
      ringing: new Set(),
      timing,
    });
    expect(reminded.due).toEqual([]);
  });

  it('the "nobody moves the board" count waits for the owner’s whole reminder window', () => {
    expect(boardUnusedMin(timing)).toBe(16);
    const stuck = Array.from({ length: BOARD_UNUSED_COUNT }, (_, i) => o(String(i + 10), 'sent_to_kitchen', 16));
    expect(due(stuck, timing).boardUnused).toBe(true);
    expect(due(stuck.map((s) => ({ ...s, createdAt: minsAgo(15) })), timing).boardUnused).toBe(false);
  });

  it('the notes and the Sounds rule say the owner’s minutes', () => {
    const r = due([o('40', 'sent_to_kitchen', 7), o('41', 'preparing', 26)], timing).due;
    expect(describeReminders(r, timing).description).toBe('not started: #0040 · over 25 min: #0041. Check them on Live Orders.');
    expect(waitingRuleText(timing)).toBe(
      'A soft beep and a note when a website order is still not started 6 minutes after it came in, or not done after 25. Once per order, at most one beep every 5 minutes. With nobody signed in, the note stays on the PIN screen and, while a shift is open, beeps again every 5 minutes until someone signs in.',
    );
    expect(boardUnusedText(timing)).toContain('for over 16 minutes');
  });

  it('the reminder round (the beep’s planner) passes them through', () => {
    const plan = planWaitingReminders([o('1', 'sent_to_kitchen', 6)], {
      loggedIn: true,
      settings: DEFAULT_ALERT_SOUND_SETTINGS,
      now: NOW,
      lastToneAt: 0,
      reminded: new Set(),
      ringing: new Set(),
      timing,
    });
    expect(plan.due.map((d) => d.key)).toEqual(['1:6']);
    // Without them, today's minutes.
    const today = planWaitingReminders([o('1', 'sent_to_kitchen', 6)], {
      loggedIn: true,
      settings: DEFAULT_ALERT_SOUND_SETTINGS,
      now: NOW,
      lastToneAt: 0,
      reminded: new Set(),
      ringing: new Set(),
    });
    expect(today.due).toEqual([]);
  });
});

describe('the step-in box says the minutes this login was given', () => {
  it('built from the value', () => {
    expect(stepInHeldText(5)).toBe(
      'A cashier was using this till, so your login stops after 5 minutes. Type your PIN or password to keep working. Nothing on the screen is lost.',
    );
    expect(stepInHeldText(30)).toContain('stops after 30 minutes');
  });
});
