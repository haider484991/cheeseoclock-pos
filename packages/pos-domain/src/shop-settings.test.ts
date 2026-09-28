import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_ONLINE_OPTIONS,
  DEFAULT_WEBSITE_PICKUP,
  DELIVERY_ZONES,
  PICKUP_DISCOUNT_PERCENT,
  DEFAULT_FOODPANDA_CHECKS,
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  FOODPANDA_TABLET_TOLERANCE_CENTS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  SHOP_SETTING_KEYS,
  SUGGESTED_FOODPANDA_COMMISSION_BPS,
} from '@cheeseoclock/shared-types';

/**
 * The frozen defaults (shared-types shop-settings.ts). A key never saved
 * reads as its default, so these ARE the till's behaviour until the owner
 * saves something — and two tills on different versions with the key unsaved
 * must read the same. These values are released: NEVER edit one. A change to
 * how the shop works is a saved setting. If this test fails, put the value
 * back.
 */
describe('the released defaults are pinned', () => {
  it('foodpanda.deal: no deal (today: foodpanda orders at full till price)', () => {
    expect(DEFAULT_FOODPANDA_DEAL).toEqual({
      v: 1,
      percent: 0,
      shopPercent: 0,
      minOrderCents: null,
      maxOffCents: null,
      startsOn: null,
      endsOn: null,
    });
  });

  it('foodpanda.fees: 25% suggested (costing spec 4.7), not confirmed, after the deal, no fee, no tax, at till prices, no fee on the total', () => {
    expect(SUGGESTED_FOODPANDA_COMMISSION_BPS).toBe(2500);
    expect(DEFAULT_FOODPANDA_FEES).toEqual({
      v: 1,
      commissionBps: 2500,
      confirmed: false,
      base: 'after_deal',
      fixedFeeCents: 0,
      commissionTaxBps: 0,
      upliftBps: 0,
      paymentFeeBps: 0,
    });
  });

  it('foodpanda.checks: shown at Pay, both optional', () => {
    expect(DEFAULT_FOODPANDA_CHECKS).toEqual({ v: 1, orderCode: 'optional', tabletTotal: 'optional' });
    expect(FOODPANDA_TABLET_TOLERANCE_CENTS).toBe(100);
  });

  it('discounts.delivery: NO — a discount leaves the delivery charge alone (the owner, 28 Sep 2026; the one default that is not "what the till did before")', () => {
    expect(DEFAULT_DISCOUNT_DELIVERY).toEqual({ v: 1, alsoOffDeliveryCharge: false });
    expect(SHOP_SETTING_DEFAULTS['discounts.delivery']).toBe(DEFAULT_DISCOUNT_DELIVERY);
  });

  it('one default per key, frozen, in the format this version writes', () => {
    expect([...SHOP_SETTING_KEYS]).toEqual([
      'foodpanda.deal',
      'foodpanda.fees',
      'foodpanda.checks',
      'discounts.approval',
      'discounts.presets',
      'discounts.delivery',
      'staff.timing',
      'kitchen.timing',
      'stock.rules',
      'menu.importPolicy',
      'discounts.websitePickup',
      'delivery.zones',
      'online.options',
    ]);
    for (const key of SHOP_SETTING_KEYS) {
      const d = SHOP_SETTING_DEFAULTS[key];
      expect(Object.isFrozen(d)).toBe(true);
      expect(d.v).toBe(SHOP_SETTING_FORMAT[key]);
    }
    expect(Object.isFrozen(SHOP_SETTING_DEFAULTS)).toBe(true);
  });

  it('discounts.websitePickup: offered, 10% off (today’s website pick-up)', () => {
    expect(DEFAULT_WEBSITE_PICKUP).toEqual({ v: 1, offered: true, percent: 10 });
    expect(PICKUP_DISCOUNT_PERCENT).toBe(10);
  });

  it('online.options: the menu goes to the website only when asked (today)', () => {
    expect(DEFAULT_ONLINE_OPTIONS).toEqual({ v: 1, autoPublishMenu: false });
  });

  it('delivery.zones: today’s 21 areas and fees exactly (DHA Phase 8 at Rs 250), all on, no fee item named yet', () => {
    expect(DEFAULT_DELIVERY_ZONES.v).toBe(1);
    expect(DEFAULT_DELIVERY_ZONES.zones.map((z) => [z.id, z.feeCents, z.active, z.feeItemId])).toEqual(
      DELIVERY_ZONES.map((z) => [z.id, z.feeCents, true, null]),
    );
    expect(DEFAULT_DELIVERY_ZONES.zones.map((z) => [z.id, z.feeCents])).toEqual([
      ['dha-1', 20_000],
      ['dha-2', 20_000],
      ['dha-2-ext', 20_000],
      ['dha-3', 20_000],
      ['dha-4', 20_000],
      ['dha-5', 20_000],
      ['dha-6', 20_000],
      ['dha-7', 20_000],
      ['dha-7-ext', 20_000],
      ['dha-8', 25_000],
      ['emaar', 25_000],
      ['creek-vista', 25_000],
      ['clifton-1', 25_000],
      ['clifton-2', 25_000],
      ['clifton-3', 20_000],
      ['clifton-4', 20_000],
      ['clifton-5', 20_000],
      ['clifton-6', 20_000],
      ['clifton-7', 20_000],
      ['clifton-8', 20_000],
      ['clifton-9', 20_000],
    ]);
    expect(Object.isFrozen(DEFAULT_DELIVERY_ZONES.zones)).toBe(true);
    for (const z of DEFAULT_DELIVERY_ZONES.zones) expect(Object.isFrozen(z)).toBe(true);
  });
});
