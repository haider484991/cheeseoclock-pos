import path from 'node:path';
import log from 'electron-log/main';
import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { isSetupPhase, requireAdmin, requireAdminOrSetupPhase, requireSettingsManage } from '../guards.js';
import {
  listBackups,
  createBackup,
  exportBackup,
  stageRestoreFromPicker,
  stageRestoreFromPath,
  deleteBackup,
  applyPendingRestoreNowAndRelaunch,
} from '../../services/backup-service.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';

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

  defineHandler('backup:create', ctx, () => {
    requireSettingsManage();
    return ok(createBackup({ kind: 'manual' }));
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

  defineHandler('backup:applyAndRelaunch', ctx, async () => {
    requireAdminOrSetupPhase(ctx.db, 'Restoring a backup');
    // Safety copy: the state a restore is about to overwrite goes to the cloud
    // first (kept for 30 days regardless of rotation), so a restore can never
    // be a way to make today's sales disappear. Best effort — a fresh install
    // has nothing to protect and no connection yet.
    if (!isSetupPhase(ctx.db)) {
      try {
        await webOrdersBridge.uploadBackupNow({ reason: 'before-restore' });
        log.info('Safety copy uploaded before restore');
      } catch (e) {
        log.warn('Safety copy before restore skipped', {
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    applyPendingRestoreNowAndRelaunch();
    return ok({ relaunching: true } as const);
  });
}
