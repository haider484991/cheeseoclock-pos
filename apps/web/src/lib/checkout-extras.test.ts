import { describe, expect, it } from 'vitest';
import { ORDER_NOTES_MAX, SOCIAL_MAX, cleanSocial, composeNotes, parsePin, pinLine, pinUrl } from './checkout-extras';

describe('parsePin', () => {
  it('takes a phone’s position: six decimals, whole metres', () => {
    expect(parsePin({ lat: 24.80835364, lng: 67.06845187, accuracyM: 24.6 })).toEqual({ lat: 24.808354, lng: 67.068452, accuracyM: 25 });
  });

  it('an accuracy that is missing, negative or not a number is null; a huge one is capped', () => {
    expect(parsePin({ lat: 24.8, lng: 67.06 })?.accuracyM).toBeNull();
    expect(parsePin({ lat: 24.8, lng: 67.06, accuracyM: -3 })?.accuracyM).toBeNull();
    expect(parsePin({ lat: 24.8, lng: 67.06, accuracyM: '20' })?.accuracyM).toBeNull();
    expect(parsePin({ lat: 24.8, lng: 67.06, accuracyM: 5_000_000 })?.accuracyM).toBe(100_000);
  });

  it('what is not a pin is null — never an error: strings, NaN, Infinity, off the globe, null island, nothing', () => {
    for (const bad of [
      undefined,
      null,
      'pin',
      42,
      {},
      { lat: '24.8', lng: '67.0' },
      { lat: NaN, lng: 67 },
      { lat: 24, lng: Infinity },
      { lat: 91, lng: 67 },
      { lat: -91, lng: 67 },
      { lat: 24, lng: 181 },
      { lat: 24, lng: -181 },
      { lat: 0, lng: 0 },
    ]) {
      expect(parsePin(bad), JSON.stringify(bad)).toBeNull();
    }
    // A point on the equator or the prime meridian is a real place.
    expect(parsePin({ lat: 0, lng: 67 })).not.toBeNull();
    expect(parsePin({ lat: 24, lng: 0 })).not.toBeNull();
  });
});

describe('the pin in words', () => {
  const pin = { lat: 24.808354, lng: 67.068452, accuracyM: 25 };

  it('a Google Maps link with six decimals, whatever the number’s own length', () => {
    expect(pinUrl(pin)).toBe('https://maps.google.com/?q=24.808354,67.068452');
    expect(pinUrl({ lat: 24.8, lng: 67 })).toBe('https://maps.google.com/?q=24.800000,67.000000');
    expect(pinUrl({ lat: -24.5, lng: -67.25 })).toBe('https://maps.google.com/?q=-24.500000,-67.250000');
  });

  it('the notes line says how close it is only when the phone did', () => {
    expect(pinLine(pin)).toBe('Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m)');
    expect(pinLine({ ...pin, accuracyM: null })).toBe('Map pin: https://maps.google.com/?q=24.808354,67.068452');
    expect(pinLine({ ...pin, accuracyM: 0 })).toBe('Map pin: https://maps.google.com/?q=24.808354,67.068452');
  });
});

describe('cleanSocial', () => {
  it('keeps a handle or a link as typed, trimmed', () => {
    expect(cleanSocial('  @ahmed_k ')).toBe('@ahmed_k');
    expect(cleanSocial('instagram.com/ahmed.k')).toBe('instagram.com/ahmed.k');
    expect(cleanSocial('Ahmed Khan   (facebook)')).toBe('Ahmed Khan (facebook)');
  });

  it('control characters and angle brackets become spaces; a stray "@" or nothing is null', () => {
    expect(cleanSocial('@a\nhmed\t<script>')).toBe('@a hmed script');
    expect(cleanSocial('@')).toBeNull();
    expect(cleanSocial('   ')).toBeNull();
    expect(cleanSocial('')).toBeNull();
    expect(cleanSocial(undefined)).toBeNull();
    expect(cleanSocial(12345)).toBeNull();
  });

  it('is cut at SOCIAL_MAX', () => {
    const long = cleanSocial('@' + 'a'.repeat(200));
    expect(long).toHaveLength(SOCIAL_MAX);
  });
});

describe('composeNotes', () => {
  const pin = { lat: 24.808354, lng: 67.068452, accuracyM: 25 };

  it('nothing to say is null — and the customer’s notes alone are exactly as before', () => {
    expect(composeNotes({ pin: null, social: null, notes: null })).toBeNull();
    expect(composeNotes({ pin: null, social: null, notes: '   ' })).toBeNull();
    expect(composeNotes({ pin: null, social: null, notes: 'Ring the bell twice' })).toBe('Ring the bell twice');
  });

  it('the pin first, then the handle, then the customer’s words', () => {
    expect(composeNotes({ pin, social: '@ahmed_k', notes: 'Ring the bell twice' })).toBe(
      'Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m). Social: @ahmed_k. Ring the bell twice',
    );
    expect(composeNotes({ pin, social: null, notes: null })).toBe('Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m)');
    expect(composeNotes({ pin: null, social: '@ahmed_k', notes: null })).toBe('Social: @ahmed_k');
    expect(composeNotes({ pin: null, social: '@ahmed_k', notes: 'Near the park' })).toBe('Social: @ahmed_k. Near the park');
  });

  it('when it runs out of room the customer’s words give way, never the pin or the handle', () => {
    const notes = 'x'.repeat(600);
    const out = composeNotes({ pin, social: '@ahmed_k', notes })!;
    expect(out).toHaveLength(ORDER_NOTES_MAX);
    expect(out.startsWith('Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m). Social: @ahmed_k. xxx')).toBe(true);
    // Notes alone are cut at the cap too, as the route always did.
    expect(composeNotes({ pin: null, social: null, notes })).toHaveLength(ORDER_NOTES_MAX);
  });

  it('a smaller cap is honoured', () => {
    expect(composeNotes({ pin: null, social: '@ahmed_k', notes: 'abcdef' }, 15)).toBe('Social: @ahmed_');
  });
});

describe('composeNotes with a Buy 1 Get 1 deal (7 Oct 2026)', () => {
  it('leads with whose post the cashier checks, before the pin; no second "Social:"', () => {
    const pin = { lat: 24.808354, lng: 67.068452, accuracyM: 25 };
    expect(composeNotes({ pin, social: '@ahmed_k', notes: 'Ring twice', buy1Get1: true })).toBe(
      'Buy 1 Get 1: check the post by @ahmed_k. Map pin: https://maps.google.com/?q=24.808354,67.068452 (about 25 m). Ring twice',
    );
    expect(composeNotes({ pin: null, social: '@ahmed_k', notes: null, buy1Get1: true })).toBe('Buy 1 Get 1: check the post by @ahmed_k');
  });

  it('without a deal, or without a name, the notes are as before', () => {
    expect(composeNotes({ pin: null, social: '@ahmed_k', notes: null, buy1Get1: false })).toBe('Social: @ahmed_k');
    expect(composeNotes({ pin: null, social: null, notes: 'Hi', buy1Get1: true })).toBe('Hi');
  });
});
