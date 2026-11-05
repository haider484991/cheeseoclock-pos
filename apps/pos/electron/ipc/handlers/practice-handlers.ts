import log from 'electron-log/main';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, type PracticeClearResult } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { requireAdmin } from '../guards.js';
import { verifyOwnerSecret } from '../../services/auth-service.js';
import { licenceService } from '../../services/licence/licence-service.js';
import { getFbrMode } from '../../services/fbr-config.js';
import { readSyncSwitch } from '../../services/sync-config.js';
import { createBackupAsync } from '../../services/backup-service.js';
import { cancelPendingJobs } from '../../db/repositories/print-queue-repo.js';
import { NOT_PRINTED_DELETED_TEST } from '../../services/print-spooler.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';
import {
  clearPracticeOrders,
  practiceClearPreview,
  type PracticeClearEnv,
} from '../../db/repositories/practice-clear-repo.js';

const CLEAR_PRACTICE = 'Clearing the practice orders';

/** What the database rows don't say: the licence, FBR and the second-till link. */
function envOf(db: AppDatabase): PracticeClearEnv {
  return {
    licensed: licenceService.status().licenceId !== null,
    fbrLive: getFbrMode(db) === 'production',
    secondTill: readSyncSwitch(db).mode !== 'off',
  };
}

/**
 * "Clear practice orders" (Settings → About; practice-clear-repo.ts). The
 * owner (admin) login only — a manager or cashier is refused before anything
 * is read — and the clear itself needs the owner's PIN or password typed
 * again, like "Delete test order". A safety copy is made first; when it
 * can't be made, nothing is cleared.
 */
export function registerPracticeHandlers(ctx: HandlerContext): void {
  defineHandler('practice:preview', ctx, () => {
    requireAdmin(CLEAR_PRACTICE);
    return ok(practiceClearPreview(ctx.db, ctx.deviceId, envOf(ctx.db)));
  });

  defineHandler('practice:clear', ctx, async (_ctx, payload) => {
    const s = requireAdmin(CLEAR_PRACTICE);
    const ownerSecret = typeof payload?.ownerSecret === 'string' ? payload.ownerSecret : '';
    if (!ownerSecret) throw new IpcGuardError({ code: 'validation_failed', message: 'Type your owner PIN or password.' });
    const customers = payload?.customers === true;
    const drawerLog = payload?.drawerLog === true;

    let ownerUserId: string;
    try {
      ownerUserId = (await verifyOwnerSecret(ctx.db, ownerSecret)).ownerUserId;
    } catch (e) {
      throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : "That is not the owner's PIN or password." });
    }

    // Refuse before the copy when it can't be done anyway (the clear checks again).
    const before = practiceClearPreview(ctx.db, ctx.deviceId, envOf(ctx.db));
    const block = before.blocks[0];
    if (block) throw new IpcGuardError({ code: 'precondition_failed', message: block.message });

    let backupFileName: string;
    try {
      backupFileName = (await createBackupAsync({ kind: 'before-clear' })).fileName;
    } catch (e) {
      log.error('No safety copy before clearing the practice orders', e);
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'The safety copy could not be made, so nothing was cleared. Check Settings → Backups, then try again.',
      });
    }

    let done: ReturnType<typeof clearPracticeOrders>;
    try {
      done = clearPracticeOrders(ctx.db, { customers, drawerLog, ownerUserId }, { userId: s.id, deviceId: ctx.deviceId }, envOf(ctx.db));
    } catch (e) {
      throw new IpcGuardError({ code: 'precondition_failed', message: e instanceof Error ? e.message : 'Nothing was cleared.' });
    }

    // After the commit. Nothing still waiting for a cleared order prints
    // (never a CANCELLED slip: practice food was never cooked for anyone).
    for (const orderId of done.orderIds) {
      try {
        cancelPendingJobs(ctx.db, orderId, { bills: true, note: NOT_PRINTED_DELETED_TEST });
      } catch (e) {
        log.warn('Could not tidy the print queue for a cleared practice order', { orderId, error: String(e) });
      }
    }
    if (done.webOrderIds.length > 0) {
      try {
        webOrdersBridge.kick();
      } catch (e) {
        log.warn('Website not told yet about the cleared practice orders (it will be on the next push):', e);
      }
    }

    const result: PracticeClearResult = {
      orders: done.orders,
      shifts: done.shifts,
      cashMovements: done.cashMovements,
      drawerLog: done.drawerLog,
      customers: done.customers,
      backupFileName,
    };
    return ok(result);
  });
}
