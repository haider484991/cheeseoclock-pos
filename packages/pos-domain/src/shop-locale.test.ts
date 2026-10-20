/**
 * The shop locale's default has one job: BE today. These tests tie it to the
 * constants the till actually uses, so the default cannot drift away from the
 * pilot by someone editing one side and not the other.
 *
 * The oracle tests prove the formatting functions still agree with v0.7.51.
 * These prove the SETTING those functions will read describes that same till.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHOP_LOCALE,
  US_SHOP_LOCALE,
  SHOP_LOCALE_PRESETS,
  SHOP_LOCALE_KEY,
  CASH_NOTE_FACE_CENTS,
  type PaymentMethod,
} from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

describe('the Pakistani default is the till as it stands', () => {
  it('counts the drawer with the owner own note rows', () => {
    // shift.ts CASH_NOTE_FACE_CENTS is the list the owner gave on 2 Oct 2026.
    // If that list ever changes, this default must change with it.
    expect(DEFAULT_SHOP_LOCALE.cashFacesCents).toEqual([...CASH_NOTE_FACE_CENTS]);
  });

  it('formats money through the same Intl tag formatCents uses', () => {
    // Not a copy of the expected text: this rebuilds it from the locale's own
    // tag, so the setting and the function cannot disagree about 'en-PK'.
    for (const cents of [400000, 64110, 0, 999999, 100]) {
      const whole = cents % 100 === 0;
      const expected = new Intl.NumberFormat(DEFAULT_SHOP_LOCALE.numberLocale, {
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(cents / 100);
      expect(formatCents(cents)).toBe(
        `${DEFAULT_SHOP_LOCALE.symbol}${DEFAULT_SHOP_LOCALE.symbolSeparator}${expected}`,
      );
      expect(formatCents(cents, { showSymbol: false })).toBe(expected);
    }
  });

  it('takes the five ways this shop is actually paid, and not the platform one', () => {
    expect([...DEFAULT_SHOP_LOCALE.tenders]).toEqual([
      'cash',
      'card',
      'easypaisa',
      'jazzcash',
      'bank_transfer',
    ] satisfies PaymentMethod[]);
    // foodpanda is settled by the platform and is never drawer money, so it
    // is not a tender a cashier can pick.
    expect(DEFAULT_SHOP_LOCALE.tenders).not.toContain('foodpanda');
  });

  it('keeps the clock and the paper the pilot already has', () => {
    expect(DEFAULT_SHOP_LOCALE.timeZone).toBe('Asia/Karachi');
    expect(DEFAULT_SHOP_LOCALE.tradingDayStartHour).toBe(5);
    expect(DEFAULT_SHOP_LOCALE.dateOrder).toBe('dmy');
    expect(DEFAULT_SHOP_LOCALE.receiptTitle).toBe('RECEIPT');
    expect(DEFAULT_SHOP_LOCALE.taxMode).toBe('exclusive');
    expect(DEFAULT_SHOP_LOCALE.paperSymbol).toBe('Rs');
    // ASCII only: the thermal printer prints anything else as '?'.
    expect(/^[\x20-\x7e]+$/.test(DEFAULT_SHOP_LOCALE.paperSymbol)).toBe(true);
  });

  it('cannot be edited at run time', () => {
    expect(Object.isFrozen(DEFAULT_SHOP_LOCALE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SHOP_LOCALE.cashFacesCents)).toBe(true);
  });
});

describe('the US preset', () => {
  it('adds tax on top, which is why the US goes first', () => {
    // The whole case for the US before the UK: no tax-included pricing, so
    // the order totals and the discount base do not have to be rewritten.
    expect(US_SHOP_LOCALE.taxMode).toBe('exclusive');
    expect(US_SHOP_LOCALE.taxMode).toBe(DEFAULT_SHOP_LOCALE.taxMode);
  });

  it('reads and prints as a US shop would expect', () => {
    expect(US_SHOP_LOCALE.currency).toBe('USD');
    expect(US_SHOP_LOCALE.symbol).toBe('$');
    expect(US_SHOP_LOCALE.dateOrder).toBe('mdy');
    expect(US_SHOP_LOCALE.taxLabel).toBe('Sales tax');
    expect(US_SHOP_LOCALE.phoneCountry).toBe('US');
    expect(/^[\x20-\x7e]+$/.test(US_SHOP_LOCALE.paperSymbol)).toBe(true);
  });

  it('offers no Pakistani wallet as a tender', () => {
    expect(US_SHOP_LOCALE.tenders).not.toContain('easypaisa');
    expect(US_SHOP_LOCALE.tenders).not.toContain('jazzcash');
  });

  it('counts a drawer in US notes, largest first', () => {
    const faces = [...US_SHOP_LOCALE.cashFacesCents];
    expect(faces).toEqual([...faces].sort((a, b) => b - a));
    expect(faces[0]).toBe(10_000);
    expect(faces.at(-1)).toBe(100);
  });
});

describe('every preset holds to the v1 limits', () => {
  it('is a two-decimal currency, since ~205 lines assume it', () => {
    for (const [name, locale] of Object.entries(SHOP_LOCALE_PRESETS)) {
      expect(locale.minorUnits, name).toBe(2);
    }
  });

  it('gives whole-hour trading days and a real IANA zone', () => {
    for (const [name, locale] of Object.entries(SHOP_LOCALE_PRESETS)) {
      expect(Number.isInteger(locale.tradingDayStartHour), name).toBe(true);
      expect(locale.tradingDayStartHour, name).toBeGreaterThanOrEqual(0);
      expect(locale.tradingDayStartHour, name).toBeLessThan(24);
      // Throws on a zone Intl does not know, which is the point.
      expect(() => new Intl.DateTimeFormat('en', { timeZone: locale.timeZone }), name).not.toThrow();
    }
  });

  it('names a currency and country Intl recognises', () => {
    for (const [name, locale] of Object.entries(SHOP_LOCALE_PRESETS)) {
      expect(locale.country, name).toMatch(/^[A-Z]{2}$/);
      expect(locale.currency, name).toMatch(/^[A-Z]{3}$/);
      expect(() => new Intl.NumberFormat(locale.numberLocale), name).not.toThrow();
    }
  });

  it('is stored under the settings key the repo will write', () => {
    expect(SHOP_LOCALE_KEY).toBe('shop.locale');
  });
});
