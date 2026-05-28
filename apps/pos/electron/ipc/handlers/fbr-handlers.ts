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

/** "abcdef…uvwxyz" → "****wxyz" so the operator can confirm without seeing it. */
function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}

export function registerFbrHandlers(ctx: HandlerContext): void {
  defineHandler('fbr:getConfig', ctx, () => {
    // Restrict reads to managers/admins. Cashiers don't need (and previously
    // could see, including the bearer token via DevTools) FBR settings.
    const s = requireSession();
    const canSeeSecrets = hasCapability(s.role, 'settings.manage');
    const cfg = getFbrConfig(ctx.db);
    const ready = isFbrReady(cfg);
    return ok({
      mode: cfg.mode,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      // Never return the bearer token in plaintext. Manager UI gets a masked
      // preview ("****" + last 4) so it can show "configured" without
      // leaking the secret across the IPC boundary. Replace via fbr:setConfig.
      ...(cfg.bearerToken
        ? {
            bearerToken: canSeeSecrets
              ? maskSecret(cfg.bearerToken)
              : undefined,
          }
        : {}),
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
    // If the client sent back the masked preview from fbr:getConfig
    // (starts with `****`), they didn't actually want to change the token —
    // preserve the existing one. Otherwise the masked value would clobber
    // the real token in the DB.
    const existing = getFbrConfig(ctx.db);
    const bearerToken =
      payload.bearerToken && payload.bearerToken.startsWith('****')
        ? existing.bearerToken
        : payload.bearerToken;
    const parsed = FbrConfigSchema.safeParse({
      mode: payload.mode,
      endpoint: payload.endpoint,
      bearerToken,
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
