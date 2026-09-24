import { describe, expect, it } from 'vitest';
import type { PublishedMenu } from '@cheeseoclock/shared-types';
import { DELIVERY_ZONES, deliveryChargeItemFor, findZone, isDeliveryChargeItem } from './delivery-zones';

describe('delivery zones', () => {
  it('covers DHA and Clifton only, at the rate card’s two fees', () => {
    expect(new Set(DELIVERY_ZONES.map((z) => z.group))).toEqual(new Set(['DHA', 'Clifton']));
    expect(new Set(DELIVERY_ZONES.map((z) => z.feeCents))).toEqual(new Set([20_000, 25_000]));
  });

  it('charges Rs 250 exactly for Clifton 1 & 2, Emaar and Creek Vista', () => {
    const rs250 = DELIVERY_ZONES.filter((z) => z.feeCents === 25_000).map((z) => z.id).sort();
    expect(rs250).toEqual(['clifton-1', 'clifton-2', 'creek-vista', 'emaar']);
  });

  it('has every DHA phase 1–8 and Clifton block 1–9', () => {
    for (let p = 1; p <= 8; p++) expect(findZone(`dha-${p}`)?.feeCents).toBe(20_000);
    for (let b = 1; b <= 9; b++) expect(findZone(`clifton-${b}`)).toBeDefined();
  });

  it('ids are unique', () => {
    expect(new Set(DELIVERY_ZONES.map((z) => z.id)).size).toBe(DELIVERY_ZONES.length);
  });

  it('knows nothing outside the zones', () => {
    expect(findZone('gizri')).toBeUndefined();
    expect(findZone('saddar')).toBeUndefined();
    expect(findZone('')).toBeUndefined();
    expect(findZone(undefined)).toBeUndefined();
  });
});

describe('deliveryChargeItemFor', () => {
  const charge = (name: string, cents: number) => ({
    posItemId: `id:${name}`,
    name,
    description: null,
    basePriceCents: cents,
    taxRateBps: 1500,
    imageUrl: null,
    sortOrder: 0,
    modifierGroups: [],
  });
  const menu: PublishedMenu = {
    categories: [
      {
        posCategoryId: 'c',
        name: 'Delivery Charges',
        displayOrder: 6,
        items: [charge('Delivery Charge (Rs 200)', 20_000), charge('delivery charge rs 250', 25_000)],
      },
      { posCategoryId: 'f', name: 'Fries', displayOrder: 3, items: [charge('Fries — Regular', 20_000)] },
    ],
    publishedAt: '2026-09-25T00:00:00.000Z',
    store: { name: 'x', phone: null, whatsapp: null, addressLine: null, tagline: null },
  };

  it('matches the charge item by price, whatever the cashier named it', () => {
    expect(deliveryChargeItemFor(menu, 20_000)?.posItemId).toBe('id:Delivery Charge (Rs 200)');
    expect(deliveryChargeItemFor(menu, 25_000)?.posItemId).toBe('id:delivery charge rs 250');
  });

  it('never picks food that happens to cost the same', () => {
    expect(isDeliveryChargeItem({ name: 'Fries — Regular' })).toBe(false);
    expect(deliveryChargeItemFor(menu, 30_000)).toBeUndefined();
  });
});
