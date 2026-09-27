import { formatCents } from '@cheeseoclock/pos-domain';
import { discountLeavesDeliveryCharge, type OrderDiscount } from '@cheeseoclock/shared-types';

/**
 * An order discount's words on the screens that show a bill: the cart, Pay,
 * the order drawer and the receipt after Pay. Each says "food only" when the
 * discount's OWN frozen rule left the order's delivery charge alone
 * (shared-types discountLeavesDeliveryCharge: the snapshot's
 * alsoOffDeliveryCharge, never the live setting), so "10% off" next to a
 * figure that is 10% of the food never reads as a mistake. A discount with no
 * rule (given before 0.7.26), one that came off the charge too, or an order
 * with no delivery charge reads exactly as before. The printed bill's words
 * are shared-types discountBillLabel.
 */

type Discount = Pick<OrderDiscount, 'discountType' | 'value' | 'reason'> &
  Partial<Pick<OrderDiscount, 'source' | 'alsoOffDeliveryCharge'>>;
type Line = { readonly menuItemName?: string | null };

/** "10%" or "Rs 200". */
function amountWords(d: Pick<Discount, 'discountType' | 'value'>): string {
  return d.discountType === 'percent' ? `${d.value}%` : formatCents(d.value);
}

/** The cart's words after "Discount": " · 10%", " · 10% off food · Staff". */
export function cartDiscountDetail(d: Discount, items: ReadonlyArray<Line>): string {
  const food = discountLeavesDeliveryCharge(d, items) ? ' off food' : '';
  return ` · ${amountWords(d)}${food}${d.reason ? ` · ${d.reason}` : ''}`;
}

/**
 * Pay's discount row: "Discount" or the foodpanda deal's label, and
 * " (food only)" when something came off and the delivery charge was left
 * alone (a deal under its minimum takes nothing off: no "food only" on −0.00).
 */
export function payDiscountLabel(
  dealLabel: string | null | undefined,
  d: Discount | null | undefined,
  items: ReadonlyArray<Line>,
  discountCents: number,
): string {
  const label = dealLabel ?? 'Discount';
  return discountCents > 0 && discountLeavesDeliveryCharge(d, items) ? `${label} (food only)` : label;
}

/** The order drawer's row: "Discount", "Discount (Staff)"; "Discount (Staff, food only)", "Discount (food only)". */
export function drawerDiscountLabel(reason: string | null | undefined, foodOnly: boolean): string {
  if (foodOnly) return `Discount (${reason ? `${reason}, ` : ''}food only)`;
  return reason ? `Discount (${reason})` : 'Discount';
}

/** The receipt on screen after Pay: "Discount (10%)", "Discount (Staff)"; "Discount (10%, food only)", "Discount (Staff, food only)". */
export function receiptDiscountLabel(d: Discount, items: ReadonlyArray<Line>): string {
  const what = d.reason ?? amountWords(d);
  return discountLeavesDeliveryCharge(d, items) ? `Discount (${what}, food only)` : `Discount (${what})`;
}
