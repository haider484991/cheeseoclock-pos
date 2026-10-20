/**
 * The drawer screen and the drawer schema have to agree on the notes.
 *
 * The schema learned the shop's notes first (cashCountInputSchema reads the
 * locale), which on its own made things worse for a US till: the screen
 * still drew Pakistan's seven rows, and the schema would then refuse what
 * the screen sent. This file holds the two together — whatever the screen
 * builds, the schema accepts, for either country — and pins the Pakistani
 * screen to what Cheese O'Clock's cashiers see today.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cashCountInputSchema } from '@cheeseoclock/shared-schemas';
import { US_SHOP_LOCALE, setShopLocale, resetShopLocale } from '@cheeseoclock/shared-types';
import { noteCounterRows, noteCounterFirstRow } from './NoteCounter';
import {
  noteCounterInitial,
  noteCounterRowCount,
  noteCounterOtherRow,
  noteCounterSelect,
  noteCounterKey,
  noteCounterToCount,
  type NoteCounterState,
} from './noteCounterState';
import { quickCashRupees } from '../checkout/tenderAmounts';

afterEach(resetShopLocale);

/** Type `digits` into every row, the way a cashier would. */
function countEveryRow(digits: string): NoteCounterState {
  let s = noteCounterInitial();
  for (let row = 0; row < noteCounterRowCount(); row++) {
    s = noteCounterSelect(s, row);
    for (const d of digits) s = noteCounterKey(s, d);
  }
  return s;
}

describe('the Pakistani drawer is the one the cashiers know', () => {
  it('draws Rs 5,000 down to Rs 10, then coins and other', () => {
    const rows = noteCounterRows();
    expect(rows.map((r) => r.label)).toEqual([
      'Rs 5,000', 'Rs 1,000', 'Rs 500', 'Rs 100', 'Rs 50', 'Rs 20', 'Rs 10', 'Coins and other',
    ]);
    expect(rows.find((r) => r.label === 'Rs 10')?.sub).toBe('note or coin');
    expect(rows.at(-1)?.sub).toBe('Rs 5, 2, 1 coins, in rupees');
    expect(noteCounterFirstRow()).toBe('[data-note-row="5000"]');
  });

  it('sends a count the schema takes', () => {
    const r = cashCountInputSchema.safeParse(noteCounterToCount(countEveryRow('3')));
    expect(r.success).toBe(true);
  });
});

describe('a US drawer is drawn in dollars, and closes', () => {
  it('draws $100 down to $1, then coins and other in dollars', () => {
    setShopLocale(US_SHOP_LOCALE);
    const rows = noteCounterRows();
    expect(rows.map((r) => r.label)).toEqual(['$100', '$50', '$20', '$10', '$5', '$1', 'Coins and other']);
    expect(rows.find((r) => r.label === '$1')?.sub).toBe('note or coin');
    expect(rows.at(-1)?.sub).toBe('Quarters, dimes, nickels and pennies, in dollars');
    expect(noteCounterRowCount()).toBe(7);
    expect(noteCounterOtherRow()).toBe(6);
    expect(noteCounterFirstRow()).toBe('[data-note-row="100"]');
  });

  it('sends a count the schema takes — the shift can be closed', () => {
    setShopLocale(US_SHOP_LOCALE);
    const count = noteCounterToCount(countEveryRow('3'));
    expect(count.notes.map((n) => n.faceCents)).toEqual([...US_SHOP_LOCALE.cashFacesCents]);
    expect(count.otherCents).toBe(300);
    expect(cashCountInputSchema.safeParse(count).success).toBe(true);
  });
});

describe('quick cash offers the shop own notes', () => {
  it('offers dollars on a US bill', () => {
    setShopLocale(US_SHOP_LOCALE);
    // $27.35: the next $10, $20, $50 and $100 at or above it.
    expect(quickCashRupees(2_735)).toEqual([30, 40, 50, 100]);
  });

  it('never offers the bill itself, or less', () => {
    setShopLocale(US_SHOP_LOCALE);
    for (const cents of [100, 2_000, 4_999, 10_000, 12_345]) {
      for (const units of quickCashRupees(cents)) expect(units * 100).toBeGreaterThan(cents);
    }
  });
});
