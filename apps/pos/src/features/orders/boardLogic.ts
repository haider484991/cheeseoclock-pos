/**
 * Pure rules behind the Live Orders board: how late a card is, which one-tap
 * action it offers, which leave-out / allergy flags it must show, and the
 * quick search. Tested in boardLogic.test.ts.
 */
import type { KitchenTiming, OrderMode, OrderSnapshot, OrderStatus } from '@cheeseoclock/shared-types';
import { DEFAULT_KITCHEN_TIMING, isLeaveOutChoice } from '@cheeseoclock/shared-types';
import { KITCHEN_TICKET_STATUSES } from '@cheeseoclock/pos-domain';

/**
 * Minutes after which a card turns amber, then red, by default (15, 30). The
 * owner's are Settings → Staff & kitchen timing ('kitchen.timing', from
 * checkout:getRules).
 */
export const WARN_AFTER_MIN = DEFAULT_KITCHEN_TIMING.amberMin;
export const LATE_AFTER_MIN = DEFAULT_KITCHEN_TIMING.redMin;

/** The board's colour minutes. */
export type BoardTiming = Pick<KitchenTiming, 'amberMin' | 'redMin'>;
const DEFAULT_BOARD_TIMING: BoardTiming = { amberMin: WARN_AFTER_MIN, redMin: LATE_AFTER_MIN };

export function ageMinutes(fromIso: string, now: number): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

export type AgeTone = 'ok' | 'warn' | 'late';

export function ageTone(minutes: number, timing: BoardTiming = DEFAULT_BOARD_TIMING): AgeTone {
  if (minutes >= timing.redMin) return 'late';
  if (minutes >= timing.amberMin) return 'warn';
  return 'ok';
}

/** "3 waiting over 30 min" — the board's header, with the owner's red minutes. */
export function lateCountText(count: number, timing: BoardTiming): string {
  return `${count} waiting over ${timing.redMin} min`;
}

/** The board's colours in words (its help line): "A card turns amber after 15 minutes and red after 30." */
export function boardColoursText(timing: BoardTiming): string {
  return `A card turns amber after ${timing.amberMin} minutes and red after ${timing.redMin}.`;
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
 * Whether a card offers "Reprint kitchen ticket": only while the kitchen still
 * has the order (new, preparing, ready). Once it is out for delivery (or
 * later) the till refuses that ticket for everyone (reprint-policy.ts
 * KITCHEN_REPRINT_STATUSES), so the button would only ever say no.
 */
export function offersKitchenReprint(status: OrderStatus): boolean {
  return KITCHEN_TICKET_STATUSES.includes(status);
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

/**
 * What goes under one card line (owner 2026-09-27: the card said only
 * "Family Feast"): its deal parts, each with its picks ("Fajita Pizza —
 * Large + Extra cheese", "1.5 litre drink + 7up"), then the line's own
 * extras, flavours and dips. Leave-outs are left out here: cardFlags shows
 * them, in red, on every card.
 */
export function cardLineDetails(
  line: Pick<OrderSnapshot['items'][number], 'id' | 'modifiers'>,
  items: Array<Pick<OrderSnapshot['items'][number], 'id' | 'parentOrderItemId' | 'quantity' | 'menuItemName' | 'modifiers'>>,
): string[] {
  const picks = (mods: Array<{ modifierName: string }>) =>
    mods.filter((m) => !isLeaveOutChoice(m.modifierName)).map((m) => m.modifierName);
  const parts = items
    .filter((i) => i.parentOrderItemId === line.id)
    .map((i) => [`${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.menuItemName}`, ...picks(i.modifiers)].join(' + '));
  return [...parts, ...picks(line.modifiers).map((name) => `+ ${name}`)];
}

/** Items on a card, deal parts not counted twice. */
export function cardItemCount(items: Array<{ parentOrderItemId: unknown; quantity: number }>): number {
  return cardLines(items).reduce((s, i) => s + i.quantity, 0);
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
