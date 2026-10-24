import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { metaNames, metaPhone, metaUserData } from './meta-user-data';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('metaPhone: country code and number, digits only', () => {
  it('reads every way a Pakistani mobile is typed', () => {
    for (const typed of ['0300 1234567', '03001234567', '+92 300 1234567', '92-300-1234567', '3001234567']) {
      expect(metaPhone(typed), typed).toBe('923001234567');
    }
  });

  it('is null for anything else', () => {
    for (const typed of ['', '12345', '021 1234567 89', 'call me', null, undefined]) {
      expect(metaPhone(typed as string | null | undefined)).toBeNull();
    }
  });
});

describe('metaNames: first and last word, lowercase letters only', () => {
  it('splits and cleans a name', () => {
    expect(metaNames('Ahmed Khan')).toEqual({ fn: 'ahmed', ln: 'khan' });
    expect(metaNames('  Syed  Ali  Raza ')).toEqual({ fn: 'syed', ln: 'raza' });
    expect(metaNames("O'Brien-Smith")).toEqual({ fn: 'obriensmith', ln: null });
    expect(metaNames('Ali')).toEqual({ fn: 'ali', ln: null });
  });

  it('keeps letters of any script and drops what has none', () => {
    expect(metaNames('محمد علی')).toEqual({ fn: 'محمد', ln: 'علی' });
    expect(metaNames('Ali 123')).toEqual({ fn: 'ali', ln: null });
    expect(metaNames('---')).toEqual({ fn: null, ln: null });
    expect(metaNames(undefined)).toEqual({ fn: null, ln: null });
  });
});

describe('metaUserData', () => {
  it('hashes each detail as Meta asks: phone, its id, name, Karachi / Sindh / pk', () => {
    expect(metaUserData({ phone: '0300 1234567', name: 'Ahmed Khan' })).toEqual({
      ph: hash('923001234567'),
      external_id: hash('923001234567'),
      fn: hash('ahmed'),
      ln: hash('khan'),
      ct: hash('karachi'),
      st: hash('sindh'),
      country: hash('pk'),
    });
  });

  it('the same customer hashes the same, however the number was typed', () => {
    expect(metaUserData({ phone: '+923001234567' })).toEqual(metaUserData({ phone: '0300-1234567' }));
  });

  it('leaves out a name it cannot read', () => {
    const data = metaUserData({ phone: '03001234567', name: '' })!;
    expect(Object.keys(data).sort()).toEqual(['country', 'ct', 'external_id', 'ph', 'st']);
  });

  it('gives nothing at all without a valid phone', () => {
    expect(metaUserData({ phone: '12345', name: 'Ahmed Khan' })).toBeNull();
    expect(metaUserData({ name: 'Ahmed Khan' })).toBeNull();
  });

  it('nothing in clear: every value is a 64-digit hash', () => {
    const data = metaUserData({ phone: '0300 1234567', name: 'Ahmed Khan' })!;
    for (const v of Object.values(data)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    const sent = JSON.stringify(data);
    for (const clear of ['0300', '923001234567', 'Ahmed', 'ahmed', 'karachi']) expect(sent).not.toContain(clear);
  });
});
