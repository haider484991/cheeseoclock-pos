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

describe('the owner’s delivery areas', () => {
  it('names the areas the owner delivers to, and says when delivery is paused everywhere', () => {
    expect(validateCheckout({ ...OK, hasZone: false, deliveryAreas: 'DHA, Clifton and PECHS' })?.message).toBe(
      'Choose your delivery area — we deliver in DHA, Clifton and PECHS only.',
    );
    expect(validateCheckout({ ...OK, hasZone: false, deliveryAreas: '', canPickup: true })).toEqual({
      field: 'zone',
      message: 'Delivery is paused right now — choose pick-up, or order on WhatsApp.',
    });
  });

  it('points a switched-off area’s refusal at the area field', () => {
    expect(problemFromServer({ error: 'zone_paused', message: 'Delivery to Emaar Crescent Bay (DHA) is paused right now.' })).toEqual({
      field: 'zone',
      message: 'Delivery to Emaar Crescent Bay (DHA) is paused right now.',
    });
  });
});

describe('Buy 1 Get 1 deals at checkout (owner, 7 Oct 2026)', () => {
  const DEAL = { ...OK, buy1Get1InCart: true, buy1Get1Open: true, social: '@ahmed_k' };

  it('pass with the customer’s Instagram or Facebook name, inside the hours', () => {
    expect(validateCheckout(DEAL)).toBeNull();
    expect(validateCheckout({ ...DEAL, fulfilment: 'pickup', hasZone: false, address: '' })).toBeNull();
  });

  it('are refused outside 1–7 PM, at the cart', () => {
    expect(validateCheckout({ ...DEAL, buy1Get1Open: false })).toEqual({
      field: 'cart',
      message: 'Buy 1 Get 1 deals are sold from 1 PM to 7 PM. Remove the deal to order now.',
    });
  });

  it('follow the owner’s rules: their hours in the words, switched off, the name made optional', () => {
    const late = { on: true, opensMinute: 22 * 60, closesMinute: 60, asksSocial: true };
    expect(validateCheckout({ ...DEAL, buy1Get1Open: false, buy1Get1Rules: late })).toEqual({
      field: 'cart',
      message: 'Buy 1 Get 1 deals are sold from 10 PM to 1 AM. Remove the deal to order now.',
    });
    expect(validateCheckout({ ...DEAL, buy1Get1Open: false, buy1Get1Rules: { ...late, on: false } })).toEqual({
      field: 'cart',
      message: 'Buy 1 Get 1 deals are not on at the moment. Remove the deal to order now.',
    });
    // The name optional: a deal goes without it; with it, as before.
    const optional = { ...late, asksSocial: false };
    expect(validateCheckout({ ...DEAL, social: '', buy1Get1Rules: optional })).toBeNull();
    expect(validateCheckout({ ...DEAL, buy1Get1Rules: optional })).toBeNull();
    expect(validateCheckout({ ...DEAL, social: '', buy1Get1Rules: late })?.field).toBe('social');
  });

  it('need the Instagram or Facebook name — after the other details — and only with a deal in the cart', () => {
    expect(validateCheckout({ ...DEAL, social: '' })).toEqual({
      field: 'social',
      message: 'Add your Instagram or Facebook name to get the Buy 1 Get 1 deal: post your meal, tag us and show us the post.',
    });
    expect(validateCheckout({ ...DEAL, social: ' @ ' })?.field).toBe('social');
    expect(validateCheckout({ ...DEAL, social: '', name: '' })?.field).toBe('name');
    expect(validateCheckout({ ...OK, social: '' })).toBeNull();
    expect(validateCheckout({ ...OK, buy1Get1InCart: false, buy1Get1Open: false })).toBeNull();
  });

  it('the server’s refusals point at the cart and at the name field', () => {
    expect(problemFromServer({ error: 'buy1get1_closed', message: 'Closed now.' })).toEqual({ field: 'cart', message: 'Closed now.' });
    expect(problemFromServer({ error: 'buy1get1_social', message: 'Add your name.' })).toEqual({ field: 'social', message: 'Add your name.' });
  });
});
