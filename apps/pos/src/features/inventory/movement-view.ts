/**
 * How the stock history reads: plain names for what happened, friendly
 * times, and the date ranges behind the filter chips. Pure (tested in
 * movement-view.test.ts); `now` is passed in so tests can pin the clock.
 */

import { orderStockNoteKind, releasedWasteReasonLabel, tradingDayOfMs, tradingDayStartMs } from '@cheeseoclock/pos-domain';
import type { StockMovement, WasteReasonSetting } from '@cheeseoclock/shared-types';

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
 * `reasons`: the owner's waste reasons (Settings → Kitchen & stock, hidden
 * ones too): a renamed or added reason reads with his name — the row keeps
 * the id, so old rows follow a rename.
 */
export function movementLabel(
  m: Pick<StockMovement, 'reason' | 'deltaQty' | 'notes' | 'detail'>,
  reasons?: ReadonlyArray<Pick<WasteReasonSetting, 'id' | 'label'>>,
): {
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
      const why = m.detail ? wasteWhy(m.detail, reasons) : undefined;
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
 * Why, as the history says it: the owner's name where he renamed the reason
 * or added it, else the released word ("burnt", "sent back"; nothing for
 * Other).
 */
function wasteWhy(detail: string, reasons: ReadonlyArray<Pick<WasteReasonSetting, 'id' | 'label'>> | undefined): string | undefined {
  const id = /^waste:(.+)$/.exec(detail)?.[1];
  const mine = id ? reasons?.find((r) => r.id === id) : undefined;
  if (mine && mine.label !== releasedWasteReasonLabel(mine.id)) return mine.label;
  return WASTE_WHY[detail];
}

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

/**
 * Start of the range as an ISO instant, or undefined for all time. Days are
 * the shop's trading days, 05:00 to 05:00 Pakistan time (the shop trades
 * noon to 1 am, like Reports and Order History): "Today" at 2 am still
 * shows the night's stock, and the last 7 days are today and the 6 trading
 * days before. Up to v0.7.26 it started at the computer's midnight.
 */
export function rangeSinceIso(range: DateRange, now: Date = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  return new Date(tradingDayStartMs(tradingDayOfMs(now.getTime()) - days)).toISOString();
}

const time = new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit', hour12: true });
// A trading day starts at 00:00 UTC (05:00 Pakistan time), so its date is read in UTC.
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * "Today 3:04 pm", "Yesterday 9:15 am", "21 Sep 8:00 pm", "3 Mar 2025 1:00 pm".
 * The day is the shop's trading day (05:00 to 05:00 Pakistan time), the
 * same as the Today chip (rangeSinceIso): at 2 am, last night's 11:30 pm is
 * "Today 11:30 pm", and after 05:00 the night's 2 am is "Yesterday 2:00 am".
 * An older row carries its trading day's date (1 am on the 22nd is the
 * night of the 21st). The words used to follow the computer's midnight,
 * and disagreed with the chip between midnight and 05:00.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = time.format(d).toLowerCase();
  const day = tradingDayOfMs(d.getTime());
  const today = tradingDayOfMs(now.getTime());
  if (day === today) return `Today ${t}`;
  if (day === today - 1) return `Yesterday ${t}`;
  const date = new Date(tradingDayStartMs(day));
  const thisYear = date.getUTCFullYear() === new Date(tradingDayStartMs(today)).getUTCFullYear();
  return `${(thisYear ? dayMonth : dayMonthYear).format(date)} ${t}`;
}
