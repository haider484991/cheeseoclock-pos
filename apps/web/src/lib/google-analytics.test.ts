import { describe, expect, it } from 'vitest';
import { cleanPageLocation, cleanReferrer } from './google-analytics';

const ORIGIN = 'https://www.cheeseoclock.net';

describe('cleanPageLocation', () => {
  it('sends a tracking page as /track: no order id, no phone', () => {
    expect(cleanPageLocation(`${ORIGIN}/track/0192f1aa-77?phone=03001234567`, ORIGIN)).toBe(`${ORIGIN}/track`);
    expect(cleanPageLocation('/track/abc?phone=03001234567', ORIGIN)).toBe(`${ORIGIN}/track`);
  });

  it('catches a tracking page however its path is written', () => {
    expect(cleanPageLocation(`${ORIGIN}/%74rack/abc?phone=0300`, ORIGIN)).toBe(`${ORIGIN}/track`);
    expect(cleanPageLocation(`${ORIGIN}/TRACK/abc?phone=0300`, ORIGIN)).toBe(`${ORIGIN}/track`);
    expect(cleanPageLocation(`${ORIGIN}/menu/../track/abc?phone=0300`, ORIGIN)).toBe(`${ORIGIN}/track`);
  });

  it('sends the dashboard as /dashboard', () => {
    expect(cleanPageLocation(`${ORIGIN}/dashboard/orders/123?x=1`, ORIGIN)).toBe(`${ORIGIN}/dashboard`);
  });

  it('keeps only the campaign tags of the query', () => {
    expect(
      cleanPageLocation(`${ORIGIN}/menu?utm_source=facebook&phone=0300&utm_campaign=deals&name=Ali&fbclid=abc`, ORIGIN),
    ).toBe(`${ORIGIN}/menu?utm_source=facebook&utm_campaign=deals&fbclid=abc`);
    expect(cleanPageLocation(`${ORIGIN}/?area=gizri&sheet=cart`, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(cleanPageLocation(`${ORIGIN}/menu#cart`, ORIGIN)).toBe(`${ORIGIN}/menu`);
  });

  it('gives another site only its origin', () => {
    expect(cleanPageLocation('https://example.com/a?phone=0300', ORIGIN)).toBe('https://example.com');
  });
});

describe('cleanReferrer', () => {
  it('cleans this site’s own address', () => {
    expect(cleanReferrer(`${ORIGIN}/track/abc?phone=0300`, ORIGIN)).toBe(`${ORIGIN}/track`);
    expect(cleanReferrer(`${ORIGIN}/menu?x=1`, ORIGIN)).toBe(`${ORIGIN}/menu`);
  });

  it('keeps another site’s referrer as the browser gave it, and nothing for none', () => {
    expect(cleanReferrer('https://www.google.com/', ORIGIN)).toBe('https://www.google.com/');
    expect(cleanReferrer('', ORIGIN)).toBe('');
    expect(cleanReferrer('not a url', ORIGIN)).toBe('');
  });
});
