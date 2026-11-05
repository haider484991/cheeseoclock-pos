import type { OrderMode, OrderStatus, PaymentMethod, TestDeleteStock } from './order.js';
import type { OrderStockLine, StockSettlement } from './order-stock.js';

/**
 * Deleting a test order — the OWNER only (owner, 27 Sep 2026; migration
 * 0043). The order disappears from sales, reports, the shift's cash and the
 * customer's history, stays in the owner's list of deleted test orders, and
 * can't be brought back. Only on the till that took the order and all its
 * payments, and never an order that went to FBR in production.
 */

/** Cash of the order in one shift, net (sales less refunds), and whether that shift is still open. */
export interface TestDeleteShiftCash {
  shiftId: string;
  open: boolean;
  /** Signed paisa. */
  netCents: number;
}

/** What the order's stock is, for the question: */
export type TestDeleteStockState =
  /** It still holds stock: "Put the stock back?" must be answered. */
  | 'holds'
  /** It took no stock ("This order took no stock."). */
  | 'none'
  /** Already put back when it was cancelled or refunded. */
  | 'returned_before'
  /** Already counted as waste when it was cancelled or refunded. */
  | 'wasted_before';

/** What the dialog shows before the owner confirms (orders:testDeletePreview). Nothing is written. */
export interface TestDeletePreview {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  mode: OrderMode;
  totalCents: number;
  takenAt: string;
  takenBy: string;
  /** "2× Fajita Pizza", one per top-level line. */
  items: Array<{ name: string; quantity: number }>;
  /** Paid, net per method (sales less refunds), live rows only. */
  paid: Array<{ method: PaymentMethod; netCents: number }>;
  /** Why it can't be deleted, in the exact words; null when it can. The form is hidden then. */
  refusal: string | null;
  stock: {
    state: TestDeleteStockState;
    /** What it holds (the owner sees the lines and what they cost). Empty unless 'holds'. */
    lines: OrderStockLine[];
  };
  /** Its cash, per shift (an open shift's expected cash goes down by it). */
  cash: TestDeleteShiftCash[];
  /** The kitchen gets a CANCELLED slip (a ticket printed, and the food was not handed over). */
  kitchenSlip: boolean;
  /** It came from the website: the site will show it as cancelled. */
  web: boolean;
}

/** What deleting a test order did (orders:deleteTest). */
export interface TestDeleteResult {
  orderId: string;
  orderNumber: string;
  statusBefore: OrderStatus;
  deleteStock: TestDeleteStock;
  /** What it did to stock (null when nothing moved). */
  stock: StockSettlement | null;
  cash: TestDeleteShiftCash[];
  kitchenSlip: boolean;
  web: boolean;
}

/** One deleted test order in the owner's list. */
export interface DeletedTestOrderRow {
  orderId: string;
  orderNumber: string;
  mode: OrderMode;
  /** Its status when it was deleted (never changed by the delete). */
  status: OrderStatus;
  totalCents: number;
  takenAt: string;
  takenBy: string;
  deletedAt: string;
  deletedBy: string;
  reason: string | null;
  /** What was paid, net (sales less refunds), before it was deleted. */
  paidCents: number;
  /** Methods of its payments ("Cash", "Card"), as paid. */
  paidMethods: PaymentMethod[];
  deleteStock: TestDeleteStock | null;
  /** Booked as waste against it, at what the take cost ("Waste Rs X"). */
  wasteCents: number;
  /** "2× Fajita Pizza, 1× Cola" */
  itemsSummary: string;
}

export interface DeletedTestsPage {
  rows: DeletedTestOrderRow[];
  /** How many in the period (the page may hold fewer). */
  total: number;
  /** Their totals together. */
  totalCents: number;
}

export interface ListDeletedTestsRequest {
  sinceIso: string;
  untilIso: string;
  limit?: number;
  offset?: number;
}

export interface DeleteTestOrderRequest {
  orderId: string;
  reason: string;
  /** "Put the stock back?" — null when the order holds no stock. */
  restock: boolean | null;
  /** The owner's PIN or password, typed again. */
  ownerSecret: string;
  /** The status the dialog showed. */
  expectStatus: OrderStatus;
}

/** The reasons offered as chips (any text up to 200 letters is fine). */
export const TEST_DELETE_REASON_CHIPS = [
  'Printer test',
  'Staff training',
  'Menu or price test',
  'Rung up by mistake while testing',
] as const;

/**
 * Settings → About → "Clear practice orders" (owner, 5 Nov 2026: "we want
 * only the logs to clear nothing else menu and items should be there" —
 * with "give option to delete customer and drawer logs"; only during the
 * trial). Every order goes the way of a deleted test order, but as
 * delete_kind 'practice', so it never fills the owner's list of deleted test
 * orders; the closed shifts and their cash in / out go too. The menu, items,
 * choices, tax, staff, printers and settings are never touched. Only while
 * the till has no licence key, never with FBR live, never with a shift open
 * or a second till connected.
 */
export type PracticeClearBlockCode = 'licensed' | 'fbr_live' | 'shift_open' | 'second_till' | 'order_refused';

export interface PracticeClearBlock {
  code: PracticeClearBlockCode;
  /** In plain words, for the owner. */
  message: string;
}

/** What is on the till now (practice:preview). Nothing is written. */
export interface PracticeClearPreview {
  /** Orders still in the history, unfinished carts included. */
  orders: number;
  /** Closed shifts. */
  shifts: number;
  /** Cash in / cash out / rider payouts. */
  cashMovements: number;
  /** Rows of the cash drawer log. */
  drawerLog: number;
  /** Saved customers. */
  customers: number;
  /** Why it can't be done now; empty when it can. */
  blocks: PracticeClearBlock[];
}

export interface PracticeClearRequest {
  /** The owner's PIN or password, typed again. */
  ownerSecret: string;
  /** Also delete the saved customers (names, phone numbers, addresses). */
  customers: boolean;
  /** Also delete the cash drawer log. */
  drawerLog: boolean;
}

/** What it cleared (practice:clear). */
export interface PracticeClearResult {
  orders: number;
  shifts: number;
  cashMovements: number;
  drawerLog: number;
  customers: number;
  /** The safety copy made first (Settings → Backups). */
  backupFileName: string;
}
