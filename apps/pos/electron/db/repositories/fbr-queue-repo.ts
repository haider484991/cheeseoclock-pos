import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso } from './base.js';
import type { FbrMode } from '@cheeseoclock/fbr-core';

export type FbrQueueStatus = 'pending' | 'sent' | 'failed' | 'skipped';
/** What the row submits: the sale invoice, or a debit note reversing a refund. */
export type FbrQueueKind = 'sale' | 'debit_note';

export interface FbrQueueRow {
  id: string;
  orderId: string;
  kind: FbrQueueKind;
  /** For debit notes: the refund payment id the note reverses. '' for sales. */
  refId: string;
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
  kind: FbrQueueKind;
  ref_id: string;
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
    kind: r.kind,
    refId: r.ref_id,
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
  ref: { kind: FbrQueueKind; refId: string } = { kind: 'sale', refId: '' },
): void {
  const id = uuidv7();
  const now = nowIso();
  const json = JSON.stringify(payload);
  // A row that FBR already accepted is never re-opened: re-submitting an
  // accepted invoice would mint a second invoice number for the same sale.
  db.prepare(
    `INSERT INTO fbr_submission_queue
       (id, order_id, kind, ref_id, payload_json, status, attempts, enqueued_at, next_attempt_at,
        mode_at_enqueue, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id, kind, ref_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       status = 'pending',
       last_error = NULL,
       next_attempt_at = excluded.next_attempt_at,
       updated_at = excluded.updated_at
     WHERE fbr_submission_queue.status != 'sent'`,
  ).run(id, orderId, ref.kind, ref.refId, json, now, now, modeAtEnqueue, now, now);
}

export interface PendingFbrJob {
  id: string;
  orderId: string;
  payload: unknown;
  attempts: number;
  modeAtEnqueue: FbrMode;
}

/** Why a submission of a deleted order was never sent. */
export const FBR_SKIPPED_DELETED_TEST = 'Deleted as a test order';

export function claimNextPendingJob(db: AppDatabase): PendingFbrJob | null {
  const now = nowIso();
  let row:
    | {
        id: string;
        order_id: string;
        payload_json: string;
        attempts: number;
        mode_at_enqueue: FbrMode;
        order_deleted: string | null;
      }
    | undefined;
  for (;;) {
    row = db
      .prepare(
        `SELECT q.id, q.order_id, q.payload_json, q.attempts, q.mode_at_enqueue, o.deleted_at AS order_deleted
           FROM fbr_submission_queue q
           LEFT JOIN orders o ON o.id = q.order_id
          WHERE q.status IN ('pending', 'failed')
            AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
          ORDER BY q.enqueued_at
          LIMIT 1`,
      )
      .get(now) as typeof row;
    if (!row) return null;
    // An order deleted (as a test) meanwhile is never submitted: skipped.
    if (row.order_deleted === null) break;
    db.prepare(
      `UPDATE fbr_submission_queue SET status = 'skipped', last_error = ?, next_attempt_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(FBR_SKIPPED_DELETED_TEST, now, row.id);
  }
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

/** The order's sale invoice row (debit notes are looked up separately). */
export function getFbrRowByOrder(db: AppDatabase, orderId: string): FbrQueueRow | null {
  const row = db
    .prepare(
      `SELECT * FROM fbr_submission_queue WHERE order_id = ? AND kind = 'sale'`,
    )
    .get(orderId) as Row | undefined;
  return row ? toRow(row) : null;
}

/**
 * Whether this till took money for the order. The sale's FBR row is queued
 * by the till that took the payment (orders:tender / markServed /
 * markDelivered), and this table is per till: when the money was taken on
 * the other till, this one will never have the row.
 */
export function paymentTakenOnDevice(db: AppDatabase, orderId: string, deviceId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM payments
        WHERE order_id = ? AND device_id = ? AND amount_cents > 0 AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(orderId, deviceId);
  return row !== undefined;
}

/** The debit notes for these refund payments (a refund's rows share one note, keyed by one of them). */
export function getFbrDebitNotes(db: AppDatabase, orderId: string, refIds: readonly string[]): FbrQueueRow[] {
  if (refIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM fbr_submission_queue
        WHERE order_id = ? AND kind = 'debit_note' AND ref_id IN (${refIds.map(() => '?').join(', ')})`,
    )
    .all(orderId, ...refIds) as Row[];
  return rows.map(toRow);
}

/**
 * A test order was deleted (0043): its submissions still waiting — pending,
 * or failed and waiting for a retry — are never sent: 'skipped', with why.
 * Only noop or sandbox rows can be here (an order with a production row is
 * never deleted). Pure-local, like the rest of this queue; the order's
 * delete audit row lists the ids. Returns them.
 */
export function skipFbrForOrder(db: AppDatabase, orderId: string, why: string = FBR_SKIPPED_DELETED_TEST): string[] {
  const rows = db
    .prepare(`SELECT id FROM fbr_submission_queue WHERE order_id = ? AND status IN ('pending', 'failed') ORDER BY enqueued_at`)
    .all(orderId) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const now = nowIso();
  db.prepare(
    `UPDATE fbr_submission_queue SET status = 'skipped', last_error = ?, next_attempt_at = NULL, updated_at = ?
      WHERE order_id = ? AND status IN ('pending', 'failed')`,
  ).run(why, now, orderId);
  return rows.map((r) => r.id);
}

/**
 * Whether anything about this order ever went to FBR in production mode: a
 * production submission of any status, or a paper that printed a
 * production FBR number (either till: the print log syncs). Such an order
 * can't be deleted as a test — it is refunded instead.
 */
export function touchedFbrProduction(db: AppDatabase, orderId: string): boolean {
  const queued = db
    .prepare(`SELECT 1 AS x FROM fbr_submission_queue WHERE order_id = ? AND mode_at_enqueue = 'production' LIMIT 1`)
    .get(orderId);
  if (queued) return true;
  const printed = db
    .prepare(`SELECT 1 AS x FROM document_prints WHERE order_id = ? AND fbr_mode = 'production' LIMIT 1`)
    .get(orderId);
  return printed !== undefined;
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
