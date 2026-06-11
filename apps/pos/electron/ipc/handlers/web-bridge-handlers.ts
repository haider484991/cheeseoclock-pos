import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  WebBridgeConfigSchema,
  getWebBridgeConfig,
  isWebBridgeReady,
  setWebBridgeConfig,
} from '../../services/web-bridge-config.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';

function requireSettingsManage(): AuthenticatedUser {
  const s = getCurrentSession();
  if (!s) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(s.role, 'settings.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Website settings require manager or admin',
    });
  }
  return s;
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}

export function registerWebBridgeHandlers(ctx: HandlerContext): void {
  defineHandler('webBridge:getConfig', ctx, () => {
    requireSettingsManage();
    const cfg = getWebBridgeConfig(ctx.db);
    return ok({
      enabled: cfg.enabled,
      ...(cfg.siteUrl ? { siteUrl: cfg.siteUrl } : {}),
      ...(cfg.bridgeSecret ? { bridgeSecret: maskSecret(cfg.bridgeSecret) } : {}),
      pollIntervalMs: cfg.pollIntervalMs,
      cloudBackupFrequency: cfg.cloudBackupFrequency,
      ready: isWebBridgeReady(cfg),
    });
  });

  defineHandler('webBridge:setConfig', ctx, (_ctx, payload) => {
    requireSettingsManage();
    // Preserve the saved secret if the client re-submitted the masked form.
    const existing = getWebBridgeConfig(ctx.db);
    const bridgeSecret =
      payload.bridgeSecret && payload.bridgeSecret.startsWith('****')
        ? existing.bridgeSecret
        : payload.bridgeSecret;
    const parsed = WebBridgeConfigSchema.safeParse({
      enabled: payload.enabled,
      siteUrl: payload.siteUrl,
      bridgeSecret,
      pollIntervalMs: payload.pollIntervalMs ?? existing.pollIntervalMs,
      cloudBackupFrequency:
        payload.cloudBackupFrequency ?? existing.cloudBackupFrequency,
    });
    if (!parsed.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: parsed.error.errors.map((e) => e.message).join(', '),
      });
    }
    setWebBridgeConfig(ctx.db, parsed.data);
    webOrdersBridge.reschedule();
    return ok({ ok: true } as const);
  });

  defineHandler('webBridge:getStatus', ctx, () => {
    requireSettingsManage();
    return ok(webOrdersBridge.status());
  });

  defineHandler('webBridge:publishMenu', ctx, async () => {
    requireSettingsManage();
    try {
      const result = await webOrdersBridge.publishMenu();
      return ok(result);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Publish failed',
      });
    }
  });

  defineHandler('webBridge:pollNow', ctx, () => {
    requireSettingsManage();
    webOrdersBridge.kick();
    return ok({ kicked: true } as const);
  });

  defineHandler('webBridge:backupNow', ctx, async () => {
    requireSettingsManage();
    try {
      return ok(await webOrdersBridge.uploadBackupNow());
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Cloud backup failed',
      });
    }
  });

  defineHandler('webBridge:listCloudBackups', ctx, async () => {
    requireSettingsManage();
    try {
      return ok(await webOrdersBridge.listCloudBackups());
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not list cloud backups',
      });
    }
  });

  defineHandler('webBridge:restoreCloudBackup', ctx, async (_ctx, payload) => {
    requireSettingsManage();
    try {
      return ok(await webOrdersBridge.restoreCloudBackup(payload.id));
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Cloud restore failed',
      });
    }
  });
}
