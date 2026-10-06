import { describe, expect, it } from 'vitest';
import { digitalCentsOf, isDigitalPayment, splitTender } from './split-tender.js';

// A Rs 1,000 bill before tax: Rs 1,150 in cash (15%), Rs 1,080 by card (8%).
const quote = { totalCents: 115_000, digitalTotalCents: 108_000, netCents: 100_000 };

describe('splitTender: the card amount buys that share of the bill at card prices', () => {
  it('all cash: the stored total to the paisa, nothing at the card rate', () => {
    expect(splitTender(quote, 0)).toEqual({
      ok: true,
      cashDueCents: 115_000,
      totalCents: 115_000,
      taxCents: 15_000,
      digitalNetCents: 0,
      digitalTaxCents: 0,
    });
  });

  it('all card: the card total, every rupee before tax at the card rate', () => {
    expect(splitTender(quote, 108_000)).toEqual({
      ok: true,
      cashDueCents: 0,
      totalCents: 108_000,
      taxCents: 8_000,
      digitalNetCents: 100_000,
      digitalTaxCents: 8_000,
    });
  });

  it('half on the card: half the bill at 8%, the other half in cash at 15%', () => {
    expect(splitTender(quote, 54_000)).toEqual({
      ok: true,
      cashDueCents: 57_500,
      totalCents: 111_500,
      taxCents: 11_500,
      digitalNetCents: 50_000,
      digitalTaxCents: 4_000,
    });
  });

  it('any split: the parts add up to what was paid, and the tax is the total less the bill before tax', () => {
    for (const card of [1, 999, 12_345, 50_001, 99_999, 107_999]) {
      const s = splitTender(quote, card);
      expect(s.ok).toBe(true);
      if (!s.ok) continue;
      expect(s.totalCents).toBe(card + s.cashDueCents);
      expect(s.taxCents).toBe(s.totalCents - quote.netCents);
      expect(s.digitalNetCents + s.digitalTaxCents).toBe(card);
      expect(s.cashDueCents).toBeGreaterThanOrEqual(0);
      // Never dearer than cash, never cheaper than card.
      expect(s.totalCents).toBeLessThanOrEqual(quote.totalCents);
      expect(s.totalCents).toBeGreaterThanOrEqual(quote.digitalTotalCents);
    }
  });

  it('no card rate on the order: the stored total however it is paid, and nothing counted at the card rate', () => {
    const plain = { totalCents: 115_000, digitalTotalCents: null, netCents: 100_000 };
    expect(splitTender(plain, 0)).toMatchObject({ ok: true, cashDueCents: 115_000, totalCents: 115_000, taxCents: 15_000, digitalNetCents: 0, digitalTaxCents: 0 });
    expect(splitTender(plain, 40_000)).toMatchObject({ ok: true, cashDueCents: 75_000, totalCents: 115_000, taxCents: 15_000, digitalNetCents: 0, digitalTaxCents: 0 });
    expect(splitTender(plain, 115_000)).toMatchObject({ ok: true, cashDueCents: 0, totalCents: 115_000, digitalNetCents: 0, digitalTaxCents: 0 });
  });

  it('refuses more on the card than the bill by card, in rupees, and anything that is not whole paisa', () => {
    expect(splitTender(quote, 108_001)).toEqual({ ok: false, reason: 'Rs 1,080.01 on the card is more than the bill by card (Rs 1,080)' });
    expect(splitTender({ ...quote, digitalTotalCents: null }, 115_001)).toEqual({ ok: false, reason: 'Rs 1,150.01 on the card is more than the bill (Rs 1,150)' });
    expect(splitTender(quote, -1).ok).toBe(false);
    expect(splitTender(quote, 10.5).ok).toBe(false);
  });

  it('a Rs 0 bill (a free order): nothing on a card, nothing due', () => {
    const free = { totalCents: 0, digitalTotalCents: 0, netCents: 0 };
    expect(splitTender(free, 0)).toEqual({ ok: true, cashDueCents: 0, totalCents: 0, taxCents: 0, digitalNetCents: 0, digitalTaxCents: 0 });
    expect(splitTender(free, 1).ok).toBe(false);
  });

  it('zero-rated lines only: the card total equals the cash total and the split changes nothing', () => {
    const zero = { totalCents: 50_000, digitalTotalCents: 50_000, netCents: 50_000 };
    expect(splitTender(zero, 20_000)).toEqual({ ok: true, cashDueCents: 30_000, totalCents: 50_000, taxCents: 0, digitalNetCents: 20_000, digitalTaxCents: 0 });
  });
});

describe('the card / wallet / bank legs', () => {
  it('card, EasyPaisa, JazzCash and a bank transfer are paid at the card rate; cash and foodpanda are not', () => {
    expect(['card', 'easypaisa', 'jazzcash', 'bank_transfer'].every(isDigitalPayment)).toBe(true);
    expect(isDigitalPayment('cash')).toBe(false);
    expect(isDigitalPayment('foodpanda')).toBe(false);
  });

  it('adds up the card-rate legs of a sale', () => {
    expect(
      digitalCentsOf([
        { method: 'cash', amountCents: 57_500 },
        { method: 'card', amountCents: 50_000 },
        { method: 'jazzcash', amountCents: 4_000 },
      ]),
    ).toBe(54_000);
    expect(digitalCentsOf([])).toBe(0);
  });
});
