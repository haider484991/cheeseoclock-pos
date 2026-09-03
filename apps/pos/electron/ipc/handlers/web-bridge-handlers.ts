import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { requireAdmin, requireAdminOrSetupPhase, requireSettingsManage } from '../guards.js';
import {
  WebBridgeConfigSchema,
  getWebBridgeConfig,
  isWebBridgeReady,
  normaliseSiteUrl,
  setWebBridgeConfig,
} from '../../services/web-bridge-config.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}

function precondition(e: unknown, fallback: string): IpcGuardError {
  return new IpcGuardError({
    code: 'precondition_failed',
    message: e instanceof Error ? e.message : fallback,
  });
}

function connectionFrom(payload: { siteUrl: string; bridgeSecret: string }) {
  let siteUrl: string;
  try {
    siteUrl = normaliseSiteUrl(payload.siteUrl);
  } catch {
    throw new IpcGuardError({
      code: 'validation_failed',
      message: 'Enter the full website address, starting with https://',
    });
  }
  const bridgeSecret = payload.bridgeSecret.trim();
  if (!bridgeSecret) {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Enter the bridge secret' });
  }
  return { siteUrl, bridgeSecret };
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
      secretUnreadable: cfg.secretUnreadable,
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
      return ok(await webOrdersBridge.publishMenu());
    } catch (e) {
      throw precondition(e, 'Publish failed');
    }
  });

  defineHandler('webBridge:pollNow', ctx, () => {
    requireSettingsManage();
    webOrdersBridge.kick();
    return ok({ kicked: true } as const);
  });

  defineHandler('webBridge:diagnose', ctx, async () => {
    requireSettingsManage();
    return ok(await webOrdersBridge.diagnose());
  });

  defineHandler('webBridge:backupNow', ctx, async () => {
    requireSettingsManage();
    try {
      return ok(await webOrdersBridge.uploadBackupNow({ reason: 'manual' }));
    } catch (e) {
      throw precondition(e, 'Cloud backup failed');
    }
  });

  defineHandler('webBridge:listCloudBackups', ctx, async () => {
    requireSettingsManage();
    try {
      return ok(await webOrdersBridge.listCloudBackups());
    } catch (e) {
      throw precondition(e, 'Could not list cloud backups');
    }
  });

  defineHandler('webBridge:restoreCloudBackup', ctx, async (_ctx, payload) => {
    const session = requireAdmin('Restoring a cloud copy');
    try {
      return ok(
        await webOrdersBridge.restoreCloudBackup(payload.id, { byUserId: session.id }),
      );
    } catch (e) {
      throw precondition(e, 'Cloud restore failed');
    }
  });

  // Onboarding restore: a fresh install has no saved connection, so the wizard
  // passes one. Also open to the owner on a configured PC.
  defineHandler('webBridge:previewCloudBackups', ctx, async (_ctx, payload) => {
    requireAdminOrSetupPhase(ctx.db, 'Reading cloud copies with another connection');
    const conn = connectionFrom(payload);
    try {
      return ok(await webOrdersBridge.listCloudBackups(conn));
    } catch (e) {
      throw precondition(e, 'Could not reach the website');
    }
  });

  defineHandler('webBridge:restoreCloudBackupWith', ctx, async (_ctx, payload) => {
    const session = requireAdminOrSetupPhase(ctx.db, 'Restoring a cloud copy');
    const conn = connectionFrom(payload);
    try {
      return ok(
        await webOrdersBridge.restoreCloudBackup(payload.id, {
          conn,
          byUserId: session?.id ?? null,
          captureConnection: true,
        }),
      );
    } catch (e) {
      throw precondition(e, 'Cloud restore failed');
    }
  });
}
