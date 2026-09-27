import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { logoFingerprint } from '@cheeseoclock/printer-core';
import { assertCounterMayReprint } from '../order-access.js';
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
import { reprintWithApproval } from '../../services/reprint-service.js';
import { reprintCounts } from '../../db/repositories/document-print-repo.js';
import { testDrawer } from '../../services/drawer-service.js';
import { isSystemPrintingSupported, listSystemPrinters } from '../../services/system-printers.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

// Printers are `printer.manage`: the owner's since 2026-09-27 ("managers can't
// see the reports and settings"). A separate capability from `settings.manage`
// so printers can be handed to another role later without the rest of Settings.
function requirePrinterManage(): AuthenticatedUser {
  const session = requireSession();
  if (!hasCapability(session.role, 'printer.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Only the owner can change the printers.',
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

  defineHandler('printer:reprint', ctx, async (_ctx, payload) => {
    const s = requireSession();
    // A counter login reprints only orders it may open (order-access.ts).
    assertCounterMayReprint(ctx.db, s, payload.orderId, 'receipt');
    // DUPLICATE marking, the manager's PIN when needed, the print log: reprint-service.ts.
    return ok(await reprintWithApproval(ctx.db, s, payload));
  });

  defineHandler('printer:reprintKitchen', ctx, (_ctx, payload) => {
    const s = requireSession();
    assertCounterMayReprint(ctx.db, s, payload.orderId, 'kitchen');
    return ok(printSpooler.reprintKitchenTicket(payload.orderId, { requestedByUserId: s.id }));
  });

  // What the print button would print (original or DUPLICATE) and every paper
  // the order had: the same orders as a reprint (order-access.ts).
  defineHandler('printer:orderPapers', ctx, (_ctx, payload) => {
    const s = requireSession();
    const orderId = typeof payload?.orderId === 'string' ? payload.orderId : '';
    if (!orderId) throw new IpcGuardError({ code: 'validation_failed', message: 'Which order?' });
    assertCounterMayReprint(ctx.db, s, orderId, 'receipt');
    try {
      return ok(printSpooler.orderPapers(orderId));
    } catch (e) {
      throw new IpcGuardError({
        code: 'not_found',
        message: e instanceof Error ? e.message : 'Order not found',
      });
    }
  });

  // "Try again" on the failed-print note: that very job again (the till's own
  // paper stays the original). A counter login: only jobs of orders it may
  // reprint (order-access.ts).
  defineHandler('printer:retryJob', ctx, (_ctx, payload) => {
    const s = requireSession();
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : '';
    if (!jobId) throw new IpcGuardError({ code: 'validation_failed', message: 'Which print?' });
    const row = ctx.db.prepare(`SELECT order_id AS orderId, job_kind AS kind FROM print_queue WHERE id = ?`).get(jobId) as
      | { orderId: string | null; kind: string }
      | undefined;
    if (!row) return ok({ requeued: false });
    if (row.orderId) assertCounterMayReprint(ctx.db, s, row.orderId, row.kind === 'kitchen' ? 'kitchen' : 'receipt');
    return ok({ requeued: printSpooler.retryFailedJob(jobId) !== null });
  });

  // "Reprinted ×N" in Order History: papers printed by hand, per order.
  defineHandler('printer:reprintCounts', ctx, (_ctx, payload) => {
    requireSession();
    const ids = Array.isArray(payload?.orderIds)
      ? payload.orderIds.filter((x): x is string => typeof x === 'string').slice(0, 100)
      : [];
    return ok(reprintCounts(ctx.db, ids));
  });
}
