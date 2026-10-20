import { shopZoneDateFormat } from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderMode, PaymentMethod, PaymentMethodChanged, Role } from '@cheeseoclock/shared-types';
import { PAYMENT_LABELS } from './historyFilters';

/**
 * An order → Money → Change (v0.7.42; the owner, 8 Oct 2026: "admin be able
 * to change payment method after the order have done so this issues can be
 * resolve after at closing"). Since 0.7.45 (the owner, 12 Oct 2026: "first
 * the cashier thought it will paid cash then customer decided to pay on
 * card") the counter too while the shift that took the money is open — a
 * cashier with a manager's PIN — and a bill that depends on how it is paid is
 * worked out again for the new way. Never a foodpanda payment. Pure, so the
 * words are tested.
 */

export const CHANGE_METHOD_TITLE = 'How was it paid?';
export const CHANGE_REFUND_TITLE = 'How was the refund given?';

export const CHANGE_METHOD_NOTE =
  'The drawer’s expected cash follows, also for a shift that is already closed. When the tax depends on how it is paid, ' +
  'the bill is worked out again at the new way’s rate. It is saved with your name.';

/** What the PIN box says when a cashier changes it (the manager's name is saved with it). */
export const CHANGE_METHOD_PIN_WHY = "Changing how an order was paid needs a manager's PIN or password.";
export const CHANGE_METHOD_PIN_NOTE = "It is saved with the manager's name. No paper prints; the drawer opens for any cash.";

/**
 * The Change button on a payment: the owner (admin login) at any time; a
 * manager or a cashier while the shift that took the money is still open on
 * this till (`shiftOpen`; a cashier is asked for a manager's PIN). Never on
 * foodpanda's.
 */
export function mayChangeMethod(role: Role | null, orderMode: OrderMode, method: PaymentMethod, shiftOpen = false): boolean {
  if (role === null || orderMode === 'foodpanda' || method === 'foodpanda') return false;
  return role === 'admin' || shiftOpen;
}

/** The drawer at a close, in the till's words: matches (under Re 1 either way), short or over. */
export function drawerWord(varianceCents: number): string {
  if (Math.abs(varianceCents) < 100) return 'matches';
  return varianceCents < 0 ? `short ${formatCents(-varianceCents)}` : `over ${formatCents(varianceCents)}`;
}

// The shop's own day, built when asked (Karachi on a Pakistani till).
const DAY = { format: (d: Date): string => shopZoneDateFormat({ weekday: 'short', day: 'numeric', month: 'short' }, 'en-GB').format(d) };

/** "Thu 8 Oct", in Karachi. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'that day' : DAY.format(d);
}

/** "in cash", "on the card", "by JazzCash": a way of paying after an amount. */
function byWay(method: PaymentMethod): string {
  if (method === 'cash') return 'in cash';
  if (method === 'card') return 'on the card';
  if (method === 'bank_transfer') return 'by bank transfer';
  return `by ${PAYMENT_LABELS[method]}`;
}

/**
 * What the cashier does when the customer pays the other way now, under the
 * pick: hand back what was paid, take the new amount. One way to another at
 * the same amount reads the same (a payment typed in wrong needs neither).
 */
export function changeHandOver(from: PaymentMethod, fromCents: number, to: PaymentMethod, toCents: number): string {
  const back =
    from === 'cash'
      ? `hand back ${formatCents(fromCents)} cash`
      : from === 'card'
        ? `reverse the ${formatCents(fromCents)} card payment on the machine`
        : `send back the ${formatCents(fromCents)} ${PAYMENT_LABELS[from]} payment`;
  const take = `take ${formatCents(toCents)} ${byWay(to)}`;
  const tail = toCents !== fromCents ? ` The bill is now ${formatCents(toCents)}: the tax ${byWay(to)} is different.` : '';
  return `If the customer pays again: ${back}, then ${take}. If it was only pressed wrong, nothing to hand back.${tail}`;
}

/** What the toast says once it is saved: the change, the bill worked out again, and a closed shift put right with it. */
export function methodChangedToast(
  orderLabel: string,
  from: PaymentMethod,
  to: PaymentMethod,
  closedShift: PaymentMethodChanged['closedShift'],
  rebilled: PaymentMethodChanged['rebilled'] = null,
): { title: string; description?: string } {
  const title = `${orderLabel}: ${PAYMENT_LABELS[from]} → ${PAYMENT_LABELS[to]}`;
  const parts: string[] = [];
  if (rebilled) parts.push(`The bill is now ${formatCents(rebilled.totalAfterCents)} (it was ${formatCents(rebilled.totalBeforeCents)}).`);
  if (closedShift) {
    parts.push(
      `The shift opened ${dayOf(closedShift.openedAt)} was already closed: its drawer now ${drawerWord(closedShift.varianceCents)} (it was ${drawerWord(closedShift.previousVarianceCents)}).`,
    );
  }
  return parts.length > 0 ? { title, description: parts.join(' ') } : { title };
}
