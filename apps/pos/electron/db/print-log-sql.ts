/**
 * The print log's shared SQL (migrations/0030_document_prints.sql), with no
 * write path attached: repositories/document-print-repo.ts re-exports it for
 * Order History, and Reports → Staff (services/print-report.ts) reads it
 * from here, so the Reports worker thread loads neither the repositories'
 * writes nor Electron.
 */

/**
 * Why a paper printed: a receipt job's reason, or for the kitchen auto /
 * reprint / cancel; 'edited' (v0.7.36) for an Edit order's CHANGE slip and
 * the bill printed again after it.
 */
export type PrintReason = 'payment' | 'dispatch' | 'refund' | 'reprint' | 'auto' | 'cancel' | 'edited';

/** The Reprint button (and the chef-hat button): printed by hand. */
export const MANUAL_REASON: PrintReason = 'reprint';

/**
 * One row per Reprint press that printed the same paper AGAIN: receipts,
 * bills and slips (kitchen tickets left out), counted by press — a press the
 * printer fumbled ('unsure', then printed on the retry) is one — and only
 * when an earlier paper of the same series (order + what it is + which copy)
 * had already gone out, on either till.
 *
 * Since the owner's rule (27 Sep 2026) every hand press SAYS DUPLICATE and is
 * logged with print_no ≥ 1 (audit print_duplicate) — the first bill of a
 * table printed from the board too. That paper is not counted here: it is the
 * table's only bill, routine work, and counting it would bury the signal
 * Reports → Staff exists for (an old paid receipt printed again and handed to
 * a new customer). So a press counts when print_no ≥ 2 (two papers before it)
 * or an earlier row of its series is in the log. print_no 1 alone cannot tell
 * "the first paper, by hand" from "one paper before it", so the log is asked.
 * (A paper printed before the print log existed — an order paid before 0030 —
 * is not in the log: a later press on such an order counts only from its
 * second one.) Rows logged before the owner's rule follow the same test.
 *
 * Orders the owner deleted as tests (0043) are left out. Shared by Order
 * History (reprintCounts) and Reports → Staff (print-report.ts), so both show
 * the same number. `filter` narrows the rows first (placeholders only, never
 * values; it sees document_prints' own columns, unqualified).
 */
export function duplicatePressesSql(filter: string): string {
  return `SELECT p.orderId AS orderId, p.userId AS userId
            FROM (SELECT order_id AS orderId, requested_by_user_id AS userId, doc_key AS docKey, copy,
                         COALESCE(print_job_id, id) AS press, MIN(print_no) AS firstNo,
                         MIN(created_at) AS firstAt, MIN(rowid) AS firstRowid
                    FROM document_prints
                   WHERE reason = '${MANUAL_REASON}' AND copy IN ('customer', 'shop') AND deleted_at IS NULL
                     AND NOT EXISTS (SELECT 1 FROM orders dt
                                      WHERE dt.id = document_prints.order_id AND dt.deleted_at IS NOT NULL AND dt.delete_kind = 'test')
                     AND (${filter})
                   GROUP BY order_id, COALESCE(print_job_id, id)
                  HAVING MIN(print_no) > 0) p
           WHERE p.firstNo > 1
              OR EXISTS (SELECT 1 FROM document_prints e
                          WHERE e.order_id = p.orderId AND e.doc_key = p.docKey AND e.copy = p.copy
                            AND e.deleted_at IS NULL AND COALESCE(e.print_job_id, e.id) <> p.press
                            AND (e.created_at < p.firstAt OR (e.created_at = p.firstAt AND e.rowid < p.firstRowid)))`;
}
