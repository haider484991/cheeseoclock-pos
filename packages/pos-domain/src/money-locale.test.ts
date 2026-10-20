/**
 * The other half of the locale work: that a US till actually reads as a US
 * till, and that switching one till's locale can never reach Pakistan's.
 *
 * The oracle tests prove the default did not move. These prove the setting
 * does something — a guard rail with nothing behind it is not worth its cost.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SHOP_LOCALE,
  US_SHOP_LOCALE,
  setShopLocale,
  getShopLocale,
  resetShopLocale,
} from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

afterEach(resetShopLocale);

describe('a US till formats as a US till', () => {
  it('writes dollars with no space, as the United States does', () => {
    expect(formatCents(400000, { locale: US_SHOP_LOCALE })).toBe('$4,000');
    expect(formatCents(64110, { locale: US_SHOP_LOCALE })).toBe('$641.10');
    expect(formatCents(0, { locale: US_SHOP_LOCALE })).toBe('$0');
  });

  it('keeps the two-minor-digit rule the till has always had', () => {
    // A part-dollar shows both cents digits, never "$641.1".
    expect(formatCents(64110, { locale: US_SHOP_LOCALE })).toBe('$641.10');
    expect(formatCents(100, { locale: US_SHOP_LOCALE })).toBe('$1');
    expect(formatCents(105, { locale: US_SHOP_LOCALE })).toBe('$1.05');
  });

  it('drops the symbol when asked, the same as Pakistan', () => {
    expect(formatCents(400000, { locale: US_SHOP_LOCALE, showSymbol: false })).toBe('4,000');
  });
});

describe('the process locale', () => {
  it('starts as Pakistan, so a till that never sets it is unchanged', () => {
    expect(getShopLocale()).toBe(DEFAULT_SHOP_LOCALE);
    expect(formatCents(400000)).toBe('Rs 4,000');
  });

  it('is used by every call once a till sets it', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(formatCents(400000)).toBe('$4,000');
  });

  it('is beaten by an explicit locale, so one shop can show another format', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(formatCents(400000, { locale: DEFAULT_SHOP_LOCALE })).toBe('Rs 4,000');
  });

  it('goes back to Pakistan on reset, so no test can leak into the next', () => {
    setShopLocale(US_SHOP_LOCALE);
    resetShopLocale();
    expect(formatCents(400000)).toBe('Rs 4,000');
  });
});

describe('Pakistan and the US stay different where it counts', () => {
  it('reads the same number differently, and that is the whole point', () => {
    const cents = 1_234_567;
    expect(formatCents(cents, { locale: DEFAULT_SHOP_LOCALE })).toBe('Rs 12,345.67');
    expect(formatCents(cents, { locale: US_SHOP_LOCALE })).toBe('$12,345.67');
  });

  it('adds tax on top in both, which is why the US needs no totals rewrite', () => {
    expect(US_SHOP_LOCALE.taxMode).toBe(DEFAULT_SHOP_LOCALE.taxMode);
  });
});
