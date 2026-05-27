import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso } from './base.js';
import type { FbrMode } from '@cheeseoclock/fbr-core';

export type FbrQueueStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface FbrQueueRow {
  id: string;
  orderId: string;
  status: FbrQueueStatus;
  attempts: number;
  lastError: string | null;
  irn: string | null;
  qrPayload: string | null;
  enqueuedAt: string;
  submittedAt: string | null;
  nextAttemptAt: string | null;
  modeAtEnqueue: FbrMode;
}

interface Row {
  id: string;
  order_id: string;
  payload_json: string;
  status: FbrQueueStatus;
  attempts: number;
  last_error: string | null;
  irn: string | null;
  qr_payload: string | null;
  enqueued_at: string;
  submitted_at: string | null;
  next_attempt_at: string | null;
  mode_at_enqueue: FbrMode;
}

function toRow(r: Row): FbrQueueRow {
  return {
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    irn: r.irn,
    qrPayload: r.qr_payload,
    enqueuedAt: r.enqueued_at,
    submittedAt: r.submitted_at,
    nextAttemptAt: r.next_attempt_at,
    modeAtEnqueue: r.mode_at_enqueue,
  };
}

export function enqueueFbrSubmission(
  db: AppDatabase,
  orderId: string,
  payload: unknown,
  modeAtEnqueue: FbrMode,
): void {
  const id = uuidv7();
  const now = nowIso();
  const json = JSON.stringify(payload);
  db.prepare(
    `INSERT INTO fbr_submission_queue
       (id, order_id, payload_json, status, attempts, enqueued_at, next_attempt_at,
        mode_at_enqueue, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       status = 'pending',
       last_error = NULL,
       next_attempt_at = excluded.next_attempt_at,
       updated_at = excluded.updated_at`,
  ).run(id, orderId, json, now, now, modeAtEnqueue, now, now);
}

export interface PendingFbrJob {
  id: string;
  orderId: string;
  payload: unknown;
  attempts: number;
  modeAtEnqueue: FbrMode;
}

export function claimNextPendingJob(db: AppDatabase): PendingFbrJob | null {
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT id, order_id, payload_json, attempts, mode_at_enqueue
         FROM fbr_submission_queue
        WHERE status IN ('pending', 'failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY enqueued_at
        LIMIT 1`,
    )
    .get(now) as
    | {
        id: string;
        order_id: string;
        payload_json: string;
        attempts: number;
        mode_at_enqueue: FbrMode;
      }
    | undefined;
  if (!row) return null;
  // Optimistically bump attempts so concurrent claims don't double-submit.
  db.prepare(
    `UPDATE fbr_submission_queue SET attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  ).run(now, row.id);
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    orderId: row.order_id,
    payload,
    attempts: row.attempts + 1,
    modeAtEnqueue: row.mode_at_enqueue,
  };
}

export function markFbrSent(
  db: AppDatabase,
  id: string,
  irn: string,
  qrPayload: string | null,
): void {
  const now = nowIso();
  db.prepare(
    `UPDATE fbr_submission_queue SET status = 'sent', irn = ?, qr_payload = ?,
          submitted_at = ?, updated_at = ?, last_error = NULL, next_attempt_at = NULL
       WHERE id = ?`,
  ).run(irn, qrPayload, now, now, id);
}

export function markFbrFailed(
  db: AppDatabase,
  id: string,
  error: string,
  retryable: boolean,
  backoffMs: number,
): void {
  const now = nowIso();
  const next = retryable ? new Date(Date.now() + backoffMs).toISOString() : null;
  db.prepare(
    `UPDATE fbr_submission_queue SET status = ?, last_error = ?, updated_at = ?, next_attempt_at = ?
       WHERE id = ?`,
  ).run(retryable ? 'pending' : 'failed', error, now, next, id);
}

export interface FbrQueueStats {
  pending: number;
  failed: number;
  sent: number;
  skipped: number;
  oldestPendingIso: string | null;
}

export function getFbrQueueStats(db: AppDatabase): FbrQueueStats {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM fbr_submission_queue GROUP BY status`,
    )
    .all() as Array<{ status: FbrQueueStatus; n: number }>;
  const stats: FbrQueueStats = {
    pending: 0,
    failed: 0,
    sent: 0,
    skipped: 0,
    oldestPendingIso: null,
  };
  for (const r of rows) stats[r.status] = r.n;
  const oldest = db
    .prepare(
      `SELECT enqueued_at FROM fbr_submission_queue
        WHERE status IN ('pending', 'failed') ORDER BY enqueued_at LIMIT 1`,
    )
    .get() as { enqueued_at: string } | undefined;
  if (oldest) stats.oldestPendingIso = oldest.enqueued_at;
  return stats;
}

export function getFbrRowByOrder(db: AppDatabase, orderId: string): FbrQueueRow | null {
  const row = db
    .prepare(
      `SELECT * FROM fbr_submission_queue WHERE order_id = ?`,
    )
    .get(orderId) as Row | undefined;
  return row ? toRow(row) : null;
}

export function retryAllFailed(db: AppDatabase): number {
  const now = nowIso();
  const r = db
    .prepare(
      `UPDATE fbr_submission_queue SET status = 'pending', next_attempt_at = NULL, last_error = NULL, updated_at = ?
         WHERE status = 'failed'`,
    )
    .run(now);
  return r.changes;
}
