import { describe, expect, it } from 'vitest';
import { DELIVERY_FEE_MAX_CENTS } from '@cheeseoclock/shared-types';
import { chargesOnBillWords, typedDeliveryChargeCents } from './delivery-charge.js';

describe('typedDeliveryChargeCents: the “Custom charge” box (owner, 10 Oct 2026)', () => {
  it('whole rupees, commas and an “Rs” allowed', () => {
    expect(typedDeliveryChargeCents('300')).toBe(30_000);
    expect(typedDeliveryChargeCents(' 1,200 ')).toBe(120_000);
    expect(typedDeliveryChargeCents('Rs 350')).toBe(35_000);
    expect(typedDeliveryChargeCents('rs.75')).toBe(7_500);
    expect(typedDeliveryChargeCents('1')).toBe(100);
  });

  it('nothing, Rs 0, paisa, words or more than an area may charge: not a charge', () => {
    for (const bad of ['', '0', '00', '250.50', '-300', 'three hundred', '3 00']) {
      expect({ bad, cents: typedDeliveryChargeCents(bad) }).toEqual({ bad, cents: null });
    }
    expect(typedDeliveryChargeCents(String(DELIVERY_FEE_MAX_CENTS / 100))).toBe(DELIVERY_FEE_MAX_CENTS);
    expect(typedDeliveryChargeCents(String(DELIVERY_FEE_MAX_CENTS / 100 + 1))).toBeNull();
  });
});

describe('chargesOnBillWords: what the bill carries, on the row', () => {
  it('none, one, or several (named, to check)', () => {
    expect(chargesOnBillWords([])).toBeNull();
    expect(chargesOnBillWords([{ id: 'a', unitPriceCents: 30_000, quantity: 1 }])).toBe('Rs 300 delivery charge is on the bill');
    expect(
      chargesOnBillWords([
        { id: 'a', unitPriceCents: 30_000, quantity: 1 },
        { id: 'b', unitPriceCents: 20_000, quantity: 1 },
      ]),
    ).toBe('2 delivery charges are on the bill (Rs 300, Rs 200) — check it');
    expect(chargesOnBillWords([{ id: 'a', unitPriceCents: 20_000, quantity: 2 }])).toBe(
      '2 delivery charges are on the bill (Rs 200) — check it',
    );
  });
});
