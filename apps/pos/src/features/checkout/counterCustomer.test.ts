import { describe, expect, it } from 'vitest';
import { counterPhoneLookup } from '@cheeseoclock/pos-domain';
import { counterPhoneHint, savedAddressToMakeUsual, typedAddressToSave, type AddressFields } from './counterCustomer';

const form = (over: Partial<AddressFields> = {}): AddressFields => ({
  addressLabel: 'Order',
  addressLine: 'House 41-C, Lane 3',
  area: 'DHA Phase 6',
  city: 'Karachi',
  matchedAddressId: null,
  saveAddressToCustomer: true,
  makeDefault: false,
  ...over,
});

describe('counterPhoneHint', () => {
  it('asks for the whole number while it is being typed', () => {
    expect(counterPhoneHint(counterPhoneLookup('0300 12'), false, false)).toMatch(/whole number/);
  });

  it('says "Looking…" while the lookup runs, and "No match" only once it came back empty', () => {
    const whole = counterPhoneLookup('03001234567');
    expect(counterPhoneHint(whole, true, false)).toBe('Looking…');
    expect(counterPhoneHint(whole, false, false)).toMatch(/^No match/);
    expect(counterPhoneHint(whole, false, true)).toBeNull();
  });

  it('a number the till cannot look up is saved as typed', () => {
    expect(counterPhoneHint(counterPhoneLookup('+44 7700 900123'), false, false)).toMatch(/as typed/);
  });

  it('nothing typed: nothing to say', () => {
    expect(counterPhoneHint(counterPhoneLookup(''), false, false)).toBeNull();
  });
});

describe('typedAddressToSave', () => {
  it('kept (the box as it starts): saved on the customer, but not made their usual one', () => {
    expect(typedAddressToSave(form(), 'delivery', 'Karachi')).toEqual({
      label: 'Order',
      addressLine: 'House 41-C, Lane 3',
      area: 'DHA Phase 6',
      city: 'Karachi',
      isDefault: false,
    });
  });

  it('"use it next time" ticked as well: the one filled in next time (a regular who moved)', () => {
    expect(typedAddressToSave(form({ makeDefault: true }), 'delivery', 'Karachi')).toMatchObject({
      label: 'Order',
      isDefault: true,
    });
  });

  it('unticked: saved as a one-off, never the usual one — even with "use it next time" left ticked', () => {
    for (const makeDefault of [false, true]) {
      expect(typedAddressToSave(form({ saveAddressToCustomer: false, makeDefault }), 'delivery', 'Karachi')).toMatchObject({
        label: 'One-off',
        isDefault: false,
      });
    }
  });

  it('nothing to save: not a delivery, nothing typed, or a saved address picked', () => {
    expect(typedAddressToSave(form(), 'takeaway', 'Karachi')).toBeNull();
    expect(typedAddressToSave(form({ addressLine: '   ' }), 'delivery', 'Karachi')).toBeNull();
    expect(typedAddressToSave(form({ matchedAddressId: 'a1' }), 'delivery', 'Karachi')).toBeNull();
  });

  it('an empty area is no area; an empty city is the shop city', () => {
    expect(typedAddressToSave(form({ area: ' ', city: '' }), 'delivery', 'Karachi')).toMatchObject({
      area: null,
      city: 'Karachi',
    });
  });
});

describe('savedAddressToMakeUsual', () => {
  const saved = [
    { id: 'a1', label: 'Home', addressLine: 'House 1', area: 'DHA Phase 6', city: null, isDefault: true },
    { id: 'a2', label: 'Office', addressLine: 'Office 9', area: null, city: 'Karachi', isDefault: false },
  ];

  it('re-saves the picked address exactly as stored, as the usual one', () => {
    expect(savedAddressToMakeUsual(form({ matchedAddressId: 'a2', makeDefault: true }), 'delivery', saved)).toEqual({
      label: 'Office',
      addressLine: 'Office 9',
      area: null,
      city: 'Karachi',
      isDefault: true,
    });
  });

  it('only when asked, only for a delivery, and not for the usual one already', () => {
    expect(savedAddressToMakeUsual(form({ matchedAddressId: 'a2' }), 'delivery', saved)).toBeNull();
    expect(savedAddressToMakeUsual(form({ matchedAddressId: 'a2', makeDefault: true }), 'takeaway', saved)).toBeNull();
    expect(savedAddressToMakeUsual(form({ matchedAddressId: 'a1', makeDefault: true }), 'delivery', saved)).toBeNull();
    expect(savedAddressToMakeUsual(form({ matchedAddressId: 'gone', makeDefault: true }), 'delivery', saved)).toBeNull();
  });
});
