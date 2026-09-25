import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { ReceiptCopy } from '@cheeseoclock/shared-types';
import { nowIso } from './base.js';

/**
 * Persistent print queue. See migrations/0010_print_queue.sql (+ 0015 for the
 * job kinds).
 *
 * Pure-local (not synced) — print jobs are per-device by design. The repo
 * doesn't go through writeWithSync; we just write the row + index by
 * status/next_attempt_at and let the spooler service own the worker loop.
 */

export type PrintJobKind = 'receipt' | 'kitchen' | 'drawer';
export type PrintJobStatus = 'pending' | 'in_flight' | 'done' | 'failed';

/** Why a receipt was printed — lets the spooler tell "the bill already went out with the rider". */
export type ReceiptJobReason = 'payment' | 'dispatch' | 'refund' | 'reprint';

export interface ReceiptJobPayload {
  kind: 'receipt';
  orderId: string;
  openDrawer: boolean;
  /** Printed in this order, on one strip; the drawer (if any) opens with the first copy. */
  copies: ReceiptCopy[];
  reason: ReceiptJobReason;
}

export interface KitchenJobPayload {
  kind: 'kitchen';
  orderId: string;
  /** Stamped REPRINT on paper so the line doesn't cook it twice. */
  reprint: boolean;
}

/** Just the drawer pulse — money in, no paper. */
export interface DrawerJobPayload {
  kind: 'drawer';
  orderId: string;
}

export type PrintJobPayload = ReceiptJobPayload | KitchenJobPayload | DrawerJobPayload;

export interface PrintJobRow {
  id: string;
  jobKind: PrintJobKind;
  orderId: string | null;
  payload: PrintJobPayload;
  status: PrintJobStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  completedAt: string | null;
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

/** Whatever is on disk: today's payloads, or a pre-0.5.7 `{ orderId, openDrawer }`. */
interface RawPayload {
  orderId: string;
  openDrawer?: boolean;
  copies?: ReceiptCopy[];
  reason?: ReceiptJobReason;
  reprint?: boolean;
}

function parsePayload(kind: PrintJobKind, json: string): PrintJobPayload {
  const raw = JSON.parse(json) as RawPayload;
  switch (kind) {
    case 'kitchen':
      return { kind, orderId: raw.orderId, reprint: raw.reprint === true };
    case 'drawer':
      return { kind, orderId: raw.orderId };
    default:
      // Rows queued before 0.5.7 carry only { orderId, openDrawer }.
      return {
        kind: 'receipt',
        orderId: raw.orderId,
        openDrawer: raw.openDrawer === true,
        copies: Array.isArray(raw.copies) && raw.copies.length > 0 ? raw.copies : ['customer'],
        reason: raw.reason ?? 'payment',
      };
  }
}

function rowToJob(r: RawRow): PrintJobRow {
  return {
    id: r.id,
    jobKind: r.job_kind,
    orderId: r.order_id,
    payload: parsePayload(r.job_kind, r.payload_json),
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

export function enqueuePrintJob(db: AppDatabase, payload: PrintJobPayload): PrintJobRow {
  const id = uuidv7();
  const now = nowIso();
  db.prepare(
    `INSERT INTO print_queue
       (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(id, payload.kind, payload.orderId, JSON.stringify(payload), now, now, now);
  const row = db.prepare(`SELECT ${SELECT} FROM print_queue WHERE id = ?`).get(id) as RawRow;
  return rowToJob(row);
}

/**
 * Has this order already had a job of this kind queued or printed? Jobs that
 * failed for good don't count: once the printer is fixed the order should get
 * its paper after all.
 */
export function hasPrintJob(
  db: AppDatabase,
  orderId: string,
  kind: PrintJobKind,
  reason?: ReceiptJobReason,
): boolean {
  const row =
    reason === undefined
      ? db
          .prepare(
            `SELECT 1 AS hit FROM print_queue
              WHERE order_id = ? AND job_kind = ? AND status != 'failed' LIMIT 1`,
          )
          .get(orderId, kind)
      : db
          .prepare(
            `SELECT 1 AS hit FROM print_queue
              WHERE order_id = ? AND job_kind = ? AND status != 'failed'
                AND json_extract(payload_json, '$.reason') = ? LIMIT 1`,
          )
          .get(orderId, kind, reason);
  return row !== undefined;
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

export function purgeOldFailedJobs(db: AppDatabase, olderThanIso: string): number {
  return db
    .prepare(`DELETE FROM print_queue WHERE status = 'failed' AND updated_at < ?`)
    .run(olderThanIso).changes;
}
