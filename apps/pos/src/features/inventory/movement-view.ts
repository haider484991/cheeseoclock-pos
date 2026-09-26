/**
 * How the stock history reads: plain names for what happened, friendly
 * times, and the date ranges behind the filter chips. Pure (tested in
 * movement-view.test.ts); `now` is passed in so tests can pin the clock.
 */

import type { StockMovement } from '@cheeseoclock/shared-types';

export type MovementTone = 'blue' | 'green' | 'red' | 'amber' | 'purple' | 'stone';

/**
 * "Sale", "Returned", "Delivery", "Waste", "Stock take", "Batch", "Fix".
 * Batches are recorded as adjustments with a note ("Made 2 batches",
 * "Used in 1 batch of Pizza Sauce"), and a cancelled order puts its stock
 * back as a positive sale.
 */
export function movementLabel(m: Pick<StockMovement, 'reason' | 'deltaQty' | 'notes'>): { label: string; tone: MovementTone } {
  switch (m.reason) {
    case 'sale':
      return m.deltaQty > 0 ? { label: 'Returned', tone: 'stone' } : { label: 'Sale', tone: 'blue' };
    case 'delivery':
      return { label: 'Delivery', tone: 'green' };
    case 'waste':
      return { label: 'Waste', tone: 'red' };
    case 'count':
      return { label: 'Stock take', tone: 'amber' };
    case 'transfer':
      return { label: 'Transfer', tone: 'stone' };
    case 'adjustment':
      return /^(made \d+ batch|used in \d+ batch)/i.test(m.notes ?? '')
        ? { label: 'Batch', tone: 'purple' }
        : { label: 'Fix', tone: 'stone' };
  }
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
