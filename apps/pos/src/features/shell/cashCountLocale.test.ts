/**
 * Counting the drawer in the shop's own notes.
 *
 * This was more than wording. The write schema compared a saved count against
 * Pakistan's CASH_NOTE_FACE_CENTS, so a US drawer — $100 down to $1 — could
 * not be saved at all, whatever the screen offered. It now asks the shop's
 * locale, and the message naming the rows is built when the count is checked
 * rather than when the module is imported.
 *
 * The Pakistani half is an oracle: these are the words and the rows Cheese
 * O'Clock closes its shifts with today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cashCountInputSchema } from '@cheeseoclock/shared-schemas';
import {
  CASH_NOTE_FACE_CENTS,
  DEFAULT_SHOP_LOCALE,
  US_SHOP_LOCALE,
  setShopLocale,
  resetShopLocale,
} from '@cheeseoclock/shared-types';

afterEach(resetShopLocale);

const countOf = (faces: readonly number[]) => ({
  notes: faces.map((faceCents) => ({ faceCents, count: 1 })),
  otherCents: 0,
});

function refusal(value: unknown): string {
  const r = cashCountInputSchema.safeParse(value);
  if (r.success) throw new Error('that count was accepted, not refused');
  return r.error.issues[0]?.message ?? '';
}

describe('Pakistan closes its shift exactly as before', () => {
  it('takes the seven rows the owner asked for', () => {
    expect(cashCountInputSchema.safeParse(countOf(CASH_NOTE_FACE_CENTS)).success).toBe(true);
  });

  it('names the rows in the same words', () => {
    expect(refusal(countOf([500_000, 100_000]))).toBe(
      'The note rows are Rs 5,000, 1,000, 500, 100, 50, 20 and 10',
    );
  });

  it('refuses coins and other in the same words', () => {
    const bad = (otherCents: number) => refusal({ ...countOf(CASH_NOTE_FACE_CENTS), otherCents });
    expect(bad(150)).toBe('Coins and other is in whole rupees');
    expect(bad(-100)).toBe("Coins and other can't be below Rs 0");
    expect(bad(10_000_000)).toBe('Coins and other is at most Rs 99,999');
  });
});

describe('a US shop can actually count its drawer', () => {
  it('takes US notes, which the Pakistani rows would have refused', () => {
    setShopLocale(US_SHOP_LOCALE);
    const r = cashCountInputSchema.safeParse(countOf(US_SHOP_LOCALE.cashFacesCents));
    expect(r.success).toBe(true);
  });

  it('names the US rows, symbol on the first only', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(refusal(countOf([10_000]))).toBe('The note rows are $100, 50, 20, 10, 5 and 1');
  });

  it('refuses a Pakistani drawer on a US till, and the other way round', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(cashCountInputSchema.safeParse(countOf(DEFAULT_SHOP_LOCALE.cashFacesCents)).success).toBe(false);
    resetShopLocale();
    expect(cashCountInputSchema.safeParse(countOf(US_SHOP_LOCALE.cashFacesCents)).success).toBe(false);
  });

  it('counts coins and other in dollars', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(refusal({ ...countOf(US_SHOP_LOCALE.cashFacesCents), otherCents: 150 })).toBe(
      'Coins and other is in whole dollars',
    );
  });
});
