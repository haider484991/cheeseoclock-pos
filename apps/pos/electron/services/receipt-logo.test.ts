import { describe, expect, it } from 'vitest';
import { logoFingerprint, LOGO_RASTER_ALGO } from '@cheeseoclock/printer-core';
import type { PrinterConnectionConfig, ReceiptLogoRasterJson } from '@cheeseoclock/shared-types';
import {
  LOGO_TEST_NOTE,
  ReceiptLogoRasterSchema,
  isLogoChecked,
  logoCheckedValue,
  logoInfo,
  logoTestOptions,
  resolveReceiptLogo,
} from './receipt-logo.js';

const LOGO = 'data:image/png;base64,ZmFrZS1sb2dv'; // a made-up logo
const OTHER_LOGO = 'data:image/png;base64,b3RoZXItbG9nbw==';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A picture of `width`×`height` dots, every byte `fill`. */
function pic(
  paperWidth: 32 | 48,
  width: number,
  height: number,
  fill = 0x81,
): ReceiptLogoRasterJson {
  return { paperWidth, width, height, data: b64(new Uint8Array((width / 8) * height).fill(fill)) };
}

const goodSet = () => ({
  source: logoFingerprint(LOGO),
  algo: LOGO_RASTER_ALGO,
  rasters: [pic(32, 120, 120), pic(48, 160, 160)],
});

describe('ReceiptLogoRasterSchema', () => {
  it('accepts a picture per paper width', () => {
    expect(ReceiptLogoRasterSchema.safeParse(goodSet()).success).toBe(true);
    expect(ReceiptLogoRasterSchema.safeParse({ ...goodSet(), rasters: [] }).success).toBe(true);
    // The largest there is: full 80 mm width, full height.
    expect(ReceiptLogoRasterSchema.safeParse({ ...goodSet(), rasters: [pic(48, 576, 160)] }).success).toBe(true);
  });

  it('refuses anything malformed or too big', () => {
    const bad: Array<[string, unknown]> = [
      ['width not whole bytes', { ...goodSet(), rasters: [{ ...pic(48, 16, 10), width: 12 }] }],
      ['wider than 80 mm', { ...goodSet(), rasters: [pic(48, 584, 10)] }],
      ['taller than 20 mm', { ...goodSet(), rasters: [pic(48, 64, 161)] }],
      ['taller than 15 mm on 58 mm', { ...goodSet(), rasters: [pic(32, 64, 121)] }],
      ['wider than 58 mm', { ...goodSet(), rasters: [pic(32, 392, 10)] }],
      [
        'one byte short',
        { ...goodSet(), rasters: [{ ...pic(48, 16, 10), data: b64(new Uint8Array(19).fill(1)) }] },
      ],
      ['not base64', { ...goodSet(), rasters: [{ ...pic(48, 16, 1), data: 'ab$=' }] }],
      ['two for one width', { ...goodSet(), rasters: [pic(48, 16, 1), pic(48, 16, 1)] }],
      ['three pictures', { ...goodSet(), rasters: [pic(32, 16, 1), pic(48, 16, 1), pic(48, 8, 1)] }],
      ['unpadded fingerprint', { ...goodSet(), source: '8-3e224' }],
      ['no fingerprint', { ...goodSet(), source: '' }],
      ['algo 0', { ...goodSet(), algo: 0 }],
      ['not an object', 'garbage'],
    ];
    for (const [why, value] of bad) {
      expect(ReceiptLogoRasterSchema.safeParse(value).success, why).toBe(false);
    }
  });

  it('accepts the fingerprint of any logo', () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let i = 0; i < 300; i++) {
      const url = `data:image/png;base64,${Array.from({ length: next() % 200 }, () =>
        String.fromCharCode(43 + (next() % 80)),
      ).join('')}`;
      const set = { ...goodSet(), source: logoFingerprint(url) };
      expect(ReceiptLogoRasterSchema.safeParse(set).success, url).toBe(true);
    }
    expect(ReceiptLogoRasterSchema.safeParse({ ...goodSet(), source: logoFingerprint('logo-229') }).success).toBe(true);
  });
});

describe('resolveReceiptLogo', () => {
  const resolve = (stored: unknown, paperWidth: 32 | 48 = 48) =>
    resolveReceiptLogo({ logoUrl: LOGO, stored, paperWidth });

  it('none: no logo set', () => {
    expect(resolveReceiptLogo({ logoUrl: undefined, stored: goodSet(), paperWidth: 48 })).toEqual({
      state: 'none',
      raster: null,
    });
  });

  it('not ready: no picture yet, garbage, or a picture of another logo', () => {
    expect(resolve(null).state).toBe('not_ready');
    expect(resolve({ what: 'ever' }).state).toBe('not_ready');
    expect(resolve('garbage').state).toBe('not_ready');
    expect(resolve({ ...goodSet(), source: logoFingerprint(OTHER_LOGO) }).state).toBe('not_ready');
  });

  it('blank: nothing to print on this paper', () => {
    expect(resolve({ ...goodSet(), rasters: [pic(32, 120, 120)] }, 48).state).toBe('blank');
    expect(resolve({ ...goodSet(), rasters: [pic(48, 160, 160, 0)] }, 48).state).toBe('blank');
  });

  it('too dark: a black block is never printed', () => {
    expect(resolve({ ...goodSet(), rasters: [pic(48, 160, 160, 0xff)] }, 48)).toEqual({
      state: 'too_dark',
      raster: null,
    });
  });

  it('ready: the stored dots, for this paper', () => {
    const set = goodSet();
    set.rasters[1] = { ...pic(48, 16, 2), data: b64(Uint8Array.of(0x80, 0x01, 0x18, 0x81)) };
    const wide = resolve(set, 48);
    expect(wide.state).toBe('ready');
    expect(wide.raster?.width).toBe(16);
    expect(wide.raster?.height).toBe(2);
    expect([...(wide.raster?.data ?? [])]).toEqual([0x80, 0x01, 0x18, 0x81]);
    expect(resolve(set, 32).raster?.width).toBe(120);
  });
});

describe('logo bookkeeping', () => {
  it('logoInfo gives the fingerprint and version of a valid set only', () => {
    expect(logoInfo(goodSet())).toEqual({ source: logoFingerprint(LOGO), algo: LOGO_RASTER_ALGO });
    expect(logoInfo(null)).toBeNull();
    expect(logoInfo({ source: 'x' })).toBeNull();
  });

  it('a test print counts for this logo on this printer only', () => {
    const lan: PrinterConnectionConfig = { transport: 'network', network: { host: '192.168.1.50', port: 9100 }, width: 48 };
    const usb: PrinterConnectionConfig = { transport: 'usb', usb: { printerName: 'Receipt' }, width: 48 };
    const stored = logoCheckedValue(LOGO, lan);
    expect(isLogoChecked(stored, LOGO, lan)).toBe(true);
    expect(isLogoChecked(stored, LOGO, usb)).toBe(false);
    expect(isLogoChecked(stored, OTHER_LOGO, lan)).toBe(false);
    expect(isLogoChecked(stored, undefined, lan)).toBe(false);
    expect(isLogoChecked(null, LOGO, lan)).toBe(false);
  });
});

describe('logoTestOptions', () => {
  const ready = resolveReceiptLogo({ logoUrl: LOGO, stored: goodSet(), paperWidth: 48 });

  it('prints a usable logo on the test page even when receipts have it off', () => {
    const on = logoTestOptions(ready, true);
    expect(on.logo).toBe(ready.raster);
    expect(on.logoNote).toBe('should be above');
    expect(on.logoOnReceipts).toBe(true);
    const off = logoTestOptions(ready, false);
    expect(off.logo).toBe(ready.raster);
    expect(off.logoOnReceipts).toBe(false);
  });

  it('says why there is no logo', () => {
    expect(logoTestOptions({ state: 'none', raster: null }, true)).toEqual({ logo: null, logoNote: 'none set' });
    expect(logoTestOptions({ state: 'too_dark', raster: null }, true)).toEqual({
      logo: null,
      logoNote: 'too dark to print',
      logoOnReceipts: true,
    });
  });

  it('keeps every note short and plain for a 58 mm page', () => {
    for (const note of Object.values(LOGO_TEST_NOTE)) {
      expect(note).toMatch(/^[ -~]+$/);
      expect(`Logo ${note}`.length).toBeLessThanOrEqual(32);
    }
  });
});
