import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  PrintPolicySchema,
  PrinterConnectionConfigSchema,
  ReceiptBrandingSchema,
  getKitchenPrinterConfig,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptPrinterConfig,
  setKitchenPrinterConfig,
  setPrintPolicy,
  setReceiptBranding,
  setReceiptPrinterConfig,
} from '../../services/printer-config.js';
import { printSpooler } from '../../services/print-spooler.js';
import { isSystemPrintingSupported, listSystemPrinters } from '../../services/system-printers.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

function requireSettingsManage(): AuthenticatedUser {
  const session = requireSession();
  if (!hasCapability(session.role, 'settings.manage')) {
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
    });
  });

  defineHandler('printer:setConfig', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = PrinterConnectionConfigSchema.safeParse(payload.config);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setReceiptPrinterConfig(ctx.db, parsed.data);
    printSpooler.resetAdapter();
    return ok({ ok: true } as const);
  });

  defineHandler('printer:setBranding', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = ReceiptBrandingSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setReceiptBranding(ctx.db, parsed.data);
    return ok({ ok: true } as const);
  });

  defineHandler('printer:setPolicy', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = PrintPolicySchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setPrintPolicy(ctx.db, parsed.data);
    return ok({ ok: true } as const);
  });

  defineHandler('printer:setKitchenPrinter', ctx, (_ctx, payload) => {
    requireSettingsManage();
    if (payload.config === null) {
      setKitchenPrinterConfig(ctx.db, null);
    } else {
      const parsed = PrinterConnectionConfigSchema.safeParse(payload.config);
      if (!parsed.success) {
        throw new IpcGuardError({
          code: 'validation_failed',
          message: parsed.error.errors.map((e) => e.message).join(', '),
        });
      }
      setKitchenPrinterConfig(ctx.db, parsed.data);
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
