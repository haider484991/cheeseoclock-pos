import path from 'node:path';
import log from 'electron-log/main';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError, markShuttingDown } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { isSetupPhase, requireAdmin, requireAdminOrSetupPhase, requireSettingsManage } from '../guards.js';
import {
  listBackups,
  createBackupAsync,
  exportBackup,
  stageRestoreFromPicker,
  stageRestoreFromPath,
  deleteBackup,
  applyPendingRestoreNowAndRelaunch,
  stopBackupService,
  hasPendingRestore,
  confirmPendingRestore,
  cancelPendingRestore,
} from '../../services/backup-service.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';
import { getBackupHealth } from '../../services/backup-health.js';
import { getWebBridgeConfig, isWebBridgeReady } from '../../services/web-bridge-config.js';

/**
 * Reading and making backups: manager or admin. Restoring or deleting one
 * rewrites or discards history: the owner (admin) only — except on a fresh
 * install with no users yet, where the onboarding wizard restores a PC.
 */
export function registerBackupHandlers(ctx: HandlerContext): void {
  defineHandler('backup:list', ctx, () => {
    requireSettingsManage();
    return ok(listBackups());
  });

  defineHandler('backup:create', ctx, async () => {
    requireSettingsManage();
    // Written a slice at a time: "Back up now" mid-service no longer freezes the till.
    return ok(await createBackupAsync({ kind: 'manual' }));
  });

  defineHandler('backup:export', ctx, async () => {
    requireSettingsManage();
    const p = await exportBackup();
    return ok({ path: p });
  });

  defineHandler('backup:stageRestoreFromPicker', ctx, async () => {
    const session = requireAdminOrSetupPhase(ctx.db, 'Restoring a backup');
    const r = await stageRestoreFromPicker({ source: 'file', byUserId: session?.id ?? null });
    return ok(r);
  });

  defineHandler('backup:stageRestoreFromPath', ctx, (_ctx, payload) => {
    const session = requireAdminOrSetupPhase(ctx.db, 'Restoring a backup');
    return ok(
      stageRestoreFromPath(payload.path, {
        source: 'snapshot',
        label: path.basename(payload.path),
        byUserId: session?.id ?? null,
      }),
    );
  });

  defineHandler('backup:delete', ctx, (_ctx, payload) => {
    requireAdmin('Deleting a backup');
    deleteBackup(payload.fileName);
    return ok({ fileName: payload.fileName });
  });

  defineHandler('backup:health', ctx, () => {
    requireSettingsManage();
    return ok(getBackupHealth(ctx.db));
  });

  // The owner said no to a copy that was already staged: drop it, so it is
  // not applied the next time the till starts.
  defineHandler('backup:cancelStagedRestore', ctx, () => {
    requireAdminOrSetupPhase(ctx.db, 'Cancelling a restore');
    return ok(cancelPendingRestore());
  });

  defineHandler('backup:applyAndRelaunch', ctx, async (_ctx, payload) => {
    requireAdminOrSetupPhase(ctx.db, 'Restoring a backup');
    if (!hasPendingRestore()) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'Nothing is waiting to be restored. Pick the copy again.',
      });
    }
    // Safety copy: the state a restore is about to overwrite goes to the cloud
    // first (kept for 30 days regardless of rotation), so a restore can never
    // be a way to make today's sales disappear. A fresh install has nothing to
    // protect and no connection yet; a till never linked to the website can't
    // upload one (its data is still archived on this PC). But a linked till
    // whose upload failed no longer restores silently: the owner is asked.
    if (!isSetupPhase(ctx.db)) {
      try {
        await webOrdersBridge.uploadBackupNow({ reason: 'before-restore' });
        log.info('Safety copy uploaded before restore');
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const linked = isWebBridgeReady(getWebBridgeConfig(ctx.db)).ok;
        if (linked && !payload?.withoutSafetyCopy) {
          throw new IpcGuardError({
            code: 'precondition_failed',
            message: `The safety copy could not be uploaded: ${reason}`,
            details: { safetyCopyFailed: true, reason },
          });
        }
        log.warn('Restoring without a cloud safety copy', { reason, linked, ownerAgreed: !!payload?.withoutSafetyCopy });
      }
    }
    // Only now is the staged copy marked to be applied at the next start.
    confirmPendingRestore();
    // Quiesce: no more polls, backups or handler calls may touch the database
    // between closing it and the restart.
    markShuttingDown();
    webOrdersBridge.stop();
    stopBackupService();
    applyPendingRestoreNowAndRelaunch();
    return ok({ relaunching: true } as const);
  });
}
