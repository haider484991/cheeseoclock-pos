import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  SyncConfigSchema,
  getSyncConfig,
  isSyncReady,
  setSyncConfig,
} from '../../services/sync-config.js';
import { syncWorker } from '../../services/sync-worker.js';

function requireSession(): AuthenticatedUser {
  const s = getCurrentSession();
  if (!s) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return s;
}

function requireSettingsManage(): AuthenticatedUser {
  const s = requireSession();
  if (!hasCapability(s.role, 'settings.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Sync settings require manager or admin',
    });
  }
  return s;
}

export function registerSyncHandlers(ctx: HandlerContext): void {
  defineHandler('sync:getConfig', ctx, () => {
    requireSession();
    const cfg = getSyncConfig(ctx.db);
    return ok({
      mode: cfg.mode,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.deviceSecret ? { deviceSecret: cfg.deviceSecret } : {}),
      pollIntervalMs: cfg.pollIntervalMs,
      paused: cfg.paused,
      ready: isSyncReady(cfg),
    });
  });

  defineHandler('sync:setConfig', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = SyncConfigSchema.safeParse({
      mode: payload.mode,
      baseUrl: payload.baseUrl,
      deviceSecret: payload.deviceSecret,
      pollIntervalMs: payload.pollIntervalMs ?? 15_000,
      paused: payload.paused ?? false,
    });
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setSyncConfig(ctx.db, parsed.data);
    syncWorker.resetAdapter();
    if (!parsed.data.paused && parsed.data.mode !== 'off') syncWorker.kick();
    return ok({ ok: true } as const);
  });

  defineHandler('sync:getStatus', ctx, () => {
    requireSession();
    const cfg = getSyncConfig(ctx.db);
    const status = syncWorker.status();
    return ok({ ...status, mode: cfg.mode, paused: cfg.paused });
  });

  defineHandler('sync:triggerNow', ctx, () => {
    requireSettingsManage();
    syncWorker.kick();
    return ok({ kicked: true } as const);
  });
}
