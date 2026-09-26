import type { WebOrderItem } from '@cheeseoclock/shared-types';
import { isLeaveOutChoice } from '@cheeseoclock/shared-types';
import type { SavedLine } from './cart';
import { isDeliveryChargeItem } from './delivery-zones';
import { formatCents } from './format';
import { optionLabel } from './menu-view';

/** Small display helpers shared by the ordering page and the tracking page. Pure. */

/** "Rs 200–250" across the delivery zones (or "Rs 200" when every zone costs the same). */
export function feeRangeText(zones: ReadonlyArray<{ feeCents: number }>): string {
  if (zones.length === 0) return '';
  const fees = zones.map((z) => z.feeCents);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  return min === max ? formatCents(min) : `${formatCents(min)}–${formatCents(max).replace(/^Rs\s*/, '')}`;
}

/**
 * An option's name inside its item sheet group. Deal slots lose their
 * "Large:" prefix (optionLabel); inside "Dips on the side" every option reads
 * "Side of …", so the group title says it once. The cart and the ticket keep
 * the full "Side of Ranch" — out of its group, "Ranch" is ambiguous.
 */
export function sheetOptionLabel(optionName: string): string {
  const label = optionLabel(optionName);
  const side = /^side of\s+(.+)$/i.exec(label.trim());
  return side ? side[1]!.trim() : label;
}

/**
 * A placed order's items, food apart from the delivery charge: the server adds
 * the zone's fee as a "Delivery Charge (Rs N)" till item, which the customer
 * reads as a delivery line in the totals, not as something they ordered.
 */
export function splitDeliveryCharge(items: readonly WebOrderItem[]): {
  food: WebOrderItem[];
  deliveryCents: number;
} {
  const food: WebOrderItem[] = [];
  let deliveryCents = 0;
  for (const i of items) {
    if (isDeliveryChargeItem(i)) deliveryCents += i.unitPriceCents * i.quantity;
    else food.push(i);
  }
  return { food, deliveryCents };
}

/**
 * The stored subtotal as the customer reads it: their food, and the delivery
 * fee. Worked out as subtotal minus the food lines, so it is right both when
 * the fee rode as the till's "Delivery Charge" item and when a till without
 * that item had it priced in with no line of its own (api/orders).
 */
export function orderMoney(order: {
  items: readonly WebOrderItem[];
  subtotalCents: number;
  fulfilment?: 'delivery' | 'pickup';
}): { food: WebOrderItem[]; itemsCents: number; deliveryCents: number } {
  const { food } = splitDeliveryCharge(order.items);
  const itemsCents = food.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  const rest = order.subtotalCents - itemsCents;
  if (order.fulfilment === 'pickup' || rest <= 0) {
    return { food, itemsCents: order.subtotalCents, deliveryCents: 0 };
  }
  return { food, itemsCents, deliveryCents: rest };
}

/** A placed item's choices, leave-outs apart — the same split the cart shows. */
export function orderItemChoices(item: Pick<WebOrderItem, 'modifiers'>): { leaveOuts: string[]; others: string[] } {
  const names = item.modifiers.map((m) => optionLabel(m.name));
  return {
    leaveOuts: names.filter(isLeaveOutChoice),
    others: names.filter((n) => !isLeaveOutChoice(n)),
  };
}

/** A placed order back into cart lines, for "order again" (the menu re-checks every one). */
export function savedLinesFromOrderItems(items: readonly WebOrderItem[]): SavedLine[] {
  return items
    .filter((i) => !isDeliveryChargeItem(i))
    .map((i) => ({
      posItemId: i.posItemId,
      quantity: i.quantity,
      modifierIds: i.modifiers.map((m) => m.posModifierId),
      notes: i.notes,
    }));
}

/** The tracking page for an order. The phone is what lets the page show it (api/orders/[id]). */
export function trackPath(orderId: string, phone?: string | null, placed = false): string {
  const q = new URLSearchParams();
  if (phone) q.set('phone', phone);
  if (placed) q.set('placed', '1');
  const qs = q.toString();
  return `/track/${encodeURIComponent(orderId)}${qs ? `?${qs}` : ''}`;
}

/** The till's "WEB-0042" / "2026-0042" order number as the short number the counter calls out. */
export function shortOrderNumber(posOrderNumber: string | null): string | null {
  if (!posOrderNumber) return null;
  return posOrderNumber.split('-').pop() || posOrderNumber;
}
