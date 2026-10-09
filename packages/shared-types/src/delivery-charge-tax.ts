/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge" (the
 * owner, 10 Oct 2026: "i want to setting to set delivery tax in settings").
 *
 * The delivery charge is a menu item per fee ("Delivery Charge (Rs N)", made
 * by the areas' Save), and an item is taxed by its tax category — so the
 * charge has always been taxed like any item: since the menu file made the
 * charges, at the food's 15% (the owner kept it, 2 Oct 2026, Q1). The card
 * puts every charge item on ONE tax:
 *
 *  - 'food': the food's own tax (the one most of the menu is on), its card
 *    rate too — what the charges carry today;
 *  - 'none': no tax on the charge (the bill's "Sales tax on delivery" line
 *    goes);
 *  - 'rate': a rate of its own, and a card rate if the shop has one, on the
 *    tax category "Delivery charge tax" (made, or set to these rates, by the
 *    Save; Menu → Tax lists it). 'none' is that category at 0%.
 *
 * Nothing is stored apart from the items: the card reads the charge items'
 * tax, so a till updated to this version shows what it already charges and
 * nothing changes until the owner saves. Orders already open keep the tax
 * their lines were sold at (order_items' snapshot).
 */
export type DeliveryChargeTaxChoice =
  | { kind: 'food' }
  | { kind: 'none' }
  | { kind: 'rate'; rateBps: number; digitalRateBps: number | null };

/** The tax category 'rate' (and 'none', at 0%) keeps the charges on. */
export const DELIVERY_CHARGE_TAX_NAME = 'Delivery charge tax';

/** A tax category as the card shows it. */
export interface DeliveryChargeTaxCategory {
  id: string;
  name: string;
  rateBps: number;
  /** Its rate when the bill is paid by card / wallet / bank; null = the same as rateBps. */
  digitalRateBps: number | null;
}

/** One "Delivery Charge (Rs N)" item and the tax it is on now. */
export interface DeliveryChargeTaxItem {
  itemId: string;
  name: string;
  feeCents: number;
  isActive: boolean;
  tax: DeliveryChargeTaxCategory;
}

/** settings:deliveryChargeTax — what the card shows. */
export interface DeliveryChargeTaxView {
  /** The charges' tax now as a choice; null when they are on different taxes, or there is no charge item. */
  now: DeliveryChargeTaxChoice | null;
  /** Every delivery charge item (switched-off ones too): the ones that are on first, then by fee. */
  charges: DeliveryChargeTaxItem[];
  /** The food's tax: the one most of the other items are on. Null when Menu → Tax has none. */
  food: DeliveryChargeTaxCategory | null;
  /**
   * How the website's checkout gets a change: 'itself' — the Save sends the
   * delivery areas again with their charge items (the block alone);
   * 'publish' — the areas were never saved on this till (the website uses
   * its own list), so the next menu Publish takes it.
   */
  website: 'itself' | 'publish';
}

/** settings:saveDeliveryChargeTax (the owner only). */
export interface SaveDeliveryChargeTaxRequest {
  choice: DeliveryChargeTaxChoice;
}

export interface DeliveryChargeTaxSaved {
  view: DeliveryChargeTaxView;
  /** Charge items moved onto the chosen tax (0: they were on it already). */
  itemsChanged: number;
  /** The charges' tax changed (items moved, or "Delivery charge tax" re-rated). */
  changed: boolean;
  /** The delivery areas went to the website again with their charge items (website 'itself'). */
  sentToWebsite: boolean;
}
