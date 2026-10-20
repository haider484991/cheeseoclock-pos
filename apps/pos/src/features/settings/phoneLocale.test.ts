/**
 * Phone numbers follow the shop's country (international edition, 1c).
 *
 * Pakistan's rule is untouched — the oracle in pos-domain holds it to
 * v0.7.51 over 100k inputs — so this file is about the US branch and about
 * the two places setup checks a number: the Website step's hint, and the
 * shop's phone line that the website dials.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { normalizePhone, setShopLocale, resetShopLocale, US_SHOP_LOCALE } from '@cheeseoclock/shared-types';
import { shopPhoneSchema } from '@cheeseoclock/shared-schemas';

afterEach(resetShopLocale);

const refusal = (v: unknown): string => {
  const r = shopPhoneSchema.safeParse(v);
  if (r.success) throw new Error(`${JSON.stringify(v)} was accepted`);
  return r.error.issues[0]?.message ?? '';
};

describe('a US till reads US numbers', () => {
  it('takes them however they are written', () => {
    setShopLocale(US_SHOP_LOCALE);
    for (const typed of ['(415) 555-0123', '415.555.0123', '415-555-0123', '4155550123', '1 415 555 0123', '+1 415 555 0123']) {
      expect(normalizePhone(typed), typed).toBe('+14155550123');
    }
  });

  it('refuses what is not a US number instead of rewriting it', () => {
    setShopLocale(US_SHOP_LOCALE);
    for (const typed of ['0300 1234567', '+92 300 1234567', '+44 7700 900123', '011 44 7700 900123', '123 456 7890', '415 155 0123', '555-0123', '', '  ']) {
      expect(normalizePhone(typed), typed).toBeNull();
    }
  });

  it('can still be asked about another country by name', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(normalizePhone('0300 1234567', 'PK')).toBe('+923001234567');
  });
});

describe("the shop's phone line", () => {
  it('reads as it always did in Pakistan', () => {
    expect(shopPhoneSchema.safeParse({ display: '0300 9367865', e164: '+923009367865' }).success).toBe(true);
    expect(refusal({ display: '0300 9367865', e164: '+92300936786' })).toBe(
      'A phone number is a Pakistani number (+92 and ten digits)',
    );
    expect(refusal({ display: '0300 9367865', e164: '+923001112233' })).toBe(
      '0300 9367865 is not a Pakistani phone number the website can call',
    );
  });

  it('takes a US shop its own number, in its own words', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(shopPhoneSchema.safeParse({ display: '(415) 555-0123', e164: '+14155550123' }).success).toBe(true);
    expect(refusal({ display: '0300 9367865', e164: '+923009367865' })).toBe(
      'A phone number is a US number (+1 and ten digits)',
    );
  });
});
