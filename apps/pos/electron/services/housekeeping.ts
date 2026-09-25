import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { purgeOldDoneJobs, purgeOldFailedJobs } from '../db/repositories/print-queue-repo.js';
import { purgeSyncedQueue } from '../db/repositories/sync-repo.js';

/**
 * Pure-local bookkeeping tables only ever grew: every write adds a sync_queue
 * row, every receipt a print_queue row, every web order a web_order_imports
 * row. None of it is business data (orders, payments and the audit trail are
 * never touched here), so what is finished and old is deleted — at boot and
 * once a day — to keep the till's database and its backups small.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows the second-till sync already delivered. */
const SYNCED_KEEP_DAYS = 30;
/** Printed or given-up print jobs (the failed ones are shown in Settings for a while). */
const PRINT_DONE_KEEP_DAYS = 14;
const PRINT_FAILED_KEEP_DAYS = 30;
/**
 * Web-order import records, once the order's journey is over. The site cancels
 * a 'new' order it could not hand out within 45 minutes, so a record this old
 * is never needed to stop a double import.
 */
const WEB_IMPORT_KEEP_DAYS = 60;

export function runHousekeeping(db: AppDatabase, now = Date.now()): void {
  const before = (days: number) => new Date(now - days * DAY_MS).toISOString();
  try {
    const synced = purgeSyncedQueue(db, before(SYNCED_KEEP_DAYS));
    const printed = purgeOldDoneJobs(db, before(PRINT_DONE_KEEP_DAYS));
    const failed = purgeOldFailedJobs(db, before(PRINT_FAILED_KEEP_DAYS));
    const imports = db
      .prepare(
        `DELETE FROM web_order_imports
          WHERE updated_at < ?
            AND (status = 'failed' OR IFNULL(last_pushed_status, '') IN ('delivered', 'cancelled'))`,
      )
      .run(before(WEB_IMPORT_KEEP_DAYS)).changes;
    if (synced + printed + failed + imports > 0) {
      log.info('Housekeeping: old bookkeeping rows removed', { synced, printed, failed, imports });
    }
  } catch (e) {
    // Never fatal: a till that can't tidy up still sells.
    log.warn('Housekeeping failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

let timer: NodeJS.Timeout | null = null;

/** Run now, then once a day while the app is open. */
export function startHousekeeping(db: AppDatabase): void {
  runHousekeeping(db);
  if (timer) clearInterval(timer);
  timer = setInterval(() => runHousekeeping(db), DAY_MS);
  timer.unref?.();
}
