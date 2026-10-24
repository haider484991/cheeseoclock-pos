import { describe, expect, it } from 'vitest';
import { CALL_FIRST_HEADLINE, callFirstLine, junkAddressReason, junkPhoneReason } from './call-first';

describe('junkAddressReason', () => {
  it('passes the addresses Karachi customers really type', () => {
    for (const real of [
      'House 12, Street 4',
      'Flat 3B, Bukhari Commercial, Lane 7',
      '26-C Khayaban-e-Ittehad',
      'Plot 45, 11th Street, Phase 5 Ext',
      'Bungalow 101/1, Khayaban-e-Seher',
      'Apartment 504, Emaar Coral Tower',
    ]) {
      expect(junkAddressReason(real), real).toBeNull();
    }
  });

  it('flags placeholder words, whatever their case, and says which', () => {
    expect(junkAddressReason('ABC Road House No 99')).toBe('check the address ("ABC")');
    expect(junkAddressReason('test 123')).toBe('check the address ("test")');
    expect(junkAddressReason('House 5 xyz street')).toBe('check the address ("xyz")');
    expect(junkAddressReason('Fake street 9')).toBe('check the address ("Fake")');
    expect(junkAddressReason('N/A 12')).toBe('check the address ("N/A")');
  });

  it('does not flag a placeholder hidden inside a real word', () => {
    expect(junkAddressReason('House 7, Abcott Lane')).toBeNull();
    expect(junkAddressReason('Testa Heights, Flat 2')).toBeNull();
  });

  it('flags mashed keys, a few letters, and an address with no house number', () => {
    expect(junkAddressReason('aaaaa 12')).toBe('check the address ("aaaaa")');
    expect(junkAddressReason('house kkkkk 4')).toBe('check the address (repeated letters)');
    expect(junkAddressReason('Hse 9')).toBe('check the address (too short)');
    expect(junkAddressReason('Near the big masjid')).toBe('check the address (no house number)');
  });
});

describe('junkPhoneReason', () => {
  it('passes real numbers, order #4’s included', () => {
    for (const real of ['+923340020300', '+923009367865', '+923212345678', '+923001234599']) {
      expect(junkPhoneReason(real), real).toBeNull();
    }
  });

  it('flags the checkout’s own example, a run of one digit and a counted sequence', () => {
    expect(junkPhoneReason('+923001234567')).toBe('check the number');
    expect(junkPhoneReason('+923007654321')).toBe('check the number');
    expect(junkPhoneReason('+923331111111')).toBe('check the number');
    expect(junkPhoneReason('+923000000001')).toBe('check the number');
  });
});

describe('callFirstLine', () => {
  it('says nothing for a trusted number, whatever its address and number look like', () => {
    expect(callFirstLine({ trusted: true, phone: '+923001234567', address: 'test' })).toBeNull();
  });

  it('a new number: the headline and every reason, in plain ASCII for the thermal printer', () => {
    const line = callFirstLine({ trusted: false, phone: '+923001234567', address: 'ABC Road House No 99' })!;
    expect(line).toBe(
      `${CALL_FIRST_HEADLINE}: new number; check the number; check the address ("ABC")`,
    );
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  });

  it('a pick-up has no address to judge', () => {
    expect(callFirstLine({ trusted: false, phone: '+923340020300', address: null })).toBe(
      `${CALL_FIRST_HEADLINE}: new number`,
    );
  });
});
