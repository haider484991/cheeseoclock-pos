import type { Cents } from './money.js';
import type { UUID } from './ids.js';

export interface Shift {
  id: UUID;
  deviceId: string;
  openedByUserId: UUID;
  openedByName: string;
  closedByUserId: UUID | null;
  closedByName: string | null;
  openedAt: string;
  closedAt: string | null;
  openingCashCents: Cents;
  /** Manager's drawer count at close. Null while open. */
  countedCashCents: Cents | null;
  /** Computed at close: opening + cash sales − cash refunds + pay-ins − pay-outs. */
  expectedCashCents: Cents | null;
  /** counted − expected (negative = short, positive = over). */
  varianceCents: Cents | null;
  /**
   * The note typed when the shift was OPENED ("Morning shift, Ali on
   * register"). A shift closed before migration 0039 keeps its one note here.
   */
  notes: string | null;
  /** The note typed when the shift was CLOSED ("Rs 100 short, change given wrong"). Null while open. */
  closeNotes: string | null;
  /**
   * Unpaid orders this till still had when the shift closed, carried over to
   * the next shift with a manager's reason (0 when none; migration 0039).
   * The manager who approved it is `closedByUserId`.
   */
  carriedUnpaidCount: number;
  /** The manager's reason for carrying them over; null when none were carried. */
  carryOverReason: string | null;
}

/**
 * An order still unpaid on this till when its shift is being closed: the
 * close box lists them, and the manager gives one reason to carry them all
 * over to the next shift (owner, 2026-09-27).
 */
export interface UnpaidOrderAtClose {
  orderId: UUID;
  orderNumber: string;
  createdAt: string;
  totalCents: Cents;
  /** Who took the order ("Website" for a web order). */
  takenBy: string;
}

/**
 * What the close box needs before the count (`shifts:closeCheck`): who is
 * closing (the signed-in manager, or the manager whose PIN was typed on a
 * cashier's till) and the unpaid orders that will be carried over. Never
 * the expected cash: the count is blind.
 */
export interface ShiftCloseCheck {
  closerName: string;
  /** True when a manager's PIN or password approved it on a cashier's login. */
  viaManagerPin: boolean;
  unpaidOrders: UnpaidOrderAtClose[];
}

/** Per-shift summary numbers used by the close dialog + history view. */
export interface ShiftSummary {
  shiftId: UUID;
  orderCount: number;
  paidOrderCount: number;
  refundedOrderCount: number;
  voidedOrderCount: number;
  totalRevenueCents: Cents;
  totalRefundsCents: Cents;
  netRevenueCents: Cents;
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  /** Cash put into the drawer that is not a sale (change top-ups). */
  cashInCents: Cents;
  /** Cash taken out that is not a refund (suppliers, expenses, rider tips). */
  cashOutCents: Cents;
  /** opening + cashSales − cashRefunds + cashIn − cashOut. */
  expectedCashCents: Cents;
  byMethod: Array<{
    method: string;
    salesCents: Cents;
    refundCents: Cents;
    netCents: Cents;
  }>;
}

export type CashMovementType = 'payout' | 'payin' | 'tip_out';

export interface CashMovement {
  id: UUID;
  shiftId: UUID;
  type: CashMovementType;
  amountCents: Cents;
  reason: string;
  userId: UUID;
  userName: string | null;
  /** The manager whose PIN let a cashier record it; null when a manager did it. */
  approvedByUserId: UUID | null;
  createdAt: string;
  /**
   * The purchase this payout paid for (costing spec Phase 5): written with a
   * purchase "Paid from the drawer", or linked later by a manager. Null for
   * a free-text payout (and for cash in and rider tips).
   */
  refPurchaseOrderId?: UUID | null;
}

/**
 * Why the cash drawer was opened by hand (not by a sale):
 *  - no_sale: the Open drawer button (change, checking a note, …);
 *  - count: "Open drawer to count" while closing the shift — once per shift;
 *    any later one is recorded as no_sale;
 *  - test: Test drawer under Settings → Printers.
 */
export type DrawerOpenKind = 'no_sale' | 'count' | 'test';

/** One manual drawer open, saved (and audited) before the drawer is pulsed. */
export interface DrawerOpen {
  id: UUID;
  /** The shift open on this till at the time; null when none was. */
  shiftId: UUID | null;
  kind: DrawerOpenKind;
  reason: string | null;
  /** Who pressed the button. */
  userId: UUID;
  /** The manager whose PIN let a cashier open it; null when a manager did it. */
  approvedByUserId: UUID | null;
  createdAt: string;
}

/** What happened when the till tried to open the drawer by hand. */
export interface DrawerOpenResult {
  /** The saved DrawerOpen. */
  id: string;
  /** The printer took the pulse. */
  opened: boolean;
  /** The printer had a problem mid-way: the drawer may or may not have opened. */
  unsure: boolean;
  /** No printer is set up (Settings → Printers): nothing could open. */
  noPrinter: boolean;
  /** Why it did not open, in plain words; null when it opened. */
  message: string | null;
}
