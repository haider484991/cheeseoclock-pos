/**
 * What a counter login (a cashier: no `order.history`) may open or reprint.
 *
 * The research behind it (owner, 2026-09-26): every POS we looked at gives the
 * cashier what serves the customer in front of them now, and keeps anything
 * that looks back in time for managers. Toast's quick order mode shows a
 * cashier only their own previous checks; Loyverse without "View all
 * receipts" shows only the last few receipts. So a counter login reaches:
 *   - the draft being rung up,
 *   - anything on the Live Orders board,
 *   - orders of a shift that is still open (or taken with no shift open),
 *     and never more than COUNTER_ORDER_WINDOW_MS back — a shift nobody
 *     closed must not open up days of history (counterOrderScope).
 * Reprinting is narrower: a kitchen ticket only while the kitchen still has
 * the order (a ticket for finished food is how food gets cooked that is never
 * rung up), and never a bill for a draft.
 *
 * Pure: the clock and "is that shift still open?" are passed in. The main
 * process applies it (apps/pos/electron/ipc/order-access.ts).
 */
import type { OrderStatus } from '@cheeseoclock/shared-types';
import { normalizePhone } from './phone.js';

/**
 * The Live Orders board. A copy of ACTIVE_STATUSES in
 * apps/pos/electron/db/repositories/order-repo.ts (not exported there); the
 * handler test checks every board order passes, so a drift fails a test.
 */
export const BOARD_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'];

/** The kitchen still has it: its ticket may be printed again. */
export const KITCHEN_TICKET_STATUSES: readonly OrderStatus[] = ['sent_to_kitchen', 'preparing', 'ready'];

/** How far back a counter login reaches, even while a shift stays open. */
export const COUNTER_ORDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many of this shift's orders the counter's Recent Orders list shows. */
export const RECENT_AT_COUNTER_LIMIT = 20;

/** 'open' = look at the order; 'receipt' / 'kitchen' = print that paper again. */
export type CounterPurpose = 'open' | 'receipt' | 'kitchen';

/**
 * 'ok', or why not:
 *   earlier_shift — past the board, from a shift that is closed now;
 *   too_old       — past the board and more than COUNTER_ORDER_WINDOW_MS old
 *                   by this till's clock (or its date can't be read);
 *   left_kitchen  — a kitchen ticket for food the kitchen is done with;
 *   not_sent      — paper for a draft that was never sent or paid.
 */
export type CounterVerdict = 'ok' | 'earlier_shift' | 'too_old' | 'left_kitchen' | 'not_sent';

export interface CounterOrderFacts {
  status: OrderStatus;
  /** '' when the order was taken with no shift open (shift_id NULL). */
  shiftId: string;
  createdAt: string;
}

/**
 * An order that left the board: is it one of the shift open now (or taken
 * with no shift), and not too old?
 *
 * A date AHEAD of the till's clock is fine. The till wrote that date itself,
 * so it only means the clock was moved back since (Windows correcting a clock
 * that ran fast, e.g. after a power cut); refusing it would lock the counter
 * out of its own shift's orders with nothing gained.
 *
 * A date more than COUNTER_ORDER_WINDOW_MS back is refused even in a shift
 * that is still open: a shift nobody closed must not open up days of history.
 * The price: when a clock that ran SLOW is corrected forward by more than a
 * day, the orders taken before the fix look old too (the dates alone can't
 * tell the two apart), and a manager opens those.
 */
export function counterOrderScope(
  order: CounterOrderFacts,
  shiftStillOpen: boolean,
  nowMs: number,
): 'ok' | 'earlier_shift' | 'too_old' {
  if (order.shiftId !== '' && !shiftStillOpen) return 'earlier_shift';
  const age = nowMs - Date.parse(order.createdAt);
  if (!Number.isFinite(age) || age > COUNTER_ORDER_WINDOW_MS) return 'too_old';
  return 'ok';
}

export function counterOrderAccess(
  order: CounterOrderFacts,
  purpose: CounterPurpose,
  shiftStillOpen: boolean,
  nowMs: number,
): CounterVerdict {
  if (purpose === 'kitchen') {
    if (order.status === 'open') return 'not_sent';
    return KITCHEN_TICKET_STATUSES.includes(order.status) ? 'ok' : 'left_kitchen';
  }
  if (order.status === 'open') return purpose === 'open' ? 'ok' : 'not_sent';
  if (BOARD_STATUSES.includes(order.status)) return 'ok';
  return counterOrderScope(order, shiftStillOpen, nowMs);
}

/**
 * An order number typed into the counter's Recent Orders, read as ONE whole
 * number: the full "20260926-1043" off the receipt, or the "#1043" people
 * say ("1043", "#1043", "43" = #0043). Null for anything else — a part of a
 * number never matches a range of orders. The day's count restarts at 1, so
 * "#1043" can be two orders only if one shift runs past midnight UTC; the
 * shift / till scope around it (counter-orders-repo.ts) keeps it to a couple.
 */
export type CounterOrderNumber = { full: string } | { suffix: string };

export function counterOrderNumber(typed: string): CounterOrderNumber | null {
  const t = typed.trim().replace(/^#\s*/, '');
  if (/^\d{8}-\d{4,}$/.test(t)) return { full: t };
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  if (n < 1) return null;
  return { suffix: String(n).padStart(4, '0') };
}

/**
 * The checkout phone box at the counter, where a saved customer is found only
 * by their whole number (a part of a number would let someone read the
 * customer list a few at a time):
 *   empty    — nothing typed;
 *   typing   — fewer digits than a whole number;
 *   complete — a whole number: look it up as `canonical`;
 *   unknown  — enough digits, but not a number the shop can match (a
 *              landline without its area code, a foreign mobile): the order
 *              still saves the customer as typed.
 */
export interface CounterPhoneLookup {
  stage: 'empty' | 'typing' | 'complete' | 'unknown';
  canonical: string | null;
}

export function counterPhoneLookup(typed: string): CounterPhoneLookup {
  const trimmed = typed.trim();
  if (!trimmed) return { stage: 'empty', canonical: null };
  const canonical = normalizePhone(trimmed);
  if (canonical) return { stage: 'complete', canonical };
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(4);
  else if (digits.startsWith('92') && digits.length > 10) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return { stage: digits.length < 10 ? 'typing' : 'unknown', canonical: null };
}
