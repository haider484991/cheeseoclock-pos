/**
 * The shop logo for the receipt printer, made on screen.
 *
 * The main process has no image decoder, so the renderer — whose canvas reads
 * every picture the till stores — turns the saved logo into pixels, and
 * printer-core's conversion (the same code main prints with) makes the 1-bit
 * pictures. They are saved beside the branding, tied to the exact logo by its
 * fingerprint. The preview on the Shop & logo tab uses the same pictures, so
 * what the owner sees is what the paper gets.
 */

import {
  LOGO_RASTER_ALGO,
  extractLogoInk,
  judgeLogoRaster,
  logoFingerprint,
  rasteriseLogoInk,
  type LogoInk,
  type MonoRaster,
} from '@cheeseoclock/printer-core';
import type {
  PrinterWidth,
  ReceiptLogoRasterJson,
  ReceiptLogoRasterSet,
  ReceiptLogoStatus,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';

/** Pictures bigger than this are looked at scaled down (stored logos are at most 512 px). */
const MAX_ANALYSIS_SIDE = 1024;
const PAPERS: PrinterWidth[] = [32, 48];

/** Base64 of raw bytes, in chunks (a spread of 11 KB into fromCharCode is asking for trouble). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(s);
}

/**
 * A logo stored as a JPEG has no see-through parts: the old picker saved
 * every logo that way (see-through parts turned black), and the till still
 * does for a picture without transparency. Anything else keeps its transparency.
 */
export function logoIsJpeg(logoUrl: string): boolean {
  return /^data:image\/jpe?g[;,]/i.test(logoUrl);
}

/**
 * What the owner should upload instead of a logo that would print as a black
 * block. A JPEG is usually a logo sitting on a background; a logo that is
 * already see-through is a big filled shape, which a receipt printer can only
 * print solid — the same file again would not help.
 */
export function darkLogoFix(logoUrl: string | null | undefined): string {
  return !logoUrl || logoIsJpeg(logoUrl)
    ? 'the logo again as a PNG with a see-through background'
    : 'an outline or text-only version of the logo';
}

/** Whether the stored printer copy was made from this logo by this version's conversion. */
export function receiptLogoUpToDate(
  logoUrl: string,
  stored: ReceiptLogoStatus['stored'] | undefined,
): boolean {
  return !!stored && stored.source === logoFingerprint(logoUrl) && stored.algo >= LOGO_RASTER_ALGO;
}

/** The printer copy of a logo, from its cleaned-up ink. Pure. */
export function receiptLogoSet(source: string, ink: LogoInk | null): ReceiptLogoRasterSet {
  const rasters: ReceiptLogoRasterJson[] = [];
  if (ink) {
    for (const paperWidth of PAPERS) {
      const r = rasteriseLogoInk(ink, paperWidth);
      if (r) rasters.push({ paperWidth, width: r.width, height: r.height, data: toBase64(r.data) });
    }
  }
  return { source, algo: LOGO_RASTER_ALGO, rasters };
}

// A logo is decoded once and reused by the preview and the save.
const inkCache = new Map<string, Promise<LogoInk | null>>();

/** The logo's ink, straight from the stored data URL. Throws when the picture can't be read. */
export function logoInk(logoUrl: string): Promise<LogoInk | null> {
  const hit = inkCache.get(logoUrl);
  if (hit) return hit;
  const job = decodeInk(logoUrl);
  inkCache.set(logoUrl, job);
  job.catch(() => inkCache.delete(logoUrl));
  // Keep the last two: the saved logo and one being tried out.
  while (inkCache.size > 2) {
    const oldest = inkCache.keys().next().value;
    if (oldest === undefined) break;
    inkCache.delete(oldest);
  }
  return job;
}

async function decodeInk(logoUrl: string): Promise<LogoInk | null> {
  const img = new Image();
  img.src = logoUrl;
  await img.decode();
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('The logo has no size');
  const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No canvas to read the logo');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Left see-through: printer-core lays every pixel over white paper itself.
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  // Only a JPEG can be sitting on a solid black background; in a see-through
  // logo, black is always artwork.
  return extractLogoInk(ctx.getImageData(0, 0, w, h).data, w, h, {
    mayHaveBlackBackground: logoIsJpeg(logoUrl),
  });
}

export async function buildReceiptLogoSet(logoUrl: string): Promise<ReceiptLogoRasterSet> {
  return receiptLogoSet(logoFingerprint(logoUrl), await logoInk(logoUrl));
}

/** Make and save the printer copy of the logo that is set now. Needs a manager or owner login. */
export async function saveReceiptLogo(logoUrl: string): Promise<{ saved: boolean }> {
  return ipc.printer.setLogoRaster(await buildReceiptLogoSet(logoUrl));
}

/** Save the printer copy if it is missing or stale. Never throws: printing works without it. */
export async function ensureReceiptLogo(
  cfg: { branding: { logoUrl?: string }; logo: ReceiptLogoStatus } | undefined,
): Promise<void> {
  const logoUrl = cfg?.branding.logoUrl;
  if (!logoUrl || receiptLogoUpToDate(logoUrl, cfg.logo.stored)) return;
  try {
    await saveReceiptLogo(logoUrl);
  } catch (e) {
    console.warn('Receipt logo not prepared', e);
  }
}

export type LogoPreviewState = 'none' | 'loading' | 'error' | 'blank' | 'too_dark' | 'ready';

export interface LogoPreview {
  state: LogoPreviewState;
  /** The dots as they will print ('ready' and 'too_dark' only). */
  raster: MonoRaster | null;
  /** A solid black background was taken out. */
  repaired: boolean;
}

/** What the printer would make of `logoUrl` on `paper`, for the preview. */
export async function previewReceiptLogo(logoUrl: string, paper: PrinterWidth): Promise<LogoPreview> {
  const ink = await logoInk(logoUrl);
  const raster = ink ? rasteriseLogoInk(ink, paper) : null;
  const verdict = judgeLogoRaster(raster, paper);
  const state: LogoPreviewState = verdict === 'invalid' ? 'blank' : verdict;
  return {
    state,
    raster: state === 'ready' || state === 'too_dark' ? raster : null,
    repaired: ink?.repaired ?? false,
  };
}
