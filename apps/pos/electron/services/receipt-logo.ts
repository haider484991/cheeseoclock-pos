/**
 * The shop logo on customer receipts — the main-process side.
 *
 * The picture itself is made on screen (the renderer decodes the stored logo
 * with a canvas and runs printer-core's conversion) and saved here under its
 * own settings key, beside `receipt.branding` rather than inside it:
 *  - branding saves are audited with the full before/after JSON, and the
 *    audit log can never be trimmed — a derived picture has no place there;
 *  - a bad picture inside branding would make the whole branding fail to
 *    parse and fall back to the default shop name;
 *  - the picture carries the fingerprint of the exact logo it was made from,
 *    so a picture of an older (or someone else's) logo never prints.
 *
 * PURE: zod, printer-core and Buffer only. It must not import settings-repo
 * (which pulls in the sync repositories), so its test runs on its own.
 */

import { z } from 'zod';
import {
  judgeLogoRaster,
  logoBox,
  logoFingerprint,
  type MonoRaster,
  type TestPageOptions,
} from '@cheeseoclock/printer-core';
import type {
  PrinterConnectionConfig,
  PrinterWidth,
  ReceiptLogoRasterSet,
  ReceiptLogoState,
} from '@cheeseoclock/shared-types';

/** Settings key of the printer's copy of the logo (not audited: derived from the audited logo). */
export const LOGO_RASTER_KEY = 'receipt.logoRaster';
/** Settings key recording which logo went through a test print on which printer. */
export const LOGO_CHECKED_KEY = 'receipt.logoChecked';

/** Largest picture: 576 dots (72 bytes) × 160 rows = 11,520 bytes = 15,360 base64 characters. */
const MAX_DATA_CHARS = Math.ceil((576 / 8) * 160 / 3) * 4;

const FINGERPRINT = /^[0-9a-z]{1,8}-[0-9a-f]{8}$/;

const RasterJsonSchema = z
  .object({
    paperWidth: z.union([z.literal(32), z.literal(48)]),
    width: z.number().int().min(8).max(576).multipleOf(8),
    height: z.number().int().min(1).max(160),
    data: z
      .string()
      .max(MAX_DATA_CHARS)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Logo data is not base64'),
  })
  .superRefine((r, ctx) => {
    const box = logoBox(r.paperWidth);
    if (r.width > box.maxWidth || r.height > box.maxHeight) {
      ctx.addIssue({ code: 'custom', message: 'Logo too big for this paper' });
    }
    if (r.data.length % 4 !== 0 || Buffer.from(r.data, 'base64').length !== (r.width / 8) * r.height) {
      ctx.addIssue({ code: 'custom', message: 'Logo data is the wrong size' });
    }
  });

export const ReceiptLogoRasterSchema: z.ZodType<ReceiptLogoRasterSet> = z.object({
  source: z.string().regex(FINGERPRINT),
  algo: z.number().int().min(1).max(10_000),
  rasters: z
    .array(RasterJsonSchema)
    .max(2)
    .refine((a) => new Set(a.map((r) => r.paperWidth)).size === a.length, 'One picture per paper width'),
});

export interface ResolvedReceiptLogo {
  state: ReceiptLogoState;
  /** The picture to print — only when `state` is 'ready'. */
  raster: MonoRaster | null;
}

/**
 * What the stored picture means for `paperWidth`, given the logo that is set
 * now. Never throws on bad stored data: it just isn't 'ready'.
 */
export function resolveReceiptLogo(input: {
  logoUrl: string | undefined;
  stored: unknown;
  paperWidth: PrinterWidth;
}): ResolvedReceiptLogo {
  if (!input.logoUrl) return { state: 'none', raster: null };
  const parsed = ReceiptLogoRasterSchema.safeParse(input.stored);
  if (!parsed.success || parsed.data.source !== logoFingerprint(input.logoUrl)) {
    return { state: 'not_ready', raster: null };
  }
  const json = parsed.data.rasters.find((r) => r.paperWidth === input.paperWidth);
  // The screen made no picture for this width: nothing on it would print.
  if (!json) return { state: 'blank', raster: null };
  const raster: MonoRaster = {
    width: json.width,
    height: json.height,
    data: new Uint8Array(Buffer.from(json.data, 'base64')),
  };
  switch (judgeLogoRaster(raster, input.paperWidth)) {
    case 'ready':
      return { state: 'ready', raster };
    case 'too_dark':
      return { state: 'too_dark', raster: null };
    case 'blank':
      return { state: 'blank', raster: null };
    default:
      return { state: 'not_ready', raster: null };
  }
}

/** Which logo a valid stored set was made from (no picture data), or null. */
export function logoInfo(stored: unknown): { source: string; algo: number } | null {
  const parsed = ReceiptLogoRasterSchema.safeParse(stored);
  return parsed.success ? { source: parsed.data.source, algo: parsed.data.algo } : null;
}

/** Stable key for a printer setup: a test print on one printer says nothing about another. */
export function printerKey(config: PrinterConnectionConfig): string {
  return logoFingerprint(JSON.stringify(config));
}

const LogoCheckedSchema = z.object({ source: z.string(), printer: z.string() });

/** The value to store once a test print with this logo went through on this printer. */
export function logoCheckedValue(logoUrl: string, config: PrinterConnectionConfig) {
  return { source: logoFingerprint(logoUrl), printer: printerKey(config) };
}

export function isLogoChecked(
  stored: unknown,
  logoUrl: string | undefined,
  config: PrinterConnectionConfig,
): boolean {
  if (!logoUrl) return false;
  const parsed = LogoCheckedSchema.safeParse(stored);
  return (
    parsed.success &&
    parsed.data.source === logoFingerprint(logoUrl) &&
    parsed.data.printer === printerKey(config)
  );
}

/** What the test page says about the logo. ASCII, and fits 32 columns after "Logo". */
export const LOGO_TEST_NOTE: Record<ReceiptLogoState, string> = {
  ready: 'should be above',
  none: 'none set',
  not_ready: 'not ready yet',
  blank: 'too light to print',
  too_dark: 'too dark to print',
};

/**
 * The logo part of a receipt test page. The picture prints whenever it is
 * usable — even with the setting off — so a printer can be checked before the
 * logo is switched on for customers.
 */
export function logoTestOptions(logo: ResolvedReceiptLogo, enabled: boolean): TestPageOptions {
  return {
    logo: logo.state === 'ready' ? logo.raster : null,
    logoNote: LOGO_TEST_NOTE[logo.state],
    ...(logo.state === 'none' ? {} : { logoOnReceipts: enabled }),
  };
}
