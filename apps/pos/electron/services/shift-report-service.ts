import { createHash } from 'node:crypto';
import log from 'electron-log/main';
import {
  NO_DISCOUNT_REASON_LABEL,
  SHIFT_REPORT_SECTIONS,
  isDeliveryChargeLine,
  isDeliveryChargeName,
  shiftReportRules,
} from '@cheeseoclock/shared-types';
import type {
  OrderStatus,
  PrintResult,
  PrinterWidth,
  ShiftReport,
  ShiftReportAtClose,
  ShiftReportCancelled,
  ShiftReportPrintResult,
  ShiftReportRules,
} from '@cheeseoclock/shared-types';
import { parseShiftReportJson } from '@cheeseoclock/shared-schemas';
import { renderShiftReport } from '@cheeseoclock/printer-core';
import {
  buildShiftReport,
  shiftReportDiscountKind,
  shiftReportJson,
  type ShiftReportFacts,
  type ShiftReportFactsLine,
  type ShiftReportFactsOrder,
  type ShiftReportFactsPayment,
  type ShiftReportFactsRefund,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import { readDeliveryFeeItemIds } from '../db/business-settings-read.js';
import {
  SETTLED_IN_SHIFT_SQL,
  getShiftCloseReport,
  recordShiftReportPrint,
  shiftReportPrintHistory,
  type ShiftCloseContext,
  type ShiftCloseReport,
  type ShiftReportPrintOutcome,
} from '../db/repositories/shift-repo.js';
import { channelOf } from './analytics/sql.js';
import {
  SHIFT_TEST_DELETED_CASH_SQL,
  getOrderStockAnswers,
  refundReason,
} from './business-report.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptPrinterConfig,
} from './printer-config.js';
import { printSpooler } from './print-spooler.js';

/**
 * The shift report's figures, read at Close shift (final plan step 19d-3;
 * the owner, 2 Oct 2026: "while closing there should full sales from
 * printer"). closeShift calls makeShiftReport's maker inside its own
 * transaction, after every check that can refuse the close and before the
 * shift is written; the maker reads the facts here, pos-domain
 * buildShiftReport works the report out, and shiftReportJson's text is
 * stored with the shift (shifts.close_report_json, migration 0051) and its
 * SHA-256 kept in the close's audit row. Every print reads that saved text,
 * so a later refund, a renamed item or a deleted test order never changes a
 * closed shift's paper. The text holds every section, whatever the print
 * settings say: they only change what prints.
 *
 * Read-only: nothing here writes (the repositories own every write). It
 * reads no food cost, waste value, commission or profit — no ingredient,
 * recipe, price or cost table — so the close never loads costing data.
 * Printing the saved report once the close is done (shiftReportAtClose,
 * step 19f-2) and again later (printShiftReportAgain, step 19f-3) puts each
 * try on record through shift-repo's recordShiftReportPrint.
 *
 * The bases (shared-types shift-report.ts):
 *  - the orders SETTLED on this till in this shift (shift-repo
 *    SETTLED_IN_SHIFT_SQL: the shift that took their money), gross: SALES,
 *    BY CHANNEL, ITEMS SOLD and ORDERS. The same set the close box's 'Paid
 *    orders' counts (getShiftSummary.paidOrderCount);
 *  - the shift's live payment rows of live orders — the rows closeShift's
 *    cash figures add up — for MONEY TAKEN and the refunds. The refunds are
 *    the orders getShiftSummary.refundedOrderCount counts;
 *  - this till's orders cancelled between the open and the close;
 *  - the drawer, the note count and the unpaid orders exactly as the close
 *    worked them out (ShiftCloseContext), never read again.
 */

/** os.platform() names, as the till's first start wrote them after the PC's name ("DESKTOP-7Q2M1KD (win32)"). */
const PLATFORM_TAIL =
  /\s*\((?:win32|darwin|linux|freebsd|openbsd|netbsd|sunos|aix|android|cygwin|haiku)\)\s*$/i;

/** The till's name as the paper prints it ('Till: DESKTOP-7Q2M1KD'): its device name less the platform its first start added. */
export function tillNameForPaper(displayName: string): string {
  return displayName.replace(PLATFORM_TAIL, '').trim();
}

/** A person's name read at the close: null for no one, 'Unknown' when they are not on this till. */
function userName(db: AppDatabase, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const row = db.prepare(`SELECT full_name AS name FROM users WHERE id = ?`).get(userId) as
    | { name: string | null }
    | undefined;
  return row?.name?.trim() || 'Unknown';
}

/**
 * This till's name for the paper: its device name (device_info, written at
 * the till's first start) less the platform tail; the device id when it has
 * none. Read, never written: the maker runs inside the close.
 */
function tillName(db: AppDatabase, deviceId: string): string {
  const row = db
    .prepare(`SELECT display_name AS name FROM device_info WHERE id = 'singleton'`)
    .get() as { name: string | null } | undefined;
  return tillNameForPaper(row?.name ?? '') || deviceId;
}

interface SettledRow {
  id: string;
  orderNumber: string;
  mode: string;
  source: string;
  outside: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAt: string;
  status: string;
  discountSource: string | null;
  hasRefund: number;
}

interface LineRow {
  orderId: string;
  menuItemId: string | null;
  soldName: string;
  menuName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: number;
  lineTotal: number;
  rate: number;
}

interface PaymentRow {
  id: string;
  orderId: string;
  method: string;
  cents: number;
  paidAt: string;
  referenceNo: string | null;
  orderNumber: string;
  /** The order's stored total: a refund row of less is a part refund. */
  orderTotal: number;
  orderReason: string | null;
}

/** The orders settled on this till in the shift, with what the report needs of each, by when they were paid. */
function readSettled(db: AppDatabase, shiftId: string): SettledRow[] {
  return db
    .prepare(
      `SELECT o.id AS id, o.order_number AS orderNumber, o.mode AS mode, o.source AS source,
              (o.rider_keeps_cents IS NOT NULL) AS outside,
              o.subtotal_cents AS subtotal, o.discount_cents AS discount, o.tax_cents AS tax, o.total_cents AS total,
              o.paid_at AS paidAt, o.status AS status,
              -- The latest live discount row describes the stored discount (as Reports reads it).
              CASE WHEN o.discount_cents > 0 THEN (
                SELECT d.source FROM order_discounts d
                 WHERE d.order_id = o.id AND d.deleted_at IS NULL
                 ORDER BY d.created_at DESC, d.id DESC LIMIT 1) END AS discountSource,
              EXISTS (SELECT 1 FROM payments rp
                       WHERE rp.order_id = o.id AND rp.deleted_at IS NULL AND rp.amount_cents < 0) AS hasRefund
         FROM orders o
        WHERE o.id IN (${SETTLED_IN_SHIFT_SQL})
        ORDER BY o.paid_at, o.order_number, o.id`,
    )
    .all({ shiftId }) as SettledRow[];
}

/**
 * The live payment rows of the shift (live orders only): the money taken and
 * handed back on this till in it — the rows closeShift's cash sales and cash
 * refunds add up (the payment's shift, or the order's for a row from before
 * payments.shift_id). Two indexed selects, never one OR across both tables.
 */
function readPayments(db: AppDatabase, shiftId: string): PaymentRow[] {
  const cols = `p.id AS id, p.order_id AS orderId, p.method AS method, p.amount_cents AS cents, p.paid_at AS paidAt,
                p.reference_no AS referenceNo, o.order_number AS orderNumber,
                o.total_cents AS orderTotal, o.void_reason AS orderReason`;
  return db
    .prepare(
      `SELECT ${cols}
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.shift_id = @shiftId AND p.deleted_at IS NULL AND o.deleted_at IS NULL
       UNION ALL
       SELECT ${cols}
         FROM orders o
         JOIN payments p ON p.order_id = o.id
        WHERE o.shift_id = @shiftId AND o.deleted_at IS NULL AND +p.shift_id IS NULL AND p.deleted_at IS NULL
       ORDER BY paidAt, id`,
    )
    .all({ shiftId }) as PaymentRow[];
}

/**
 * The lines of the settled orders, the delivery charges' set apart: a charge
 * is a line sold under a delivery-charge name, a line of one of the areas'
 * fee items, or one whose menu item is named like a charge now (Reports'
 * FEE_LINE with the charges alone: never the "not food" categories or the
 * costing lookups). Each other line with the menu's name and category as
 * they are at the close (else its sold name and no category), the category
 * placed in the till's own order.
 */
function readLines(
  db: AppDatabase,
  orderIds: readonly string[],
): { lines: ShiftReportFactsLine[]; chargeCents: Map<string, number> } {
  const lines: ShiftReportFactsLine[] = [];
  const chargeCents = new Map<string, number>();
  if (orderIds.length === 0) return { lines, chargeCents };
  const rows = db
    .prepare(
      `SELECT oi.order_id AS orderId, oi.menu_item_id AS menuItemId, oi.menu_item_name AS soldName,
              mi.name AS menuName, mi.category_id AS categoryId, c.name AS categoryName,
              oi.quantity AS quantity, oi.line_total_cents AS lineTotal, oi.tax_rate_bps_snapshot AS rate
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         LEFT JOIN categories c ON c.id = mi.category_id
        WHERE oi.order_id IN (SELECT value FROM json_each(@ids)) AND oi.deleted_at IS NULL
        ORDER BY oi.order_id, oi.created_at, oi.id`,
    )
    .all({ ids: JSON.stringify(orderIds) }) as LineRow[];
  // The till's own category order (Menu's): deleted categories keep their name but have no place.
  const rank = new Map(
    (
      db
        .prepare(`SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY display_order, name`)
        .all() as Array<{ id: string }>
    ).map((c, i) => [c.id, i] as const),
  );
  const feeItemIds = readDeliveryFeeItemIds(db);
  for (const r of rows) {
    const isCharge =
      isDeliveryChargeLine({ menuItemName: r.soldName, menuItemId: r.menuItemId }, feeItemIds) ||
      (r.menuName !== null && isDeliveryChargeName(r.menuName));
    if (isCharge) {
      chargeCents.set(r.orderId, (chargeCents.get(r.orderId) ?? 0) + Number(r.lineTotal));
      continue;
    }
    const categoryName = r.categoryName ?? null;
    lines.push({
      orderId: r.orderId,
      menuItemId: r.menuItemId,
      name: r.menuName ?? r.soldName,
      categoryName,
      categoryRank:
        categoryName !== null && r.categoryId !== null ? (rank.get(r.categoryId) ?? null) : null,
      quantity: Number(r.quantity),
      lineTotalCents: Number(r.lineTotal),
      taxRateBps: Number(r.rate),
    });
  }
  return { lines, chargeCents };
}

/** Each order's payment methods: those of its live positive payments, each once. */
function readMethods(db: AppDatabase, orderIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (orderIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT p.order_id AS orderId, p.method AS method
         FROM payments p
        WHERE p.order_id IN (SELECT value FROM json_each(@ids)) AND p.deleted_at IS NULL AND p.amount_cents > 0
        GROUP BY p.order_id, p.method`,
    )
    .all({ ids: JSON.stringify(orderIds) }) as Array<{ orderId: string; method: string }>;
  for (const r of rows) out.set(r.orderId, [...(out.get(r.orderId) ?? []), r.method]);
  return out;
}

/**
 * This till's orders cancelled in the shift: live, cancelled with something
 * on them, between the open and the close (when cancelled, else when last
 * changed), in that order. Whether the food was made is the cancel's own
 * answer (getOrderStockAnswers: the stock rows' notes and the audit rows, no
 * prices); null when nobody said. The reason as Reports words it.
 */
function readCancelled(db: AppDatabase, ctx: ShiftCloseContext): ShiftReportCancelled[] {
  const rows = db
    .prepare(
      `SELECT o.id AS id, o.order_number AS orderNumber, COALESCE(o.voided_at, o.updated_at) AS at,
              o.total_cents AS cents, o.void_reason AS reason
         FROM orders o
        WHERE o.status = 'void' AND o.deleted_at IS NULL AND o.created_at <= @closedAt
          AND o.device_id = @deviceId AND o.total_cents > 0
          AND COALESCE(o.voided_at, o.updated_at) >= @openedAt AND COALESCE(o.voided_at, o.updated_at) <= @closedAt
        ORDER BY at, o.order_number, o.id`,
    )
    .all({
      deviceId: ctx.shift.deviceId,
      openedAt: ctx.shift.openedAt,
      closedAt: ctx.closedAt,
    }) as Array<{
    id: string;
    orderNumber: string;
    at: string;
    cents: number;
    reason: string | null;
  }>;
  const answers = getOrderStockAnswers(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    orderNumber: r.orderNumber,
    at: r.at,
    cents: Number(r.cents),
    made: answers.get(r.id) ?? null,
    // Reports' one wording for none (Team & leakage), as a refund's.
    reason: r.reason?.trim() || NO_DISCOUNT_REASON_LABEL,
  }));
}

/**
 * Everything the shift report is made from, read inside the close from the
 * close's own figures (see the file header). Read-only.
 */
export function readShiftReportFacts(db: AppDatabase, ctx: ShiftCloseContext): ShiftReportFacts {
  const shift = ctx.shift;
  const settledRows = readSettled(db, shift.id);
  const ids = settledRows.map((o) => o.id);
  const { lines, chargeCents } = readLines(db, ids);
  const methods = readMethods(db, ids);
  const paymentRows = readPayments(db, shift.id);

  const settled: ShiftReportFactsOrder[] = settledRows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    channel: channelOf(o.mode, o.source),
    outside: Number(o.outside) === 1,
    subtotalCents: Number(o.subtotal),
    discountCents: Number(o.discount),
    taxCents: Number(o.tax),
    totalCents: Number(o.total),
    deliveryChargeCents: chargeCents.get(o.id) ?? 0,
    discountKind: shiftReportDiscountKind(Number(o.discount), o.discountSource, o.source),
    paidAt: o.paidAt,
    status: o.status as OrderStatus,
    methods: methods.get(o.id) ?? [],
    hasRefund: Number(o.hasRefund) === 1,
  }));
  const payments: ShiftReportFactsPayment[] = paymentRows.map((p) => ({
    orderId: p.orderId,
    method: p.method,
    cents: Number(p.cents),
  }));
  // Each refund row says what that row did: 'full' only when it alone handed
  // back the order's whole total. An order refunded in two parts (or back
  // through two methods) has two rows of less, and the paper says ', part'
  // on each; the order's own state is in ORDERS ('(refunded)').
  const refunds: ShiftReportFactsRefund[] = paymentRows
    .filter((p) => Number(p.cents) < 0)
    .map((p) => ({
      orderId: p.orderId,
      orderNumber: p.orderNumber,
      at: p.paidAt,
      method: p.method,
      cents: -Number(p.cents),
      full: -Number(p.cents) >= Number(p.orderTotal),
      reason: refundReason(p.referenceNo, p.orderReason),
    }));

  return {
    shiftId: shift.id,
    deviceId: shift.deviceId,
    tillName: tillName(db, shift.deviceId),
    shopName: getReceiptBranding(db).storeName,
    openedAt: shift.openedAt,
    closedAt: ctx.closedAt,
    openedBy: shift.openedByName,
    closedBy: userName(db, ctx.closedByUserId) ?? 'Unknown',
    pinOnLoginOf: userName(db, ctx.approval?.tillSignedInUserId),
    settled,
    lines,
    payments,
    refunds,
    cancelled: readCancelled(db, ctx),
    drawer: { ...ctx.drawer, countedNotes: ctx.countedNotes },
    unpaid: { orders: ctx.unpaid, reason: ctx.carryOverReason },
  };
}

/**
 * The maker closeShift calls at the close (CloseShiftOptions.makeReport):
 * the facts, the report, its stored text and that text's SHA-256 (hex),
 * which the close's audit row keeps. Null — no report, and the log says why
 * — for a shift that is not this till's: closeShift does not check the
 * shift's till, and the paper would carry this till's name. A throw is the
 * close's to log; the shift closes all the same.
 */
export function makeShiftReport(
  db: AppDatabase,
  deviceId: string,
): (ctx: ShiftCloseContext) => ShiftCloseReport | null {
  return (ctx) => {
    if (ctx.shift.deviceId !== deviceId) {
      log.warn('Shift report not made: the shift is on another till', {
        shiftId: ctx.shift.id,
        shiftDeviceId: ctx.shift.deviceId,
        deviceId,
      });
      return null;
    }
    const json = shiftReportJson(buildShiftReport(readShiftReportFacts(db, ctx)));
    return { json, sha256: createHash('sha256').update(json, 'utf8').digest('hex') };
  };
}

/**
 * The cash of the shift's test orders the owner deleted after it closed
 * (signed; 0 for none, an open shift or an unknown one): Shift history's
 * figure for one shift, its outside riders' payouts taken off. A reprint
 * notes it under the saved figures, which it never changes.
 */
export function testDeletedSinceClose(db: AppDatabase, shiftId: string): number {
  const row = db
    .prepare(`SELECT ${SHIFT_TEST_DELETED_CASH_SQL} AS cents FROM shifts s WHERE s.id = ?`)
    .get(shiftId) as { cents: number | null } | undefined;
  return Number(row?.cents ?? 0);
}

// ---------------------------------------------------------------------------
// Printing at the close

/** Who closed the shift, as 'shifts:close' worked it out (shifts-handlers ShiftCloser). */
export interface ShiftReportCloser {
  /** The manager or owner who closed it (on a cashier's login, the one whose PIN or password was typed). */
  userId: string;
  name: string;
  /** Set when a manager's PIN or password closed it on a cashier's login: who was signed in. */
  tillSignedInUserId: string | null;
}

/** One paper of a shift's saved report, and who it is printed for. */
interface FrozenPrint {
  db: AppDatabase;
  shiftId: string;
  /** The report as saved at the close (shifts.close_report_json), never worked out again. */
  report: ShiftReport;
  /** This till's switches (Settings → Printers → Shift report), read when it was asked for. */
  rules: ShiftReportRules;
  /** The 'Printed ... by' name (and, on a reprint, the DUPLICATE band's). */
  printedByName: string;
  byUserId: string;
  approvedByUserId: string | null;
  /** null for the ORIGINAL; N for a DUPLICATE 'Reprint #N'. */
  reprintNo: number | null;
  /** A reprint's note under the saved figures: the cash of test orders deleted since the close (signed; 0 for none). */
  testDeletedCashCents: number;
}

/**
 * The shift report at Close shift (final plan step 19f-2; the owner, 2 Oct
 * 2026: the FULL paper at every close, whoever closes — owner, manager, or a
 * manager's PIN on a cashier's login). 'shifts:close' calls it once the
 * close is saved, so the count stays blind: nothing of it prints before.
 *
 * It answers at once and NEVER throws: a print problem can never turn a
 * saved close into an error. Everything it reads (the saved report, the
 * owner's switches, the printer setup) sits in one try; any throw is logged
 * and answered 'not_made'. In order:
 *  - 'not_made': no report was saved with the close (another till's shift,
 *    or the maker failed: the close logged why), or it cannot be read;
 *  - 'off': the owner switched printing at close off on this till;
 *  - 'no_printer': the "No printer" setup. Its papers go to a file
 *    (userData/printer-mock), and so does this one, like every receipt
 *    there; nobody holds a paper, so nothing is put in the print log and no
 *    failure is shown;
 *  - 'printing': sent to the receipt printer WITHOUT waiting (printFrozen).
 *    A paper that does not print comes back as a 'printer:failed' note
 *    naming the shift.
 * The sections and ITEMS SOLD are this till's switches, the same for every
 * closer; they change only what prints (the saved report keeps every
 * section).
 */
export function shiftReportAtClose(db: AppDatabase, shiftId: string, closer: ShiftReportCloser): ShiftReportAtClose {
  try {
    const parsed = parseShiftReportJson(getShiftCloseReport(db, shiftId)?.json);
    if (!parsed || !('report' in parsed)) {
      log.warn('Shift report not printed: none saved with the close', { shiftId });
      return 'not_made';
    }
    const rules = shiftReportRules(getPrintPolicy(db));
    if (!rules.onClose) {
      log.info('Shift report not printed: printing at close is off on this till', { shiftId });
      return 'off';
    }
    const job: FrozenPrint = {
      db,
      shiftId,
      report: parsed.report,
      rules,
      printedByName: closer.name,
      byUserId: closer.userId,
      // The manager's PIN or password closed it on a cashier's login.
      approvedByUserId: closer.tillSignedInUserId ? closer.userId : null,
      reprintNo: null,
      testDeletedCashCents: 0,
    };
    if (!printSpooler.hasReceiptPrinter()) {
      void toNoPrinterFile(job);
      return 'no_printer';
    }
    void printFrozen(job);
    return 'printing';
  } catch (e) {
    log.error('Shift report not printed at the close', { shiftId, error: e instanceof Error ? e.message : String(e) });
    return 'not_made';
  }
}

/**
 * The paper's bytes at the printer's width: the saved report, this till's
 * switches, printed now. A reprint says DUPLICATE 'Reprint #N' (now, by the
 * person printing it) and notes the test orders deleted since the close.
 */
function renderFrozen(job: FrozenPrint, width: PrinterWidth): Uint8Array {
  const printedAt = new Date();
  const stamp = job.reprintNo === null ? null : { reprintNo: job.reprintNo, at: printedAt, byName: job.printedByName };
  return renderShiftReport(job.report, {
    width,
    sections: job.rules.sections,
    items: job.rules.items,
    printedAt,
    printedByName: job.printedByName,
    stamp,
    sinceClose: stamp ? { testDeletedCashCents: job.testDeletedCashCents } : null,
  });
}

/** The receipt printer's paper width as set (48 when it cannot be read): for the print log when the paper was never drawn. */
function receiptWidth(db: AppDatabase): PrinterWidth {
  try {
    return (getReceiptPrinterConfig(db) ?? DEFAULT_RECEIPT_CONFIG).width === 32 ? 32 : 48;
  } catch {
    return 48;
  }
}

/**
 * One paper of the saved report sent to the receipt printer
 * (printDocumentNow: in turn with the queue, no print_queue row, no drawer
 * pulse), and the width it was drawn at (the printer's as set when it was
 * never drawn). A throw is a failure like any other.
 */
async function sendFrozen(job: FrozenPrint): Promise<{ result: PrintResult; width: PrinterWidth }> {
  const drawn: { width: PrinterWidth | null } = { width: null };
  let result: PrintResult;
  try {
    result = await printSpooler.printDocumentNow((width) => {
      drawn.width = width;
      return renderFrozen(job, width);
    });
  } catch (e) {
    // printDocumentNow never throws; should it ever, it is a failure like any other.
    result = {
      ok: false,
      durationMs: 0,
      error: { code: 'spooler_exception', message: e instanceof Error ? e.message : String(e), recoverable: true },
    };
  }
  return { result, width: drawn.width ?? receiptWidth(job.db) };
}

/**
 * One 'shift_report_printed' row for a try ('maybe' when the printer failed
 * after the bytes may have gone out): the ORIGINAL, or 'Reprint #N', with
 * the sections and the width it printed at. A row that cannot be written is
 * logged; the paper's answer stands.
 */
function recordTry(job: FrozenPrint, sent: { result: PrintResult; width: PrinterWidth }): void {
  const { db, shiftId, rules } = job;
  const { result } = sent;
  try {
    recordShiftReportPrint(db, {
      shiftId,
      copy: job.reprintNo === null ? 'original' : 'reprint',
      reprintNo: job.reprintNo ?? 0,
      sections: SHIFT_REPORT_SECTIONS.map((s) => s.key).filter((k) => rules.sections[k]),
      items: rules.items,
      width: sent.width,
      outcome: (result.ok ? 'ok' : result.error?.maybeSent ? 'maybe' : 'failed') satisfies ShiftReportPrintOutcome,
      errorCode: result.ok ? null : (result.error?.code ?? 'unknown'),
      byUserId: job.byUserId,
      approvedByUserId: job.approvedByUserId,
    });
  } catch (e) {
    log.error('Shift report print not put on record', { shiftId, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The ORIGINAL at the close, on the receipt printer. Nothing waits for it.
 * The try goes on record (recordTry); a paper that did not print is then
 * told to the till windows (notifyShiftReportFailure), so Try again finds
 * the failed original. Never throws: every error is caught and logged.
 */
async function printFrozen(job: FrozenPrint): Promise<void> {
  const { shiftId } = job;
  try {
    const sent = await sendFrozen(job);
    recordTry(job, sent);
    if (sent.result.ok) {
      log.info('Shift report printed', { shiftId, width: sent.width });
    } else {
      printSpooler.notifyShiftReportFailure(shiftId, sent.result.error);
    }
  } catch (e) {
    log.error('Shift report not printed', { shiftId, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The "No printer" setup: the report goes to its file like every paper there
 * (the mock printer, userData/printer-mock), so it can still be read. Not a
 * paper anyone holds: no print-log row, no failure note. Never throws.
 */
async function toNoPrinterFile(job: FrozenPrint): Promise<void> {
  try {
    const result = await printSpooler.printDocumentNow((width) => renderFrozen(job, width));
    if (result.ok) log.info('Shift report written to the No printer file', { shiftId: job.shiftId });
    else log.warn('Shift report not written to the No printer file', { shiftId: job.shiftId, error: result.error });
  } catch (e) {
    log.warn('Shift report not written to the No printer file', {
      shiftId: job.shiftId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Printing again: Try again and Print again

/** Why a shift's report cannot be printed again; 'shifts:printReport' words it (guards.ts REFUSED). */
export type ShiftReportAgainRefusal = 'not_saved' | 'newer' | 'unreadable';

/** printShiftReportAgain said no: nothing printed, nothing put on record. */
export class ShiftReportRefused extends Error {
  constructor(readonly reason: ShiftReportAgainRefusal) {
    super(`Shift report not printed again: ${reason}`);
    this.name = 'ShiftReportRefused';
  }
}

/** Who prints the report again: the person signed in, and the manager or owner whose PIN or password let a cashier's login do it. */
export interface ShiftReportAgainBy {
  userId: string;
  name: string;
  approvedByUserId: string | null;
}

/** The answer on the "No printer" setup, where nothing prints. */
export const NO_RECEIPT_PRINTER = 'No receipt printer is set up on this till';

let againTurn: Promise<unknown> = Promise.resolve();

/** One print-again at a time on this till: each reads the print log after the one before it put its try on record. */
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = againTurn.then(work, work);
  againTurn = run.catch(() => undefined);
  return run;
}

/**
 * The shift report again (final plan step 19f-3): Try again on the note
 * that it did not print, the close result's Print again and Shift history's
 * (through 'shifts:printReport', which decides who may, and that the shift
 * is closed, first). Awaited: it answers once the printer has (the
 * adapters' own timeouts bound the wait).
 *
 * It prints the figures saved at the close (parseShiftReportJson), never
 * worked out again, through this till's renderer with its section switches
 * as they are NOW: a section the owner switched on since the close prints
 * from the saved figures too (the owner, 2 Oct 2026: toggles change only
 * what prints). Printing at close being off does not stop it.
 *  - again false (Try again) while this till tried the ORIGINAL and none
 *    came out (no 'ok' or 'maybe' on record): the ORIGINAL again, like a
 *    receipt's Try again;
 *  - otherwise a DUPLICATE 'Reprint #N', N one more than the highest that
 *    came out or may have on this till, with the cash of test orders the
 *    owner deleted since the close noted under the saved figures (never
 *    taken off them).
 * Each try goes on record (one 'shift_report_printed' row). The "No
 * printer" setup writes the paper to its file, as at the close, puts
 * nothing on record and answers not printed, code 'no_printer'.
 *
 * Refused with ShiftReportRefused (nothing printed or written): no report
 * saved with the close ('not_saved'), one made by a newer till ('newer'),
 * or one that cannot be read ('unreadable').
 */
export function printShiftReportAgain(
  db: AppDatabase,
  req: { shiftId: string; again: boolean },
  by: ShiftReportAgainBy,
): Promise<ShiftReportPrintResult> {
  return inTurn(async () => {
    const { shiftId } = req;
    const stored = getShiftCloseReport(db, shiftId);
    if (!stored) throw new ShiftReportRefused('not_saved');
    const parsed = parseShiftReportJson(stored.json);
    if (!parsed) {
      log.warn('Shift report not printed again: the saved report cannot be read', { shiftId });
      throw new ShiftReportRefused('unreadable');
    }
    if (!('report' in parsed)) throw new ShiftReportRefused('newer');

    const history = shiftReportPrintHistory(db, shiftId);
    const original = !req.again && history.originalTries > 0 && !history.originalPrinted;
    const job: FrozenPrint = {
      db,
      shiftId,
      report: parsed.report,
      rules: shiftReportRules(getPrintPolicy(db)),
      printedByName: by.name,
      byUserId: by.userId,
      approvedByUserId: by.approvedByUserId,
      reprintNo: original ? null : history.reprints + 1,
      testDeletedCashCents: original ? 0 : testDeletedSinceClose(db, shiftId),
    };
    const copy = original ? 'original' : 'reprint';
    const reprintNo = job.reprintNo ?? 0;
    if (!printSpooler.hasReceiptPrinter()) {
      await toNoPrinterFile(job);
      return { printed: false, copy, reprintNo, error: { code: 'no_printer', message: NO_RECEIPT_PRINTER } };
    }
    const sent = await sendFrozen(job);
    recordTry(job, sent);
    const { result } = sent;
    if (result.ok) {
      log.info('Shift report printed again', { shiftId, copy, reprintNo, width: sent.width });
      return { printed: true, copy, reprintNo, error: null };
    }
    log.warn('Shift report not printed again', { shiftId, copy, reprintNo, error: result.error });
    return {
      printed: false,
      copy,
      reprintNo,
      error: {
        code: result.error?.code ?? 'unknown',
        message: result.error?.message ?? 'Unknown print error',
        ...(result.error?.maybeSent ? { maybeSent: true } : {}),
      },
    };
  });
}
