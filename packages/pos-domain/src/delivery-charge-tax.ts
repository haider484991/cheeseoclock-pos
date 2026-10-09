import type {
  DeliveryChargeTaxCategory,
  DeliveryChargeTaxChoice,
  DeliveryChargeTaxItem,
} from '@cheeseoclock/shared-types';
import { applyBps } from './money.js';

/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge" (shared-types
 * delivery-charge-tax.ts): what the charges are taxed now, read from the
 * charge items, and what a choice charges. Pure, so it is tested.
 */

/** A tax's rate when the bill is paid by card / wallet / bank: its card rate, else its rate. */
function cardRateOf(t: { rateBps: number; digitalRateBps: number | null }): number {
  return t.digitalRateBps ?? t.rateBps;
}

/**
 * The charges' tax now, as the card's choice. The charge items that are on
 * decide (all of them when none is): on ONE tax — the food's is 'food', one
 * charging nothing either way is 'none', any other is 'rate' with its rates.
 * Null when they are on different taxes, or there is no charge item.
 */
export function deliveryChargeTaxNow(
  charges: ReadonlyArray<Pick<DeliveryChargeTaxItem, 'isActive' | 'tax'>>,
  foodTaxId: string | null,
): DeliveryChargeTaxChoice | null {
  const on = charges.filter((c) => c.isActive);
  const looked = on.length > 0 ? on : charges;
  const first = looked[0];
  if (!first || looked.some((c) => c.tax.id !== first.tax.id)) return null;
  const tax = first.tax;
  if (foodTaxId !== null && tax.id === foodTaxId) return { kind: 'food' };
  if (tax.rateBps === 0 && cardRateOf(tax) === 0) return { kind: 'none' };
  return { kind: 'rate', rateBps: tax.rateBps, digitalRateBps: tax.digitalRateBps };
}

/** The rates a choice charges: the food's for 'food' (null when there is no food tax), nothing for 'none'. */
export function deliveryChargeTaxRates(
  choice: DeliveryChargeTaxChoice,
  food: Pick<DeliveryChargeTaxCategory, 'rateBps' | 'digitalRateBps'> | null,
): { rateBps: number; digitalRateBps: number | null } | null {
  if (choice.kind === 'food') return food ? { rateBps: food.rateBps, digitalRateBps: food.digitalRateBps } : null;
  if (choice.kind === 'none') return { rateBps: 0, digitalRateBps: null };
  return { rateBps: choice.rateBps, digitalRateBps: choice.digitalRateBps };
}

/** Do two choices say the same? ('rate': the same rate, and the same rate by card — none counts as the rate itself.) */
export function sameDeliveryChargeTax(a: DeliveryChargeTaxChoice | null, b: DeliveryChargeTaxChoice | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'rate' && b.kind === 'rate') return a.rateBps === b.rateBps && cardRateOf(a) === cardRateOf(b);
  return a.kind === b.kind;
}

/**
 * The card's worked example for one charge: its tax and what the bill
 * carries for it, in cash and — when the card rate is another — by card.
 * Rounded per line, as the till taxes a line (pos-domain applyBps).
 */
export function deliveryChargeTaxExample(
  feeCents: number,
  rates: { rateBps: number; digitalRateBps: number | null },
): { taxCents: number; withTaxCents: number; card: { rateBps: number; taxCents: number; withTaxCents: number } | null } {
  const taxCents = applyBps(feeCents, rates.rateBps) as number;
  const cardBps = cardRateOf(rates);
  const cardTax = applyBps(feeCents, cardBps) as number;
  return {
    taxCents,
    withTaxCents: feeCents + taxCents,
    card: cardBps === rates.rateBps ? null : { rateBps: cardBps, taxCents: cardTax, withTaxCents: feeCents + cardTax },
  };
}
