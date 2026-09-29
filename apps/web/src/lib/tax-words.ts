import { isDeliveryChargeItem } from './delivery-zones';

/**
 * The tax the website names ("15% tax is added on the bill"), from the
 * published menu (sweep B2): the one rate every food item carries. The
 * delivery charges are left out (they are till items, not food). Food at
 * more than one rate names no number ("tax is added on the bill") rather
 * than a wrong one.
 *
 * Pure and safe in the browser (the /menu page works it out from its own
 * menu prop). The words: delivery-facts {tax} / {Tax}.
 */

/**
 * The rate the website names while it does not know the menu (a build or a
 * preview without a database, a database error with nothing read yet, no
 * menu published): today's, 15%. The ONE rate typed by hand.
 */
export const DEFAULT_TAX_BPS = 1500;

/** What the rate needs of a menu: its items' names, ids and rates. */
export interface TaxMenu {
  categories: ReadonlyArray<{ items: ReadonlyArray<{ posItemId: string; name: string; taxRateBps: number }> }>;
}

/**
 * The food's one tax rate, in basis points; null when the food is taxed at
 * more than one rate (no number is named); DEFAULT_TAX_BPS when the menu is
 * unknown or has no food. `feeItemIds`: the settings block's delivery charge
 * items (a charge is also found by its name).
 */
export function taxBpsOf(menu: TaxMenu | null | undefined, feeItemIds?: ReadonlySet<string> | null): number | null {
  if (!menu) return DEFAULT_TAX_BPS;
  const rates = new Set<number>();
  for (const c of menu.categories) {
    for (const i of c.items) if (!isDeliveryChargeItem(i, feeItemIds)) rates.add(i.taxRateBps);
  }
  if (rates.size === 0) return DEFAULT_TAX_BPS;
  return rates.size === 1 ? [...rates][0]! : null;
}

/** A rate in words: 1500 → "15%", 1650 → "16.5%", 1625 → "16.25%". */
export function taxPercentWords(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
