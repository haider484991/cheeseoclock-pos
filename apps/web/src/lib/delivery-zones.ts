import {
  findDeliveryChargeItem,
  isDeliveryChargeName,
  type PublishedMenu,
  type PublishedMenuItem,
} from '@cheeseoclock/shared-types';

/**
 * Where the shop delivers, and what each place costs.
 *
 * The list itself lives in @cheeseoclock/shared-types (delivery-areas.ts) —
 * ONE list shared with the till, whose address entry picks from the same
 * zones and shows the same fees. Edit zones and fees there, not here. This
 * module keeps the website's names for it, plus the helpers that know about
 * the published menu.
 *
 * The owner delivers in DHA and Clifton ONLY, and the checkout refuses an
 * order without one of these zones (owner, 25 Sep 2026: "customers should not
 * be able to order outside our zones").
 *
 * The fee reaches the till as a real line item: the POS menu carries
 * "Delivery Charge (Rs 200)" and "Delivery Charge (Rs 250)" items (category
 * "Delivery Charges"), and the server adds the one whose price matches the
 * zone. Changing a fee means changing that POS item's price too.
 */
export {
  DELIVERY_ZONES,
  FEE_SUMMARY,
  findZone,
  type DeliveryZone,
  type ZoneGroup,
} from '@cheeseoclock/shared-types';

/** A POS item the website must never sell on its own. */
export function isDeliveryChargeItem(item: Pick<PublishedMenuItem, 'name'>): boolean {
  return isDeliveryChargeName(item.name);
}

/**
 * The published "Delivery Charge (Rs N)" item whose price is this fee, or
 * undefined when the till's menu has none yet (a shop that has not imported
 * the new menu). Matched on price rather than the exact name so a cashier
 * retyping the name cannot break checkout.
 */
export function deliveryChargeItemFor(
  menu: PublishedMenu,
  feeCents: number,
): PublishedMenuItem | undefined {
  return findDeliveryChargeItem(
    menu.categories.flatMap((c) => c.items),
    feeCents,
  );
}
