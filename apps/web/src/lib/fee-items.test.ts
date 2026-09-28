/**
 * Delivery charge items on the website: recognised by name (every stored
 * order, every item a till makes) OR by the settings block's fee item ids,
 * and looked up for an area by its own item, then by name and price.
 * Made-up menu.
 */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedSettings } from '@cheeseoclock/shared-types';
import { restoreLines } from './cart';
import { DEFAULT_ZONE_FACTS } from './delivery-facts';
import { feeItemIdsOf, isDeliveryChargeItem, zoneFeeItemFor } from './delivery-zones';
import { buildMenuView } from './menu-view';
import { validateOrderable } from './order-validation';
import { menuNode } from './seo';

function item(id: string, name: string, priceRs: number): PublishedMenuItem {
  return {
    posItemId: id,
    name,
    description: null,
    basePriceCents: priceRs * 100,
    taxRateBps: 1500,
    imageUrl: null,
    sortOrder: 0,
    modifierGroups: [],
  };
}

// An older till renamed a fee item that a switched-off area still names: only its id says what it is.
const renamed = item('fee-old', 'Rider 300', 300);
const settings: PublishedSettings = {
  v: 1,
  settingsAt: '2026-09-27T10:00:00.000Z',
  settingsRev: 2,
  settingsTie: 0,
  deviceId: 'till-test',
  pickup: { offered: true, percent: 10 },
  zones: DEFAULT_ZONE_FACTS.map((z) =>
    z.id === 'emaar' ? { ...z, active: false, feeCents: 30_000, feeItemId: 'fee-old' } : z.id === 'dha-8' ? { ...z, feeItemId: 'fee-250' } : z,
  ),
};
const MENU: PublishedMenu = {
  categories: [
    { posCategoryId: 'c1', name: 'Pizza', displayOrder: 1, items: [item('pizza', 'Test Pizza — Large', 2000)] },
    {
      posCategoryId: 'c9',
      name: 'Delivery Charges',
      displayOrder: 9,
      items: [item('fee-200', 'Delivery Charge (Rs 200)', 200), item('fee-250', 'Delivery Charge (Rs 250)', 250), renamed],
    },
  ],
  publishedAt: '2026-09-27T10:00:00.000Z',
  store: { name: 'Test Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
  settings,
};

describe('recognising a delivery charge item', () => {
  it('by its name, always; by the block’s fee item ids when there is a block', () => {
    const ids = feeItemIdsOf(MENU);
    expect([...ids].sort()).toEqual(['fee-250', 'fee-old']);
    expect(isDeliveryChargeItem({ name: 'Delivery Charge (Rs 200)' })).toBe(true);
    expect(isDeliveryChargeItem(renamed)).toBe(false);
    expect(isDeliveryChargeItem(renamed, ids)).toBe(true);
    expect(isDeliveryChargeItem(item('pizza', 'Test Pizza — Large', 2000), ids)).toBe(false);
    expect(feeItemIdsOf({})).toEqual(new Set());
  });

  it('keeps it off the menu, out of a restored cart, off an order and out of the JSON-LD', () => {
    const shown = buildMenuView(MENU).flatMap((s) => s.cards.flatMap((c) => c.variants.map((v) => v.item.posItemId)));
    expect(shown).toEqual(['pizza']);
    const { lines, dropped } = restoreLines(MENU, [{ posItemId: 'fee-old', quantity: 1, modifierIds: [], notes: null }]);
    expect([lines, dropped]).toEqual([[], 1]);
    expect(validateOrderable(renamed, 'delivery', feeItemIdsOf(MENU))).toMatch(/delivery charge is added from your delivery area/);
    const sections = (menuNode(MENU) as { hasMenuSection: Array<{ hasMenuItem: Array<{ name: string }> }> }).hasMenuSection;
    expect(sections.flatMap((s) => s.hasMenuItem.map((i) => i.name))).toEqual(['Test Pizza — Large']);
  });
});

describe('the item that charges an area’s fee', () => {
  it('is the area’s own item at its fee, else the one named for the fee, else none', () => {
    expect(zoneFeeItemFor(MENU, { feeCents: 25_000, feeItemId: 'fee-250' })?.posItemId).toBe('fee-250');
    // Its own item re-priced (an older till): today's match by name and price.
    expect(zoneFeeItemFor(MENU, { feeCents: 20_000, feeItemId: 'fee-250' })?.posItemId).toBe('fee-200');
    // No block yet: by name and price, as before.
    expect(zoneFeeItemFor(MENU, { feeCents: 25_000, feeItemId: null })?.posItemId).toBe('fee-250');
    expect(zoneFeeItemFor(MENU, { feeCents: 45_000, feeItemId: 'nope' })).toBeUndefined();
    // A free area has no charge line.
    expect(zoneFeeItemFor(MENU, { feeCents: 0, feeItemId: null })).toBeUndefined();
  });
});
