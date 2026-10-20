/**
 * resolveShopLocale: what a till stores becomes the locale it runs as.
 *
 * The direction that matters is the fallback. Every till that existed before
 * 'shop.locale' is Pakistani and stores nothing, and a value this version
 * cannot read must never strand a shop between two currencies — so anything
 * that is not a clean, known choice is Pakistan, returned as
 * DEFAULT_SHOP_LOCALE itself (the same object), so nothing downstream of a
 * Pakistani till can tell a resolved locale from the built-in one.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHOP_LOCALE,
  DEFAULT_STORED_SHOP_LOCALE,
  US_SHOP_LOCALE,
  US_TIME_ZONES,
  resolveShopLocale,
} from '@cheeseoclock/shared-types';

describe('a Pakistani till resolves to the built-in locale itself', () => {
  it('when nothing is stored', () => {
    expect(resolveShopLocale(null)).toBe(DEFAULT_SHOP_LOCALE);
    expect(resolveShopLocale(undefined)).toBe(DEFAULT_SHOP_LOCALE);
  });

  it('when Pakistan is stored', () => {
    expect(resolveShopLocale(DEFAULT_STORED_SHOP_LOCALE)).toBe(DEFAULT_SHOP_LOCALE);
    expect(resolveShopLocale({ v: 1, country: 'PK', timeZone: 'Asia/Karachi' })).toBe(DEFAULT_SHOP_LOCALE);
  });

  it('when what is stored cannot be read — never a half-foreign till', () => {
    for (const odd of [
      'US',
      42,
      [],
      { country: 'US' },
      { country: 'US', timeZone: 'Europe/London' },
      { country: 'US', timeZone: 'Asia/Karachi' },
      { country: 'GB', timeZone: 'Europe/London' },
      { country: 'us', timeZone: 'America/New_York' },
    ]) {
      expect(resolveShopLocale(odd), JSON.stringify(odd)).toBe(DEFAULT_SHOP_LOCALE);
    }
  });
});

describe('a US till resolves to the US preset in its own zone', () => {
  it('is the preset itself in the preset zone', () => {
    expect(resolveShopLocale({ v: 1, country: 'US', timeZone: 'America/New_York' })).toBe(US_SHOP_LOCALE);
  });

  it('keeps everything but the zone in any other US zone', () => {
    for (const zone of US_TIME_ZONES) {
      const l = resolveShopLocale({ v: 1, country: 'US', timeZone: zone });
      expect(l.timeZone).toBe(zone);
      expect({ ...l, timeZone: US_SHOP_LOCALE.timeZone }).toEqual({ ...US_SHOP_LOCALE });
      expect(Object.isFrozen(l)).toBe(true);
    }
  });

  it('offers only zones Intl knows', () => {
    for (const zone of US_TIME_ZONES) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    }
  });
});
