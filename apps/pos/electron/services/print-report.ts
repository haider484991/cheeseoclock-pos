import type { ReportStaffLine, ReportVoidLine } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { duplicatePressesSql } from '../db/print-log-sql.js';

/**
 * The print log's part of Reports → Staff (and the shift / day report):
 *  - per person, how many receipts / bills / slips they printed AGAIN by
 *    hand (a print button), one per press, when a paper of the same kind had
 *    already gone out — a table's first bill printed from the board says
 *    DUPLICATE (the owner's rule) but is routine and is not counted
 *    (duplicatePressesSql in print-log-sql.ts). Loss-prevention guides
 *    watch reprints per employee next to voids and no-sale opens: a
 *    reprinted paid receipt is how an old customer's bill is handed to a new
 *    customer;
 *  - on each cancelled order, whether a bill had been printed for it first —
 *    a bill that went out, cash collected, then "customer refused" is the
 *    classic skim.
 * Read-only; the log itself is written by document-print-repo.ts.
 */

/** Papers printed again by hand per person in the period, one per press (kitchen tickets not counted). */
export function handPrintsByUser(db: AppDatabase, range: { sinceIso: string; untilIso: string }): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT userId, COUNT(*) AS n
         FROM (${duplicatePressesSql('created_at >= ? AND created_at < ? AND requested_by_user_id IS NOT NULL')})
        GROUP BY userId`,
    )
    .all(range.sinceIso, range.untilIso) as Array<{ userId: string; n: number }>;
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

/** Staff lines with each person's hand-printed papers; someone who only reprinted still shows. */
export function withHandPrints(
  db: AppDatabase,
  range: { sinceIso: string; untilIso: string },
  staff: ReportStaffLine[],
  userName: (id: string) => string | null,
): ReportStaffLine[] {
  let counts: Map<string, number>;
  try {
    counts = handPrintsByUser(db, range);
  } catch {
    return staff; // an older database without the log: the report still works
  }
  const lines = staff.map((s) => ({ ...s, reprints: counts.get(s.key) ?? 0 }));
  for (const [key, n] of counts) {
    if (lines.some((l) => l.key === key)) continue;
    lines.push({
      key,
      name: userName(key) ?? 'Unknown',
      isWebsite: false,
      orderCount: 0,
      netSalesCents: 0,
      discountCents: 0,
      voidCount: 0,
      noSaleOpens: 0,
      reprints: n,
    });
  }
  return lines;
}

/** Cancelled orders marked when a bill (NOT PAID) had been printed for them before the cancel. */
export function withBillPrinted<T extends Pick<ReportVoidLine, 'orderId'>>(db: AppDatabase, voids: T[]): Array<T & { billPrinted: boolean }> {
  if (voids.length === 0) return [];
  let printed = new Set<string>();
  try {
    const ids = voids.map((v) => v.orderId);
    printed = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT order_id AS orderId FROM document_prints
              WHERE order_id IN (${ids.map(() => '?').join(', ')}) AND document = 'bill' AND deleted_at IS NULL`,
          )
          .all(...ids) as Array<{ orderId: string }>
      ).map((r) => r.orderId),
    );
  } catch {
    // An older database without the log: nothing to mark.
  }
  return voids.map((v) => ({ ...v, billPrinted: printed.has(v.orderId) }));
}
