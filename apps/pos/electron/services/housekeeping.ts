import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { purgeOldDoneJobs, purgeOldFailedJobs } from '../db/repositories/print-queue-repo.js';
import {
  QUEUE_CLOCK_ERROR_MS,
  purgeSyncedBatch,
  pruneUnsentWindow,
  queueRowidSpan,
} from '../db/repositories/sync-repo.js';
import { readSyncSwitch } from './sync-config.js';

/**
 * Pure-local bookkeeping tables only ever grew: every write adds a sync_queue
 * row, every receipt a print_queue row, every web order a web_order_imports
 * row. None of it is business data (orders, payments and the audit trail are
 * never touched here), so what is finished and old is deleted to keep the
 * till's database and its backups small.
 *
 * The second-till queue (sync_queue):
 *   - Entries already delivered go after 30 days.
 *   - Entries never sent go after 3 days, but ONLY while the second-till link
 *     is Off. The owner agreed to this on 2026-09-26: at the shop the link is
 *     off, so the queue grew by every sale forever. Clearing them also marks
 *     that the other till is owed everything once (sync_state
 *     "snapshot.needed", same transaction): if the link is ever switched on,
 *     the sync worker sends an image of every row first (sync-snapshot.ts),
 *     so nothing that was cleared is missing on the other till. 3 days, not
 *     all: a link switched off for a weekend (the other till broken) picks up
 *     where it stopped instead of sending the whole shop again.
 *     Never while the link is on, paused ("changes wait here") or in the
 *     developer test mode.
 * Both go a small window of rows at a time with a pause in between, starting
 * a few minutes after the app opens, so no step holds the till up.
 *
 * Deleting frees pages inside the file but does not shrink it. At the next
 * start after a lot was freed, compactIfWorthIt rebuilds the file (VACUUM)
 * before the window opens, when it is small enough to take about a second,
 * so the database and every backup made from it get smaller.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows the second-till sync already delivered. */
const SYNCED_KEEP_DAYS = 30;
/** Unsent rows, only while the second-till link is off (see above). */
export const UNSENT_KEEP_DAYS_WHILE_OFF = 3;
/** Printed or given-up print jobs (the failed ones are shown in Settings for a while). */
const PRINT_DONE_KEEP_DAYS = 14;
const PRINT_FAILED_KEEP_DAYS = 30;
/**
 * Web-order import records, once the order's journey is over. The site cancels
 * a 'new' order it could not hand out within 45 minutes, so a record this old
 * is never needed to stop a double import.
 */
const WEB_IMPORT_KEEP_DAYS = 60;

/** Queue rows looked at per step. */
export const PRUNE_BATCH_ROWS = 2_000;
/** Between steps: the till's own work goes first. */
const STEP_GAP_MS = 15;
/** The queue tidy starts this long after the app opens (after the 30 s and 2 min boot jobs). */
const QUEUE_TIDY_DELAY_MS = 4 * 60_000;
/** After this many rows deleted in one run, the WAL file is emptied back into the database. */
const CHECKPOINT_AFTER_ROWS = 10_000;

export function runHousekeeping(db: AppDatabase, now = Date.now()): void {
  const before = (days: number) => new Date(now - days * DAY_MS).toISOString();
  try {
    const printed = purgeOldDoneJobs(db, before(PRINT_DONE_KEEP_DAYS));
    const failed = purgeOldFailedJobs(db, before(PRINT_FAILED_KEEP_DAYS));
    const imports = db
      .prepare(
        `DELETE FROM web_order_imports
          WHERE updated_at < ?
            AND (status = 'failed' OR IFNULL(last_pushed_status, '') IN ('delivered', 'cancelled'))`,
      )
      .run(before(WEB_IMPORT_KEEP_DAYS)).changes;
    if (printed + failed + imports > 0) {
      log.info('Housekeeping: old bookkeeping rows removed', { printed, failed, imports });
    }
  } catch (e) {
    // Never fatal: a till that can't tidy up still sells.
    log.warn('Housekeeping failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

export interface TidyOptions {
  now?: number;
  batchRows?: number;
  /** Between steps (default: a short timer). */
  pause?: () => Promise<void>;
}

interface StepStats {
  steps: number;
  busyMs: number;
  slowestMs: number;
}

function timedStep<T>(stats: StepStats, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    stats.steps++;
    stats.busyMs += ms;
    if (ms > stats.slowestMs) stats.slowestMs = ms;
  }
}

const defaultPause = () => new Promise<void>((r) => setTimeout(r, STEP_GAP_MS));

/**
 * Delete never-sent queue entries older than UNSENT_KEEP_DAYS_WHILE_OFF, only
 * while the second-till link is Off (paused or not; never in any other mode).
 * Entries stamped more than a day in the future go too: they were written
 * while the PC clock was wrong, and every entry after them carries a stamp
 * just past theirs (the queue clock never goes backwards), so going by age
 * alone would clear nothing until the calendar caught up. The link switch is
 * read again before every window, in the same turn as the delete, so
 * switching the link on stops it at once. Returns rows removed.
 */
export async function pruneUnsentWhileOff(db: AppDatabase, opts: TidyOptions = {}): Promise<number> {
  const batch = Math.max(1, opts.batchRows ?? PRUNE_BATCH_ROWS);
  const pause = opts.pause ?? defaultPause;
  const nowMs = opts.now ?? Date.now();
  const cutoff = new Date(nowMs - UNSENT_KEEP_DAYS_WHILE_OFF * DAY_MS).toISOString();
  const clockError = new Date(nowMs + QUEUE_CLOCK_ERROR_MS).toISOString();
  const stats: StepStats = { steps: 0, busyMs: 0, slowestMs: 0 };
  let removed = 0;
  try {
    if (readSyncSwitch(db).mode !== 'off') return 0;
    const span = queueRowidSpan(db);
    if (!span) return 0;
    for (let from = span.lo; from <= span.hi; from += batch) {
      await pause();
      if (readSyncSwitch(db).mode !== 'off') break;
      removed += timedStep(stats, () => pruneUnsentWindow(db, from, from + batch, cutoff, clockError));
    }
    if (removed > 0) {
      log.info('Housekeeping: unsent second-till rows cleared (link is off; everything is sent once if it is switched on)', {
        removed,
        ...roundStats(stats),
        freeBytes: freeBytes(db),
      });
    }
  } catch (e) {
    log.warn('Housekeeping: clearing unsent second-till rows failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return removed;
}

/** Delete delivered queue entries older than SYNCED_KEEP_DAYS, a batch at a time. */
export async function purgeDeliveredQueue(db: AppDatabase, opts: TidyOptions = {}): Promise<number> {
  const batch = Math.max(1, opts.batchRows ?? PRUNE_BATCH_ROWS);
  const pause = opts.pause ?? defaultPause;
  const cutoff = new Date((opts.now ?? Date.now()) - SYNCED_KEEP_DAYS * DAY_MS).toISOString();
  const stats: StepStats = { steps: 0, busyMs: 0, slowestMs: 0 };
  let removed = 0;
  try {
    for (;;) {
      await pause();
      const n = timedStep(stats, () => purgeSyncedBatch(db, cutoff, batch));
      removed += n;
      if (n < batch) break;
    }
    if (removed > 0) {
      log.info('Housekeeping: delivered second-till rows removed', { removed, ...roundStats(stats) });
    }
  } catch (e) {
    log.warn('Housekeeping: removing delivered second-till rows failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return removed;
}

let tidying = false;

/** Both queue clean-ups, one run at a time. */
export async function tidySyncQueue(db: AppDatabase, opts: TidyOptions = {}): Promise<void> {
  if (tidying) return;
  tidying = true;
  try {
    const delivered = await purgeDeliveredQueue(db, opts);
    const unsent = await pruneUnsentWhileOff(db, opts);
    if (delivered + unsent >= CHECKPOINT_AFTER_ROWS) {
      // One big delete leaves its pages in the WAL file; hand them back.
      checkpointWithoutWaiting(db, 'Housekeeping');
    }
  } finally {
    tidying = false;
  }
}

/**
 * Empty the WAL file back into the database (TRUNCATE) without ever waiting.
 * A TRUNCATE checkpoint waits, through the busy handler (busy_timeout, 5 s in
 * connection.ts), for every reader still on an older snapshot. The "send
 * everything" build keeps such a reader open on this same thread across its
 * steps, so waiting could only end in a 5 s freeze of the whole till. With
 * the busy handler off for this one statement, a blocked checkpoint copies
 * what it can (like PASSIVE) and returns; the next one finishes the job.
 * Returns true when the WAL was emptied.
 */
export function checkpointWithoutWaiting(db: AppDatabase, who: string): boolean {
  let restore: number | null = null;
  try {
    const row = db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown> | undefined;
    restore = Number(row ? Object.values(row)[0] : 0) || 0;
    db.prepare('PRAGMA busy_timeout = 0').get();
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined;
    return !r || Number(r.busy ?? 0) === 0;
  } catch (e) {
    log.warn(`${who}: checkpoint failed`, { error: e instanceof Error ? e.message : String(e) });
    return false;
  } finally {
    if (restore !== null) {
      try {
        db.prepare(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(restore))}`).get();
      } catch {
        // Nothing else to do; the connection keeps working either way.
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Giving freed space back (VACUUM), at start only
// -----------------------------------------------------------------------------

/** Only when at least this much is free... */
const COMPACT_MIN_FREE_BYTES = 8 * 1024 * 1024;
/** ...and at least this share of the file. */
const COMPACT_MIN_FREE_SHARE = 0.25;
/** Rebuilding holds the live data in memory (temp_store = MEMORY) and takes ~1 s per 100 MB. */
const COMPACT_MAX_LIVE_BYTES = 256 * 1024 * 1024;

export interface CompactOptions {
  /** Free disk space where the database lives (default: asked of the OS). */
  freeDiskBytes?: () => number | null;
}

export type CompactResult =
  | { compacted: true; beforeBytes: number; afterBytes: number; ms: number }
  | { compacted: false; why: string };

/**
 * Rebuild the database file without its free pages (VACUUM), when that gives
 * back a lot: at least 8 MB and a quarter of the file. Run at start, before
 * the window opens, where the ~1 s it takes at shop size holds nothing up; a
 * database bigger than COMPACT_MAX_LIVE_BYTES is left alone (too long, too
 * much memory), as is one without twice its size free on the disk (VACUUM
 * writes a whole new copy through the WAL). VACUUM keeps every table's rows
 * in their order (the audit chain is walked in rowid order), and nothing
 * persists a rowid across a restart.
 */
export function compactIfWorthIt(db: AppDatabase, opts: CompactOptions = {}): CompactResult {
  try {
    const pageSize = pragmaNumber(db, 'page_size');
    const fileBytes = pragmaNumber(db, 'page_count') * pageSize;
    const unused = pragmaNumber(db, 'freelist_count') * pageSize;
    const liveBytes = fileBytes - unused;
    if (unused < COMPACT_MIN_FREE_BYTES || unused < fileBytes * COMPACT_MIN_FREE_SHARE) {
      return { compacted: false, why: 'little to give back' };
    }
    if (liveBytes > COMPACT_MAX_LIVE_BYTES) return { compacted: false, why: 'database too big to rebuild at start' };
    const disk = (opts.freeDiskBytes ?? (() => diskFreeBytes(db)))();
    if (disk === null || disk < liveBytes * 2 + 64 * 1024 * 1024) {
      return { compacted: false, why: 'not enough free disk space' };
    }
    const t0 = performance.now();
    db.exec('VACUUM');
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      // Not in WAL mode (tests); nothing to empty.
    }
    const afterBytes = pragmaNumber(db, 'page_count') * pragmaNumber(db, 'page_size');
    const ms = Math.round(performance.now() - t0);
    log.info('Housekeeping: database compacted', { beforeBytes: fileBytes, afterBytes, ms });
    return { compacted: true, beforeBytes: fileBytes, afterBytes, ms };
  } catch (e) {
    log.warn('Housekeeping: compaction skipped', { error: e instanceof Error ? e.message : String(e) });
    return { compacted: false, why: 'failed' };
  }
}

function pragmaNumber(db: AppDatabase, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] : 0) || 0;
}

function freeBytes(db: AppDatabase): number {
  return pragmaNumber(db, 'freelist_count') * pragmaNumber(db, 'page_size');
}

function diskFreeBytes(db: AppDatabase): number | null {
  const file = (db as { name?: unknown }).name;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const s = fs.statfsSync(path.dirname(file));
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function roundStats(s: StepStats): { steps: number; busyMs: number; slowestStepMs: number } {
  return { steps: s.steps, busyMs: Math.round(s.busyMs), slowestStepMs: Math.round(s.slowestMs) };
}

let timer: NodeJS.Timeout | null = null;
let tidyTimer: NodeJS.Timeout | null = null;

/**
 * At start: compact if worth it, then the small tidy-ups. The queue tidy runs
 * a few minutes later; everything again once a day while the app is open.
 */
export function startHousekeeping(db: AppDatabase): void {
  compactIfWorthIt(db);
  runHousekeeping(db);
  if (tidyTimer) clearTimeout(tidyTimer);
  tidyTimer = setTimeout(() => void tidySyncQueue(db), QUEUE_TIDY_DELAY_MS);
  tidyTimer.unref?.();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runHousekeeping(db);
    void tidySyncQueue(db);
  }, DAY_MS);
  timer.unref?.();
}
