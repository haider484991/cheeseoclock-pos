import log from 'electron-log/main';
import type { RowImage } from '@cheeseoclock/sync-core';
import type { AppDatabase } from '../db/connection.js';
import {
  newestUnsentAt,
  queueRowidSpan,
  readSnapshotMarker,
} from '../db/repositories/sync-repo.js';
import { checkpointWithoutWaiting } from './housekeeping.js';
import {
  enqueueImages,
  finishFullSend,
  supersedeWindow,
} from '../db/repositories/sync-snapshot-repo.js';
import {
  quoteIdent,
  replicableTables,
  rowImage,
  snapshotOrder,
} from '../db/replicable-schema.js';

/**
 * "Send everything once": queue an image of every row of every replicable
 * table (soft-deleted rows included), so a second till gets the whole shop
 * even though older queue entries were cleared (housekeeping, while the link
 * was off) or went to another server.
 *
 * One moment in time. The rows are read through a second, read-only
 * connection holding one read transaction open for the whole build (WAL lets
 * the till keep writing meanwhile), so every image shows the database as it
 * was at that moment, however long the build takes and whatever is sold
 * meanwhile. The images are stamped just before that moment and queued
 * parents first (foreign-key order, then rowid order); everything written
 * after it is queued as usual with a later stamp. The other till therefore
 * applies one consistent picture and then the changes since, in order: an
 * order rung up mid-build arrives after the menu items, users and shift it
 * points at, never before.
 *
 * Nothing is kept across a restart: a build that did not finish (the app
 * closed, the link was switched off or paused) starts again from the top next
 * time, and its first step deletes the images the unfinished one queued.
 *
 * Main-thread cost is bounded per step (row and byte caps, a short pause
 * between steps) and logged, so the next decision can use numbers from the
 * shop.
 */

/** The read side: a better-sqlite3 (app) or node:sqlite (tests) connection. */
export interface SnapshotReader {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}

export interface SendEverythingOptions {
  /** A second connection to the same database file. */
  openReader: () => SnapshotReader;
  /** Asked before every step: false stops the build (link switched off or paused). */
  shouldContinue: () => boolean;
  /** Rows per step. */
  batchRows?: number;
  /** Payload bytes per step (menu photos are stored as data URLs). */
  batchBytes?: number;
  /** Queue rowids examined per clearing step. */
  clearRows?: number;
  /** Between steps. */
  pause?: () => Promise<void>;
  now?: () => number;
}

export const SNAPSHOT_BATCH_ROWS = 1_000;
export const SNAPSHOT_BATCH_BYTES = 2_000_000;
const CLEAR_BATCH_ROWS = 2_000;
const STEP_GAP_MS = 15;

export type SendEverythingResult = 'none' | 'done' | 'stopped';

export async function sendEverythingOnce(
  db: AppDatabase,
  opts: SendEverythingOptions,
): Promise<SendEverythingResult> {
  const marker = readSnapshotMarker(db);
  if (!marker) return 'none';
  const batchRows = Math.max(1, opts.batchRows ?? SNAPSHOT_BATCH_ROWS);
  const batchBytes = Math.max(1, opts.batchBytes ?? SNAPSHOT_BATCH_BYTES);
  const clearRows = Math.max(1, opts.clearRows ?? CLEAR_BATCH_ROWS);
  const pause = opts.pause ?? (() => new Promise<void>((r) => setTimeout(r, STEP_GAP_MS)));
  const now = opts.now ?? Date.now;

  const tables = replicableTables(db);
  const order = snapshotOrder(db);
  const stats = { steps: 0, busyMs: 0, slowestMs: 0, rows: 0, cleared: 0 };
  const timed = <T>(fn: () => T): T => {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t0;
      stats.steps++;
      stats.busyMs += ms;
      if (ms > stats.slowestMs) stats.slowestMs = ms;
    }
  };
  const started = now();
  let outcome: SendEverythingResult = 'stopped';

  const reader = opts.openReader();
  try {
    // Pin the moment: from here on every read sees the database as it is now.
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    const pinnedAt = now();
    const stamp = new Date(pinnedAt - 1).toISOString();
    log.info('Send everything: started', { reason: marker.reason, tables: order.length });

    // 1. Clear what the images replace: every entry in the queue at the
    //    moment (read in the same turn as the pin, so nothing is written in
    //    between).
    const span = queueRowidSpan(db);
    const newestAtMoment = newestUnsentAt(db);
    if (span && newestAtMoment !== null) {
      for (let from = span.lo; from <= span.hi; from += clearRows) {
        await pause();
        if (!opts.shouldContinue()) return (outcome = 'stopped');
        stats.cleared += timed(() => supersedeWindow(db, from, from + clearRows, span.hi, newestAtMoment));
      }
    }

    // 2. Every row of every table, parents first.
    for (const name of order) {
      const table = tables.get(name);
      if (!table) continue;
      const select = reader.prepare(
        `SELECT rowid AS "__rowid", * FROM ${quoteIdent(name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      );
      let after = Number.MIN_SAFE_INTEGER;
      for (;;) {
        await pause();
        if (!opts.shouldContinue()) return (outcome = 'stopped');
        const done = timed(() => {
          const rows = select.all(after, batchRows) as Array<Record<string, unknown>>;
          const images: RowImage[] = [];
          let bytes = 0;
          for (const row of rows) {
            const image = rowImage(table, row);
            const size = JSON.stringify(image).length;
            if (images.length > 0 && bytes + size > batchBytes) break;
            images.push(image);
            bytes += size;
            after = Number(row['__rowid']);
          }
          if (images.length > 0) enqueueImages(db, name, images, stamp);
          stats.rows += images.length;
          return rows.length < batchRows && images.length === rows.length;
        });
        if (done) break;
      }
    }

    finishFullSend(db, marker.gen, { rows: stats.rows, tables: order.length, startedAt: stamp });
    outcome = 'done';
    return outcome;
  } finally {
    try {
      reader.exec('COMMIT');
    } catch {
      // Nothing was written through the reader.
    }
    try {
      reader.close();
    } catch {
      // Already closed.
    }
    if (outcome === 'done') {
      // The WAL could not be reset while the reader held its moment; give the
      // file its space back now (without waiting on any other reader).
      const t0 = performance.now();
      checkpointWithoutWaiting(db, 'Send everything');
      stats.slowestMs = Math.max(stats.slowestMs, performance.now() - t0);
    }
    log.info(`Send everything: ${outcome}`, {
      rows: stats.rows,
      clearedEntries: stats.cleared,
      steps: stats.steps,
      busyMs: Math.round(stats.busyMs),
      slowestStepMs: Math.round(stats.slowestMs),
      wallMs: now() - started,
    });
  }
}
