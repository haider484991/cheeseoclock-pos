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
  /** A refund slip: the paid_at shared by that refund's rows (which refund it is for). */
  refundAt?: string;
  /** Who was signed in when it was queued, or who pressed Reprint. */
  requestedByUserId?: string | null;
  /** The manager whose PIN or password allowed a reprint. */
  approvedByUserId?: string | null;
}

export interface KitchenJobPayload {
  kind: 'kitchen';
  orderId: string;
  /**
   * Printed by hand (the chef-hat button). The REPRINT stamp itself comes
   * from the print log, not from this flag.
   */
  reprint: boolean;
  /** The order was cancelled while the kitchen had it: "CANCELLED — DO NOT MAKE". */
  cancelled?: boolean;
  /** Who was signed in when it was queued, or who pressed the button. */
  requestedByUserId?: string | null;
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
  cancelled?: boolean;
  refundAt?: unknown;
  requestedByUserId?: unknown;
  approvedByUserId?: unknown;
}

/** A user id kept only when it is one (a string); anything else is dropped. */
function optId(v: unknown): { requestedByUserId?: string } | Record<string, never> {
  return typeof v === 'string' && v ? { requestedByUserId: v } : {};
}

function parsePayload(kind: PrintJobKind, json: string): PrintJobPayload {
  const raw = JSON.parse(json) as RawPayload;
  switch (kind) {
    case 'kitchen':
      return raw.cancelled === true
        ? { kind, orderId: raw.orderId, reprint: false, cancelled: true, ...optId(raw.requestedByUserId) }
        : { kind, orderId: raw.orderId, reprint: raw.reprint === true, ...optId(raw.requestedByUserId) };
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
        ...(typeof raw.refundAt === 'string' && raw.refundAt ? { refundAt: raw.refundAt } : {}),
        ...optId(raw.requestedByUserId),
        ...(typeof raw.approvedByUserId === 'string' && raw.approvedByUserId
          ? { approvedByUserId: raw.approvedByUserId }
          : {}),
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
 *
 * A due cash-drawer pulse goes first, ahead of any paper — even an earlier
 * order's receipt: the cashier is standing there with the money. Then oldest
 * due first; jobs queued in the same millisecond keep the order they were
 * queued in (rowid).
 */
export function claimNextPendingJob(db: AppDatabase): PrintJobRow | null {
  const now = nowIso();
  let claimed: PrintJobRow | null = null;
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ${SELECT} FROM print_queue
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY CASE job_kind WHEN 'drawer' THEN 0 ELSE 1 END, next_attempt_at, rowid
          LIMIT 1`,
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

/** `note`: why a job is done without being sent (e.g. the drawer already opened for it). */
export function markJobDone(db: AppDatabase, id: string, note: string | null = null): void {
  const now = nowIso();
  db.prepare(
    `UPDATE print_queue SET status = 'done', completed_at = ?, updated_at = ?, last_error = ?,
                            sending_plan_json = NULL
      WHERE id = ?`,
  ).run(now, now, note, id);
}

/**
 * A job not yet finished — pending (due, in backoff or waiting for FBR) or
 * being sent now — for this order and kind. For receipts, one that prints
 * `copy` and is not a refund slip; for the kitchen, a ticket (not a
 * CANCELLED slip). A reprint pressed meanwhile joins it instead of printing
 * a second paper.
 */
export function findOpenJob(
  db: AppDatabase,
  orderId: string,
  kind: 'receipt' | 'kitchen',
  copy: ReceiptCopy = 'customer',
): PrintJobRow | null {
  const rows = db
    .prepare(
      `SELECT ${SELECT} FROM print_queue
        WHERE order_id = ? AND job_kind = ? AND status IN ('pending', 'in_flight')
        ORDER BY rowid`,
    )
    .all(orderId, kind) as RawRow[];
  for (const r of rows) {
    const job = rowToJob(r);
    const p = job.payload;
    if (p.kind === 'kitchen' && p.cancelled !== true) return job;
    if (p.kind === 'receipt' && p.reason !== 'refund' && p.copies.includes(copy)) return job;
  }
  return null;
}

/** A pending job goes now (a reprint joined it): no more backoff wait. */
export function retryNow(db: AppDatabase, id: string): void {
  const now = nowIso();
  db.prepare(
    `UPDATE print_queue SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(now, now, id);
}

/**
 * What the job is about to send (its copies and their place in the print
 * log), written just before the bytes go out. Still there at boot on a job
 * in flight: those papers may exist.
 */
export function setSendingPlan(db: AppDatabase, id: string, plan: unknown): void {
  db.prepare(`UPDATE print_queue SET sending_plan_json = ?, updated_at = ? WHERE id = ?`).run(
    plan === null ? null : JSON.stringify(plan),
    nowIso(),
    id,
  );
}

/** Jobs cut off mid-send (in flight with a plan) — for the boot check, before they are re-queued. */
export function listInFlightWithPlan(db: AppDatabase): Array<{ job: PrintJobRow; plan: unknown }> {
  const rows = db
    .prepare(
      `SELECT ${SELECT}, sending_plan_json AS plan FROM print_queue
        WHERE status = 'in_flight' AND sending_plan_json IS NOT NULL AND sending_plan_json != '"legacy"'
        ORDER BY rowid`,
    )
    .all() as Array<RawRow & { plan: string }>;
  const out: Array<{ job: PrintJobRow; plan: unknown }> = [];
  for (const r of rows) {
    try {
      out.push({ job: rowToJob(r), plan: JSON.parse(r.plan) as unknown });
    } catch {
      // A plan that can't be read is no evidence either way.
    }
  }
  return out;
}

/**
 * Jobs for an order that must not print any more because it was cancelled:
 * its kitchen tickets still waiting (never a CANCELLED slip), and on a void
 * its bills too (a dispatch bill or a reprint not yet out). Refund slips and
 * drawer pulses are never touched. Marked done with `note`; returns how many.
 * A job being sent right now is left alone.
 */
export function cancelPendingJobs(
  db: AppDatabase,
  orderId: string,
  opts: { bills: boolean; note: string },
): number {
  const rows = db
    .prepare(`SELECT ${SELECT} FROM print_queue WHERE order_id = ? AND status = 'pending' ORDER BY rowid`)
    .all(orderId) as RawRow[];
  let n = 0;
  for (const r of rows) {
    const p = rowToJob(r).payload;
    const stop =
      (p.kind === 'kitchen' && p.cancelled !== true) ||
      (opts.bills && p.kind === 'receipt' && (p.reason === 'dispatch' || p.reason === 'reprint'));
    if (!stop) continue;
    markJobDone(db, r.id, opts.note);
    n += 1;
  }
  return n;
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
            updated_at = ?,
            sending_plan_json = NULL
      WHERE id = ?`,
  ).run(errorMessage, next, new Date(now).toISOString(), id);
}

/**
 * Put a claimed job back for a moment without counting an attempt — e.g. a
 * receipt waiting a little for its FBR invoice number, which must not hold
 * up the jobs behind it (a cash drawer, the next kitchen ticket).
 */
export function deferJob(db: AppDatabase, id: string, delayMs: number): void {
  const now = Date.now();
  db.prepare(
    `UPDATE print_queue
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, sending_plan_json = NULL
      WHERE id = ?`,
  ).run(new Date(now + delayMs).toISOString(), new Date(now).toISOString(), id);
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
            updated_at = ?,
            sending_plan_json = NULL
      WHERE id = ?`,
  ).run(errorMessage, now, id);
}

/**
 * Reset any rows stuck in `in_flight` back to `pending` — called once at
 * boot. Without this, an app crash mid-print would leave a job orphaned.
 *
 * Except a drawer pulse: cut off mid-send it may already have opened the
 * drawer, and sending it again would open it twice (and late). Those are
 * marked failed instead.
 */
export function recoverStuckInFlight(db: AppDatabase): number {
  const now = nowIso();
  const drawers = db
    .prepare(
      `UPDATE print_queue
          SET status = 'failed',
              updated_at = ?,
              last_error = 'Stopped mid-send; the drawer may already have opened'
        WHERE status = 'in_flight' AND job_kind = 'drawer'`,
    )
    .run(now);
  const result = db
    .prepare(
      `UPDATE print_queue
          SET status = 'pending',
              updated_at = ?,
              last_error = COALESCE(last_error, 'Recovered from crash mid-print')
        WHERE status = 'in_flight'`,
    )
    .run(now);
  return Number(drawers.changes) + Number(result.changes);
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

/**
 * Finished jobs past their keep time. The ones printed before the print log
 * existed (marked "legacy" by migration 0030) stay: they are the only record
 * that those receipts went out, so a reprint of them still says DUPLICATE.
 */
export function purgeOldDoneJobs(db: AppDatabase, olderThanIso: string): number {
  const result = db
    .prepare(
      `DELETE FROM print_queue
        WHERE status = 'done' AND completed_at < ?
          AND (sending_plan_json IS NULL OR sending_plan_json != '"legacy"')`,
    )
    .run(olderThanIso);
  return result.changes;
}

export function purgeOldFailedJobs(db: AppDatabase, olderThanIso: string): number {
  return db
    .prepare(`DELETE FROM print_queue WHERE status = 'failed' AND updated_at < ?`)
    .run(olderThanIso).changes;
}
