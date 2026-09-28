import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_OFFERS,
  DEFAULT_FOODPANDA_CHECKS,
  DEFAULT_FOODPANDA_DEAL,
  DEFAULT_FOODPANDA_FEES,
  DEFAULT_ORDER_REASONS,
  FOODPANDA_TABLET_TOLERANCE_CENTS,
  ORDER_REASON_ID_RE,
  ORDER_REASON_LABEL_MAX,
  ORDER_REASONS_MAX,
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

  it('discounts.offers: NO offers and the cashier is not asked — nothing changes until the owner adds one', () => {
    expect(DEFAULT_DISCOUNT_OFFERS).toEqual({ v: 1, askCameBy: false, offers: [] });
    expect(Object.isFrozen(DEFAULT_DISCOUNT_OFFERS.offers)).toBe(true);
    expect(SHOP_SETTING_DEFAULTS['discounts.offers']).toBe(DEFAULT_DISCOUNT_OFFERS);
  });

  it('orders.reasons: today’s Cancel and Refund buttons, in today’s order, with what each says about the food; no cash-out buttons', () => {
    // Exactly the lists the Cancel and Refund boxes had typed in (stockCopy.ts up to v0.7.26).
    const today = {
      cancel: [
        { label: 'Customer cancelled' },
        { label: 'Refused at the door', foodMade: 'made' },
        { label: 'Not collected', foodMade: 'made' },
        { label: 'Wrong order / duplicate', foodMade: 'not_made' },
        { label: 'Out of stock', foodMade: 'not_made' },
      ],
      refund: [{ label: 'Customer unhappy' }, { label: 'Wrong order' }, { label: 'Cancelled by Foodpanda' }, { label: 'Out of stock', foodMade: 'not_made' }],
    };
    const asToday = (buttons: ReadonlyArray<{ label: string; food: string }>) =>
      buttons.map((b) => (b.food === 'ask' ? { label: b.label } : { label: b.label, foodMade: b.food }));
    expect(asToday(DEFAULT_ORDER_REASONS.cancel)).toEqual(today.cancel);
    expect(asToday(DEFAULT_ORDER_REASONS.refund)).toEqual(today.refund);
    expect(DEFAULT_ORDER_REASONS.cashOut).toEqual([]);
    expect(DEFAULT_ORDER_REASONS.v).toBe(1);
    expect(DEFAULT_ORDER_REASONS).toEqual({
      v: 1,
      cancel: [
        { id: 'customer_cancelled', label: 'Customer cancelled', food: 'ask' },
        { id: 'refused_at_door', label: 'Refused at the door', food: 'made' },
        { id: 'not_collected', label: 'Not collected', food: 'made' },
        { id: 'wrong_order_duplicate', label: 'Wrong order / duplicate', food: 'not_made' },
        { id: 'out_of_stock', label: 'Out of stock', food: 'not_made' },
      ],
      refund: [
        { id: 'customer_unhappy', label: 'Customer unhappy', food: 'ask' },
        { id: 'wrong_order', label: 'Wrong order', food: 'ask' },
        { id: 'cancelled_by_foodpanda', label: 'Cancelled by Foodpanda', food: 'ask' },
        { id: 'out_of_stock', label: 'Out of stock', food: 'not_made' },
      ],
      cashOut: [],
    });
    // Deeply frozen, and inside its own bounds.
    for (const list of [DEFAULT_ORDER_REASONS.cancel, DEFAULT_ORDER_REASONS.refund, DEFAULT_ORDER_REASONS.cashOut]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.length).toBeLessThanOrEqual(ORDER_REASONS_MAX);
    }
    for (const b of [...DEFAULT_ORDER_REASONS.cancel, ...DEFAULT_ORDER_REASONS.refund]) {
      expect(Object.isFrozen(b)).toBe(true);
      expect(b.label.length).toBeLessThanOrEqual(ORDER_REASON_LABEL_MAX);
      expect(ORDER_REASON_ID_RE.test(b.id)).toBe(true);
    }
    expect(SHOP_SETTING_DEFAULTS['orders.reasons']).toBe(DEFAULT_ORDER_REASONS);
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
      'discounts.offers',
      'orders.reasons',
    ]);
    for (const key of SHOP_SETTING_KEYS) {
      const d = SHOP_SETTING_DEFAULTS[key];
      expect(Object.isFrozen(d)).toBe(true);
      expect(d.v).toBe(SHOP_SETTING_FORMAT[key]);
    }
    expect(Object.isFrozen(SHOP_SETTING_DEFAULTS)).toBe(true);
  });
});
