/**
 * Pure helpers for the Order History page: date presets, filter choices in
 * cashier words, and row labels. Kept out of the component so they are
 * unit-tested (historyFilters.test.ts).
 */
import type {
  OrderHistoryChannel,
  OrderHistoryStatusGroup,
  OrderStatus,
  PaymentMethod,
} from '@cheeseoclock/shared-types';

export const HISTORY_PAGE_SIZE = 50;

export type HistoryDatePreset = 'today' | 'yesterday' | 'week' | 'all' | 'custom';

export const DATE_PRESETS: Array<{ key: HistoryDatePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'all', label: 'All' },
  { key: 'custom', label: 'Pick dates' },
];

export const STATUS_CHOICES: Array<{ key: OrderHistoryStatusGroup; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'not_paid', label: 'Not paid' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'refunded', label: 'Refunded' },
];

export const CHANNEL_CHOICES: Array<{ key: OrderHistoryChannel; label: string }> = [
  { key: 'all', label: 'All types' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'foodpanda', label: 'Foodpanda' },
  { key: 'web', label: 'Website' },
];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank',
  foodpanda: 'Foodpanda',
};

export const PAYMENT_CHOICES: Array<{ key: PaymentMethod | 'all'; label: string }> = [
  { key: 'all', label: 'Any payment' },
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'easypaisa', label: 'EasyPaisa' },
  { key: 'jazzcash', label: 'JazzCash' },
  { key: 'bank_transfer', label: 'Bank transfer' },
  { key: 'foodpanda', label: 'Foodpanda' },
];

// ------------------------------------------------------------ trading days --
//
// The same rule as Reports (features/reports/dateRange.ts): the shop trades
// noon – 1 am, so a trading day runs 05:00 → 05:00 Pakistan time. Pakistan is
// UTC+5 all year, so 05:00 PKT is 00:00 UTC and a trading day is exactly one
// UTC date. Worked out in plain UTC arithmetic so a till whose Windows time
// zone is set wrong still cuts the day in the right place.

const DAY_MS = 86_400_000;
const PKT_OFFSET_MS = 5 * 3_600_000;
const DAY_START_HOUR_PKT = 5;
/** Where a trading day starts relative to 00:00 UTC (0 for 05:00 PKT). */
const DAY_START_OFFSET_MS = DAY_START_HOUR_PKT * 3_600_000 - PKT_OFFSET_MS;

/** The trading day an instant falls in, as a whole number of days. */
export function tradingDayOf(ms: number): number {
  return Math.floor((ms - DAY_START_OFFSET_MS) / DAY_MS);
}
function dayStartIso(day: number): string {
  return new Date(day * DAY_MS + DAY_START_OFFSET_MS).toISOString();
}
/** "2026-09-26" (a date input's value) → its trading day, or null. */
function dayFromYmd(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/**
 * The created_at window for a preset, in trading days (the same days as
 * Reports): since inclusive, until exclusive. "This week" starts on Monday.
 * Custom takes two date-input values (YYYY-MM-DD, either order); a missing
 * or unreadable one leaves that side open.
 */
export function historyRange(
  preset: HistoryDatePreset,
  now: Date = new Date(),
  custom?: { from?: string; to?: string },
): { sinceIso?: string; untilIso?: string } {
  const today = tradingDayOf(now.getTime());
  switch (preset) {
    case 'today':
      return { sinceIso: dayStartIso(today), untilIso: dayStartIso(today + 1) };
    case 'yesterday':
      return { sinceIso: dayStartIso(today - 1), untilIso: dayStartIso(today) };
    case 'week': {
      // Day 0 (1970-01-01) was a Thursday; Monday → 0 … Sunday → 6.
      const sinceMonday = (((today + 3) % 7) + 7) % 7;
      return { sinceIso: dayStartIso(today - sinceMonday), untilIso: dayStartIso(today + 1) };
    }
    case 'custom': {
      let from = custom?.from ? dayFromYmd(custom.from) : null;
      let to = custom?.to ? dayFromYmd(custom.to) : null;
      if (from !== null && to !== null && from > to) [from, to] = [to, from];
      return {
        ...(from !== null ? { sinceIso: dayStartIso(from) } : {}),
        ...(to !== null ? { untilIso: dayStartIso(to + 1) } : {}),
      };
    }
    case 'all':
    default:
      return {};
  }
}

/** "#0042" from "20260926-0042". */
export function shortOrderNumber(orderNumber: string): string {
  return `#${orderNumber.split('-').pop() ?? orderNumber}`;
}

/** "Showing 51–100 of 1,234". */
export function pageLabel(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return 'No orders';
  const n = (x: number) => x.toLocaleString('en-PK');
  return `Showing ${n(offset + 1)}–${n(offset + shown)} of ${n(total)}`;
}

/**
 * When an order was taken: just the clock time if it is in today's trading
 * day, otherwise the date too ("Thu 24 Sep, 9:15 pm").
 */
const TIME_FMT = new Intl.DateTimeFormat('en-PK', {
  timeZone: 'Asia/Karachi',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

export function orderTimeLabel(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const time = TIME_FMT.format(ms);
  if (tradingDayOf(ms) === tradingDayOf(now.getTime())) return time;
  return `${DAY_FMT.format(ms)}, ${time}`;
}

/** Status in cashier words. Paid-in-advance orders still on the board say so. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  open: 'Not sent',
  sent_to_kitchen: 'In kitchen',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  served: 'Handed over',
  paid: 'Done',
  void: 'Cancelled',
  refunded: 'Refunded',
};

/** Is money still owed on this order? */
export function isOwed(o: { status: OrderStatus; paidAt: string | null }): boolean {
  return o.paidAt === null && o.status !== 'void' && o.status !== 'refunded';
}

/** The payment column: "Cash", "Card + Cash", "Not paid", or blank for a cancelled order. */
export function paymentLabel(o: {
  status: OrderStatus;
  paidAt: string | null;
  paymentMethods: PaymentMethod[];
}): string {
  if (o.status === 'void') return '—';
  if (o.paymentMethods.length > 0) return o.paymentMethods.map((m) => PAYMENT_LABELS[m]).join(' + ');
  if (o.paidAt !== null) return 'Free'; // fully discounted: stamped paid, no payment rows
  return 'Not paid';
}
