import type { OrderPaperLine, OrderPapers, PrintedDocument } from '@cheeseoclock/shared-types';

/**
 * The words for an order's papers on screen: the print button (what it will
 * print, and whether that is the original) and the order panel's "Papers
 * printed" list. Pure, so it is tested on its own.
 *
 * The rule behind them (the owner, 27 Sep 2026; Settings → Printing rules):
 * the paper the till prints by itself in the normal flow is the ORIGINAL;
 * every paper printed with a print button says DUPLICATE, the first of its
 * kind too. A bill and the paid receipt are different papers. The button says
 * which paper it prints ("Print bill" the first time, "Print bill again"
 * after); either way the paper says DUPLICATE.
 */

const PAPER_NAME: Record<'bill' | 'receipt' | 'void', string> = {
  bill: 'bill',
  receipt: 'receipt',
  void: 'cancelled slip',
};

/**
 * What the order's print button says, from what it would print now. When
 * the till's own paper failed and nothing came since (next.failedJobId), the
 * button sends THAT job again — the original, like "Try again" on the
 * failed-print note — instead of printing a DUPLICATE.
 */
export function paperButtonLabel(next: OrderPapers['next'] | null | undefined): string {
  if (!next) return 'Print bill or receipt';
  if (next.waiting) return 'Printing…';
  if (next.failedJobId) return `Print the ${PAPER_NAME[next.document]} that failed`;
  const again = next.printedBefore > 0;
  switch (next.document) {
    case 'bill':
      return again ? 'Print bill again' : 'Print bill';
    case 'void':
      return again ? 'Print cancelled slip again' : 'Print cancelled slip';
    default:
      return again ? 'Reprint receipt' : 'Print receipt';
  }
}

const DOCUMENT_WORDS: Record<PrintedDocument, string> = {
  receipt: 'RECEIPT',
  bill: 'BILL',
  void: 'CANCELLED ORDER',
  refund: 'REFUND',
  kitchen: 'KITCHEN TICKET',
  kitchen_cancel: 'KITCHEN CANCELLED',
  kitchen_change: 'KITCHEN CHANGE',
};

const REASON_WORDS: Record<string, string> = {
  payment: 'at payment',
  dispatch: 'when the rider left',
  refund: 'at the refund',
  reprint: 'by hand',
  auto: 'when sent to the kitchen',
  cancel: 'when cancelled',
  edited: 'after the order was changed',
};

const TIME_24 = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short' });

/** "19:35", or "Sat 26 Sep 19:35" when the paper is from another day than `sameDayAs`. */
export function paperTime(iso: string, sameDayAs?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const time = TIME_24.format(ms);
  if (sameDayAs === undefined) return time;
  const ref = Date.parse(sameDayAs);
  return Number.isFinite(ref) && DAY.format(ref) === DAY.format(ms) ? time : `${DAY.format(ms)} ${time}`;
}

/** What the paper said at the top: "Original", "DUPLICATE Reprint #1", "RE-SENT"… */
function markWords(line: OrderPaperLine): string {
  if (line.label === 'May have printed') return 'May have printed (the printer failed mid-way)';
  const kitchen = line.document === 'kitchen' || line.document === 'kitchen_cancel' || line.document === 'kitchen_change';
  if (!line.duplicate || kitchen) return line.label;
  return `DUPLICATE ${line.label}`;
}

/**
 * One line of "Papers printed", e.g.
 *  "19:35 RECEIPT — Original — at payment — Ali"
 *  "19:52 RECEIPT — DUPLICATE Reprint #1 — Sana (approved by Owner)"
 * `sameDayAs`: the order's day (a paper from another day shows its date).
 */
export function paperLineText(line: OrderPaperLine, sameDayAs?: string): string {
  const doc = `${DOCUMENT_WORDS[line.document] ?? line.document.toUpperCase()}${line.copy === 'shop' ? ' (shop copy)' : ''}`;
  const parts = [`${paperTime(line.at, sameDayAs)} ${doc}`, markWords(line)];
  // A reprint says it was by hand already.
  if (!line.label.startsWith('Reprint')) {
    const why = REASON_WORDS[line.reason];
    if (why) parts.push(why);
  }
  const who = [
    line.byName ?? null,
    line.approvedByName ? `(approved by ${line.approvedByName})` : null,
    line.otherTill ? '(other till)' : null,
  ]
    .filter((x): x is string => !!x)
    .join(' ');
  if (who) parts.push(who);
  return parts.join(' — ');
}
