import { describe, expect, it } from 'vitest';
import type { DeliveryChargeTaxCategory } from '@cheeseoclock/shared-types';
import {
  deliveryChargeTaxExample,
  deliveryChargeTaxNow,
  deliveryChargeTaxRates,
  sameDeliveryChargeTax,
} from './delivery-charge-tax.js';

// Made-up taxes, as Menu → Tax would hold them.
const GST: DeliveryChargeTaxCategory = { id: 'tax-gst', name: 'Test GST', rateBps: 1_500, digitalRateBps: 800 };
const ZERO: DeliveryChargeTaxCategory = { id: 'tax-zero', name: 'Test zero', rateBps: 0, digitalRateBps: null };
const OWN: DeliveryChargeTaxCategory = { id: 'tax-own', name: 'Delivery charge tax', rateBps: 500, digitalRateBps: null };
const charge = (tax: DeliveryChargeTaxCategory, isActive = true) => ({ isActive, tax });

describe('deliveryChargeTaxNow: what the delivery charges are taxed now', () => {
  it('on the food’s tax: “the same as the food” (today’s till: both charges on the food’s 15%)', () => {
    expect(deliveryChargeTaxNow([charge(GST), charge(GST)], GST.id)).toEqual({ kind: 'food' });
  });

  it('on a tax charging nothing either way: “no tax”', () => {
    expect(deliveryChargeTaxNow([charge(ZERO), charge(ZERO)], GST.id)).toEqual({ kind: 'none' });
    // 0% in cash but 5% by card is a rate, not "no tax".
    const cardOnly = { ...ZERO, id: 'tax-card', digitalRateBps: 500 };
    expect(deliveryChargeTaxNow([charge(cardOnly)], GST.id)).toEqual({ kind: 'rate', rateBps: 0, digitalRateBps: 500 });
  });

  it('on another tax: its own rate, with its card rate', () => {
    expect(deliveryChargeTaxNow([charge(OWN)], GST.id)).toEqual({ kind: 'rate', rateBps: 500, digitalRateBps: null });
    // A second 15% category is still a rate of its own (not the food's tax).
    const twin = { ...GST, id: 'tax-twin' };
    expect(deliveryChargeTaxNow([charge(twin)], GST.id)).toEqual({ kind: 'rate', rateBps: 1_500, digitalRateBps: 800 });
  });

  it('the charges that are on decide; a switched-off old fee on another tax does not', () => {
    expect(deliveryChargeTaxNow([charge(GST), charge(ZERO, false)], GST.id)).toEqual({ kind: 'food' });
    // None on: all of them decide.
    expect(deliveryChargeTaxNow([charge(ZERO, false), charge(ZERO, false)], GST.id)).toEqual({ kind: 'none' });
  });

  it('charges on different taxes, or no charge at all: null (the owner picks)', () => {
    expect(deliveryChargeTaxNow([charge(GST), charge(ZERO)], GST.id)).toBeNull();
    expect(deliveryChargeTaxNow([], GST.id)).toBeNull();
  });

  it('a menu with no food tax: never “the same as the food”', () => {
    expect(deliveryChargeTaxNow([charge(GST)], null)).toEqual({ kind: 'rate', rateBps: 1_500, digitalRateBps: 800 });
  });
});

describe('deliveryChargeTaxRates / sameDeliveryChargeTax', () => {
  it('the food’s rates for “the same as the food”, nothing for “no tax”, its own for a rate', () => {
    expect(deliveryChargeTaxRates({ kind: 'food' }, GST)).toEqual({ rateBps: 1_500, digitalRateBps: 800 });
    expect(deliveryChargeTaxRates({ kind: 'food' }, null)).toBeNull();
    expect(deliveryChargeTaxRates({ kind: 'none' }, GST)).toEqual({ rateBps: 0, digitalRateBps: null });
    expect(deliveryChargeTaxRates({ kind: 'rate', rateBps: 500, digitalRateBps: 300 }, GST)).toEqual({ rateBps: 500, digitalRateBps: 300 });
  });

  it('a card rate equal to the rate is the same as none', () => {
    expect(sameDeliveryChargeTax({ kind: 'rate', rateBps: 500, digitalRateBps: 500 }, { kind: 'rate', rateBps: 500, digitalRateBps: null })).toBe(true);
    expect(sameDeliveryChargeTax({ kind: 'rate', rateBps: 500, digitalRateBps: 300 }, { kind: 'rate', rateBps: 500, digitalRateBps: null })).toBe(false);
    expect(sameDeliveryChargeTax({ kind: 'food' }, { kind: 'food' })).toBe(true);
    expect(sameDeliveryChargeTax({ kind: 'food' }, { kind: 'none' })).toBe(false);
    expect(sameDeliveryChargeTax(null, null)).toBe(true);
    expect(sameDeliveryChargeTax(null, { kind: 'none' })).toBe(false);
  });
});

describe('deliveryChargeTaxExample: the card’s worked example', () => {
  it('Rs 200 at 15% (8% by card): Rs 30 tax, Rs 230; by card Rs 16, Rs 216', () => {
    expect(deliveryChargeTaxExample(20_000, { rateBps: 1_500, digitalRateBps: 800 })).toEqual({
      taxCents: 3_000,
      withTaxCents: 23_000,
      card: { rateBps: 800, taxCents: 1_600, withTaxCents: 21_600 },
    });
  });

  it('no card rate: no card line; no tax: the charge as it is', () => {
    expect(deliveryChargeTaxExample(25_000, { rateBps: 500, digitalRateBps: null })).toEqual({
      taxCents: 1_250,
      withTaxCents: 26_250,
      card: null,
    });
    expect(deliveryChargeTaxExample(20_000, { rateBps: 0, digitalRateBps: null })).toEqual({ taxCents: 0, withTaxCents: 20_000, card: null });
  });

  it('rounds per line like the till (Rs 250 at 7.5% = Rs 18.75; Rs 199 at 15% = Rs 29.85)', () => {
    expect(deliveryChargeTaxExample(25_000, { rateBps: 750, digitalRateBps: null }).taxCents).toBe(1_875);
    expect(deliveryChargeTaxExample(19_900, { rateBps: 1_500, digitalRateBps: null }).taxCents).toBe(2_985);
  });
});
