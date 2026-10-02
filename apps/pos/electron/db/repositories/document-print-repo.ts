import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { PrintedDocument } from '@cheeseoclock/shared-types';
import { writeWithSync, nowIso } from './base.js';
import { getSettingRaw } from './settings-repo.js';
import { MANUAL_REASON, duplicatePressesSql, type PrintReason } from '../print-log-sql.js';

/**
 * The print log (migrations/0030_document_prints.sql): one row per paper the
 * till put out for an order, or may have. The spooler reads it to decide
 * ORIGINAL or DUPLICATE ("Reprint #2") and writes it once the printer took
 * the bytes. print_no is 0 for a paper that printed as the ORIGINAL; for one
 * marked DUPLICATE (or REPRINT / RE-SENT) it is how many papers of its series
 * went out before it, at least 1 — since the owner's rule (27 Sep 2026) a
 * paper printed with a print button always says DUPLICATE, even the first of
 * its kind (services/order-papers.ts). Each row is a synced business row plus a hash-chained audit entry
 * (print_original / print_duplicate / print_unsure: who, which order, which
 * copy), so reprints are on the record like voids and no-sale opens.
 *
 * No import of user-repo or order-repo here: the spooler (and its tests) use
 * this file, and user-repo pulls in the PIN hashing.
 */

export type PrintedCopy = 'customer' | 'shop' | 'kitchen';
export type PrintOutcome = 'printed' | 'unsure';

// Why a paper printed, the Reprint button's reason and the DUPLICATE-press SQL live in ../print-log-sql.ts.
export { MANUAL_REASON, duplicatePressesSql, type PrintReason };

/** A job finished by the version before the log: counted as printed (see legacyPrintCount). */
export const LEGACY_PLAN = '"legacy"';

/** Setting written by migration 0030: when the log started (ISO). */
export const PRINT_LOG_SINCE_KEY = 'printing.printLogSince';

export interface RecordDocumentPrintInput {
  orderId: string;
  orderNumber: string;
  document: PrintedDocument;
  docKey: string;
  copy: PrintedCopy;
  printNo: number;
  outcome: PrintOutcome;
  reason: PrintReason;
  requestedByUserId: string | null;
  approvedByUserId: string | null;
  printJobId: string | null;
  fbrIrn?: string | null;
  /** The QR printed with that number (so the other till's duplicate carries the same one). */
  fbrQrPayload?: string | null;
  /** Whether that number was a sandbox (test) or a production one. */
  fbrMode?: LoggedFbrMode | null;
  /**
   * When the paper printed, if that was before now: a paper noted late (the
   * log could not be written when the printer took it) keeps its place in
   * its series. Defaults to now.
   */
  createdAt?: string | null;
}

export type LoggedFbrMode = 'sandbox' | 'production';

/** An FBR number some till printed for an order, as the (synced) log has it. */
export interface LoggedFbr {
  irn: string;
  qrPayload: string | null;
  mode: LoggedFbrMode;
}

/** One paper of a series, oldest first. */
export interface SeriesPrint {
  id: string;
  printNo: number;
  outcome: PrintOutcome;
  reason: string;
  printJobId: string | null;
  requestedByUserId: string | null;
  approvedByUserId: string | null;
  fbrIrn: string | null;
  createdAt: string;
}

/** The series key of a document: its name, or one per refund. */
export function docKeyFor(document: PrintedDocument, refundAt?: string | null): string {
  return document === 'refund' ? `refund:${refundAt ?? ''}` : document;
}

/**
 * Put one paper in the log. `deviceId` is this till. The audit actor is the
 * person who asked for it (for a paper printed by itself, whoever was signed
 * in when the sale queued it; null when nobody was).
 */
export function recordDocumentPrint(db: AppDatabase, input: RecordDocumentPrintInput, deviceId: string): string {
  const id = uuidv7();
  const updatedAt = nowIso();
  // The print time, when it is known and earlier (a paper noted late); never a time still to come.
  const at = typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : null;
  const now = at !== null && at < updatedAt ? at : updatedAt;
  const fbrIrn = input.fbrIrn ?? null;
  const fbrQrPayload = fbrIrn ? (input.fbrQrPayload ?? null) : null;
  const fbrMode = fbrIrn ? (input.fbrMode ?? null) : null;
  const after = {
    id,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    document: input.document,
    docKey: input.docKey,
    copy: input.copy,
    printNo: input.printNo,
    reason: input.reason,
    outcome: input.outcome,
    requestedByUserId: input.requestedByUserId,
    approvedByUserId: input.approvedByUserId,
    printJobId: input.printJobId,
    fbrIrn,
    fbrQrPayload,
    fbrMode,
    // audit_log has no device column; the shop may run two tills.
    deviceId,
    createdAt: now,
  };
  const action =
    input.outcome === 'unsure' ? 'print_unsure' : input.printNo === 0 ? 'print_original' : 'print_duplicate';
  writeWithSync({
    db,
    entityType: 'document_prints',
    entityId: id,
    op: 'upsert',
    action,
    actor: { userId: input.requestedByUserId, deviceId },
    before: null,
    after,
    writeRow: () => {
      db.prepare(
        `INSERT INTO document_prints
           (id, order_id, document, doc_key, copy, print_no, outcome, reason,
            requested_by_user_id, approved_by_user_id, print_job_id, fbr_irn,
            fbr_qr_payload, fbr_mode, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        input.orderId,
        input.document,
        input.docKey,
        input.copy,
        input.printNo,
        input.outcome,
        input.reason,
        input.requestedByUserId,
        input.approvedByUserId,
        input.printJobId,
        fbrIrn,
        fbrQrPayload,
        fbrMode,
        now,
        updatedAt,
        deviceId,
      );
    },
  });
  return id;
}

/** Every paper of one series (order + document key + copy), oldest first. */
export function listSeriesPrints(db: AppDatabase, orderId: string, docKey: string, copy: PrintedCopy): SeriesPrint[] {
  const rows = db
    .prepare(
      `SELECT id, print_no AS printNo, outcome, reason, print_job_id AS printJobId,
              requested_by_user_id AS requestedByUserId, approved_by_user_id AS approvedByUserId,
              fbr_irn AS fbrIrn, created_at AS createdAt
         FROM document_prints
        WHERE order_id = ? AND doc_key = ? AND copy = ? AND deleted_at IS NULL
        ORDER BY created_at, id`,
    )
    .all(orderId, docKey, copy) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id']),
    printNo: Number(r['printNo']),
    outcome: r['outcome'] === 'unsure' ? 'unsure' : 'printed',
    reason: String(r['reason']),
    printJobId: (r['printJobId'] as string | null) ?? null,
    requestedByUserId: (r['requestedByUserId'] as string | null) ?? null,
    approvedByUserId: (r['approvedByUserId'] as string | null) ?? null,
    fbrIrn: (r['fbrIrn'] as string | null) ?? null,
    createdAt: String(r['createdAt']),
  }));
}

/** One paper of an order, any series, with the names of who asked and who approved. */
export interface OrderPrintRow extends SeriesPrint {
  document: PrintedDocument;
  docKey: string;
  copy: PrintedCopy;
  requestedByName: string | null;
  approvedByName: string | null;
  /** The till that printed it. */
  deviceId: string;
}

/**
 * Every paper of an order in the print log — both tills' (the log syncs) —
 * oldest first: the order panel's "Papers printed".
 */
export function listOrderPapers(db: AppDatabase, orderId: string): OrderPrintRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.document, d.doc_key AS docKey, d.copy, d.print_no AS printNo, d.outcome, d.reason,
              d.print_job_id AS printJobId, d.requested_by_user_id AS requestedByUserId,
              d.approved_by_user_id AS approvedByUserId, d.fbr_irn AS fbrIrn, d.created_at AS createdAt,
              d.device_id AS deviceId, ur.full_name AS requestedByName, ua.full_name AS approvedByName
         FROM document_prints d
         LEFT JOIN users ur ON ur.id = d.requested_by_user_id
         LEFT JOIN users ua ON ua.id = d.approved_by_user_id
        WHERE d.order_id = ? AND d.deleted_at IS NULL
        ORDER BY d.created_at, d.id`,
    )
    .all(orderId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r['id']),
    document: String(r['document']) as PrintedDocument,
    docKey: String(r['docKey']),
    copy: String(r['copy']) as PrintedCopy,
    printNo: Number(r['printNo']),
    outcome: r['outcome'] === 'unsure' ? 'unsure' : 'printed',
    reason: String(r['reason']),
    printJobId: (r['printJobId'] as string | null) ?? null,
    requestedByUserId: (r['requestedByUserId'] as string | null) ?? null,
    approvedByUserId: (r['approvedByUserId'] as string | null) ?? null,
    fbrIrn: (r['fbrIrn'] as string | null) ?? null,
    createdAt: String(r['createdAt']),
    deviceId: String(r['deviceId']),
    requestedByName: (r['requestedByName'] as string | null) ?? null,
    approvedByName: (r['approvedByName'] as string | null) ?? null,
  }));
}

/**
 * The sale's FBR number as a customer receipt of this order carried it, on
 * this till or the other one (the log syncs; fbr_submission_queue does not).
 * Newest first; null when no receipt with a number was printed anywhere.
 */
export function latestLoggedSaleFbr(db: AppDatabase, orderId: string): LoggedFbr | null {
  const r = db
    .prepare(
      `SELECT fbr_irn AS irn, fbr_qr_payload AS qr, fbr_mode AS mode
         FROM document_prints
        WHERE order_id = ? AND document = 'receipt' AND copy = 'customer'
          AND fbr_irn IS NOT NULL AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(orderId) as { irn: string; qr: string | null; mode: string | null } | undefined;
  if (!r?.irn) return null;
  return { irn: r.irn, qrPayload: r.qr ?? null, mode: r.mode === 'sandbox' ? 'sandbox' : 'production' };
}

/**
 * Whether a paper of this order printed for this reason (or may have:
 * 'unsure' counts), on this till or the other one: the log syncs, print_queue
 * does not. The spooler asks it for the bill that leaves with the food
 * ('dispatch'), so Send out on one till and Assign rider on the other print
 * one bill between them. A deleted row does not count. Reads by
 * idx_document_prints_order (the `+` keeps SQLite off the reason index,
 * which grows with every delivery).
 */
export function hasLoggedPaper(db: AppDatabase, orderId: string, reason: PrintReason): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM document_prints
        WHERE order_id = ? AND +reason = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(orderId, reason);
  return row !== undefined;
}

/** When the print log started on this till (null on a database that never ran 0030). */
export function printLogSince(db: AppDatabase): string | null {
  const v = getSettingRaw(db, PRINT_LOG_SINCE_KEY);
  return typeof v === 'string' && v ? v : null;
}

/**
 * Papers of a series the version before the log printed. Counted from that
 * version's finished jobs, which migration 0030 marked (drawer pulses, jobs
 * that failed and jobs done without printing are never counted):
 *  - receipt / bill: finished receipt jobs of this copy, refunds apart;
 *  - kitchen: finished kitchen tickets (not CANCELLED slips).
 * A refund slip, a cancelled-order slip and a kitchen CANCELLED slip start
 * with the log. And a receipt for an order paid before the log started, with
 * no customer-receipt job left from then on this till (deleted after 14 days,
 * or printed on the other till), is taken as printed once: the old version
 * always printed one at payment. Only such a job says anything about that
 * receipt: a failed drawer pulse, kitchen ticket or refund slip (failed jobs
 * are kept 30 days, done ones 14) does not.
 */
export function legacyPrintCount(
  db: AppDatabase,
  q: { orderId: string; document: PrintedDocument; copy: PrintedCopy; paidAt: string | null },
): number {
  if (q.document !== 'receipt' && q.document !== 'bill' && q.document !== 'kitchen') return 0;
  const jobs = db
    .prepare(`SELECT job_kind AS kind, payload_json AS payload FROM print_queue WHERE order_id = ? AND sending_plan_json = ?`)
    .all(q.orderId, LEGACY_PLAN) as Array<{ kind: string; payload: string }>;
  let n = 0;
  for (const j of jobs) {
    const p = readJobPayload(j.payload);
    if (q.document === 'kitchen') {
      if (j.kind === 'kitchen' && p.cancelled !== true) n += 1;
      continue;
    }
    if (j.kind === 'receipt' && isSaleReceiptFor(p, q.copy)) n += 1;
  }
  if (n === 0 && q.document === 'receipt' && q.copy === 'customer' && q.paidAt) {
    const since = printLogSince(db);
    if (since && q.paidAt < since) {
      const before = db
        .prepare(`SELECT payload_json AS payload FROM print_queue WHERE order_id = ? AND job_kind = 'receipt' AND created_at < ?`)
        .all(q.orderId, since) as Array<{ payload: string }>;
      if (!before.some((j) => isSaleReceiptFor(readJobPayload(j.payload), 'customer'))) n = 1;
    }
  }
  return n;
}

type JobPayloadBits = { reason?: unknown; copies?: unknown; cancelled?: unknown };

function readJobPayload(json: string): JobPayloadBits {
  try {
    const p = JSON.parse(json) as unknown;
    return p && typeof p === 'object' ? (p as JobPayloadBits) : {};
  } catch {
    return {};
  }
}

/** A receipt job for the sale (not a refund slip) that prints this copy. */
function isSaleReceiptFor(p: JobPayloadBits, copy: PrintedCopy): boolean {
  if (p.reason === 'refund') return false;
  const copies = Array.isArray(p.copies) && p.copies.length > 0 ? (p.copies as unknown[]) : ['customer'];
  return copies.includes(copy);
}

/** Papers printed AGAIN by hand (a print button, after an earlier paper of the same kind) per order, one per press. For Order History. */
export function reprintCounts(db: AppDatabase, orderIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const ids = [...new Set(orderIds)].filter((x) => typeof x === 'string' && x.length > 0);
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT orderId, COUNT(*) AS n
         FROM (${duplicatePressesSql(`order_id IN (${ids.map(() => '?').join(', ')})`)})
        GROUP BY orderId`,
    )
    .all(...ids) as Array<{ orderId: string; n: number }>;
  for (const r of rows) out[r.orderId] = Number(r.n);
  return out;
}

/** Full names for user ids (unknown ids are left out). */
export function userNames(db: AppDatabase, ids: ReadonlyArray<string | null | undefined>): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const out = new Map<string, string>();
  if (want.length === 0) return out;
  const rows = db
    .prepare(`SELECT id, full_name AS name FROM users WHERE id IN (${want.map(() => '?').join(', ')})`)
    .all(...want) as Array<{ id: string; name: string }>;
  for (const r of rows) out.set(r.id, r.name);
  return out;
}
