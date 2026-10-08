import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderMode, PaymentMethod, PaymentMethodChanged, Role } from '@cheeseoclock/shared-types';
import { PAYMENT_LABELS } from './historyFilters';

/**
 * Order History → an order → Money → Change (v0.7.42; the owner, 8 Oct 2026:
 * "admin be able to change payment method after the order have done so this
 * issues can be resolve after at closing"). The owner's alone; never a
 * foodpanda payment. Pure, so the words are tested.
 */

export const CHANGE_METHOD_TITLE = 'How was it paid?';
export const CHANGE_REFUND_TITLE = 'How was the refund given?';

export const CHANGE_METHOD_NOTE =
  'Only how it was paid changes: the amount and the bill stay as they are. ' +
  'The drawer’s expected cash follows, also for a shift that is already closed. It is saved with your name.';

/** The Change button on a payment: the owner (admin login), never on foodpanda's. */
export function mayChangeMethod(role: Role | null, orderMode: OrderMode, method: PaymentMethod): boolean {
  return role === 'admin' && orderMode !== 'foodpanda' && method !== 'foodpanda';
}

/** The drawer at a close, in the till's words: matches (under Re 1 either way), short or over. */
export function drawerWord(varianceCents: number): string {
  if (Math.abs(varianceCents) < 100) return 'matches';
  return varianceCents < 0 ? `short ${formatCents(-varianceCents)}` : `over ${formatCents(varianceCents)}`;
}

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short' });

/** "Thu 8 Oct", in Karachi. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'that day' : DAY.format(d);
}

/** What the toast says once it is saved: the change, and a closed shift put right with it. */
export function methodChangedToast(
  orderLabel: string,
  from: PaymentMethod,
  to: PaymentMethod,
  closedShift: PaymentMethodChanged['closedShift'],
): { title: string; description?: string } {
  const title = `${orderLabel}: ${PAYMENT_LABELS[from]} → ${PAYMENT_LABELS[to]}`;
  if (!closedShift) return { title };
  return {
    title,
    description: `The shift opened ${dayOf(closedShift.openedAt)} was already closed: its drawer now ${drawerWord(closedShift.varianceCents)} (it was ${drawerWord(closedShift.previousVarianceCents)}).`,
  };
}
