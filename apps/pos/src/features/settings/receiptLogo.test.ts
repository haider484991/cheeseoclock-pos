import { describe, expect, it } from 'vitest';
import { LOGO_RASTER_ALGO, extractLogoInk, logoBox, logoFingerprint } from '@cheeseoclock/printer-core';
import { darkLogoFix, logoIsJpeg, receiptLogoSet, receiptLogoUpToDate, toBase64 } from './receiptLogo';

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe('toBase64', () => {
  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    expect(toBase64(new Uint8Array(0))).toBe('');
  });

  it('handles the biggest logo (bigger than one chunk)', () => {
    const bytes = Uint8Array.from({ length: 72 * 160 }, (_, i) => (i * 37) & 0xff);
    const text = toBase64(bytes);
    expect(text.length).toBe(15_360);
    expect(fromBase64(text)).toEqual(bytes);
  });
});

describe('receiptLogoUpToDate', () => {
  const url = 'data:image/png;base64,ZmFrZS1sb2dv';
  const source = logoFingerprint(url);

  it('only when made from this logo by this version or later', () => {
    expect(receiptLogoUpToDate(url, undefined)).toBe(false);
    expect(receiptLogoUpToDate(url, null)).toBe(false);
    expect(receiptLogoUpToDate(url, { source: logoFingerprint('another'), algo: LOGO_RASTER_ALGO })).toBe(false);
    expect(receiptLogoUpToDate(url, { source, algo: LOGO_RASTER_ALGO - 1 })).toBe(false);
    expect(receiptLogoUpToDate(url, { source, algo: LOGO_RASTER_ALGO })).toBe(true);
    expect(receiptLogoUpToDate(url, { source, algo: LOGO_RASTER_ALGO + 1 })).toBe(true);
  });
});

describe('receiptLogoSet', () => {
  it('makes one picture per paper width, in the shape the till stores', () => {
    // A black ring on see-through, 200 px.
    const size = 200;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        if (r <= size / 2 && r >= size / 2 - 16) rgba[(y * size + x) * 4 + 3] = 255;
      }
    }
    const set = receiptLogoSet('8-0003e224', extractLogoInk(rgba, size, size));
    expect(set.source).toBe('8-0003e224');
    expect(set.algo).toBe(LOGO_RASTER_ALGO);
    expect(set.rasters.map((r) => r.paperWidth)).toEqual([32, 48]);
    for (const r of set.rasters) {
      const box = logoBox(r.paperWidth);
      expect(r.width % 8).toBe(0);
      expect(r.width).toBeLessThanOrEqual(box.maxWidth);
      expect(r.height).toBeLessThanOrEqual(box.maxHeight);
      expect(r.data.length % 4).toBe(0);
      expect(fromBase64(r.data)).toHaveLength((r.width / 8) * r.height);
    }
    expect(set.rasters[1]).toMatchObject({ width: 160, height: 160 });
  });

  it('makes no pictures for a logo with nothing to print', () => {
    expect(receiptLogoSet('0-811c9dc5', null).rasters).toEqual([]);
  });
});

describe('logoIsJpeg and darkLogoFix', () => {
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQ'; // made-up data
  const png = 'data:image/png;base64,iVBORw0KGgo';

  it('tells a JPEG (no see-through parts) from a picture that keeps its transparency', () => {
    expect(logoIsJpeg(jpeg)).toBe(true);
    expect(logoIsJpeg('data:image/jpg;base64,xx')).toBe(true);
    expect(logoIsJpeg('DATA:IMAGE/JPEG;base64,xx')).toBe(true);
    expect(logoIsJpeg(png)).toBe(false);
    expect(logoIsJpeg('data:image/webp;base64,xx')).toBe(false);
    expect(logoIsJpeg('data:image/svg+xml;base64,xx')).toBe(false);
  });

  it('asks for a see-through PNG only when the logo is not one already', () => {
    expect(darkLogoFix(jpeg)).toMatch(/PNG with a see-through background/);
    expect(darkLogoFix(undefined)).toMatch(/PNG with a see-through background/);
    // Already see-through: the same file again would print the same block.
    expect(darkLogoFix(png)).not.toMatch(/PNG|see-through/);
    expect(darkLogoFix(png)).toMatch(/outline or text-only/);
  });
});
