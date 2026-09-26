/**
 * "Order waiting too long": a soft reminder, once per order, when
 *   - an order is still in New (not started) 10 minutes after it came in, or
 *   - an order is still not done (New, Preparing or Ready) after 30 minutes.
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
 */
import { ageMinutes } from '../orders/boardLogic';
import { shortOrderNumber, type OrderSource, type OrderStatus } from '@cheeseoclock/shared-types';

export const NOT_STARTED_MIN = 10;
export const NOT_DONE_MIN = 30;
/** A reminder is only given this many minutes after its threshold. */
export const REMIND_WINDOW_MIN = 10;
/** This many orders in New for BOARD_UNUSED_MIN+ minutes: nobody is using the board. */
export const BOARD_UNUSED_COUNT = 5;
export const BOARD_UNUSED_MIN = 20;
/** At most one reminder beep this often, however many orders are late. */
export const REMIND_TONE_GAP_MS = 5 * 60_000;

export interface WaitingOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
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
  },
): { due: WaitingReminder[]; boardUnused: boolean } {
  const eligible = orders.filter((o) => opts.includeCounter || o.source === 'web');
  const oldNew = eligible.filter(
    (o) => o.status === 'sent_to_kitchen' && ageMinutes(o.createdAt, now) >= BOARD_UNUSED_MIN,
  ).length;
  if (oldNew >= BOARD_UNUSED_COUNT) return { due: [], boardUnused: true };

  const due: WaitingReminder[] = [];
  for (const o of eligible) {
    if (opts.ringing.has(o.id)) continue;
    const minutes = ageMinutes(o.createdAt, now);
    if (
      o.status === 'sent_to_kitchen' &&
      minutes >= NOT_STARTED_MIN &&
      minutes < NOT_STARTED_MIN + REMIND_WINDOW_MIN &&
      !opts.reminded.has(`${o.id}:${NOT_STARTED_MIN}`)
    ) {
      due.push({ key: `${o.id}:${NOT_STARTED_MIN}`, orderId: o.id, orderNumber: o.orderNumber, kind: 'notStarted', minutes });
    }
    if (
      NOT_DONE_STATUSES.has(o.status) &&
      minutes >= NOT_DONE_MIN &&
      minutes < NOT_DONE_MIN + REMIND_WINDOW_MIN &&
      !opts.reminded.has(`${o.id}:${NOT_DONE_MIN}`)
    ) {
      due.push({ key: `${o.id}:${NOT_DONE_MIN}`, orderId: o.id, orderNumber: o.orderNumber, kind: 'notDone', minutes });
    }
  }
  return { due, boardUnused: false };
}

/** One note for everything due this round. */
export function describeReminders(due: readonly WaitingReminder[]): { title: string; description: string } {
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
  if (notDone.length > 0) parts.push(`over ${NOT_DONE_MIN} min: ${nums(notDone)}`);
  return {
    title: `${due.length} orders are waiting too long`,
    description: `${parts.join(' · ')}. Check them on Live Orders.`,
  };
}
