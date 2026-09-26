import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { logoFingerprint } from '@cheeseoclock/printer-core';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  PrintPolicySchema,
  PrinterConnectionConfigSchema,
  ReceiptBrandingSchema,
  getKitchenPrinterConfig,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptLogoStatus,
  getReceiptPrinterConfig,
  setKitchenPrinterConfig,
  setPrintPolicy,
  setReceiptBranding,
  setReceiptLogoRaster,
  setReceiptPrinterConfig,
} from '../../services/printer-config.js';
import { ReceiptLogoRasterSchema } from '../../services/receipt-logo.js';
import { printSpooler } from '../../services/print-spooler.js';
import { testDrawer } from '../../services/drawer-service.js';
import { isSystemPrintingSupported, listSystemPrinters } from '../../services/system-printers.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

// Printers are `printer.manage` (managers and the owner). It used to check
// `settings.manage`, which only the owner has — a manager was told "manager or
// admin" and then refused when the kitchen printer needed changing.
function requirePrinterManage(): AuthenticatedUser {
  const session = requireSession();
  if (!hasCapability(session.role, 'printer.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Printer settings require manager or admin role',
    });
  }
  return session;
}

export function registerPrinterHandlers(ctx: HandlerContext): void {
  defineHandler('printer:getConfig', ctx, () => {
    requireSession();
    const config = getReceiptPrinterConfig(ctx.db) ?? DEFAULT_RECEIPT_CONFIG;
    const branding = getReceiptBranding(ctx.db);
    return ok({
      config,
      branding,
      transports: ['network', 'usb', 'bluetooth', 'serial'] as const,
      mockEnabled: true,
      policy: getPrintPolicy(ctx.db),
      kitchenPrinter: getKitchenPrinterConfig(ctx.db),
      logo: getReceiptLogoStatus(ctx.db, config, branding),
    });
  });

  defineHandler('printer:setConfig', ctx, (_ctx, payload) => {
    const s = requirePrinterManage();
    const parsed = PrinterConnectionConfigSchema.safeParse(payload.config);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setReceiptPrinterConfig(ctx.db, parsed.data, s.id);
    printSpooler.resetAdapter();
    return ok({ ok: true } as const);
  });

  defineHandler('printer:setBranding', ctx, (_ctx, payload) => {
    const s = requirePrinterManage();
    const parsed = ReceiptBrandingSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setReceiptBranding(ctx.db, parsed.data, s.id);
    return ok({ ok: true } as const);
  });

  // The printer's copy of the logo, made on screen. Managers and the owner
  // only: whatever is saved here prints on every customer receipt, so a
  // cashier's login must not be able to put a picture there. The fingerprint
  // check keeps it to a picture of the logo that is set right now.
  defineHandler('printer:setLogoRaster', ctx, (_ctx, payload) => {
    requirePrinterManage();
    const parsed = ReceiptLogoRasterSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: 'The logo could not be prepared for the printer',
      });
    }
    const logoUrl = getReceiptBranding(ctx.db).logoUrl;
    if (!logoUrl || parsed.data.source !== logoFingerprint(logoUrl)) return ok({ saved: false });
    setReceiptLogoRaster(ctx.db, parsed.data);
    return ok({ saved: true });
  });

  defineHandler('printer:setPolicy', ctx, (_ctx, payload) => {
    const s = requirePrinterManage();
    const parsed = PrintPolicySchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setPrintPolicy(ctx.db, parsed.data, s.id);
    return ok({ ok: true } as const);
  });

  defineHandler('printer:setKitchenPrinter', ctx, (_ctx, payload) => {
    const s = requirePrinterManage();
    if (payload.config === null) {
      setKitchenPrinterConfig(ctx.db, null, s.id);
    } else {
      const parsed = PrinterConnectionConfigSchema.safeParse(payload.config);
      if (!parsed.success) {
        throw new IpcGuardError({
          code: 'validation_failed',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        });
      }
      setKitchenPrinterConfig(ctx.db, parsed.data, s.id);
    }
    printSpooler.resetAdapter();
    return ok({ ok: true } as const);
  });

  defineHandler('printer:test', ctx, async (_ctx, payload) => {
    requireSession();
    const result = await printSpooler.testPrintNow(
      payload?.station === 'kitchen' ? 'kitchen' : 'receipt',
    );
    return ok(result);
  });

  // Just the drawer pulse, straight through the receipt printer. Managers and
  // the owner (it opens the till); saved as a "test" drawer open first.
  defineHandler('printer:testDrawer', ctx, async () => {
    const s = requirePrinterManage();
    return ok(await testDrawer(ctx.db, s, ctx.deviceId));
  });

  defineHandler('printer:listSystemPrinters', ctx, async () => {
    requireSession();
    const supported = isSystemPrintingSupported();
    const printers = supported ? await listSystemPrinters() : [];
    return ok({ printers, supported });
  });

  defineHandler('printer:reprint', ctx, (_ctx, payload) => {
    requireSession();
    printSpooler.reprintReceipt(payload.orderId);
    return ok({ enqueued: true } as const);
  });

  defineHandler('printer:reprintKitchen', ctx, (_ctx, payload) => {
    requireSession();
    printSpooler.reprintKitchenTicket(payload.orderId);
    return ok({ enqueued: true } as const);
  });
}
