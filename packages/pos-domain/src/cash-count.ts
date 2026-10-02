/**
 * The drawer counted by note at Close shift (owner, 2 Oct 2026: "when
 * closing the cash count should have 5000rs x note 1000 x 500 100 and 50 and
 * 20 and 10"). shared-types shift.ts holds the rows and the CashCount shape;
 * shared-schemas cash-count.ts checks it. Money in cents throughout, the
 * note values included, so nothing here multiplies by 100.
 *
 * Pure.
 */
import type { CashCount, Cents } from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

/**
 * How a close's over / short reads (under Re 1 either way is matched): one
 * rule for the close result, the shift report, Shift history and Team &
 * leakage. It lives in shared-types so the shift report's renderer
 * (printer-core) uses the same function; here for the till's screens.
 */
export {
  CASH_PAISA_DIFFERENCE_LABEL,
  CASH_VARIANCE_MATCHED_UNDER_CENTS,
  cashPaisaDifferenceCents,
  cashVarianceVerdict,
  type CashVarianceVerdict,
} from '@cheeseoclock/shared-types';

/** What the count adds up to: each note's value × how many, plus 'Coins and other'. */
export function cashCountTotalCents(c: CashCount): Cents {
  let total = c.otherCents;
  for (const n of c.notes) total += n.faceCents * n.count;
  return total as Cents;
}

/**
 * The stored text of a count (shifts.counted_notes_json) — the only way it
 * is written. The object is built key by key, so the text is always the
 * same for the same count, whatever order the keys came in and whatever
 * else they carried:
 * {"notes":[{"faceCents":500000,"count":2},…,{"faceCents":1000,"count":4}],"otherCents":3500}
 */
export function cashCountJson(c: CashCount): string {
  return JSON.stringify({
    notes: c.notes.map((n) => ({ faceCents: n.faceCents, count: n.count })),
    otherCents: c.otherCents,
  });
}

/**
 * The count in one line, for the screens: the rows above 0 in their stored
 * order, then the coins — '5,000 × 2 · 1,000 × 3 · 10 × 4 · coins and other
 * Rs 35'. Null when nothing was counted above 0.
 */
export function cashCountText(c: CashCount): string | null {
  const parts = c.notes.filter((n) => n.count > 0).map((n) => `${formatCents(n.faceCents, { showSymbol: false })} × ${n.count}`);
  if (c.otherCents > 0) parts.push(`coins and other ${formatCents(c.otherCents)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
