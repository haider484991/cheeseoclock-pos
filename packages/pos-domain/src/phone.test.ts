import { describe, it, expect } from 'vitest';
import { normalizePhone, phoneSearchTerms } from './phone.js';

describe('normalizePhone', () => {
  it('canonicalises the local, international and bare forms', () => {
    expect(normalizePhone('03001234567')).toBe('+923001234567');
    expect(normalizePhone('+92 300 1234567')).toBe('+923001234567');
    expect(normalizePhone('0092-300-1234567')).toBe('+923001234567');
    expect(normalizePhone('300 1234567')).toBe('+923001234567');
  });

  it('returns null for partial or non-numeric input', () => {
    expect(normalizePhone('0300123')).toBeNull();
    expect(normalizePhone('  ali  ')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('phoneSearchTerms', () => {
  it('yields the canonical form and stripped digits for a full local number', () => {
    expect(phoneSearchTerms('03001234567')).toEqual({
      canonical: '+923001234567',
      digits: '3001234567',
    });
  });

  it('drops the 92 / 0092 trunk prefixes as well as the leading 0', () => {
    expect(phoneSearchTerms('+92 300 1234567').digits).toBe('3001234567');
    expect(phoneSearchTerms('0092 300 1234567').digits).toBe('3001234567');
    expect(phoneSearchTerms('923001234567').digits).toBe('3001234567');
    expect(phoneSearchTerms('3001234567').digits).toBe('3001234567');
  });

  it('keeps the digits for a number still being typed (no canonical yet)', () => {
    expect(phoneSearchTerms('0300 123')).toEqual({ canonical: null, digits: '300123' });
    expect(phoneSearchTerms('+92300')).toEqual({ canonical: null, digits: '300' });
  });

  it('keeps the last-digits form a cashier reads off a receipt', () => {
    expect(phoneSearchTerms('4567')).toEqual({ canonical: null, digits: '4567' });
  });

  it('returns nothing to match when the input has no usable digits', () => {
    expect(phoneSearchTerms('ali')).toEqual({ canonical: null, digits: null });
    expect(phoneSearchTerms('   ')).toEqual({ canonical: null, digits: null });
    expect(phoneSearchTerms('0')).toEqual({ canonical: null, digits: null });
    expect(phoneSearchTerms('92')).toEqual({ canonical: null, digits: null });
  });

  it('ignores punctuation and letters mixed into the digits', () => {
    expect(phoneSearchTerms('0300-123-4567').canonical).toBe('+923001234567');
    expect(phoneSearchTerms('ali 0300').digits).toBe('300');
  });
});
