import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { PrinterConnectionConfig } from '@cheeseoclock/printer-core';

export const PRINTER_RECEIPT_KEY = 'printer.receipt';
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

export function setReceiptPrinterConfig(db: AppDatabase, config: PrinterConnectionConfig): void {
  setSetting(db, PRINTER_RECEIPT_KEY, config);
}

export function getReceiptBranding(db: AppDatabase): ReceiptBranding {
  const raw = getSettingRaw(db, BRANDING_KEY);
  const parsed = ReceiptBrandingSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return ReceiptBrandingSchema.parse({}); // returns defaults
}

export function setReceiptBranding(db: AppDatabase, branding: ReceiptBranding): void {
  setSetting(db, BRANDING_KEY, branding);
}

/** Built-in default — mock printer, so the app prints to disk out of the box. */
export const DEFAULT_RECEIPT_CONFIG: PrinterConnectionConfig = {
  transport: 'network',
  network: { host: 'mock', port: 9100 },
  width: 48,
};
