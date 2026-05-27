import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listBackups,
  createBackup,
  exportBackup,
  stageRestoreFromPicker,
  stageRestoreFromPath,
  deleteBackup,
  applyPendingRestoreNowAndRelaunch,
} from '../../services/backup-service.js';

function requireSettingsManage() {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'settings.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Admin or manager required' });
  }
  return session;
}

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
    const path = await exportBackup();
    return ok({ path });
  });

  defineHandler('backup:stageRestoreFromPicker', ctx, async () => {
    requireSettingsManage();
    const r = await stageRestoreFromPicker();
    return ok(r);
  });

  defineHandler('backup:stageRestoreFromPath', ctx, (_ctx, payload) => {
    requireSettingsManage();
    return ok(stageRestoreFromPath(payload.path));
  });

  defineHandler('backup:delete', ctx, (_ctx, payload) => {
    requireSettingsManage();
    deleteBackup(payload.fileName);
    return ok({ fileName: payload.fileName });
  });

  defineHandler('backup:applyAndRelaunch', ctx, () => {
    requireSettingsManage();
    applyPendingRestoreNowAndRelaunch();
    return ok({ relaunching: true } as const);
  });
}
