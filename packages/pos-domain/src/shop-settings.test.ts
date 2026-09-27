import { describe, expect, it } from 'vitest';
import {
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

  it('foodpanda.fees: 25% suggested (costing spec 4.7), not confirmed, after the deal, no fee, no tax, at till prices', () => {
    expect(SUGGESTED_FOODPANDA_COMMISSION_BPS).toBe(2500);
    expect(DEFAULT_FOODPANDA_FEES).toEqual({
      v: 1,
      commissionBps: 2500,
      confirmed: false,
      base: 'after_deal',
      fixedFeeCents: 0,
      commissionTaxBps: 0,
      upliftBps: 0,
    });
  });

  it('foodpanda.checks: shown at Pay, both optional', () => {
    expect(DEFAULT_FOODPANDA_CHECKS).toEqual({ v: 1, orderCode: 'optional', tabletTotal: 'optional' });
    expect(FOODPANDA_TABLET_TOLERANCE_CENTS).toBe(100);
  });

  it('one default per key, frozen, in the format this version writes', () => {
    expect([...SHOP_SETTING_KEYS]).toEqual(['foodpanda.deal', 'foodpanda.fees', 'foodpanda.checks']);
    for (const key of SHOP_SETTING_KEYS) {
      const d = SHOP_SETTING_DEFAULTS[key];
      expect(Object.isFrozen(d)).toBe(true);
      expect(d.v).toBe(SHOP_SETTING_FORMAT[key]);
    }
    expect(Object.isFrozen(SHOP_SETTING_DEFAULTS)).toBe(true);
  });
});
