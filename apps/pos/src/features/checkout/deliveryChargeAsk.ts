import type { OrderMode } from '@cheeseoclock/shared-types';

/**
 * When the customer panel asks the main process to bring the delivery charge
 * to the picked area (orders:setDeliveryArea): only when the area, the order
 * type or the order CHANGES — an area picked or changed, or cleared after
 * one was there. A charge the cashier takes off by hand stays off until
 * then (or "Put it back").
 *
 * The memory of what was last asked lives HERE, outside the row: the row is
 * only on screen on the "Delivery details" step, and the cart's × is on
 * "Review order", so "Edit order" → × → Continue re-creates the row. A
 * memory inside the row (a ref) was lost with it, and the new row asked
 * again — putting back the charge the cashier had just taken off, swapping
 * a charge tapped on by hand, or taking one off a free area.
 */

export interface DeliveryChargeAskState {
  orderId: string | null;
  mode: OrderMode;
  /** The area as typed or picked (trimmed here). */
  area: string;
  /** With no order yet: whether a charge would go on (decides whether to start one). */
  wouldAdd: boolean;
}

interface Asked {
  key: string;
  orderId: string | null;
  area: string;
}

let asked: Asked | null = null;

function keyOf(s: DeliveryChargeAskState): string {
  const a = s.area.trim();
  return `${s.orderId ?? ''}|${s.mode}|${a}|${s.orderId ? '' : String(s.wouldAdd)}`;
}

/**
 * What to do for the panel as it is now:
 *  - 'same': already asked about exactly this (the row came back after Edit order): nothing;
 *  - 'note': nothing to ask (no area, and none was there before on this order): remember it;
 *  - 'ask': ask the main process (then call noteDeliveryChargeAsked).
 */
export function deliveryChargeAskFor(s: DeliveryChargeAskState): 'same' | 'note' | 'ask' {
  const key = keyOf(s);
  if (asked?.key === key) return 'same';
  const hadArea = asked !== null && asked.orderId === s.orderId && asked.area !== '';
  if (!s.area.trim() && !hadArea) return 'note';
  return 'ask';
}

/** Remember what was asked about (or that there was nothing to ask). */
export function noteDeliveryChargeAsked(s: DeliveryChargeAskState): void {
  asked = { key: keyOf(s), orderId: s.orderId, area: s.area.trim() };
}

/** Forget it (tests; a signed-out till starts clean). */
export function forgetDeliveryChargeAsked(): void {
  asked = null;
}
