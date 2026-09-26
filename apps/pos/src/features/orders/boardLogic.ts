/**
 * Pure rules behind the Live Orders board: how late a card is, which one-tap
 * action it offers, which leave-out / allergy flags it must show, and the
 * quick search. Tested in boardLogic.test.ts.
 */
import type { OrderMode, OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { isLeaveOutChoice } from '@cheeseoclock/shared-types';

/** Minutes after which a card turns amber, then red. */
export const WARN_AFTER_MIN = 15;
export const LATE_AFTER_MIN = 30;

export function ageMinutes(fromIso: string, now: number): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

export type AgeTone = 'ok' | 'warn' | 'late';

export function ageTone(minutes: number): AgeTone {
  if (minutes >= LATE_AFTER_MIN) return 'late';
  if (minutes >= WARN_AFTER_MIN) return 'warn';
  return 'ok';
}

/** "just now", "12m", "1h 05m". */
export function ageLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export type BoardAction =
  | { kind: 'preparing'; label: string }
  | { kind: 'ready'; label: string }
  | { kind: 'assign_rider'; label: string }
  /** Opens the hand-over dialog (takes the payment when one is due). */
  | { kind: 'hand_over'; label: string }
  /** Paid and not a delivery: closes the order with no dialog. */
  | { kind: 'served'; label: string }
  /** Paid delivery back from the rider: closes the order with no dialog. */
  | { kind: 'delivered'; label: string }
  | { kind: 'none'; label: string };

/** The one big button on a card: the next step for this order. */
export function nextBoardAction(status: OrderStatus, mode: OrderMode, paid: boolean): BoardAction {
  switch (status) {
    case 'open':
    case 'sent_to_kitchen':
      return { kind: 'preparing', label: 'Start preparing' };
    case 'preparing':
      return { kind: 'ready', label: 'Mark ready' };
    case 'ready':
      if (mode === 'delivery') return { kind: 'assign_rider', label: 'Assign rider' };
      // Unpaid must not close without its payment: the dialog takes it.
      if (!paid) return { kind: 'hand_over', label: 'Picked up + Pay' };
      return { kind: 'served', label: 'Picked up' };
    case 'out_for_delivery':
      return paid
        ? { kind: 'delivered', label: 'Delivered' }
        : { kind: 'hand_over', label: 'Delivered + Pay' };
    default:
      return { kind: 'none', label: '' };
  }
}

/**
 * Leave-outs ("NO ONION") and allergy / special-request notes on any line.
 * The card lists only a few lines, so these are gathered separately and
 * always shown — a hidden allergy is the one thing the board must not do.
 */
export function cardFlags(snap: Pick<OrderSnapshot, 'items'>): string[] {
  return snap.items.flatMap((i) => [
    ...i.modifiers
      .filter((m) => isLeaveOutChoice(m.modifierName))
      .map((m) => `${m.modifierName.toUpperCase()} (${i.menuItemName})`),
    ...(i.notes?.trim() ? [`${i.notes.trim()} (${i.menuItemName})`] : []),
  ]);
}

/** Lines to list on a card: top-level lines only (deal parts belong to their deal). */
export function cardLines<T extends { parentOrderItemId: unknown }>(items: T[]): T[] {
  return items.filter((i) => !i.parentOrderItemId);
}

/** Items on a card, deal parts not counted twice. */
export function cardItemCount(items: Array<{ parentOrderItemId: unknown; quantity: number }>): number {
  return cardLines(items).reduce((s, i) => s + i.quantity, 0);
}

/**
 * One-tap "cash given" amounts for a bill: the exact amount, then the next
 * round 100 / 500 / 1,000 / 5,000 above it (the notes people hand over).
 * At most four, smallest first, never less than the bill.
 */
export function quickCashOptions(totalCents: number): number[] {
  if (!(totalCents > 0)) return [];
  const out = new Set<number>([totalCents]);
  for (const step of [100_00, 500_00, 1_000_00, 5_000_00]) {
    out.add(Math.ceil(totalCents / step) * step);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

/** "2,000" / " 1850.5 " → cents; blank or junk → NaN. */
export function parseRupeesToCents(text: string): number {
  const cleaned = text.replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Quick find on the board: order number ("42", "#0042"), customer name,
 * phone digits, or rider name.
 */
export function matchesBoardSearch(
  snap: Pick<OrderSnapshot, 'order' | 'customerName' | 'customerPhone' | 'rider'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase().replace(/^#\s*/, '');
  if (!q) return true;
  const shortNo = snap.order.orderNumber.split('-').pop() ?? snap.order.orderNumber;
  if (/^\d+$/.test(q)) {
    if (q.length <= 4) return Number(shortNo) === Number(q);
    const digits = (snap.customerPhone ?? '').replace(/\D/g, '');
    const core = q.replace(/^0+/, '');
    return digits.includes(core);
  }
  return (
    (snap.customerName ?? '').toLowerCase().includes(q) ||
    (snap.rider?.name ?? '').toLowerCase().includes(q) ||
    snap.order.orderNumber.toLowerCase().includes(q)
  );
}
