import { formatCents } from '@cheeseoclock/pos-domain';
import {
  NOT_ON_VALUE_DEALS,
  discountLeavesDeliveryCharge,
  discountLeavesNoDiscountItems,
  discountLeftAloneTags,
  type OrderDiscount,
} from '@cheeseoclock/shared-types';

/**
 * An order discount's words on the screens that show a bill: the cart, Pay,
 * the order drawer and the receipt after Pay. Each says "food only" when the
 * discount's OWN frozen rule left the order's delivery charge alone
 * (shared-types discountLeavesDeliveryCharge: the snapshot's
 * alsoOffDeliveryCharge, never the live setting), so "10% off" next to a
 * figure that is 10% of the food never reads as a mistake — and "not on
 * value deals" when it left the order's value deals alone
 * (discountLeavesNoDiscountItems: the snapshot's skipsNoDiscountLines and a
 * line marked noDiscount). A discount with no rule (given before 0.7.26),
 * one that came off the charge and the deals too, or an order with neither
 * reads exactly as before. The printed bill's words are shared-types
 * discountBillLabel.
 */

type Discount = Pick<OrderDiscount, 'discountType' | 'value' | 'reason'> &
  Partial<Pick<OrderDiscount, 'source' | 'alsoOffDeliveryCharge' | 'skipsNoDiscountLines' | 'offer' | 'freeOrder'>>;
type Line = { readonly menuItemName?: string | null; readonly noDiscount?: boolean };

/** A Free order's name on every screen (v0.7.36: 100% off everything, with a manager's PIN), as the bill prints it. */
export const FREE_ORDER_LABEL = 'Free order';

/** "10%" or "Rs 200". */
function amountWords(d: Pick<Discount, 'discountType' | 'value'>): string {
  return d.discountType === 'percent' ? `${d.value}%` : formatCents(d.value);
}

/**
 * The cart's words after "Discount": " · 10%", " · 10% off food · Staff",
 * " · 10% off, not on value deals · Staff", " · 10% off food, not on value deals · Staff".
 * After "Free order": its reason alone (" · Staff meal").
 */
export function cartDiscountDetail(d: Discount, items: ReadonlyArray<Line>): string {
  if (d.freeOrder === true) return d.reason ? ` · ${d.reason}` : '';
  const food = discountLeavesDeliveryCharge(d, items) ? ' off food' : '';
  const off = discountLeavesNoDiscountItems(d, items) ? `${food || ' off'}, ${NOT_ON_VALUE_DEALS}` : food;
  return ` · ${amountWords(d)}${off}${d.reason ? ` · ${d.reason}` : ''}`;
}

/**
 * Pay's discount row: "Discount" or the foodpanda deal's label, and
 * " (food only)", " (not on value deals)" or " (food only, not on value
 * deals)" when something came off and the delivery charge or the value deals
 * were left alone (a deal under its minimum takes nothing off: no "food only"
 * on −0.00).
 */
export function payDiscountLabel(
  dealLabel: string | null | undefined,
  d: Discount | null | undefined,
  items: ReadonlyArray<Line>,
  discountCents: number,
): string {
  if (d?.freeOrder === true) return d.reason ? `${FREE_ORDER_LABEL} (${d.reason})` : FREE_ORDER_LABEL;
  const label = dealLabel ?? 'Discount';
  const tags = discountLeftAloneTags(d, items);
  return discountCents > 0 && tags.length > 0 ? `${label} (${tags.join(', ')})` : label;
}

/**
 * The order drawer's row: "Discount", "Discount (Staff)"; "Discount (Staff,
 * food only)", "Discount (food only)", "Discount (Staff, not on value
 * deals)" — or one of the owner's automatic offers by its name
 * (`offerName`): "WhatsApp 10% off", "WhatsApp 10% off (food only)",
 * "WhatsApp 10% off (not on value deals)". A Free order: "Free order (Staff meal)".
 */
export function drawerDiscountLabel(
  reason: string | null | undefined,
  foodOnly: boolean,
  offerName?: string | null,
  notOnValueDeals = false,
  freeOrder = false,
): string {
  if (freeOrder) return reason ? `${FREE_ORDER_LABEL} (${reason})` : FREE_ORDER_LABEL;
  const tags = [...(foodOnly ? ['food only'] : []), ...(notOnValueDeals ? [NOT_ON_VALUE_DEALS] : [])].join(', ');
  if (offerName) return tags ? `${offerName} (${tags})` : offerName;
  if (tags) return `Discount (${reason ? `${reason}, ` : ''}${tags})`;
  return reason ? `Discount (${reason})` : 'Discount';
}

/**
 * The receipt on screen after Pay: "Discount (10%)", "Discount (Staff)";
 * "Discount (10%, food only)", "Discount (Staff, food only)", "Discount
 * (10%, not on value deals)" — an automatic offer by its name, as the
 * printed bill says it.
 */
export function receiptDiscountLabel(d: Discount, items: ReadonlyArray<Line>): string {
  if (d.freeOrder === true) return d.reason ? `${FREE_ORDER_LABEL} (${d.reason})` : FREE_ORDER_LABEL;
  const tags = discountLeftAloneTags(d, items).join(', ');
  if (d.source === 'offer' && d.reason) return tags ? `${d.reason} (${tags})` : d.reason;
  const what = d.reason ?? amountWords(d);
  return tags ? `Discount (${what}, ${tags})` : `Discount (${what})`;
}

/**
 * The owner's automatic offer on the order, for the cart and Pay: its name,
 * and whether it is on or the cashier took it off. Null when the order's
 * discount is not an offer.
 */
export function offerOnOrder(d: Discount | null | undefined): { name: string; declined: boolean } | null {
  if (!d || d.source !== 'offer') return null;
  const name = d.offer?.name ?? d.reason ?? 'Automatic offer';
  return { name, declined: d.offer?.declined === true };
}

/**
 * The cart's words after an offer's name: " · automatic offer", " · automatic
 * offer, food only", " · automatic offer, not on value deals".
 */
export function cartOfferDetail(d: Discount, items: ReadonlyArray<Line>): string {
  const tags = discountLeftAloneTags(d, items);
  return tags.length > 0 ? ` · automatic offer, ${tags.join(', ')}` : ' · automatic offer';
}

/** A line with nothing off that the bill leaves out: an automatic offer the cashier took off. */
export function isOfferTakenOff(d: Pick<OrderDiscount, 'amountCents'> & Partial<Pick<OrderDiscount, 'source'>>): boolean {
  return d.source === 'offer' && (d.amountCents as number) === 0;
}

/**
 * Every discount row the printed bill leaves out (receipt-renderer): an
 * automatic offer the cashier took off, and a discount that leaves the value
 * deals alone and found nothing else to come off (Rs 0 — the food was taken
 * off, the deals stayed). The receipt on screen leaves out the same.
 */
export function billLeavesOut(d: {
  readonly amountCents: number;
  readonly source?: OrderDiscount['source'];
  readonly skipsNoDiscountLines?: boolean;
}): boolean {
  return d.amountCents === 0 && (d.source === 'offer' || d.skipsNoDiscountLines === true);
}
