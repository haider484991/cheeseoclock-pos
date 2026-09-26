import { z } from 'zod';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { MonoRaster, PrinterConnectionConfig } from '@cheeseoclock/printer-core';
import type {
  PrintPolicy,
  PrinterWidth,
  ReceiptLogoRasterSet,
  ReceiptLogoStatus,
} from '@cheeseoclock/shared-types';
import {
  LOGO_CHECKED_KEY,
  LOGO_RASTER_KEY,
  isLogoChecked,
  logoCheckedValue,
  logoInfo,
  resolveReceiptLogo,
  type ResolvedReceiptLogo,
} from './receipt-logo.js';

export const PRINTER_RECEIPT_KEY = 'printer.receipt';
export const PRINTER_KITCHEN_KEY = 'printer.kitchen';
export const PRINT_POLICY_KEY = 'printer.policy';
export const BRANDING_KEY = 'receipt.branding';

const TransportSchema = z.enum(['usb', 'network', 'bluetooth', 'serial']);

export const PrinterConnectionConfigSchema = z
  .object({
    transport: TransportSchema,
    network: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    usb: z
      .object({
        // The OS print-queue name (see PrinterConnectionConfig.usb). Kept
        // short and free of control characters — it travels to the RAW
        // print worker on a single line.
        printerName: z
          .string()
          .trim()
          .min(1, 'Pick the printer')
          .max(220)
          // eslint-disable-next-line no-control-regex
          .regex(/^[^\u0000-\u001f\u007f]+$/, 'Printer name has unsupported characters'),
        vendorId: z.number().int().nonnegative().optional(),
        productId: z.number().int().nonnegative().optional(),
      })
      .optional(),
    bluetooth: z
      .object({ address: z.string().min(1), channel: z.number().int().nonnegative().optional() })
      .optional(),
    serial: z
      .object({ path: z.string().min(1), baudRate: z.number().int().positive().optional() })
      .optional(),
    codepage: z.string().optional(),
    width: z.union([z.literal(32), z.literal(48)]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.transport === 'network' && !c.network) {
      ctx.addIssue({ code: 'custom', path: ['network'], message: 'Enter the printer address' });
    }
    if (c.transport === 'usb' && !c.usb) {
      ctx.addIssue({ code: 'custom', path: ['usb'], message: 'Pick the printer' });
    }
  });

export const ReceiptBrandingSchema = z.object({
  storeName: z.string().min(1).default('Cheese O Clock'),
  storeTagline: z.string().optional(),
  branchLine: z.string().optional(),
  phoneLine: z.string().optional(),
  footerLine: z.string().optional(),
  /** Data URL of the company logo (already resized — see ImagePicker). */
  logoUrl: z.string().optional(),
});

export type ReceiptBranding = z.infer<typeof ReceiptBrandingSchema>;

export function getReceiptPrinterConfig(db: AppDatabase): PrinterConnectionConfig | null {
  const raw = getSettingRaw(db, PRINTER_RECEIPT_KEY);
  if (!raw) return null;
  const parsed = PrinterConnectionConfigSchema.safeParse(raw);
  return parsed.success ? (parsed.data as PrinterConnectionConfig) : null;
}

export function setReceiptPrinterConfig(
  db: AppDatabase,
  config: PrinterConnectionConfig,
  actorUserId: string | null = null,
): void {
  setSetting(db, PRINTER_RECEIPT_KEY, config, { actorUserId });
}

export function getReceiptBranding(db: AppDatabase): ReceiptBranding {
  const raw = getSettingRaw(db, BRANDING_KEY);
  const parsed = ReceiptBrandingSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return ReceiptBrandingSchema.parse({}); // returns defaults
}

export function setReceiptBranding(
  db: AppDatabase,
  branding: ReceiptBranding,
  actorUserId: string | null = null,
): void {
  setSetting(db, BRANDING_KEY, branding, { actorUserId });
}

/** Built-in default — mock printer, so the app prints to disk out of the box. */
export const DEFAULT_RECEIPT_CONFIG: PrinterConnectionConfig = {
  transport: 'network',
  network: { host: 'mock', port: 9100 },
  width: 48,
};

/**
 * A second printer for kitchen tickets — a LAN or USB printer at the pass.
 * Unset (null) means kitchen tickets come out of the receipt printer.
 */
export function getKitchenPrinterConfig(db: AppDatabase): PrinterConnectionConfig | null {
  const raw = getSettingRaw(db, PRINTER_KITCHEN_KEY);
  if (!raw) return null;
  const parsed = PrinterConnectionConfigSchema.safeParse(raw);
  return parsed.success ? (parsed.data as PrinterConnectionConfig) : null;
}

export function setKitchenPrinterConfig(
  db: AppDatabase,
  config: PrinterConnectionConfig | null,
  actorUserId: string | null = null,
): void {
  setSetting(db, PRINTER_KITCHEN_KEY, config, { actorUserId });
}

/** What prints automatically, and when — see PrintPolicy in shared-types. */
export const PrintPolicySchema = z.object({
  kitchenTicket: z.boolean().default(true),
  deliveryBillOnDispatch: z.boolean().default(true),
  shopCopy: z.enum(['never', 'delivery', 'always']).default('delivery'),
  // On by default: the owner asked for the logo on receipts. Policies saved
  // before this setting existed read as on.
  logoOnReceipt: z.boolean().default(true),
});

export function getPrintPolicy(db: AppDatabase): PrintPolicy {
  const raw = getSettingRaw(db, PRINT_POLICY_KEY);
  const parsed = PrintPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : PrintPolicySchema.parse({});
}

export function setPrintPolicy(db: AppDatabase, policy: PrintPolicy, actorUserId: string | null = null): void {
  setSetting(db, PRINT_POLICY_KEY, PrintPolicySchema.parse(policy), { actorUserId });
}

// -----------------------------------------------------------------------------
// Shop logo on receipts (see receipt-logo.ts)

/**
 * Save the printer's copy of the logo. Not audited, on purpose: it is a
 * picture derived from the logo, and the logo itself is audited when the
 * owner saves it — like the till's own bookkeeping, not a change anyone made.
 */
export function setReceiptLogoRaster(db: AppDatabase, set: ReceiptLogoRasterSet): void {
  setSetting(db, LOGO_RASTER_KEY, set);
}

/**
 * The logo for a receipt on `paperWidth` paper, and whether receipts print it.
 * Never throws: on any trouble the receipt simply prints without the logo.
 */
export function getReceiptLogo(
  db: AppDatabase,
  paperWidth: PrinterWidth,
  branding: ReceiptBranding = getReceiptBranding(db),
): ResolvedReceiptLogo & { enabled: boolean } {
  try {
    return {
      ...resolveReceiptLogo({
        logoUrl: branding.logoUrl,
        stored: getSettingRaw(db, LOGO_RASTER_KEY),
        paperWidth,
      }),
      enabled: getPrintPolicy(db).logoOnReceipt,
    };
  } catch (e) {
    log.warn('Receipt logo skipped', e);
    return { state: 'not_ready', raster: null, enabled: false };
  }
}

/**
 * The picture a customer receipt on `paperWidth` paper starts with: only when
 * receipts are set to print the logo AND the stored picture is usable. Null
 * otherwise — the receipt then prints without it. Never throws.
 */
export function receiptLogoToPrint(
  db: AppDatabase,
  paperWidth: PrinterWidth,
  branding: ReceiptBranding,
): MonoRaster | null {
  const logo = getReceiptLogo(db, paperWidth, branding);
  return logo.enabled && logo.state === 'ready' ? logo.raster : null;
}

/** What the settings screens show about the logo on this receipt printer. */
export function getReceiptLogoStatus(
  db: AppDatabase,
  config: PrinterConnectionConfig,
  branding: ReceiptBranding = getReceiptBranding(db),
): ReceiptLogoStatus {
  const logo = getReceiptLogo(db, config.width ?? 48, branding);
  return {
    state: logo.state,
    enabled: logo.enabled,
    stored: logoInfo(getSettingRaw(db, LOGO_RASTER_KEY)),
    checked: isLogoChecked(getSettingRaw(db, LOGO_CHECKED_KEY), branding.logoUrl, config),
  };
}

/** A test print with this logo went through on this printer (bookkeeping, not audited). */
export function markReceiptLogoChecked(
  db: AppDatabase,
  logoUrl: string,
  config: PrinterConnectionConfig,
): void {
  setSetting(db, LOGO_CHECKED_KEY, logoCheckedValue(logoUrl, config));
}
