import type { OrderMode, OrderSource, OrderStatus, PaymentMethod } from './order.js';

/**
 * Order History (the `orders:history` channel).
 *
 * History lists orders that were actually PLACED: sent to the kitchen, paid,
 * done, cancelled or refunded. An `open` order is a cart still being rung up
 * at the till and never appears — the owner saw carts in history "while the
 * order is ongoing, not confirmed".
 */

/** The status choices on the History page, in cashier words. */
export type OrderHistoryStatusGroup =
  /** Every placed order. */
  | 'all'
  /** With the kitchen or on the road: sent_to_kitchen, preparing, ready, out_for_delivery. */
  | 'in_progress'
  /** Handed over: paid, served, delivered. */
  | 'done'
  /** No money taken yet (and not cancelled / refunded). */
  | 'not_paid'
  /** Voided. */
  | 'cancelled'
  /** Fully refunded, or any money handed back. */
  | 'refunded';

/** Where the order came from. `web` = the website (any mode). */
export type OrderHistoryChannel = 'all' | 'takeaway' | 'delivery' | 'foodpanda' | 'web';

export interface OrderHistoryFilter {
  /** Order number (#42), customer name, or phone. */
  search?: string;
  statusGroup?: OrderHistoryStatusGroup;
  channel?: OrderHistoryChannel;
  /** Orders with a payment by this method. */
  paymentMethod?: PaymentMethod | 'all';
  /** Inclusive lower bound on created_at (ISO). */
  sinceIso?: string;
  /** Exclusive upper bound on created_at (ISO). */
  untilIso?: string;
  /** Page size (default 50, max 200). */
  limit?: number;
  /** Rows to skip (pagination). */
  offset?: number;
}

export interface OrderHistoryRow {
  id: string;
  orderNumber: string;
  mode: OrderMode;
  source: OrderSource;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  tableLabel: string | null;
  cashierName: string;
  riderName: string | null;
  /** Items on the order (quantities added up; deal parts not counted twice). */
  itemCount: number;
  totalCents: number;
  /** Money handed back on this order so far (positive number, 0 if none). */
  refundedCents: number;
  paidAt: string | null;
  createdAt: string;
  /** Methods money was taken with (no refunds), largest first. */
  paymentMethods: PaymentMethod[];
}

export interface OrderHistorySummary {
  /** Every order the filters match (all pages). */
  orderCount: number;
  /** Paid, not cancelled/refunded: same rule as Reports (net of part refunds). */
  paidCount: number;
  salesCents: number;
  /** Placed but no money taken yet (cash on delivery out, served unpaid…). */
  notPaidCount: number;
  notPaidCents: number;
  cancelledCount: number;
  cancelledCents: number;
  /** Orders with money handed back, and how much. */
  refundCount: number;
  refundedCents: number;
  /** Money taken minus money handed back, per method. */
  byMethod: Array<{ method: PaymentMethod; netCents: number }>;
}

export interface OrderHistoryPage {
  rows: OrderHistoryRow[];
  /** Rows matching the filters across all pages. */
  total: number;
  summary: OrderHistorySummary;
}
