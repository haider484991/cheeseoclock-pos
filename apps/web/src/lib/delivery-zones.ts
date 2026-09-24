import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';

/**
 * Where the shop delivers, and what each place costs.
 *
 * Source: the Dropoff rider service's 2026 rate card (Zone 1). The owner
 * delivers in DHA and Clifton ONLY — every other Karachi area on that card is
 * deliberately left out, and the checkout refuses an order without one of
 * these zones (owner, 25 Sep 2026: "customers should not be able to order
 * outside our zones").
 *
 * The fee reaches the till as a real line item: the POS menu carries
 * "Delivery Charge (Rs 200)" and "Delivery Charge (Rs 250)" items (category
 * "Delivery Charges"), and the server adds the one whose price matches the
 * zone. Changing a fee here means changing that POS item's price too.
 */

export type ZoneGroup = 'DHA' | 'Clifton';

export interface DeliveryZone {
  /** Stable id sent by the checkout — never rename one that has shipped. */
  id: string;
  /** What the customer picks and what the till shows as the order's area. */
  name: string;
  group: ZoneGroup;
  feeCents: number;
}

const RS200 = 20_000;
const RS250 = 25_000;

export const DELIVERY_ZONES: readonly DeliveryZone[] = [
  { id: 'dha-1', name: 'DHA Phase 1', group: 'DHA', feeCents: RS200 },
  { id: 'dha-2', name: 'DHA Phase 2', group: 'DHA', feeCents: RS200 },
  { id: 'dha-2-ext', name: 'DHA Phase 2 Extension', group: 'DHA', feeCents: RS200 },
  { id: 'dha-3', name: 'DHA Phase 3', group: 'DHA', feeCents: RS200 },
  { id: 'dha-4', name: 'DHA Phase 4', group: 'DHA', feeCents: RS200 },
  { id: 'dha-5', name: 'DHA Phase 5', group: 'DHA', feeCents: RS200 },
  { id: 'dha-6', name: 'DHA Phase 6', group: 'DHA', feeCents: RS200 },
  { id: 'dha-7', name: 'DHA Phase 7', group: 'DHA', feeCents: RS200 },
  { id: 'dha-7-ext', name: 'DHA Phase 7 Extension', group: 'DHA', feeCents: RS200 },
  { id: 'dha-8', name: 'DHA Phase 8', group: 'DHA', feeCents: RS200 },
  { id: 'emaar', name: 'Emaar Crescent Bay (DHA)', group: 'DHA', feeCents: RS250 },
  { id: 'creek-vista', name: 'Creek Vista (DHA)', group: 'DHA', feeCents: RS250 },
  { id: 'clifton-1', name: 'Clifton Block 1', group: 'Clifton', feeCents: RS250 },
  { id: 'clifton-2', name: 'Clifton Block 2', group: 'Clifton', feeCents: RS250 },
  { id: 'clifton-3', name: 'Clifton Block 3', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-4', name: 'Clifton Block 4', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-5', name: 'Clifton Block 5', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-6', name: 'Clifton Block 6', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-7', name: 'Clifton Block 7', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-8', name: 'Clifton Block 8', group: 'Clifton', feeCents: RS200 },
  { id: 'clifton-9', name: 'Clifton Block 9', group: 'Clifton', feeCents: RS200 },
];

/** The two fee tiers in customer words, for copy that summarises the card. */
export const FEE_SUMMARY = [
  { feeCents: RS200, places: 'DHA Phases 1–8 · Clifton Blocks 3–9' },
  { feeCents: RS250, places: 'Clifton Blocks 1 & 2 · Emaar & Creek Vista' },
] as const;

export function findZone(id: string | null | undefined): DeliveryZone | undefined {
  if (!id) return undefined;
  return DELIVERY_ZONES.find((z) => z.id === id);
}

/** A POS item the website must never sell on its own. */
export function isDeliveryChargeItem(item: Pick<PublishedMenuItem, 'name'>): boolean {
  return /^delivery charge/i.test(item.name.trim());
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
  for (const c of menu.categories) {
    for (const i of c.items) {
      if (isDeliveryChargeItem(i) && i.basePriceCents === feeCents) return i;
    }
  }
  return undefined;
}
