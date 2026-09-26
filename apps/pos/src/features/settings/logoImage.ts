/**
 * Turns the file the owner picks into the logo the till stores.
 *
 * The generic ImagePicker squeezed every picture into a JPEG, so a logo on a
 * transparent background came back on solid black, and its round preview
 * cut the corners off. A logo is kept whole here:
 *  - PNG, JPG, WebP and SVG are accepted; an SVG is drawn at full size so it
 *    stays sharp;
 *  - the shape is never changed (no cropping, no squashing), only scaled so
 *    the longest side is at most 512 px;
 *  - empty transparent margins around the artwork are trimmed, so the logo
 *    fills the space it is shown in;
 *  - transparency is kept (PNG); a picture with none is stored as a JPEG,
 *    which is smaller.
 */

const MAX_SIDE = 512;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Stored logos stay small: the value travels with every backup and to the PIN screen. */
const MAX_DATA_URL_CHARS = 600_000;

export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.svg';

const UNREADABLE = "That file isn't a picture the till can read. Use a PNG, JPG or SVG file.";

interface Loaded {
  image: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

export async function prepareLogo(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('That picture is too big (over 15 MB). Save a smaller copy and try again.');
  }
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  const src = isSvg ? await loadSvg(file) : await loadRaster(file);
  try {
    if (!src.width || !src.height) throw new Error(UNREADABLE);
    const longest = Math.max(src.width, src.height);
    // A drawing (SVG) is rendered at full size; a photo is only ever shrunk.
    const scale = isSvg ? MAX_SIDE / longest : Math.min(1, MAX_SIDE / longest);
    const canvas = drawScaled(src.image, Math.round(src.width * scale), Math.round(src.height * scale));
    return encode(trimTransparentEdges(canvas));
  } finally {
    src.close();
  }
}

async function loadRaster(file: File): Promise<Loaded> {
  try {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    throw new Error(UNREADABLE);
  }
}

/** How wide a frame `height` px tall should be for a logo: never narrower than square. */
export function logoFrameWidth(aspect: number | null, height: number, maxWidth: number): number {
  const want = aspect ? height * aspect : height;
  return Math.round(Math.max(Math.min(want, maxWidth), Math.min(height, maxWidth)));
}

/** Width and height an SVG asks for, from its own attributes or its viewBox. */
export function svgSize(svgText: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(svgText)?.[0] ?? '';
  const attr = (name: string): string | null => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
    return m?.[1] ?? null;
  };
  const px = (v: string | null): number | null => {
    if (!v || /%/.test(v)) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = px(attr('width'));
  const h = px(attr('height'));
  const vb = (attr('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbW = vb.length === 4 && Number.isFinite(vb[2]) && vb[2]! > 0 ? vb[2]! : null;
  const vbH = vb.length === 4 && Number.isFinite(vb[3]) && vb[3]! > 0 ? vb[3]! : null;
  if (w && h) return { width: w, height: h };
  if (vbW && vbH) {
    if (w) return { width: w, height: (w * vbH) / vbW };
    if (h) return { width: (h * vbW) / vbH, height: h };
    return { width: vbW, height: vbH };
  }
  return { width: w ?? MAX_SIDE, height: h ?? MAX_SIDE };
}

async function loadSvg(file: File): Promise<Loaded> {
  const text = await file.text();
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) throw new Error(UNREADABLE);
  const size = svgSize(text);
  const scale = MAX_SIDE / Math.max(size.width, size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  // Ask the SVG to draw itself at the size we render it, so it stays sharp;
  // its viewBox (if any) keeps the proportions.
  let sizedTag = tag.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
  if (!/\sviewBox\s*=/i.test(sizedTag)) {
    sizedTag = sizedTag.replace(/^<svg\b/i, `<svg viewBox="0 0 ${size.width} ${size.height}"`);
  }
  sizedTag = sizedTag.replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  const url = URL.createObjectURL(new Blob([text.replace(tag, sizedTag)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(UNREADABLE);
  }
  return { image: img, width, height, close: () => URL.revokeObjectURL(url) };
}

function drawScaled(image: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This computer could not prepare the picture. Try again.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Bounding box of the pixels that are not (almost) fully transparent. */
export function opaqueBounds(
  alphaAt: (x: number, y: number) => number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, y) > 8) {
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

function trimTransparentEdges(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const box = opaqueBounds((x, y) => data[(y * width + x) * 4 + 3] ?? 0, width, height);
  if (!box) throw new Error('That picture is empty (it is completely transparent).');
  // Keep a hair of breathing room so nothing touches the edge of its frame.
  const pad = Math.round(Math.max(box.w, box.h) * 0.02);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(width, box.x + box.w + pad) - x;
  const h = Math.min(height, box.y + box.h + pad) - y;
  if (x === 0 && y === 0 && w === width && h === height) return canvas;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')?.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < 250) return true;
  }
  return false;
}

function encode(canvas: HTMLCanvasElement): string {
  let c = canvas;
  for (;;) {
    const url = hasTransparency(c) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
    if (url.length <= MAX_DATA_URL_CHARS || Math.max(c.width, c.height) <= 160) return url;
    c = drawScaled(c, Math.round(c.width * 0.8), Math.round(c.height * 0.8));
  }
}
