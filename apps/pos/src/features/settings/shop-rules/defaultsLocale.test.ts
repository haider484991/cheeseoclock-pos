/**
 * The money in the built-in shop rules is sized to the shop's currency.
 *
 * The released defaults are rupee-sized (Rs 100 / 200 / 500 buttons, up to
 * Rs 500 off without a manager). Read as dollars they would be $100 / $200 /
 * $500 off and $500 without a manager — so a US till gets its own: $1 / $2 /
 * $5 and $5. A Pakistani till's are the released objects themselves.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_PRESETS,
  SHOP_SETTING_DEFAULTS,
  US_SHOP_LOCALE,
  resetShopLocale,
  setShopLocale,
  shopSettingDefault,
} from '@cheeseoclock/shared-types';
import { counterDiscountsFallback, DEFAULT_COUNTER_DISCOUNTS } from './counterRules';
import { RELEASED_SCREEN_RULES, screenRulesFallback } from '../../checkout/discountPresets';

afterEach(resetShopLocale);

describe('Pakistan keeps the released rules, the very same objects', () => {
  it('for every shop rule', () => {
    for (const key of Object.keys(SHOP_SETTING_DEFAULTS) as Array<keyof typeof SHOP_SETTING_DEFAULTS>) {
      expect(shopSettingDefault(key), key).toBe(SHOP_SETTING_DEFAULTS[key]);
    }
  });

  it('for the screens’ fallbacks', () => {
    expect(counterDiscountsFallback()).toBe(DEFAULT_COUNTER_DISCOUNTS);
    expect(screenRulesFallback()).toBe(RELEASED_SCREEN_RULES);
  });
});

describe('a US till starts with US-sized money', () => {
  it('$1 / $2 / $5 buttons and $5 off without a manager', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(shopSettingDefault('discounts.presets').flatCents).toEqual([100, 200, 500]);
    expect(shopSettingDefault('discounts.approval').flatOverCents).toBe(500);
    // Only the money changes: the percents, reasons and approval percent are the released ones.
    expect(shopSettingDefault('discounts.presets').percents).toEqual(DEFAULT_DISCOUNT_PRESETS.percents);
    expect(shopSettingDefault('discounts.presets').reasons).toEqual(DEFAULT_DISCOUNT_PRESETS.reasons);
    expect(shopSettingDefault('discounts.approval').percentOver).toBe(DEFAULT_DISCOUNT_APPROVAL.percentOver);
  });

  it('in the screens’ fallbacks too, while the shop’s own rules load', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(counterDiscountsFallback().presets.flatCents).toEqual([100, 200, 500]);
    expect(counterDiscountsFallback().approval.flatOverCents).toBe(500);
    expect(screenRulesFallback().approval.flatOverCents).toBe(500);
  });
});
