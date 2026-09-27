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
 * the bytes. Each row is a synced business row plus a hash-chained audit entry
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
  const now = nowIso();
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
        now,
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

/** DUPLICATE papers printed by hand (the Reprint button) per order, one per press. For Order History. */
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
