import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  FbrConfigSchema,
  getFbrConfig,
  isFbrReady,
  setFbrConfig,
} from '../../services/fbr-config.js';
import { fbrWorker } from '../../services/fbr-worker.js';
import {
  getFbrQueueStats,
  getFbrRowByOrder,
  retryAllFailed,
} from '../../db/repositories/fbr-queue-repo.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

function requireSettingsManage(): AuthenticatedUser {
  const s = requireSession();
  if (!hasCapability(s.role, 'settings.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'FBR settings require manager or admin role',
    });
  }
  return s;
}

export function registerFbrHandlers(ctx: HandlerContext): void {
  defineHandler('fbr:getConfig', ctx, () => {
    requireSession();
    const cfg = getFbrConfig(ctx.db);
    const ready = isFbrReady(cfg);
    return ok({
      mode: cfg.mode,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.bearerToken ? { bearerToken: cfg.bearerToken } : {}),
      sellerNTNCNIC: cfg.sellerNTNCNIC,
      sellerBusinessName: cfg.sellerBusinessName,
      sellerProvince: cfg.sellerProvince,
      sellerAddress: cfg.sellerAddress,
      paused: cfg.paused,
      ready,
    });
  });

  defineHandler('fbr:setConfig', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = FbrConfigSchema.safeParse({
      mode: payload.mode,
      endpoint: payload.endpoint,
      bearerToken: payload.bearerToken,
      sellerNTNCNIC: payload.sellerNTNCNIC,
      sellerBusinessName: payload.sellerBusinessName,
      sellerProvince: payload.sellerProvince,
      sellerAddress: payload.sellerAddress,
      paused: payload.paused ?? false,
    });
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setFbrConfig(ctx.db, parsed.data);
    fbrWorker.resetAdapter();
    if (!parsed.data.paused) fbrWorker.kick();
    return ok({ ok: true } as const);
  });

  defineHandler('fbr:getQueueStats', ctx, () => {
    requireSession();
    const stats = getFbrQueueStats(ctx.db);
    const cfg = getFbrConfig(ctx.db);
    return ok({ ...stats, mode: cfg.mode, paused: cfg.paused });
  });

  defineHandler('fbr:retryFailed', ctx, () => {
    requireSettingsManage();
    const requeued = retryAllFailed(ctx.db);
    fbrWorker.kick();
    return ok({ requeued });
  });

  defineHandler('fbr:getInvoiceStatus', ctx, (_ctx, payload) => {
    requireSession();
    const row = getFbrRowByOrder(ctx.db, payload.orderId);
    if (!row) {
      return ok({ status: 'none' as const, attempts: 0 });
    }
    return ok({
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      irn: row.irn,
      qrPayload: row.qrPayload,
      submittedAt: row.submittedAt,
    });
  });
}
