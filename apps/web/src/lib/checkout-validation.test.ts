import { describe, expect, it } from 'vitest';
import { problemFromServer, validateCheckout, type CheckoutInput } from './checkout-validation';

const OK: CheckoutInput = {
  fulfilment: 'delivery',
  hasZone: true,
  name: 'Ahmed Khan',
  phone: '0300 1234567',
  address: 'House 12, Street 4',
  cartSize: 2,
  pickupOnlyInCart: [],
  canPickup: false,
};

describe('validateCheckout', () => {
  it('passes a complete delivery and a complete pick-up', () => {
    expect(validateCheckout(OK)).toBeNull();
    expect(validateCheckout({ ...OK, fulfilment: 'pickup', hasZone: false, address: '' })).toBeNull();
  });

  it('sends the customer to the first thing to fix, top to bottom', () => {
    expect(validateCheckout({ ...OK, cartSize: 0, name: '' })?.field).toBe('cart');
    expect(validateCheckout({ ...OK, hasZone: false, name: '' })?.field).toBe('zone');
    expect(validateCheckout({ ...OK, name: ' A ', phone: '' })?.field).toBe('name');
    expect(validateCheckout({ ...OK, phone: '   ' })).toEqual({ field: 'phone', message: 'Please enter your mobile number.' });
    expect(validateCheckout({ ...OK, address: 'H1' })?.field).toBe('address');
  });

  it('checks the phone the way the server will read it', () => {
    expect(validateCheckout({ ...OK, phone: '12345' })?.message).toMatch(/Pakistani mobile number/);
    expect(validateCheckout({ ...OK, phone: '+92 300 1234567' })).toBeNull();
    expect(validateCheckout({ ...OK, phone: '3001234567' })).toBeNull();
  });

  it('refuses pick-up-only food on a delivery, and says how to fix it', () => {
    const p = validateCheckout({ ...OK, pickupOnlyInCart: ['Signature Loaded Fries'], canPickup: true });
    expect(p).toEqual({
      field: 'cart',
      message: 'Signature Loaded Fries is pick-up only — switch to pick-up, or remove it to order delivery.',
    });
    expect(validateCheckout({ ...OK, pickupOnlyInCart: ['A', 'B'] })?.message).toBe(
      'A, B are pick-up only — remove them to order delivery.',
    );
    expect(validateCheckout({ ...OK, fulfilment: 'pickup', pickupOnlyInCart: ['A'] })).toBeNull();
  });
});

describe('problemFromServer', () => {
  it('points a field error at its field', () => {
    expect(problemFromServer({ error: 'validation', details: { customerPhone: ['Enter a valid Pakistani mobile number'] } })).toEqual({
      field: 'phone',
      message: 'Enter a valid Pakistani mobile number',
    });
    expect(problemFromServer({ error: 'validation', details: { zoneId: ['Choose your delivery area'] } }).field).toBe('zone');
  });

  it('prefers the server’s own words, with the area field for an outside-zone refusal', () => {
    expect(problemFromServer({ error: 'outside_zone', message: 'We deliver in DHA and Clifton only.' })).toEqual({
      field: 'zone',
      message: 'We deliver in DHA and Clifton only.',
    });
    expect(problemFromServer({ error: 'store_closed', message: 'Closed.' })).toEqual({ field: null, message: 'Closed.' });
  });

  it('has a plain message for the codes that come without one', () => {
    expect(problemFromServer({ error: 'item_not_on_menu' }).message).toMatch(/menu was just updated/);
    expect(problemFromServer({ error: 'internal' }).message).toMatch(/Could not place the order/);
    expect(problemFromServer(null).message).toMatch(/Could not place the order/);
  });
});
