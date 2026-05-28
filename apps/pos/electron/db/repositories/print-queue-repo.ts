import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso } from './base.js';

/**
 * Persistent print queue. See migrations/0010_print_queue.sql for schema.
 *
 * Pure-local (not synced) — print jobs are per-device by design. The repo
 * doesn't go through writeWithSync; we just write the row + index by
 * status/next_attempt_at and let the spooler service own the worker loop.
 */

export type PrintJobKind = 'receipt';
export type PrintJobStatus = 'pending' | 'in_flight' | 'done' | 'failed';

export interface PrintJobRow {
  id: string;
  jobKind: PrintJobKind;
  orderId: string | null;
  payload: ReceiptJobPayload;
  status: PrintJobStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ReceiptJobPayload {
  orderId: string;
  openDrawer: boolean;
}

interface RawRow {
  id: string;
  job_kind: PrintJobKind;
  order_id: string | null;
  payload_json: string;
  status: PrintJobStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  completed_at: string | null;
}

function rowToJob(r: RawRow): PrintJobRow {
  return {
    id: r.id,
    jobKind: r.job_kind,
    orderId: r.order_id,
    payload: JSON.parse(r.payload_json) as ReceiptJobPayload,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const SELECT = `id, job_kind, order_id, payload_json, status, attempts,
                 last_error, next_attempt_at, created_at, completed_at`;

export function enqueueReceiptJob(
  db: AppDatabase,
  payload: ReceiptJobPayload,
): PrintJobRow {
  const id = uuidv7();
  const now = nowIso();
  db.prepare(
    `INSERT INTO print_queue
       (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, 'receipt', ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(id, payload.orderId, JSON.stringify(payload), now, now, now);
  const row = db.prepare(`SELECT ${SELECT} FROM print_queue WHERE id = ?`).get(id) as RawRow;
  return rowToJob(row);
}

/**
 * Claim the next due pending job. Atomically flips it to in_flight so two
 * worker ticks can't grab the same job. Returns null when there's nothing
 * to do.
 */
export function claimNextPendingJob(db: AppDatabase): PrintJobRow | null {
  const now = nowIso();
  let claimed: PrintJobRow | null = null;
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ${SELECT} FROM print_queue
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at LIMIT 1`,
      )
      .get(now) as RawRow | undefined;
    if (!row) return;
    db.prepare(
      `UPDATE print_queue SET status = 'in_flight', updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(now, row.id);
    claimed = rowToJob({ ...row, status: 'in_flight' });
  });
  tx();
  return claimed;
}

export function markJobDone(db: AppDatabase, id: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE print_queue SET status = 'done', completed_at = ?, updated_at = ?, last_error = NULL
      WHERE id = ?`,
  ).run(now, now, id);
}

/**
 * Mark a job pending again after a recoverable failure. Increments attempts
 * and pushes next_attempt_at out by backoffMs.
 */
export function rescheduleJob(
  db: AppDatabase,
  id: string,
  errorMessage: string,
  backoffMs: number,
): void {
  const now = Date.now();
  const next = new Date(now + backoffMs).toISOString();
  db.prepare(
    `UPDATE print_queue
        SET status = 'pending',
            attempts = attempts + 1,
            last_error = ?,
            next_attempt_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(errorMessage, next, new Date(now).toISOString(), id);
}

export function markJobFailedPermanently(
  db: AppDatabase,
  id: string,
  errorMessage: string,
): void {
  const now = nowIso();
  db.prepare(
    `UPDATE print_queue
        SET status = 'failed',
            attempts = attempts + 1,
            last_error = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(errorMessage, now, id);
}

/**
 * Reset any rows stuck in `in_flight` back to `pending` — called once at
 * boot. Without this, an app crash mid-print would leave a job orphaned.
 */
export function recoverStuckInFlight(db: AppDatabase): number {
  const now = nowIso();
  const result = db
    .prepare(
      `UPDATE print_queue
          SET status = 'pending',
              updated_at = ?,
              last_error = COALESCE(last_error, 'Recovered from crash mid-print')
        WHERE status = 'in_flight'`,
    )
    .run(now);
  return result.changes;
}

export function listRecentFailedJobs(db: AppDatabase, limit = 20): PrintJobRow[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT} FROM print_queue
        WHERE status = 'failed'
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as RawRow[];
  return rows.map(rowToJob);
}

export function purgeOldDoneJobs(db: AppDatabase, olderThanIso: string): number {
  const result = db
    .prepare(
      `DELETE FROM print_queue
        WHERE status = 'done' AND completed_at < ?`,
    )
    .run(olderThanIso);
  return result.changes;
}
