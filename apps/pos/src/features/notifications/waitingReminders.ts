/**
 * "Order waiting too long": a soft reminder, once per order, when
 *   - an order is still in New (not started) 10 minutes after it came in, or
 *   - an order is still not done (New, Preparing or Ready) after 30 minutes
 *   (the owner's minutes: Settings → Staff & kitchen timing, 'kitchen.timing'
 *   from checkout:getRules; 10 and 30 by default).
 * "Came in" is when the order was sent to the kitchen (WaitingOrder.since;
 * when it was started, for an order from before 0.7.34), like the board.
 * Out for delivery is left alone: the rider has it and the counter can't act.
 *
 * Website orders only, unless Settings → Sounds says "counter orders too":
 * nothing moves an order along by itself, so a shop that cooks from the
 * printed ticket and never taps "Start preparing" would be reminded about
 * every counter order. For the same reason, when the New column is full of
 * old orders the board is plainly not being used: stay quiet and say so once.
 *
 * Each reminder fires only in a 10-minute window after its threshold, so
 * yesterday's forgotten orders never beep. Uses the order list the sidebar
 * already refreshes — no extra polling. Pure; tested in waitingReminders.test.ts.
 *
 * With nobody signed in (the PIN screen), the same orders come from the watch
 * (alerts:getWatch, at most 3 hours old) instead: signedOutDue keeps a note
 * up for as long as an order is late, and the PIN screen beeps again every
 * PIN_REMIND_EVERY_MS until someone signs in, while a shift is open on this
 * till (watchNotes.ts).
 */
import { ageMinutes } from '../orders/boardLogic';
import {
  DEFAULT_KITCHEN_TIMING,
  orderNumberList,
  shortOrderNumber,
  type KitchenTiming,
  type OrderSource,
  type OrderStatus,
  type WatchOrder,
} from '@cheeseoclock/shared-types';

/** The released reminder minutes (the owner's are 'kitchen.timing' notStartedMin / notDoneMin). */
export const NOT_STARTED_MIN = DEFAULT_KITCHEN_TIMING.notStartedMin;
export const NOT_DONE_MIN = DEFAULT_KITCHEN_TIMING.notDoneMin;
/** A reminder is only given this many minutes after its threshold. */
export const REMIND_WINDOW_MIN = 10;
/** This many orders in New for boardUnusedMin+ minutes: nobody is using the board. */
export const BOARD_UNUSED_COUNT = 5;
/** At most one reminder beep this often, however many orders are late. */
export const REMIND_TONE_GAP_MS = 5 * 60_000;
/** With nobody signed in, the PIN screen beeps again this often while a note is up. */
export const PIN_REMIND_EVERY_MS = 5 * 60_000;

/** The reminders' minutes. */
export type ReminderTiming = Pick<KitchenTiming, 'notStartedMin' | 'notDoneMin'>;
const DEFAULT_REMINDER_TIMING: ReminderTiming = { notStartedMin: NOT_STARTED_MIN, notDoneMin: NOT_DONE_MIN };

/**
 * Orders in New this long mean nobody is moving them along: past the whole
 * "not started" reminder window (20 minutes by default).
 */
export function boardUnusedMin(timing: ReminderTiming = DEFAULT_REMINDER_TIMING): number {
  return timing.notStartedMin + REMIND_WINDOW_MIN;
}
/** The released one: 20 minutes. */
export const BOARD_UNUSED_MIN = boardUnusedMin();

export interface WaitingOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  /**
   * When the order was sent to the kitchen (orders.sent_at, migration 0048),
   * or when it was started for one sent before 0.7.34: boardLogic
   * orderClockFrom, the same moment the board and the PIN screen's watch count from.
   */
  since: string;
  source: OrderSource;
}

export interface WaitingReminder {
  /** `${orderId}:10` or `${orderId}:30` — remembered so it fires once. */
  key: string;
  orderId: string;
  orderNumber: string;
  kind: 'notStarted' | 'notDone';
  minutes: number;
}

const NOT_DONE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['sent_to_kitchen', 'preparing', 'ready']);

export function dueWaitingReminders(
  orders: readonly WaitingOrder[],
  now: number,
  opts: {
    includeCounter: boolean;
    reminded: ReadonlySet<string>;
    /** Orders already ringing as a new online order: the chime covers them. */
    ringing: ReadonlySet<string>;
    /** The owner's minutes (checkout:getRules); the released 10 / 30 when absent. */
    timing?: ReminderTiming;
  },
): { due: WaitingReminder[]; boardUnused: boolean } {
  const { notStartedMin, notDoneMin } = opts.timing ?? DEFAULT_REMINDER_TIMING;
  const eligible = orders.filter((o) => opts.includeCounter || o.source === 'web');
  const unusedAfter = boardUnusedMin({ notStartedMin, notDoneMin });
  const oldNew = eligible.filter(
    (o) => o.status === 'sent_to_kitchen' && ageMinutes(o.since, now) >= unusedAfter,
  ).length;
  if (oldNew >= BOARD_UNUSED_COUNT) return { due: [], boardUnused: true };

  const due: WaitingReminder[] = [];
  for (const o of eligible) {
    if (opts.ringing.has(o.id)) continue;
    const minutes = ageMinutes(o.since, now);
    if (
      o.status === 'sent_to_kitchen' &&
      minutes >= notStartedMin &&
      minutes < notStartedMin + REMIND_WINDOW_MIN &&
      !opts.reminded.has(`${o.id}:${notStartedMin}`)
    ) {
      due.push({ key: `${o.id}:${notStartedMin}`, orderId: o.id, orderNumber: o.orderNumber, kind: 'notStarted', minutes });
    }
    if (
      NOT_DONE_STATUSES.has(o.status) &&
      minutes >= notDoneMin &&
      minutes < notDoneMin + REMIND_WINDOW_MIN &&
      !opts.reminded.has(`${o.id}:${notDoneMin}`)
    ) {
      due.push({ key: `${o.id}:${notDoneMin}`, orderId: o.id, orderNumber: o.orderNumber, kind: 'notDone', minutes });
    }
  }
  return { due, boardUnused: false };
}

/**
 * The PIN screen's "waiting too long" (nobody signed in): the orders late
 * right now, from the watch's minutes. Unlike dueWaitingReminders there is
 * no 10-minute window and nothing is remembered: an order stays due for as
 * long as it is late (the watch leaves out orders over 3 hours old). The
 * same eligibility (website orders, counter ones too when the Sounds setting
 * says so) and the same "board not used" rule; orders still ringing as a new
 * online order are left to the chime.
 *
 * One reminder per order: one still in New after notStartedMin is "not
 * started" however long it has waited (its key stays the same as it passes
 * notDoneMin); one being made or ready after notDoneMin is "not done".
 */
export function signedOutDue(
  orders: readonly WatchOrder[],
  opts: { includeCounter: boolean; ringing: ReadonlySet<string>; timing: ReminderTiming },
): { due: WaitingReminder[]; boardUnused: boolean } {
  const { notStartedMin, notDoneMin } = opts.timing;
  const eligible = orders.filter((o) => opts.includeCounter || o.source === 'web');
  const unusedAfter = boardUnusedMin({ notStartedMin, notDoneMin });
  const oldNew = eligible.filter((o) => o.status === 'sent_to_kitchen' && o.minutes >= unusedAfter).length;
  if (oldNew >= BOARD_UNUSED_COUNT) return { due: [], boardUnused: true };

  const due: WaitingReminder[] = [];
  for (const o of eligible) {
    if (opts.ringing.has(o.orderId)) continue;
    const reminder = (kind: WaitingReminder['kind'], threshold: number): WaitingReminder => ({
      key: `${o.orderId}:${threshold}`,
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      kind,
      minutes: o.minutes,
    });
    if (o.status === 'sent_to_kitchen' && o.minutes >= notStartedMin) due.push(reminder('notStarted', notStartedMin));
    else if (NOT_DONE_STATUSES.has(o.status) && o.minutes >= notDoneMin) due.push(reminder('notDone', notDoneMin));
  }
  return { due, boardUnused: false };
}

/** One note for everything due this round. */
export function describeReminders(
  due: readonly WaitingReminder[],
  timing: ReminderTiming = DEFAULT_REMINDER_TIMING,
): { title: string; description: string } {
  const notStarted = due.filter((d) => d.kind === 'notStarted');
  const notDone = due.filter((d) => d.kind === 'notDone');
  const nums = (list: readonly WaitingReminder[]) => list.map((d) => shortOrderNumber(d.orderNumber)).join(', ');
  if (due.length === 1) {
    const d = due[0]!;
    return d.kind === 'notStarted'
      ? {
          title: `Order ${shortOrderNumber(d.orderNumber)} not started — ${d.minutes} min`,
          description: 'It is still in New on Live Orders. Tap "Start preparing" once it is being made.',
        }
      : {
          title: `Order ${shortOrderNumber(d.orderNumber)} waiting ${d.minutes} min`,
          description: 'It is not done yet. Check it on Live Orders.',
        };
  }
  const parts: string[] = [];
  if (notStarted.length > 0) parts.push(`not started: ${nums(notStarted)}`);
  if (notDone.length > 0) parts.push(`over ${timing.notDoneMin} min: ${nums(notDone)}`);
  return {
    title: `${due.length} orders are waiting too long`,
    description: `${parts.join(' · ')}. Check them on Live Orders.`,
  };
}

/**
 * The PIN screen's note (nobody signed in): describeReminders' title, and a
 * detail that sends someone to sign in — "Sign in and open Live Orders." for
 * one order; for several, "Not started: #0042, #0043 · over 30 min: #0040 —
 * sign in and open Live Orders."
 */
export function describeSignedOutReminders(
  due: readonly WaitingReminder[],
  timing: ReminderTiming = DEFAULT_REMINDER_TIMING,
): { title: string; detail: string } {
  const { title } = describeReminders(due, timing);
  if (due.length <= 1) return { title, detail: 'Sign in and open Live Orders.' };
  const nums = (kind: WaitingReminder['kind']) =>
    orderNumberList(due.filter((d) => d.kind === kind).map((d) => d.orderNumber));
  const parts: string[] = [];
  if (due.some((d) => d.kind === 'notStarted')) parts.push(`not started: ${nums('notStarted')}`);
  if (due.some((d) => d.kind === 'notDone')) parts.push(`over ${timing.notDoneMin} min: ${nums('notDone')}`);
  const list = parts.join(' · ');
  return { title, detail: `${list.charAt(0).toUpperCase()}${list.slice(1)} — sign in and open Live Orders.` };
}

/**
 * Settings → Sounds, "Order waiting too long", in words built from the
 * owner's minutes: "A soft beep and a note when a website order is still not
 * started 10 minutes after it came in, or not done after 30. Once per order,
 * at most one beep every 5 minutes. With nobody signed in, the note stays on
 * the PIN screen and, while a shift is open, beeps again every 5 minutes
 * until someone signs in." (No shift open: the shop is closed, the note
 * stays and makes no sound — watchNotes.ts planWatchTone.)
 */
export function waitingRuleText(timing: ReminderTiming): string {
  return `A soft beep and a note when a website order is still not started ${timing.notStartedMin} minutes after it came in, or not done after ${timing.notDoneMin}. Once per order, at most one beep every ${REMIND_TONE_GAP_MS / 60_000} minutes. With nobody signed in, the note stays on the PIN screen and, while a shift is open, beeps again every ${PIN_REMIND_EVERY_MS / 60_000} minutes until someone signs in.`;
}

/** The note when nobody moves orders along on Live Orders. */
export function boardUnusedText(timing: ReminderTiming): string {
  return `${BOARD_UNUSED_COUNT} or more have sat in New for over ${boardUnusedMin(timing)} minutes, so the "waiting too long" reminder stays quiet. Tap each order's next step as you go.`;
}
