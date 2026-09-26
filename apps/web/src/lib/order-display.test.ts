import { describe, expect, it } from 'vitest';
import type { WebOrderItem } from '@cheeseoclock/shared-types';
import {
  feeRangeText,
  orderItemChoices,
  orderMoney,
  savedLinesFromOrderItems,
  sheetOptionLabel,
  shortOrderNumber,
  splitDeliveryCharge,
  trackPath,
} from './order-display';

function placed(over: Partial<WebOrderItem> & { name: string }): WebOrderItem {
  return { posItemId: `id:${over.name}`, quantity: 1, unitPriceCents: 100_000, modifiers: [], notes: null, ...over };
}

describe('feeRangeText', () => {
  it('reads the zone fees as one range', () => {
    expect(feeRangeText([{ feeCents: 25_000 }, { feeCents: 20_000 }, { feeCents: 20_000 }])).toBe('Rs 200–250');
    expect(feeRangeText([{ feeCents: 20_000 }])).toBe('Rs 200');
    expect(feeRangeText([])).toBe('');
  });
});

describe('sheetOptionLabel', () => {
  it('drops the deal-slot prefix and the "Side of" every dip-on-the-side repeats', () => {
    expect(sheetOptionLabel('Large: Fajita Pizza')).toBe('Fajita Pizza');
    expect(sheetOptionLabel('Side of Garlic Mayo')).toBe('Garlic Mayo');
    expect(sheetOptionLabel('No onion')).toBe('No onion');
    expect(sheetOptionLabel('Extra cheese')).toBe('Extra cheese');
  });
});

describe('placed orders', () => {
  const items: WebOrderItem[] = [
    placed({
      name: 'Big Two',
      posItemId: 'big-two',
      modifiers: [
        { posModifierId: 'l1', name: 'Large: Fajita Pizza', priceDeltaCents: 0 },
        { posModifierId: 'l2', name: '2nd Large: Classic Supreme', priceDeltaCents: 0 },
        { posModifierId: 'no', name: 'No onion', priceDeltaCents: 0 },
      ],
      notes: 'well done',
      quantity: 2,
    }),
    placed({ name: 'Delivery Charge (Rs 250)', posItemId: 'del-250', unitPriceCents: 25_000 }),
  ];

  it('takes the delivery charge out of the food and into a fee', () => {
    const { food, deliveryCents } = splitDeliveryCharge(items);
    expect(food.map((i) => i.name)).toEqual(['Big Two']);
    expect(deliveryCents).toBe(25_000);
  });

  it('splits the stored subtotal into food and delivery, with or without a fee line', () => {
    // Fee rode as the till's item: 2 × Rs 1,000 + Rs 250.
    expect(orderMoney({ items, subtotalCents: 225_000, fulfilment: 'delivery' })).toMatchObject({
      itemsCents: 200_000,
      deliveryCents: 25_000,
    });
    // A till without delivery-charge items: the fee is in the subtotal, not in the lines.
    expect(orderMoney({ items: items.slice(0, 1), subtotalCents: 220_000, fulfilment: 'delivery' })).toMatchObject({
      itemsCents: 200_000,
      deliveryCents: 20_000,
    });
    // A pick-up has no fee, whatever the arithmetic says.
    expect(orderMoney({ items: items.slice(0, 1), subtotalCents: 200_000, fulfilment: 'pickup' })).toMatchObject({
      itemsCents: 200_000,
      deliveryCents: 0,
    });
  });

  it('reads the choices like the cart does', () => {
    expect(orderItemChoices(items[0]!)).toEqual({
      leaveOuts: ['No onion'],
      others: ['Fajita Pizza', 'Classic Supreme'],
    });
  });

  it('turns an order back into lines to order again, fee left out', () => {
    expect(savedLinesFromOrderItems(items)).toEqual([
      { posItemId: 'big-two', quantity: 2, modifierIds: ['l1', 'l2', 'no'], notes: 'well done' },
    ]);
  });
});

describe('trackPath / shortOrderNumber', () => {
  it('builds the tracking link with the phone encoded', () => {
    expect(trackPath('abc', '+923001234567', true)).toBe('/track/abc?phone=%2B923001234567&placed=1');
    expect(trackPath('abc')).toBe('/track/abc');
  });

  it('keeps the number the counter calls out', () => {
    expect(shortOrderNumber('WEB-0042')).toBe('0042');
    expect(shortOrderNumber('17')).toBe('17');
    expect(shortOrderNumber(null)).toBeNull();
  });
});
