import { describe, expect, it } from 'vitest';
import { validateOrderForTender } from './order-validation.js';
import type { OrderValidationContext } from './order-validation.js';

const base: OrderValidationContext = {
  mode: 'takeaway',
  itemCount: 1,
  subtotalCents: 1000,
  tableId: null,
  customerName: null,
  customerPhone: null,
  deliveryAddress: null,
};

describe('validateOrderForTender', () => {
  it('always needs at least one item with a positive subtotal', () => {
    expect(validateOrderForTender({ ...base, itemCount: 0, subtotalCents: 0 }).missing).toContain(
      'Add at least one item',
    );
  });

  it('dine-in needs a table (legacy orders still validate)', () => {
    expect(validateOrderForTender({ ...base, mode: 'dine_in' }).ok).toBe(false);
    expect(validateOrderForTender({ ...base, mode: 'dine_in', tableId: 't1' }).ok).toBe(true);
  });

  it('takeaway needs a phone or a name', () => {
    expect(validateOrderForTender({ ...base, mode: 'takeaway' }).ok).toBe(false);
    expect(validateOrderForTender({ ...base, mode: 'takeaway', customerName: 'Ali' }).ok).toBe(
      true,
    );
  });

  it('delivery needs name, phone and address', () => {
    const r = validateOrderForTender({ ...base, mode: 'delivery' });
    expect(r.missing).toEqual([
      'Delivery needs a customer name',
      'Delivery needs a customer phone',
      'Delivery needs a delivery address',
    ]);
    expect(
      validateOrderForTender({
        ...base,
        mode: 'delivery',
        customerName: 'Ali',
        customerPhone: '0300',
        deliveryAddress: 'DHA',
      }).ok,
    ).toBe(true);
  });

  it('foodpanda only needs items — the platform owns the customer and rider', () => {
    // No name, phone, address or table, yet it is ready to send.
    expect(validateOrderForTender({ ...base, mode: 'foodpanda' }).ok).toBe(true);
    expect(
      validateOrderForTender({ ...base, mode: 'foodpanda', itemCount: 0, subtotalCents: 0 }).ok,
    ).toBe(false);
  });
});
