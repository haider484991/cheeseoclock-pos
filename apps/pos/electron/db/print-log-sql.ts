/**
 * The print log's shared SQL (migrations/0030_document_prints.sql), with no
 * write path attached: repositories/document-print-repo.ts re-exports it for
 * Order History, and Reports → Staff (services/print-report.ts) reads it
 * from here, so the Reports worker thread loads neither the repositories'
 * writes nor Electron.
 */

/** Why a paper printed: a receipt job's reason, or for the kitchen auto / reprint / cancel. */
export type PrintReason = 'payment' | 'dispatch' | 'refund' | 'reprint' | 'auto' | 'cancel';

/** The Reprint button (and the chef-hat button): printed by hand. */
export const MANUAL_REASON: PrintReason = 'reprint';

/**
 * One row per Reprint press whose paper was a DUPLICATE: receipts, bills and
 * slips (kitchen tickets left out), counted by press — a press the printer
 * fumbled ('unsure', then printed on the retry) is one — and only when that
 * press found an earlier paper of the same series (print_no > 0 on its first
 * row). The first bill of a table printed with the button, and a first
 * receipt printed by hand long after the sale ("Printed later"), are
 * originals: never counted. Shared by Order History (reprintCounts) and
 * Reports → Staff (print-report.ts), so both show the same number.
 * `filter` narrows the rows first (placeholders only, never values).
 */
export function duplicatePressesSql(filter: string): string {
  return `SELECT order_id AS orderId, requested_by_user_id AS userId
            FROM document_prints
           WHERE reason = '${MANUAL_REASON}' AND copy IN ('customer', 'shop') AND deleted_at IS NULL
             AND (${filter})
           GROUP BY order_id, COALESCE(print_job_id, id)
          HAVING MIN(print_no) > 0`;
}
