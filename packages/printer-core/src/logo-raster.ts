/**
 * The shop logo as a 1-bit picture for a thermal receipt printer.
 *
 * PURE — no DOM, no Node, no Buffer. The renderer decodes the stored logo
 * into RGBA pixels with a canvas and hands them here; the main process only
 * validates and prints the result. One piece of code makes both the preview
 * on screen and the dots on paper, so the two always match.
 *
 * What happens to a logo (LOGO_RASTER_ALGO 2):
 *  1. Each pixel gets a darkness 0..255, as if printed on white paper: see-
 *     through is paper, and bright saturated colours (yellow, orange) count
 *     as ink through their colourfulness instead of vanishing.
 *  2. A picture on a solid black background (logos saved by older tills: the
 *     old picker turned see-through parts black, holes inside letters
 *     included; or a JPEG uploaded that way) gets the near-black turned back
 *     into paper. Only when the black joined to the border is a real
 *     background — a thin black frame drawn round a logo stays artwork.
 *  3. Small marks far from the artwork (a watermark in a corner) are dropped,
 *     so they neither print nor shrink the logo.
 *  4. The ink is cropped, fitted into the paper's logo box and resampled.
 *  5. One tone prints solid (a plain threshold: no pinholes in flat colour),
 *     unless it is a light colour that would print as a big black block: that
 *     prints as an even dot pattern, so the shape and anything cut out of it
 *     still show. Two clearly different tones: the darker prints solid, the
 *     lighter as an even dot pattern with a one-dot white gap around the
 *     darker, so dark lettering on a coloured badge stays readable.
 */

import type { PrinterWidth } from '@cheeseoclock/shared-types';

/** 1-bit picture, row-major, width/8 bytes per row, leftmost pixel in the high bit, 1 = black. */
export interface MonoRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Bump when the conversion changes: tills redraw older pictures on their own. */
export const LOGO_RASTER_ALGO = 2;

export interface LogoBox {
  /** Full printable width in dots: Font A is 12 dots a column (32 cols = 384, 48 cols = 576). */
  maxWidth: number;
  /** Tallest the logo may be, so it doesn't eat paper (8 dots = 1 mm at 203 dpi). */
  maxHeight: number;
}

export const LOGO_BOX: Record<PrinterWidth, LogoBox> = {
  32: { maxWidth: 384, maxHeight: 120 }, // 58 mm paper, at most 15 mm tall
  48: { maxWidth: 576, maxHeight: 160 }, // 80 mm paper, at most 20 mm tall
};

export function logoBox(paper: PrinterWidth): LogoBox {
  return LOGO_BOX[paper] ?? LOGO_BOX[48];
}

/**
 * Past this share of black inside the logo's own outline it would print as a
 * big black block (a logo still on the old black backdrop, a solid badge):
 * slow, hot, streaky and nothing like the logo. Such a picture is not printed.
 * Heavy bold lettering fills about half of its outline, so the line sits above it.
 */
export const LOGO_MAX_INK_SHARE = 0.6;

/** Darkness at or below this is paper (JPEG noise on white stays under it). */
const PAPER_D = 20;
/** A small logo is never blown up more than this. */
const MAX_UPSCALE = 4;

// Old black backdrop: "near-black" and how much of the border must be it.
const BACKDROP_LUM = 48;
const BACKDROP_CHROMA = 48;
const BACKDROP_BORDER_SHARE = 0.9;
/**
 * The near-black joined to the border must cover at least this share of the
 * picture to be a background. A black frame drawn round a logo is a thin strip
 * (a few %); the old backdrop fills everything around the artwork — even round
 * a circular badge that touches all four edges, the corners are over 21%.
 */
const BACKDROP_MIN_AREA = 0.2;
/** Only undo the backdrop if at least this share of the picture is still ink afterwards. */
const BACKDROP_MIN_KEPT = 0.01;

/** Marks further than this (share of the longest side) from the rest are separate. */
const SPECK_GAP = 0.05;
/** A separate group with less than this share of all the ink is a stray mark. */
const SPECK_SHARE = 0.01;

/** 3×3 darkness range below which a pixel is inside a flat area (not an edge). */
const EDGE_RANGE = 40;
/** Two tones must differ by at least this much darkness to be treated apart. */
const TONE_GAP = 64;
const MIN_LIGHT_SHARE = 0.1;
const MIN_DARK_SHARE = 0.02;
const MIN_TONE_PIXELS = 24;
/** A lighter tone at least this dark (relative to the darker) prints solid; at most SNAP_WHITE, not at all. */
const SNAP_SOLID = 0.75;
const SNAP_WHITE = 0.15;
/**
 * A single tone lighter than this (yellow, orange and other bright colours are
 * about 128) that would print as a big block prints as an even tint instead.
 * Darker tones stay solid: a black or dark block is judged too dark to print.
 */
const LIGHT_FILL_MAX = 160;
/** How much of the paper such a tint covers: always visible, never a block. */
const TINT_MIN = 0.25;
const TINT_MAX = 0.5;

/** 8×8 ordered-dither matrix; a pixel prints when its level is above (v + 0.5) / 64. */
const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28,
  52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7,
  39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 1; i < 256; i++) t[i] = (i & 1) + (t[i >> 1] ?? 0);
  return t;
})();

// -----------------------------------------------------------------------------
// Pixels

function composite(c: number, k: number): number {
  return c * k + 255 * (1 - k);
}

/**
 * How dark a pixel prints, 0 (paper) .. 255 (black). Straight (not
 * premultiplied) alpha, laid over white paper. Luminance for greys; for a
 * colour, at least half its colourfulness, so pure yellow still counts as ink.
 */
export function pixelDarkness(r: number, g: number, b: number, a: number): number {
  const k = Math.max(0, Math.min(255, a)) / 255;
  const rr = composite(r, k);
  const gg = composite(g, k);
  const bb = composite(b, k);
  const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
  const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
  return Math.round(Math.max(0, Math.min(255, Math.max(255 - lum, chroma / 2))));
}

function darknessMap(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < d.length; p++, i += 4) {
    d[p] = pixelDarkness(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0, rgba[i + 3] ?? 0);
  }
  return d;
}

/** Bounding box of the ink (darkness above paper), or null when there is none. */
export function inkBounds(
  d: ArrayLike<number>,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((d[y * w + x] ?? 0) > PAPER_D) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Undo a solid black background (the old picker's backdrop). The picture sits
 * on one when at least 90% of the border is near-black AND the near-black
 * joined to the border covers a fifth of the picture or more — a thin black
 * frame round a light logo is artwork, not a background. On the old backdrop
 * every see-through part of the logo became the same black — the holes inside
 * letters and shapes too, not only the area joined to the border. Black
 * artwork can't be told apart from it any more, so all near-black becomes
 * paper. Left alone when that would leave (almost) nothing, e.g. black
 * lettering on the black: the picture is then judged too dark to print.
 * Returns whether it changed anything.
 */
export function removeDarkBackdrop(
  d: Uint8Array,
  rgba: ArrayLike<number>,
  w: number,
  h: number,
): boolean {
  const n = w * h;
  const near = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const k = Math.max(0, Math.min(255, rgba[i + 3] ?? 0)) / 255;
    const r = composite(rgba[i] ?? 0, k);
    const g = composite(rgba[i + 1] ?? 0, k);
    const b = composite(rgba[i + 2] ?? 0, k);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    near[p] = lum < BACKDROP_LUM && chroma < BACKDROP_CHROMA ? 1 : 0;
  }

  let ring = 0;
  let dark = 0;
  const onBorder = (p: number) => {
    ring++;
    dark += near[p] ?? 0;
  };
  for (let x = 0; x < w; x++) {
    onBorder(x);
    if (h > 1) onBorder((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    onBorder(y * w);
    if (w > 1) onBorder(y * w + w - 1);
  }
  if (dark < ring * BACKDROP_BORDER_SHARE) return false;

  // How much near-black is joined to the border (4-neighbour flood fill).
  const joined = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  let area = 0;
  const reach = (p: number) => {
    if (near[p] && !joined[p]) {
      joined[p] = 1;
      stack[sp++] = p;
      area++;
    }
  };
  for (let x = 0; x < w; x++) {
    reach(x);
    reach((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    reach(y * w);
    reach(y * w + w - 1);
  }
  while (sp > 0) {
    const p = stack[--sp]!;
    const x = p % w;
    if (x > 0) reach(p - 1);
    if (x < w - 1) reach(p + 1);
    if (p >= w) reach(p - w);
    if (p < n - w) reach(p + w);
  }
  if (area < n * BACKDROP_MIN_AREA) return false;

  let kept = 0;
  for (let p = 0; p < n; p++) if (!near[p] && (d[p] ?? 0) > PAPER_D) kept++;
  if (kept < n * BACKDROP_MIN_KEPT) return false;
  for (let p = 0; p < n; p++) if (near[p]) d[p] = 0;
  return true;
}

/**
 * Drop small marks that sit apart from the artwork. Ink within 5% of the
 * longest side of other ink belongs with it (so the letters of a line of text
 * stay together); a group holding under 1% of all the ink, away from the
 * rest, is a stray mark. Returns how many pixels were cleared.
 */
export function dropStraySpecks(d: Uint8Array, w: number, h: number): number {
  const n = w * h;
  let total = 0;
  for (let p = 0; p < n; p++) if ((d[p] ?? 0) > PAPER_D) total++;
  if (total === 0) return 0;
  const r = Math.max(1, Math.ceil((SPECK_GAP * Math.max(w, h)) / 2));

  // Grow every ink pixel into a (2r+1)² square: marks closer than 2r merge.
  const across = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) if ((d[row + x] ?? 0) > PAPER_D) count++;
    for (let x = 0; x < w; x++) {
      across[row + x] = count > 0 ? 1 : 0;
      const add = x + r + 1;
      const drop = x - r;
      if (add < w && (d[row + add] ?? 0) > PAPER_D) count++;
      if (drop >= 0 && (d[row + drop] ?? 0) > PAPER_D) count--;
    }
  }
  const grown = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) count += across[y * w + x] ?? 0;
    for (let y = 0; y < h; y++) {
      grown[y * w + x] = count > 0 ? 1 : 0;
      const add = y + r + 1;
      const drop = y - r;
      if (add < h) count += across[add * w + x] ?? 0;
      if (drop >= 0) count -= across[drop * w + x] ?? 0;
    }
  }

  // Label the grown groups.
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let groups = 0;
  for (let start = 0; start < n; start++) {
    if (!grown[start] || label[start]) continue;
    groups++;
    let sp = 0;
    label[start] = groups;
    stack[sp++] = start;
    while (sp > 0) {
      const p = stack[--sp]!;
      const x = p % w;
      const visit = (q: number) => {
        if (grown[q] && !label[q]) {
          label[q] = groups;
          stack[sp++] = q;
        }
      };
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < n - w) visit(p + w);
    }
  }
  if (groups <= 1) return 0;

  const ink = new Float64Array(groups + 1);
  for (let p = 0; p < n; p++) if ((d[p] ?? 0) > PAPER_D) ink[label[p]!]!++;
  let main = 1;
  for (let g = 2; g <= groups; g++) if ((ink[g] ?? 0) > (ink[main] ?? 0)) main = g;
  let dropped = 0;
  for (let p = 0; p < n; p++) {
    const g = label[p]!;
    if ((d[p] ?? 0) > PAPER_D && g !== main && (ink[g] ?? 0) < total * SPECK_SHARE) {
      d[p] = 0;
      dropped++;
    }
  }
  return dropped;
}

/** The logo's ink after clean-up, cropped tight: darkness per pixel. */
export interface LogoInk {
  d: Uint8Array;
  width: number;
  height: number;
  /** A solid black background was taken away. */
  repaired: boolean;
}

export interface LogoInkOptions {
  /**
   * Whether the picture can be sitting on a solid black background (step 2).
   * False for one stored with transparency (a PNG): its black is artwork. The
   * old picker, and the till for a picture with no transparency, store JPEGs.
   * Default true.
   */
  mayHaveBlackBackground?: boolean;
}

/**
 * Steps 1–3 and the crop, from straight-alpha RGBA (what a canvas's
 * getImageData returns). Null when there is no ink at all.
 */
export function extractLogoInk(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  opts: LogoInkOptions = {},
): LogoInk | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('Picture size must be whole pixels');
  }
  if (rgba.length !== width * height * 4) throw new RangeError('Picture size does not match its pixels');
  const d = darknessMap(rgba, width, height);
  const repaired = opts.mayHaveBlackBackground !== false && removeDarkBackdrop(d, rgba, width, height);
  dropStraySpecks(d, width, height);
  const box = inkBounds(d, width, height);
  if (!box) return null;
  const out = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    out.set(d.subarray((box.y + y) * width + box.x, (box.y + y) * width + box.x + box.w), y * box.w);
  }
  return { d: out, width: box.w, height: box.h, repaired };
}

// -----------------------------------------------------------------------------
// Size

export interface LogoFit {
  /** Picture width: the drawn width rounded up to a whole byte. */
  width: number;
  height: number;
  /** Where the logo starts inside that width (centred). */
  drawX: number;
  drawWidth: number;
}

/** Fit a srcW×srcH logo into the box: whole logo, same shape, at most 4× bigger. */
export function fitLogo(srcW: number, srcH: number, box: LogoBox): LogoFit {
  const scale = Math.min(box.maxWidth / srcW, box.maxHeight / srcH, MAX_UPSCALE);
  const drawWidth = clamp(Math.round(srcW * scale), 1, box.maxWidth);
  const height = clamp(Math.round(srcH * scale), 1, box.maxHeight);
  const width = Math.min(box.maxWidth, Math.ceil(drawWidth / 8) * 8);
  const drawX = Math.floor((width - drawWidth) / 2);
  return { width, height, drawX, drawWidth };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** For each output index: the source indices it reads and their weights. */
function axisTaps(n: number, m: number): { idx: number[][]; wt: number[][] } {
  const idx: number[][] = [];
  const wt: number[][] = [];
  if (n > m) {
    // Shrinking: average the source pixels each output pixel covers.
    const s = n / m;
    for (let j = 0; j < m; j++) {
      const start = j * s;
      const end = start + s;
      const is: number[] = [];
      const ws: number[] = [];
      for (let i = Math.floor(start); i < Math.min(n, Math.ceil(end)); i++) {
        const cover = Math.min(i + 1, end) - Math.max(i, start);
        if (cover > 0) {
          is.push(i);
          ws.push(cover / s);
        }
      }
      idx.push(is);
      wt.push(ws);
    }
  } else {
    // Growing (or same size): blend the two nearest source pixels.
    for (let j = 0; j < m; j++) {
      const pos = ((j + 0.5) * n) / m - 0.5;
      const i0 = Math.floor(pos);
      const f = pos - i0;
      idx.push([clamp(i0, 0, n - 1), clamp(i0 + 1, 0, n - 1)]);
      wt.push([1 - f, f]);
    }
  }
  return { idx, wt };
}

function resample(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const tx = axisTaps(sw, dw);
  const across = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let j = 0; j < dw; j++) {
      const is = tx.idx[j]!;
      const ws = tx.wt[j]!;
      let v = 0;
      for (let t = 0; t < is.length; t++) v += (src[y * sw + is[t]!] ?? 0) * ws[t]!;
      across[y * dw + j] = v;
    }
  }
  const ty = axisTaps(sh, dh);
  const out = new Float32Array(dw * dh);
  for (let j = 0; j < dh; j++) {
    const is = ty.idx[j]!;
    const ws = ty.wt[j]!;
    for (let x = 0; x < dw; x++) {
      let v = 0;
      for (let t = 0; t < is.length; t++) v += (across[is[t]! * dw + x] ?? 0) * ws[t]!;
      out[j * dw + x] = v;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Black and white

function histQuantile(hist: Uint32Array, lo: number, hi: number, q: number): number {
  let count = 0;
  for (let i = lo; i <= hi; i++) count += hist[i] ?? 0;
  if (count === 0) return lo;
  const want = q * count;
  let seen = 0;
  for (let i = lo; i <= hi; i++) {
    seen += hist[i] ?? 0;
    if (seen >= want) return i;
  }
  return hi;
}

/** Otsu's split of hist[lo..255]: the last bin of the lighter class. */
function otsuSplit(hist: Uint32Array, lo: number): number {
  let total = 0;
  let sum = 0;
  for (let i = lo; i < 256; i++) {
    total += hist[i] ?? 0;
    sum += i * (hist[i] ?? 0);
  }
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let split = lo;
  for (let t = lo; t < 255; t++) {
    wB += hist[t] ?? 0;
    sumB += t * (hist[t] ?? 0);
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    const diff = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * diff * diff;
    if (between > best) {
      best = between;
      split = t;
    }
  }
  return split;
}

/**
 * Step 5: darkness (0..255 per dot, width a multiple of 8) to black and white.
 * Throws RangeError on a size that doesn't match.
 */
export function darknessToMonoRaster(g: ArrayLike<number>, width: number, height: number): MonoRaster {
  if (!Number.isInteger(width) || width < 8 || width % 8 !== 0 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Picture width must be a whole number of bytes');
  }
  if (g.length !== width * height) throw new RangeError('Picture size does not match its pixels');
  const n = width * height;
  const bpr = width / 8;
  const data = new Uint8Array(bpr * height);
  const at = (x: number, y: number) => g[y * width + x] ?? 0;

  // Tones are read from the flat insides of shapes, not their soft edges.
  const flat = new Uint32Array(256);
  const all = new Uint32Array(256);
  let flatCount = 0;
  let inkCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = at(x, y);
      if (v <= PAPER_D) continue;
      const bin = clamp(Math.round(v), 0, 255);
      inkCount++;
      all[bin]!++;
      let lo = 255;
      let hi = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const u = at(xx, yy);
          if (u < lo) lo = u;
          if (u > hi) hi = u;
        }
      }
      if (hi - lo < EDGE_RANGE) {
        flat[bin]!++;
        flatCount++;
      }
    }
  }
  if (inkCount === 0) return { width, height, data };

  const first = PAPER_D + 1;
  const useFlat = flatCount >= Math.max(MIN_TONE_PIXELS, 0.05 * inkCount);
  let two = false;
  let light = 0;
  let dark = 0;
  if (useFlat) {
    const split = otsuSplit(flat, first);
    let nA = 0;
    for (let i = first; i <= split; i++) nA += flat[i] ?? 0;
    const nB = flatCount - nA;
    if (nA >= MIN_TONE_PIXELS && nB >= MIN_TONE_PIXELS) {
      light = histQuantile(flat, first, split, 0.5);
      dark = histQuantile(flat, split + 1, 255, 0.5);
      two =
        dark - light >= TONE_GAP &&
        nA >= flatCount * MIN_LIGHT_SHARE &&
        nB >= flatCount * MIN_DARK_SHARE;
    }
  }

  const set = (x: number, y: number) => {
    const i = y * bpr + (x >> 3);
    data[i] = (data[i] ?? 0) | (0x80 >> (x & 7));
  };

  if (!two) {
    // One tone: everything at least half as dark as it prints solid.
    const tone = useFlat ? histQuantile(flat, first, 255, 0.5) : histQuantile(all, first, 255, 0.9);
    const thr = PAPER_D + 0.5 * (tone - PAPER_D);
    const inShape = (x: number, y: number) => {
      const v = at(x, y);
      return v > PAPER_D && v >= thr;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) if (inShape(x, y)) set(x, y);
    }
    const solid = { width, height, data };
    if (tone >= LIGHT_FILL_MAX || inkShare(solid) <= LOGO_MAX_INK_SHARE) return solid;
    // A light colour filling its outline (a yellow badge) would be a black
    // block, and then not print at all: print the same shape as an even tint,
    // so the badge and anything cut out of it still show.
    const level = clamp((tone - PAPER_D) / (255 - PAPER_D), TINT_MIN, TINT_MAX);
    data.fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (inShape(x, y) && level > (BAYER8[(y & 7) * 8 + (x & 7)]! + 0.5) / 64) set(x, y);
      }
    }
    return solid;
  }

  // Two tones: the darker solid; the lighter as an even pattern (or solid /
  // nothing at the ends), kept one dot away from the darker.
  const mid = (light + dark) / 2;
  const lightThr = PAPER_D + 0.5 * (light - PAPER_D);
  let level = (light - PAPER_D) / (dark - PAPER_D);
  if (level >= SNAP_SOLID) level = 1;
  else if (level <= SNAP_WHITE) level = 0;
  const isDark = new Uint8Array(n);
  for (let p = 0; p < n; p++) isDark[p] = (g[p] ?? 0) >= mid ? 1 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isDark[y * width + x]) {
        set(x, y);
        continue;
      }
      if (at(x, y) < lightThr || level === 0) continue;
      let touchesDark = false;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1) && !touchesDark; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          if (isDark[yy * width + xx]) {
            touchesDark = true;
            break;
          }
        }
      }
      if (touchesDark) continue;
      if (level === 1 || level > (BAYER8[(y & 7) * 8 + (x & 7)]! + 0.5) / 64) set(x, y);
    }
  }
  return { width, height, data };
}

/** Steps 4–5 for one paper width. Null when nothing would print. */
export function rasteriseLogoInk(ink: LogoInk, paper: PrinterWidth): MonoRaster | null {
  const fit = fitLogo(ink.width, ink.height, logoBox(paper));
  const scaled = resample(ink.d, ink.width, ink.height, fit.drawWidth, fit.height);
  const g = new Float32Array(fit.width * fit.height);
  for (let y = 0; y < fit.height; y++) {
    g.set(scaled.subarray(y * fit.drawWidth, (y + 1) * fit.drawWidth), y * fit.width + fit.drawX);
  }
  const r = darknessToMonoRaster(g, fit.width, fit.height);
  return rasterHasInk(r) ? r : null;
}

/** The whole conversion for one paper width, from straight-alpha RGBA. */
export function rasteriseLogo(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  paper: PrinterWidth,
  opts: LogoInkOptions = {},
): MonoRaster | null {
  const ink = extractLogoInk(rgba, width, height, opts);
  return ink ? rasteriseLogoInk(ink, paper) : null;
}

// -----------------------------------------------------------------------------
// Checks

export function isValidMonoRaster(r: unknown): r is MonoRaster {
  if (!r || typeof r !== 'object') return false;
  const { width, height, data } = r as Partial<MonoRaster>;
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    width % 8 === 0 &&
    height >= 1 &&
    data instanceof Uint8Array &&
    data.length === (width / 8) * height
  );
}

export function rasterHasInk(r: MonoRaster): boolean {
  for (let i = 0; i < r.data.length; i++) if (r.data[i] !== 0) return true;
  return false;
}

/** Share of black dots inside the box around the black (0 when blank). */
export function inkShare(r: MonoRaster): number {
  const bpr = r.width / 8;
  let minX = r.width;
  let maxX = -1;
  let minY = r.height;
  let maxY = -1;
  let ones = 0;
  for (let y = 0; y < r.height; y++) {
    for (let xb = 0; xb < bpr; xb++) {
      const byte = r.data[y * bpr + xb] ?? 0;
      if (!byte) continue;
      ones += POPCOUNT[byte] ?? 0;
      let first = 0;
      while (!(byte & (0x80 >> first))) first++;
      let last = 7;
      while (!(byte & (0x80 >> last))) last--;
      minX = Math.min(minX, xb * 8 + first);
      maxX = Math.max(maxX, xb * 8 + last);
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  if (maxX < 0) return 0;
  return ones / ((maxX - minX + 1) * (maxY - minY + 1));
}

export type LogoRasterVerdict = 'invalid' | 'blank' | 'too_dark' | 'ready';

/** Whether a picture can go on this paper, and if not, why. */
export function judgeLogoRaster(r: unknown, paper: PrinterWidth): LogoRasterVerdict {
  const box = logoBox(paper);
  if (!isValidMonoRaster(r) || r.width > box.maxWidth || r.height > box.maxHeight) return 'invalid';
  if (!rasterHasInk(r)) return 'blank';
  if (inkShare(r) > LOGO_MAX_INK_SHARE) return 'too_dark';
  return 'ready';
}

export function isPrintableLogo(r: unknown, paper: PrinterWidth): r is MonoRaster {
  return judgeLogoRaster(r, paper) === 'ready';
}

/**
 * The picture widened to `dots` with the logo in the middle. Sent full width,
 * the logo is centred on every printer, including ones that ignore ESC a for
 * pictures. A picture already that wide (or wider) comes back as it is.
 */
export function centreOnPaper(r: MonoRaster, dots: number): MonoRaster {
  if (r.width >= dots || dots % 8 !== 0) return r;
  const bpr = r.width / 8;
  const outBpr = dots / 8;
  const off = Math.floor((dots - r.width) / 2);
  const data = new Uint8Array(outBpr * r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if ((r.data[y * bpr + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) {
        const ox = x + off;
        const i = y * outBpr + (ox >> 3);
        data[i] = (data[i] ?? 0) | (0x80 >> (ox & 7));
      }
    }
  }
  return { width: dots, height: r.height, data };
}

/**
 * Short, stable name for an exact logo (FNV-1a 32-bit over the UTF-16 code
 * units, plus the length): ties a printer picture to the logo it was made
 * from, identically in the renderer and in main.
 */
export function logoFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length.toString(36)}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
