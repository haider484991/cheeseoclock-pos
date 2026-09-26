import { describe, expect, it } from 'vitest';
import {
  LOGO_BOX,
  LOGO_MAX_INK_SHARE,
  centreOnPaper,
  darknessToMonoRaster,
  extractLogoInk,
  fitLogo,
  inkBounds,
  inkShare,
  isPrintableLogo,
  isValidMonoRaster,
  judgeLogoRaster,
  logoBox,
  logoFingerprint,
  pixelDarkness,
  rasterHasInk,
  rasteriseLogo,
  rasteriseLogoInk,
  type MonoRaster,
} from './logo-raster.js';

type Rgba = [number, number, number, number];
const CLEAR: Rgba = [0, 0, 0, 0];
const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const YELLOW: Rgba = [255, 255, 0, 255];

function rgbaOf(w: number, h: number, at: (x: number, y: number) => Rgba): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(at(x, y), (y * w + x) * 4);
  return out;
}

function grid(w: number, h: number, at: (x: number, y: number) => number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = at(x, y);
  return g;
}

const bit = (r: MonoRaster, x: number, y: number) =>
  ((r.data[y * (r.width / 8) + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;

/** Share of black dots in [x0, x1) × [y0, y1). */
function blackShare(r: MonoRaster, x0: number, y0: number, x1: number, y1: number): number {
  let on = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (bit(r, x, y)) on++;
  return on / ((x1 - x0) * (y1 - y0));
}

/** White dots with all eight neighbours black: pinholes. */
function pinholes(r: MonoRaster): number {
  let n = 0;
  for (let y = 1; y < r.height - 1; y++) {
    for (let x = 1; x < r.width - 1; x++) {
      if (bit(r, x, y)) continue;
      let around = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && bit(r, x + dx, y + dy)) around++;
      if (around === 8) n++;
    }
  }
  return n;
}

const raster = (width: number, height: number, fill: number): MonoRaster => ({
  width,
  height,
  data: new Uint8Array((width / 8) * height).fill(fill),
});

describe('logo box and fit', () => {
  it('uses the full paper width in dots and caps the height', () => {
    expect(logoBox(32)).toEqual({ maxWidth: 384, maxHeight: 120 });
    expect(logoBox(48)).toEqual({ maxWidth: 576, maxHeight: 160 });
    expect(logoBox(40 as never)).toEqual(LOGO_BOX[48]);
  });

  it('fits a square logo by height', () => {
    expect(fitLogo(512, 512, logoBox(48))).toEqual({ width: 160, height: 160, drawX: 0, drawWidth: 160 });
    expect(fitLogo(512, 512, logoBox(32))).toEqual({ width: 120, height: 120, drawX: 0, drawWidth: 120 });
  });

  it('fits a wide logo by width', () => {
    expect(fitLogo(400, 100, logoBox(48))).toMatchObject({ width: 576, height: 144 });
    expect(fitLogo(400, 100, logoBox(32))).toMatchObject({ width: 384, height: 96 });
  });

  it('pads an odd width to whole bytes with the logo centred', () => {
    expect(fitLogo(101, 50, logoBox(48))).toEqual({ width: 328, height: 160, drawX: 2, drawWidth: 323 });
  });

  it('never leaves the box, and never blows a small logo up more than 4×', () => {
    for (const [w, h] of [
      [3000, 10],
      [10, 3000],
      [577, 161],
      [1, 1],
    ] as const) {
      for (const paper of [32, 48] as const) {
        const f = fitLogo(w, h, logoBox(paper));
        expect(f.width).toBeLessThanOrEqual(logoBox(paper).maxWidth);
        expect(f.height).toBeLessThanOrEqual(logoBox(paper).maxHeight);
        expect(f.width % 8).toBe(0);
        expect(f.drawX + f.drawWidth).toBeLessThanOrEqual(f.width);
      }
    }
    expect(fitLogo(10, 10, logoBox(48))).toMatchObject({ width: 40, height: 40 });
  });
});

describe('pixelDarkness', () => {
  it('lays the pixel over white paper', () => {
    expect(pixelDarkness(0, 0, 0, 0)).toBe(0); // see-through black is paper
    expect(pixelDarkness(0, 0, 0, 255)).toBe(255);
    expect(pixelDarkness(255, 255, 255, 255)).toBe(0);
    expect(pixelDarkness(128, 128, 128, 255)).toBe(127);
    expect(pixelDarkness(0, 0, 0, 128)).toBe(128); // half see-through black: mid grey
  });

  it('counts bright colours as ink', () => {
    expect(pixelDarkness(255, 255, 0, 255)).toBeGreaterThanOrEqual(100); // yellow
    expect(pixelDarkness(255, 165, 0, 255)).toBeGreaterThanOrEqual(100); // orange
  });
});

describe('darknessToMonoRaster', () => {
  it('packs the leftmost dot into the high bit', () => {
    expect([...darknessToMonoRaster(grid(8, 1, (x) => (x === 0 ? 255 : 0)), 8, 1).data]).toEqual([0x80]);
    expect([...darknessToMonoRaster(grid(8, 1, (x) => (x === 7 ? 255 : 0)), 8, 1).data]).toEqual([0x01]);
    expect([...darknessToMonoRaster(grid(16, 1, (x) => (x === 9 ? 255 : 0)), 16, 1).data]).toEqual([0x00, 0x40]);
  });

  it('prints paper as nothing', () => {
    const r = darknessToMonoRaster(grid(16, 4, () => 15), 16, 4);
    expect(rasterHasInk(r)).toBe(false);
  });

  // A thick L, like a letter stroke: ink on just over half of its box.
  const inL = (x: number, y: number) => x < 20 || y >= 20;

  it('prints a flat colour solid, without pinholes, despite colour noise', () => {
    const r = darknessToMonoRaster(
      grid(64, 32, (x, y) => (inL(x, y) ? 120 + ((x * 7 + y * 13) % 21) - 10 : 0)),
      64,
      32,
    );
    expect(pinholes(r)).toBe(0);
    expect(blackShare(r, 0, 0, 20, 32)).toBe(1);
    expect(blackShare(r, 20, 20, 64, 32)).toBe(1);
    expect(blackShare(r, 20, 0, 64, 20)).toBe(0);
  });

  it('prints a one-colour gradient (gold, light to dark) solid', () => {
    const r = darknessToMonoRaster(grid(64, 32, (x, y) => (inL(x, y) ? 90 + (60 * x) / 63 : 0)), 64, 32);
    expect(blackShare(r, 0, 0, 20, 32)).toBe(1);
    expect(blackShare(r, 20, 20, 64, 32)).toBe(1);
  });

  it('prints a light colour that fills its outline as an even tint, not a block', () => {
    // Yellow (128) edge to edge: solid it would be judged too dark and left off.
    const r = darknessToMonoRaster(grid(64, 32, () => 128), 64, 32);
    const tint = blackShare(r, 0, 0, 64, 32);
    expect(tint).toBeGreaterThanOrEqual(0.25);
    expect(tint).toBeLessThanOrEqual(0.5);
    expect(judgeLogoRaster(r, 48)).toBe('ready');
  });

  it('keeps a dark colour that fills its outline solid (it is then too dark to print)', () => {
    const r = darknessToMonoRaster(grid(64, 32, () => 200), 64, 32);
    expect(blackShare(r, 0, 0, 64, 32)).toBe(1);
    expect(judgeLogoRaster(r, 48)).toBe('too_dark');
  });

  it('two tones: the darker solid, the lighter as an even pattern kept one dot away', () => {
    // Yellow (127) on the left, black on the right.
    const r = darknessToMonoRaster(grid(64, 32, (x) => (x < 32 ? 127 : 255)), 64, 32);
    expect(blackShare(r, 32, 0, 64, 32)).toBe(1);
    expect(blackShare(r, 31, 0, 32, 32)).toBe(0); // the one-dot gap
    const tint = blackShare(r, 0, 2, 29, 30);
    expect(tint).toBeGreaterThan(0.25);
    expect(tint).toBeLessThan(0.75);
  });

  it('keeps dark lettering on a coloured badge readable', () => {
    // A gold badge (darkness 83) with a black letter stroke in the middle.
    const inStroke = (x: number, y: number) => x >= 44 && x < 52 && y >= 12 && y < 36;
    const r = darknessToMonoRaster(grid(96, 48, (x, y) => (inStroke(x, y) ? 255 : 83)), 96, 48);
    expect(blackShare(r, 44, 12, 52, 36)).toBe(1);
    // A white outline around the stroke separates it from the badge.
    for (let y = 11; y <= 36; y++) {
      expect(bit(r, 43, y)).toBe(false);
      expect(bit(r, 52, y)).toBe(false);
    }
    for (let x = 43; x <= 52; x++) {
      expect(bit(r, x, 11)).toBe(false);
      expect(bit(r, x, 36)).toBe(false);
    }
    // The badge is a light, even tint — not solid, not gone.
    const badge = blackShare(r, 0, 0, 40, 48);
    expect(badge).toBeGreaterThan(0.15);
    expect(badge).toBeLessThan(0.4);
  });

  it('leaves out a second tone too faint to print', () => {
    const r = darknessToMonoRaster(grid(64, 32, (x) => (x < 32 ? 40 : 255)), 64, 32);
    expect(blackShare(r, 0, 0, 32, 32)).toBe(0);
    expect(blackShare(r, 32, 0, 64, 32)).toBe(1);
  });

  it('refuses a size that does not add up', () => {
    expect(() => darknessToMonoRaster(new Float32Array(10), 10, 1)).toThrow(RangeError);
    expect(() => darknessToMonoRaster(new Float32Array(15), 16, 1)).toThrow(RangeError);
  });
});

describe('extractLogoInk', () => {
  it('finds nothing in a see-through, white or near-white picture', () => {
    expect(extractLogoInk(rgbaOf(20, 10, () => CLEAR), 20, 10)).toBeNull();
    // See-through pixels count as paper whatever colour they carry.
    expect(extractLogoInk(rgbaOf(20, 10, () => [0, 0, 0, 0]), 20, 10)).toBeNull();
    expect(extractLogoInk(rgbaOf(20, 10, () => WHITE), 20, 10)).toBeNull();
    const noise = rgbaOf(20, 10, (x, y) => [240 + ((x * 5) % 16), 240 + ((y * 3) % 16), 255 - ((x + y) % 16), 255]);
    expect(extractLogoInk(noise, 20, 10)).toBeNull();
  });

  it('crops to the ink', () => {
    const rgba = rgbaOf(40, 30, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 15 ? BLACK : CLEAR));
    const ink = extractLogoInk(rgba, 40, 30)!;
    expect([ink.width, ink.height, ink.repaired]).toEqual([10, 10, false]);
    expect(inkBounds(ink.d, ink.width, ink.height)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('drops a stray mark in a corner, so the logo is neither smaller nor marked', () => {
    const block = (x: number, y: number) => x >= 20 && x < 120 && y >= 20 && y < 80;
    const speck = (x: number, y: number) => x >= 195 && x < 198 && y >= 95 && y < 98;
    const withSpeck = extractLogoInk(rgbaOf(200, 100, (x, y) => (block(x, y) || speck(x, y) ? BLACK : CLEAR)), 200, 100)!;
    expect([withSpeck.width, withSpeck.height]).toEqual([100, 60]);
  });

  it('keeps a line of small letters that belongs to the logo', () => {
    const block = (x: number, y: number) => x >= 20 && x < 120 && y >= 20 && y < 80;
    // Ten 4×4 dots in a row under the block, like a tagline: small one by one, not as a line.
    const letters = (x: number, y: number) => y >= 94 && y < 98 && x >= 20 && x < 120 && (x - 20) % 10 < 4;
    const ink = extractLogoInk(rgbaOf(200, 100, (x, y) => (block(x, y) || letters(x, y) ? BLACK : CLEAR)), 200, 100)!;
    expect([ink.width, ink.height]).toEqual([100, 78]);
  });

  it('takes away the black backdrop of a logo saved by an older version', () => {
    // Yellow frame on solid black, holes included — how the old picker stored a see-through logo.
    const frame = (x: number, y: number) =>
      x >= 20 && x < 40 && y >= 10 && y < 30 && !(x >= 23 && x < 37 && y >= 13 && y < 27);
    const rgba = rgbaOf(60, 40, (x, y) => (frame(x, y) ? YELLOW : BLACK));
    const ink = extractLogoInk(rgba, 60, 40)!;
    expect(ink.repaired).toBe(true);
    expect([ink.width, ink.height]).toEqual([20, 20]);
    // The hole inside the frame is paper again, not black.
    expect(ink.d[10 * 20 + 10]).toBe(0);
    const r = rasteriseLogoInk(ink, 48)!;
    expect(judgeLogoRaster(r, 48)).toBe('ready');
    expect(bit(r, r.width / 2, r.height / 2)).toBe(false);
    expect(bit(r, r.width / 2, 2)).toBe(true);
  });

  it('keeps a thin black frame, and the black lettering inside it, as artwork', () => {
    // A new upload: white logo, black lettering, a yellow ring and a 2 px black frame.
    const W = 400;
    const H = 200;
    const frame = (x: number, y: number) => x < 2 || x >= W - 2 || y < 2 || y >= H - 2;
    const letters = (x: number, y: number) => x >= 200 && x < 360 && y >= 80 && y < 120 && (x - 200) % 20 < 6;
    const ring = (x: number, y: number) => {
      const r = Math.hypot(x + 0.5 - 100, y + 0.5 - 100);
      return r <= 45 && r >= 37;
    };
    const rgba = rgbaOf(W, H, (x, y) => (frame(x, y) || letters(x, y) ? BLACK : ring(x, y) ? YELLOW : WHITE));
    const ink = extractLogoInk(rgba, W, H)!;
    expect(ink.repaired).toBe(false);
    expect([ink.width, ink.height]).toEqual([W, H]); // the frame is still there
    expect(ink.d[100 * W + 202]).toBe(255); // and so is the lettering
    for (const paper of [32, 48] as const) {
      const r = rasteriseLogoInk(ink, paper)!;
      expect(judgeLogoRaster(r, paper)).toBe('ready');
      // A letter stroke prints black: 6 px of the 400 px picture, in the middle of the row.
      const s = r.width / W;
      expect(bit(r, Math.floor(203 * s), Math.floor(100 * s))).toBe(true);
    }
  });

  it('still takes away the old backdrop round a circular badge (only its corners touch the border)', () => {
    const ringOnBlack = rgbaOf(100, 100, (x, y) => {
      const r = Math.hypot(x + 0.5 - 50, y + 0.5 - 50);
      return r <= 48 && r >= 42 ? YELLOW : BLACK;
    });
    const ink = extractLogoInk(ringOnBlack, 100, 100)!;
    expect(ink.repaired).toBe(true);
    const r = rasteriseLogoInk(ink, 48)!;
    expect(judgeLogoRaster(r, 48)).toBe('ready');
    expect(bit(r, r.width / 2, r.height / 2)).toBe(false); // the inside of the ring is paper
  });

  it('never looks for a black background on a picture stored with transparency', () => {
    const frame = (x: number, y: number) =>
      x >= 20 && x < 40 && y >= 10 && y < 30 && !(x >= 23 && x < 37 && y >= 13 && y < 27);
    const rgba = rgbaOf(60, 40, (x, y) => (frame(x, y) ? YELLOW : BLACK));
    const ink = extractLogoInk(rgba, 60, 40, { mayHaveBlackBackground: false })!;
    expect(ink.repaired).toBe(false);
    expect([ink.width, ink.height]).toEqual([60, 40]);
  });

  it('leaves black-on-black alone — it is then too dark to print', () => {
    const letter = (x: number, y: number) => x >= 20 && x < 40 && y >= 10 && y < 30;
    const rgba = rgbaOf(60, 40, (x, y) => (letter(x, y) ? [10, 10, 10, 255] : BLACK));
    const ink = extractLogoInk(rgba, 60, 40)!;
    expect(ink.repaired).toBe(false);
    expect(judgeLogoRaster(rasteriseLogoInk(ink, 48), 48)).toBe('too_dark');
  });

  it('judges a mostly black picture too dark to print', () => {
    // 88% black, with a white band along the top so it is not taken for the old backdrop.
    const shape = (x: number, y: number) => x >= 40 && x < 60 && y >= 40 && y < 60;
    const rgba = rgbaOf(100, 100, (x, y) => (y < 12 ? WHITE : shape(x, y) ? YELLOW : BLACK));
    const r = rasteriseLogo(rgba, 100, 100, 48);
    expect(r).not.toBeNull();
    expect(inkShare(r!)).toBeGreaterThan(LOGO_MAX_INK_SHARE);
    expect(judgeLogoRaster(r, 48)).toBe('too_dark');
    expect(isPrintableLogo(r, 48)).toBe(false);
  });

  it('refuses pixels that do not match the size', () => {
    expect(() => extractLogoInk(new Uint8Array(10), 2, 2)).toThrow(RangeError);
    expect(() => extractLogoInk(new Uint8Array(0), 0, 0)).toThrow(RangeError);
  });
});

describe('rasteriseLogo', () => {
  const ring = (size: number, color: Rgba) =>
    rgbaOf(size, size, (x, y) => {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      return r <= size / 2 && r >= size / 2 - size * 0.08 ? color : CLEAR;
    });

  it('fits a square logo to the paper', () => {
    const rgba = ring(512, BLACK);
    const wide = rasteriseLogo(rgba, 512, 512, 48)!;
    const narrow = rasteriseLogo(rgba, 512, 512, 32)!;
    expect([wide.width, wide.height]).toEqual([160, 160]);
    expect([narrow.width, narrow.height]).toEqual([120, 120]);
    expect(judgeLogoRaster(wide, 48)).toBe('ready');
    expect(judgeLogoRaster(narrow, 32)).toBe('ready');
  });

  it('prints a one-colour yellow logo solid', () => {
    const r = rasteriseLogo(ring(256, YELLOW), 256, 256, 48)!;
    expect(pinholes(r)).toBe(0);
    expect(bit(r, 80, 4)).toBe(true); // in the ring
    expect(bit(r, 80, 80)).toBe(false); // the middle stays paper
  });

  // A filled badge with a white bar cut out, on see-through: a common shop logo.
  const badge = (fill: Rgba) =>
    rgbaOf(300, 300, (x, y) => {
      if (Math.hypot(x + 0.5 - 150, y + 0.5 - 150) > 150) return CLEAR;
      return y >= 135 && y < 165 && x >= 60 && x < 240 ? WHITE : fill;
    });

  it('prints a filled light badge as an even tint with its cut-out still white', () => {
    const rgba = badge([255, 200, 0, 255]);
    for (const paper of [32, 48] as const) {
      const r = rasteriseLogo(rgba, 300, 300, paper)!;
      expect(judgeLogoRaster(r, paper)).toBe('ready');
      expect(inkShare(r)).toBeLessThanOrEqual(LOGO_MAX_INK_SHARE);
    }
    const r = rasteriseLogo(rgba, 300, 300, 48)!; // 160×160: 300 px → 160 dots
    expect([r.width, r.height]).toEqual([160, 160]);
    expect(blackShare(r, 40, 76, 120, 84)).toBe(0); // the bar
    const tint = blackShare(r, 60, 25, 100, 50); // the badge above it
    expect(tint).toBeGreaterThan(0.25);
    expect(tint).toBeLessThan(0.55);
  });

  it('keeps a filled dark badge solid, so it is judged too dark to print', () => {
    const r = rasteriseLogo(badge(BLACK), 300, 300, 48)!;
    expect(judgeLogoRaster(r, 48)).toBe('too_dark');
  });

  it('gives nothing for a blank picture', () => {
    expect(rasteriseLogo(rgbaOf(32, 32, () => CLEAR), 32, 32, 48)).toBeNull();
    expect(rasteriseLogo(rgbaOf(32, 32, () => WHITE), 32, 32, 32)).toBeNull();
  });
});

describe('checks', () => {
  it('isValidMonoRaster', () => {
    expect(isValidMonoRaster(raster(16, 2, 0))).toBe(true);
    expect(isValidMonoRaster({ width: 10, height: 1, data: new Uint8Array(2) })).toBe(false);
    expect(isValidMonoRaster({ width: 16, height: 2, data: new Uint8Array(3) })).toBe(false);
    expect(isValidMonoRaster({ width: 16, height: 0, data: new Uint8Array(0) })).toBe(false);
    expect(isValidMonoRaster({ width: 16, height: 1, data: [0, 0] })).toBe(false);
    expect(isValidMonoRaster(null)).toBe(false);
  });

  it('judges what may print on which paper', () => {
    const sparse = raster(64, 20, 0x81); // two dots in eight
    expect(judgeLogoRaster(sparse, 48)).toBe('ready');
    expect(judgeLogoRaster(raster(64, 20, 0), 48)).toBe('blank');
    expect(judgeLogoRaster(raster(64, 20, 0xff), 48)).toBe('too_dark');
    expect(judgeLogoRaster(raster(576, 20, 0x81), 32)).toBe('invalid'); // wider than 58 mm paper
    expect(judgeLogoRaster(raster(576, 20, 0x81), 48)).toBe('ready');
    expect(judgeLogoRaster(raster(64, 161, 0x81), 48)).toBe('invalid'); // taller than the cap
    expect(judgeLogoRaster(raster(64, 121, 0x81), 32)).toBe('invalid');
    expect(judgeLogoRaster({ width: 10, height: 1, data: new Uint8Array(2) }, 48)).toBe('invalid');
    expect(isPrintableLogo(sparse, 48)).toBe(true);
    expect(isPrintableLogo(raster(64, 20, 0), 48)).toBe(false);
  });

  it('measures black inside the ink box, not the whole picture', () => {
    const r = raster(576, 160, 0);
    for (let y = 10; y < 26; y++) r.data.fill(0xff, y * 72 + 4, y * 72 + 6); // 16×16 solid block
    expect(inkShare(r)).toBe(1);
    expect(inkShare(raster(64, 8, 0xaa))).toBeCloseTo(32 / 63, 5); // box ends at the last dot
    expect(inkShare(raster(64, 8, 0))).toBe(0);
  });

  it('centres a picture across the paper, dot for dot', () => {
    expect([...centreOnPaper({ width: 8, height: 1, data: Uint8Array.of(0x80) }, 24).data]).toEqual([0, 0x80, 0]);
    expect([...centreOnPaper({ width: 8, height: 1, data: Uint8Array.of(0xff) }, 16).data]).toEqual([0x0f, 0xf0]);
    const two = centreOnPaper({ width: 8, height: 2, data: Uint8Array.of(0x01, 0x80) }, 32);
    expect(two.width).toBe(32);
    // Offset 12: dot 7 lands on dot 19 (byte 2), dot 0 on dot 12 (byte 1).
    expect([...two.data]).toEqual([0, 0, 0x10, 0, 0, 0x08, 0, 0]);
    const full = raster(576, 1, 0x81);
    expect(centreOnPaper(full, 576)).toBe(full);
  });
});

describe('logoFingerprint', () => {
  it('matches known FNV-1a values, zero-padded', () => {
    expect(logoFingerprint('')).toBe('0-811c9dc5');
    expect(logoFingerprint('a')).toBe('1-e40c292c');
    expect(logoFingerprint('logo-229')).toBe('8-0003e224');
  });

  it('is stable and tells logos apart', () => {
    const url = `data:image/png;base64,${'iVBORw0KGgo'.repeat(200)}`;
    expect(logoFingerprint(url)).toBe(logoFingerprint(`${url}`));
    expect(logoFingerprint(url)).not.toBe(logoFingerprint(`${url.slice(0, -1)}A`));
    expect(logoFingerprint('ab')).not.toBe(logoFingerprint('ba'));
  });

  it('always has the same shape', () => {
    let seed = 1;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let i = 0; i < 300; i++) {
      const s = Array.from({ length: next() % 64 }, () => String.fromCharCode(32 + (next() % 95))).join('');
      expect(logoFingerprint(s)).toMatch(/^[0-9a-z]{1,8}-[0-9a-f]{8}$/);
    }
  });
});
