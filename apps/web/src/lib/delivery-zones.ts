import {
  deliveryZoneFeeItemIds,
  findDeliveryChargeItem,
  isDeliveryChargeName,
  type PublishedMenuItem,
} from '@cheeseoclock/shared-types';
import type { PublicMenu } from './public-menu';

/**
 * Where the shop delivers, and what each place costs.
 *
 * The owner sets the areas and fees on the till (Settings → Delivery areas
 * & fees); the till sends them with the menu as the settings block, and the
 * website reads them through lib/delivery-facts.ts (pages, checkout) and
 * lib/site-facts.ts (the stored block). Until a block arrives the website
 * uses the compiled list re-exported here, which is also the till's default:
 * DHA and Clifton only, and the checkout refuses an order without one of the
 * areas (owner, 25 Sep 2026: "customers should not be able to order outside
 * our zones").
 *
 * The fee reaches the till as a real line item: a "Delivery Charge (Rs N)"
 * menu item (category "Delivery Charges"). A block names each area's item
 * (feeItemId); without one — or when a kept block meets a menu from an older
 * till that lacks the item — the item is found by its name and price.
 */
export {
  DELIVERY_ZONES,
  FEE_SUMMARY,
  findZone,
  type DeliveryZone,
  type ZoneGroup,
} from '@cheeseoclock/shared-types';

/**
 * A POS item the website must never sell on its own: named like a delivery
 * charge (every stored order, and every fee item the till makes — Menu locks
 * the name), or one of the settings block's fee items (`feeItemIds`).
 */
export function isDeliveryChargeItem(
  item: Pick<PublishedMenuItem, 'name'> & { posItemId?: string },
  feeItemIds?: ReadonlySet<string> | null,
): boolean {
  if (isDeliveryChargeName(item.name)) return true;
  return !!feeItemIds && typeof item.posItemId === 'string' && feeItemIds.has(item.posItemId);
}

/** The fee items the menu's settings block names (empty without a block). */
export function feeItemIdsOf(menu: Pick<PublicMenu, 'settings'>): Set<string> {
  return deliveryZoneFeeItemIds(menu.settings?.zones ?? []);
}

/**
 * The published "Delivery Charge (Rs N)" item whose price is this fee, or
 * undefined when the till's menu has none yet (a shop that has not imported
 * the new menu). Matched on price rather than the exact name so a cashier
 * retyping the name cannot break checkout.
 */
export function deliveryChargeItemFor(
  menu: Pick<PublicMenu, 'categories'>,
  feeCents: number,
): PublishedMenuItem | undefined {
  return findDeliveryChargeItem(
    menu.categories.flatMap((c) => c.items),
    feeCents,
  );
}

/**
 * The item that charges an area's fee, the same on the server and in the
 * browser: the area's own fee item (feeItemId) when it is on the menu at
 * exactly the fee; else today's match by name and price; undefined when
 * neither (the order then carries the "add the delivery charge by hand"
 * note) and for a free area (no charge line).
 */
export function zoneFeeItemFor(
  menu: Pick<PublicMenu, 'categories'>,
  zone: { readonly feeCents: number; readonly feeItemId?: string | null },
): PublishedMenuItem | undefined {
  if (!(zone.feeCents > 0)) return undefined;
  if (zone.feeItemId) {
    for (const c of menu.categories) {
      for (const i of c.items) {
        if (i.posItemId === zone.feeItemId && i.basePriceCents === zone.feeCents) return i;
      }
    }
  }
  return deliveryChargeItemFor(menu, zone.feeCents);
}
