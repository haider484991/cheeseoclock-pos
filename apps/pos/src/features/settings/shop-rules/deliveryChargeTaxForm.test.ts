import { describe, expect, it } from 'vitest';
import type { DeliveryChargeTaxCategory, DeliveryChargeTaxView } from '@cheeseoclock/shared-types';
import {
  bpsOfPercent,
  chargeTaxExampleWords,
  chargeTaxFromForm,
  chargeTaxNowWords,
  chargeTaxSaveNote,
  chargeTaxSavedToast,
  chargeTaxToForm,
  foodOptionWords,
  ratesWords,
} from './deliveryChargeTaxForm';

// Made-up taxes and charges, as a till would hold them.
const GST: DeliveryChargeTaxCategory = { id: 'tax-gst', name: 'Test GST', rateBps: 1_500, digitalRateBps: 800 };
const ZERO: DeliveryChargeTaxCategory = { id: 'tax-own', name: 'Delivery charge tax', rateBps: 0, digitalRateBps: null };
const charge = (feeCents: number, tax: DeliveryChargeTaxCategory, isActive = true) => ({
  itemId: `item-${feeCents}`,
  name: `Delivery Charge (Rs ${feeCents / 100})`,
  feeCents,
  isActive,
  tax,
});
const view = (over: Partial<DeliveryChargeTaxView> = {}): DeliveryChargeTaxView => ({
  now: { kind: 'food' },
  charges: [charge(20_000, GST), charge(25_000, GST)],
  food: GST,
  website: 'itself',
  ...over,
});

describe('the form ↔ the choice', () => {
  it('starts on what the charges carry now; a rate shows its two boxes; different taxes: nothing picked', () => {
    expect(chargeTaxToForm({ kind: 'food' })).toEqual({ kind: 'food', rate: '', card: '' });
    expect(chargeTaxToForm({ kind: 'none' })).toEqual({ kind: 'none', rate: '', card: '' });
    expect(chargeTaxToForm({ kind: 'rate', rateBps: 750, digitalRateBps: null })).toEqual({ kind: 'rate', rate: '7.5', card: '' });
    expect(chargeTaxToForm({ kind: 'rate', rateBps: 1_625, digitalRateBps: 500 })).toEqual({ kind: 'rate', rate: '16.25', card: '5' });
    expect(chargeTaxToForm(null)).toEqual({ kind: null, rate: '', card: '' });
  });

  it('a percent box: whole or two decimals, 0 to 100, a % sign allowed', () => {
    expect(bpsOfPercent('15')).toBe(1_500);
    expect(bpsOfPercent(' 7.5% ')).toBe(750);
    expect(bpsOfPercent('16.25')).toBe(1_625);
    expect(bpsOfPercent('0')).toBe(0);
    expect(bpsOfPercent('100')).toBe(10_000);
    for (const bad of ['', '101', '-5', '7.555', 'abc', '15..', '.5']) expect(bpsOfPercent(bad)).toBeNull();
  });

  it('a rate of its own: its rate, and the card box (empty or the same = none)', () => {
    expect(chargeTaxFromForm({ kind: 'rate', rate: '5', card: '' })).toEqual({
      value: { kind: 'rate', rateBps: 500, digitalRateBps: null },
      problem: null,
    });
    expect(chargeTaxFromForm({ kind: 'rate', rate: '15', card: '8' })).toEqual({
      value: { kind: 'rate', rateBps: 1_500, digitalRateBps: 800 },
      problem: null,
    });
    expect(chargeTaxFromForm({ kind: 'rate', rate: '15', card: '15' }).value).toEqual({ kind: 'rate', rateBps: 1_500, digitalRateBps: null });
    expect(chargeTaxFromForm({ kind: 'food', rate: '9', card: '' })).toEqual({ value: { kind: 'food' }, problem: null });
    expect(chargeTaxFromForm({ kind: 'none', rate: '', card: '' })).toEqual({ value: { kind: 'none' }, problem: null });
  });

  it('says what is wrong before Save', () => {
    expect(chargeTaxFromForm({ kind: null, rate: '', card: '' }).problem).toBe('Pick how the delivery charge is taxed.');
    expect(chargeTaxFromForm({ kind: 'rate', rate: '', card: '' }).problem).toBe('Type the tax on the delivery charge: 0 to 100%.');
    expect(chargeTaxFromForm({ kind: 'rate', rate: '150', card: '' }).problem).toBe('Type the tax on the delivery charge: 0 to 100%.');
    expect(chargeTaxFromForm({ kind: 'rate', rate: '5', card: 'x' }).problem).toBe(
      'Type the tax when paid by card (0 to 100%), or leave that box empty.',
    );
  });
});

describe('the words', () => {
  it('rates: "15% (8% by card)", "5%", "no tax"', () => {
    expect(ratesWords(GST)).toBe('15% (8% by card)');
    expect(ratesWords({ rateBps: 500, digitalRateBps: null })).toBe('5%');
    expect(ratesWords({ rateBps: 0, digitalRateBps: null })).toBe('no tax');
    expect(ratesWords({ rateBps: 0, digitalRateBps: 500 })).toBe('0% (5% by card)');
    expect(foodOptionWords(GST)).toBe('The same as the food — Test GST, 15% (8% by card)');
    expect(foodOptionWords(null)).toBe('The same as the food');
  });

  it('now: the food’s, none, its own rate — or each fee’s when they differ, or no charge yet', () => {
    expect(chargeTaxNowWords(view())).toBe('Now: 15% (8% by card), the same as the food (Test GST).');
    expect(chargeTaxNowWords(view({ now: { kind: 'none' }, charges: [charge(20_000, ZERO)] }))).toBe('Now: no tax on the delivery charge.');
    expect(chargeTaxNowWords(view({ now: { kind: 'rate', rateBps: 500, digitalRateBps: null } }))).toBe('Now: 5%, a rate of its own.');
    expect(
      chargeTaxNowWords(view({ now: null, charges: [charge(20_000, GST), charge(25_000, ZERO), charge(15_000, ZERO, false)] })),
    ).toBe('Now the delivery charges are taxed differently: Rs 200 at 15% (8% by card), Rs 250 at no tax. Save puts every one on the tax you pick.');
    expect(chargeTaxNowWords(view({ now: null, charges: [] }))).toBe(
      'No delivery charge yet: set a fee for an area below, then choose its tax here.',
    );
  });

  it('the example: the lowest fee that is on, in cash and by card', () => {
    expect(chargeTaxExampleWords(view(), { kind: 'food' })).toBe(
      'Rs 200 delivery charge + 15% tax (Rs 30) = Rs 230 on the bill. Paid by card: 8% tax (Rs 16) = Rs 216.',
    );
    expect(chargeTaxExampleWords(view(), { kind: 'none' })).toBe('Rs 200 delivery charge, no tax: Rs 200 on the bill.');
    expect(chargeTaxExampleWords(view(), { kind: 'rate', rateBps: 750, digitalRateBps: null })).toBe(
      'Rs 200 delivery charge + 7.5% tax (Rs 15) = Rs 215 on the bill.',
    );
    expect(chargeTaxExampleWords(view(), { kind: 'rate', rateBps: 0, digitalRateBps: 500 })).toBe(
      'Rs 200 delivery charge, no tax in cash: Rs 200 on the bill. Paid by card: 5% tax (Rs 10) = Rs 210.',
    );
    // Nothing picked, no charge, or no food tax to copy: no example.
    expect(chargeTaxExampleWords(view(), null)).toBeNull();
    expect(chargeTaxExampleWords(view({ charges: [] }), { kind: 'none' })).toBeNull();
    expect(chargeTaxExampleWords(view({ food: null }), { kind: 'food' })).toBeNull();
  });

  it('the note and the toast say how the website gets it', () => {
    expect(chargeTaxSaveNote({ website: 'itself' })).toBe(
      'Orders already open keep the tax they have; the next delivery bills take this one. The website’s checkout gets it by itself when you save.',
    );
    expect(chargeTaxSaveNote({ website: 'publish' })).toContain('with the next menu Publish (Settings → Online orders)');
    const after = view({ now: { kind: 'none' }, charges: [charge(20_000, ZERO)] });
    expect(chargeTaxSavedToast({ changed: true, itemsChanged: 2, sentToWebsite: true, view: after })).toEqual({
      title: 'Delivery charge tax saved',
      description: 'Now: no tax on the delivery charge. The website gets it too.',
    });
    expect(chargeTaxSavedToast({ changed: true, itemsChanged: 2, sentToWebsite: false, view: { ...after, website: 'publish' } }).description).toBe(
      'Now: no tax on the delivery charge. The website gets it with the next menu Publish.',
    );
    expect(chargeTaxSavedToast({ changed: false, itemsChanged: 0, sentToWebsite: false, view: after })).toEqual({
      title: 'Saved',
      description: 'The delivery charges were already on that tax: nothing changed.',
    });
  });
});
