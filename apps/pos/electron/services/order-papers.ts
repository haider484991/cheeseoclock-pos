import type { OrderPaperLabel, OrderPaperLine, PrintedDocument } from '@cheeseoclock/shared-types';
import { MANUAL_REASON } from '../db/print-log-sql.js';
import type { OrderPrintRow, PrintedCopy, SeriesPrint } from '../db/repositories/document-print-repo.js';
import { REPRINT_FREE_WINDOW_MS } from './reprint-policy.js';

/**
 * THE RULE every customer paper follows (the owner, 27 Sep 2026: "the
 * original bill will be created by default flow; other bills by manual click
 * will count as duplicate"). Also in Settings → Printing rules, and applied
 * by the spooler (print-spooler.ts stampFor), which uses the helpers below:
 *  - A paper's SERIES is the order + what it is when it prints (BILL /
 *    RECEIPT / CANCELLED ORDER / REFUND <time>) + which copy (customer or
 *    shop), counted across both tills (the print log syncs).
 *  - A paper the till prints BY ITSELF (print-spooler.ts onOrderEvent) is
 *    the ORIGINAL: the receipt at Pay, or when an order is paid as it is
 *    served or handed over (not a delivery whose bill already left with the
 *    rider); the delivery bill when the rider leaves (when that is on); the
 *    refund slip. It prints NO customer paper at Send, nor when a website
 *    order arrives — so a bill asked for before payment (a table, a website
 *    order before pick-up) only ever comes from a print button and says
 *    DUPLICATE. A second paper of the same series the till prints by itself
 *    says DUPLICATE "Copy #N".
 *  - EVERY paper printed with a print button (Order History, Recent Orders,
 *    the Live Orders board, the order panel, the receipt screen) says
 *    DUPLICATE "Reprint #N", with the time and who pressed — even when it is
 *    the first paper of its kind for the order (a cash-on-delivery receipt
 *    first printed by hand is a DUPLICATE).
 *  - The ONLY exception: sending a failed automatic job again (the spooler's
 *    own retry, "Try again" on the failed-print note, or the order panel's
 *    "Print the receipt that failed" — orderPapers next.failedJobId, offered
 *    only while nothing was printed or pressed for since) prints the original
 *    — unless the printer failed mid-way and a paper may already exist: then
 *    the retry says "Printer retry" (DUPLICATE), so there are never two
 *    unmarked originals.
 *  - Kitchen tickets say REPRINT / RE-SENT as before.
 *
 * In the print log (document_prints) print_no is 0 for a paper that printed
 * as the ORIGINAL (no DUPLICATE on it) and, for one that said DUPLICATE /
 * REPRINT / RE-SENT, how many papers of its series went out before it — at
 * least 1. So a hand-pressed first paper is logged with print_no 1 (audit
 * print_duplicate). Reports → Staff and Order History's "Reprinted ×N" count
 * only presses that followed an earlier paper of the series (print-log-sql.ts
 * duplicatePressesSql): a table's only bill, printed from the board, says
 * DUPLICATE but is not a reprint.
 */

/** A row of one series in the print log, as far as numbering goes. */
type SeriesRow = Pick<SeriesPrint, 'id' | 'printJobId' | 'printNo' | 'reason' | 'outcome'>;

/** One press or print job: its attempts count as one paper. */
export function paperKey(r: Pick<SeriesPrint, 'printJobId' | 'id'>): string {
  return r.printJobId ?? r.id;
}

/**
 * Some earlier paper of the series printed as the ORIGINAL (print_no 0, or
 * one the version before the print log printed). A hand-pressed first paper
 * is not one (print_no ≥ 1 since the owner's rule).
 */
export function seriesHasOriginal(earlier: readonly SeriesRow[], legacy: number): boolean {
  return legacy > 0 || earlier.some((r) => r.printNo === 0);
}

/**
 * The number a paper pressed for by hand carries ("Reprint #N"): the papers
 * of its series before it (each press or job once, however many tries the
 * printer needed) — plus one when none of them was the original, so the first
 * hand press of a paper the till never printed by itself is "Reprint #1" and
 * the numbers never repeat. `earlier` must leave out this press's own tries.
 */
export function handReprintNumber(earlier: readonly SeriesRow[], legacy: number): number {
  const papers = new Set(earlier.map(paperKey)).size + legacy;
  return papers + (seriesHasOriginal(earlier, legacy) ? 0 : 1);
}

export interface PaperLabelContext {
  /** Papers of a series the version before the print log printed (legacyPrintCount). */
  legacy: (document: PrintedDocument, docKey: string, copy: PrintedCopy) => number;
  /** When the order was paid (a receipt printed first by hand well after that said "Printed later"). */
  paidAt: string | null;
  /** This till (a paper printed on the other one says so). */
  deviceId: string;
}

/**
 * Before the owner's rule (v0.7.19 and older) the first paper of a series
 * was the original even when pressed for by hand, and said "Printed later"
 * when a manager had to allow it or (a receipt) when the sale was long past.
 * Such rows have print_no 0 and reason 'reprint'.
 */
function wasPrintedLater(row: OrderPrintRow, paidAt: string | null): boolean {
  if (row.reason !== MANUAL_REASON || row.copy === 'kitchen') return false;
  if (row.document !== 'receipt' && row.document !== 'bill') return false;
  if (row.approvedByUserId) return true;
  if (row.document !== 'receipt' || !paidAt) return false;
  const age = Date.parse(row.createdAt) - Date.parse(paidAt);
  return Number.isFinite(age) && age > REPRINT_FREE_WINDOW_MS;
}

/** What one paper said, given the papers of its series before it. */
function labelFor(
  row: OrderPrintRow,
  earlier: readonly OrderPrintRow[],
  legacy: number,
  paidAt: string | null,
): { label: OrderPaperLabel; duplicate: boolean } {
  if (row.printNo === 0) {
    return { label: wasPrintedLater(row, paidAt) ? 'Printed later' : 'Original', duplicate: false };
  }
  const kitchen = row.copy === 'kitchen';
  const manual = row.reason === MANUAL_REASON;
  const others = earlier.filter((r) => paperKey(r) !== paperKey(row));
  const earlierPapers = new Set(others.map(paperKey)).size + legacy;
  if (kitchen) {
    const nothingSurelyPrinted = legacy === 0 && earlier.every((r) => r.outcome === 'unsure');
    if (earlierPapers === 0 || nothingSurelyPrinted) return { label: 'RE-SENT', duplicate: true };
    return { label: manual ? `Reprint #${earlierPapers}` : `Copy #${earlierPapers + 1}`, duplicate: true };
  }
  if (manual) return { label: `Reprint #${handReprintNumber(others, legacy)}`, duplicate: true };
  // Printed by the till itself, yet marked: a retry after the printer failed
  // mid-way (nothing else was the original), or a second automatic paper.
  if (!seriesHasOriginal(others, legacy)) return { label: 'Printer retry', duplicate: true };
  return { label: `Copy #${earlierPapers + 1}`, duplicate: true };
}

/** Every paper of an order, labelled as it printed, oldest first. */
export function labelOrderPapers(rows: readonly OrderPrintRow[], ctx: PaperLabelContext): OrderPaperLine[] {
  const sorted = [...rows].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));
  const seen = new Map<string, OrderPrintRow[]>();
  const legacyBySeries = new Map<string, number>();
  const out: OrderPaperLine[] = [];
  for (const row of sorted) {
    const key = `${row.docKey}\u0000${row.copy}`;
    const earlier = seen.get(key) ?? [];
    let legacy = legacyBySeries.get(key);
    if (legacy === undefined) {
      legacy = ctx.legacy(row.document, row.docKey, row.copy);
      legacyBySeries.set(key, legacy);
    }
    const { label, duplicate } = labelFor(row, earlier, legacy, ctx.paidAt);
    out.push({
      at: row.createdAt,
      document: row.document,
      copy: row.copy,
      label: row.outcome === 'unsure' ? 'May have printed' : label,
      duplicate,
      byName: row.requestedByName,
      approvedByName: row.approvedByName,
      reason: row.reason,
      otherTill: row.deviceId !== ctx.deviceId,
    });
    seen.set(key, [...earlier, row]);
  }
  return out;
}
