/**
 * How the stock history reads: plain names for what happened, friendly
 * times, and the date ranges behind the filter chips. Pure (tested in
 * movement-view.test.ts); `now` is passed in so tests can pin the clock.
 */

import { orderStockNoteKind } from '@cheeseoclock/pos-domain';
import type { StockMovement } from '@cheeseoclock/shared-types';

export type MovementTone = 'blue' | 'green' | 'red' | 'amber' | 'purple' | 'stone';

/**
 * "Sale", "Returned", "Delivery", "Waste", "Stock take", "Batch", "Fix".
 * Batches are recorded as adjustments with a note ("Made 2 batches",
 * "Used in 1 batch of Pizza Sauce"). A cancelled or refunded order is
 * settled against itself ("Was the food made?", notes from pos-domain
 * orderStockNote): not made → "Returned"; made → a "Moved to waste" row that
 * undoes the sale (bookkeeping: `quiet`, shown without the green +) and a
 * "Waste" row; a stock take that already counted it → "Already counted".
 * Stock the other till took and this one put back reads "Returned" too; its
 * note says it went back "on the till that sent it". Waste booked by hand
 * says why ("Waste · burnt"), and a batch row is known by its detail too.
 */
export function movementLabel(m: Pick<StockMovement, 'reason' | 'deltaQty' | 'notes' | 'detail'>): {
  label: string;
  tone: MovementTone;
  /** Bookkeeping that moves the count but is not news: no green / red change. */
  quiet?: boolean;
} {
  const kind = orderStockNoteKind(m.notes);
  switch (m.reason) {
    case 'sale':
      if (m.deltaQty > 0 && kind === 'moved_to_waste') return { label: 'Moved to waste', tone: 'stone', quiet: true };
      if (m.deltaQty > 0 && kind === 'already_counted') return { label: 'Already counted', tone: 'stone', quiet: true };
      return m.deltaQty > 0 ? { label: 'Returned', tone: 'stone' } : { label: 'Sale', tone: 'blue' };
    case 'delivery':
      return { label: 'Delivery', tone: 'green' };
    case 'waste': {
      const why = m.detail ? WASTE_WHY[m.detail] : undefined;
      return { label: why ? `Waste · ${why}` : 'Waste', tone: 'red' };
    }
    case 'count':
      // Written by a cancel, not by someone counting: the stock take had already seen it.
      if (kind === 'already_counted') return { label: 'Already counted', tone: 'stone', quiet: true };
      return { label: 'Stock take', tone: 'amber' };
    case 'transfer':
      return { label: 'Transfer', tone: 'stone' };
    case 'adjustment':
      return m.detail === 'batch_in' || m.detail === 'batch_out' || /^(made \d+ batch|used in \d+ batch)/i.test(m.notes ?? '')
        ? { label: 'Batch', tone: 'purple' }
        : { label: 'Fix', tone: 'stone' };
  }
}

/** Why food was wasted, as the history says it (the reasons picked on the Waste screen). */
const WASTE_WHY: Partial<Record<string, string>> = {
  'waste:burnt': 'burnt',
  'waste:dropped': 'dropped',
  'waste:expired': 'expired',
  'waste:wrong_order': 'wrong order',
  'waste:returned': 'sent back',
  'waste:staff_meal': 'staff meal',
};

/**
 * The Details column: "Order #42 · Cancelled, not made — put back",
 * "Order #42 · Cancelled after cooking — counted as waste", and for a test
 * order the owner deleted "Order #42 (deleted test) · Test order deleted…".
 */
export function movementDetails(m: {
  orderNumber: string | null;
  orderDeletedAsTest?: boolean | undefined;
  refPurchaseOrderId: string | null;
  purchaseOrderRef: string | null;
  notes: string | null;
}): string {
  return [
    m.orderNumber
      ? `Order #${m.orderNumber.split('-').pop() ?? m.orderNumber}${m.orderDeletedAsTest ? ' (deleted test)' : ''}`
      : null,
    m.refPurchaseOrderId && !(m.notes ?? '').startsWith('PO ') ? `PO ${m.purchaseOrderRef ?? m.refPurchaseOrderId.slice(0, 8)}` : null,
    m.notes,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type DateRange = 'today' | '7d' | '30d' | 'all';

export const DATE_RANGES: ReadonlyArray<{ id: DateRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

/** Start of the range as an ISO instant (local midnight), or undefined for all time. */
export function rangeSinceIso(range: DateRange, now: Date = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return start.toISOString();
}

const time = new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 3:04 pm", "Yesterday 9:15 am", "21 Sep 8:00 pm", "3 Mar 2025 1:00 pm". */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = time.format(d).toLowerCase();
  if (sameDay(d, now)) return `Today ${t}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${t}`;
  return `${(d.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(d)} ${t}`;
}
