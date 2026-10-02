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
  /**
   * The drawer counted note by note at Close shift (migration 0050). Null
   * while open, for a shift closed before v0.7.35 or on an older till, and
   * when it was counted as one total. countedCashCents stays the truth: it
   * equals this count's sum at close, and nothing adds this up again.
   */
  countedNotes?: CashCount | null;
}

/**
 * The note rows of the Close shift count, in the owner's order and in cents
 * (owner, 2 Oct 2026: "5000rs x note 1000 x 500 100 and 50 and 20 and 10"):
 * Rs 5,000, 1,000, 500, 100, 50, 20 and 10.
 */
export const CASH_NOTE_FACE_CENTS = [500_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000] as const;

/** At most this many notes in one row of the count. */
export const CASH_NOTE_COUNT_MAX = 9_999;

/** 'Coins and other' is at most Rs 99,999, in whole rupees. */
export const CASH_COUNT_OTHER_MAX_CENTS = 9_999_900;

/** One row of the count: how many notes of one value. */
export interface CashNoteCount {
  /** The note's value in cents (Rs 5,000 = 500000). */
  faceCents: number;
  /** How many of them; a whole number from 0. */
  count: number;
}

/**
 * The drawer counted by note at Close shift. The Rs 10 row counts Rs 10
 * notes and Rs 10 coins together. otherCents is 'Coins and other': the
 * Rs 5, 2 and 1 coins and anything not in a row (an odd Rs 75 note), in
 * whole rupees. Money in cents throughout.
 */
export interface CashCount {
  notes: CashNoteCount[];
  otherCents: number;
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
 * An order of this shift delivered with "Customer refused an item" whose
 * part refund is not done yet (OrderSnapshot.refusedItem): the rider brought
 * less than the bill, so the drawer is short by that item until it is
 * refunded. The close box lists it so the manager sees why; the close is
 * never refused for it.
 */
export interface RefusedItemRefundOwed {
  orderId: UUID;
  orderNumber: string;
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
  /**
   * This shift's deliveries with a refused item still to refund
   * (RefusedItemRefundOwed), oldest first. Absent when there are none.
   */
  refusedItemRefundsOwed?: RefusedItemRefundOwed[];
  /**
   * Closing this shift pauses website orders on this till: the owner's
   * switch is on, the website link is set, and no other shift stays open
   * here. A warning for the close box only; the close itself applies the
   * real rule.
   */
  pausesWebsiteOrders: boolean;
}

/** Per-shift summary numbers used by the close dialog + history view. */
export interface ShiftSummary {
  shiftId: UUID;
  /** Orders started in this shift on this till (empty carts and unpaid ones too). */
  orderCount: number;
  /**
   * Orders settled on this till in this shift: their money was taken here
   * (the shift of the order's last payment in; a paid Rs 0 order by its own
   * shift). Refunded orders stay in paid. An order carried over and paid in
   * the next shift counts there; one taken on the other till and paid here
   * counts here. The close box, the close result and the shift report count
   * the same orders.
   */
  paidOrderCount: number;
  /** Orders money was handed back for on this till in this shift, in full or in part, each once. */
  refundedOrderCount: number;
  /** Orders started in this shift that were cancelled. */
  voidedOrderCount: number;
  totalRevenueCents: Cents;
  totalRefundsCents: Cents;
  netRevenueCents: Cents;
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  /** Cash put into the drawer that is not a sale (change top-ups). */
  cashInCents: Cents;
  /**
   * Cash taken out that is not a refund (suppliers, expenses, rider tips,
   * and the payouts to outside riders below).
   */
  cashOutCents: Cents;
  /**
   * Payouts to outside riders — kept delivery charges and wasted trips — a
   * subset of cashOutCents (cash payouts linked to an order, migration
   * 0049). Already taken out in expectedCashCents: never subtract it twice.
   */
  riderChargesCents: Cents;
  /** How many payouts riderChargesCents is (one per order, as a rule). */
  riderChargeCount: number;
  /**
   * How many of those were a trip paid (an order cancelled or refused at the
   * door after he went, or an add-on that went alone) rather than a delivery
   * charge he kept; the rest are kept charges. The close result says both
   * (e2e, 2 Oct 2026).
   */
  riderTripCount: number;
  /** The float counted when the shift was opened: the close result's first money row. */
  openingCashCents: Cents;
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
  /**
   * The order an outside rider was paid for (migration 0049): the delivery
   * charge he kept, or a trip for an order that was then cancelled. Null for
   * every cash in, cash out and rider tip typed by hand. Such a payout is
   * never a purchase.
   */
  orderId?: UUID | null;
  /** That order's number ("20261002-0042"); null when there is no order. */
  orderNumber?: string | null;
}

/**
 * Why the till opened the cash drawer (migrations 0028 and 0042). By hand:
 *  - no_sale: the Open drawer button (change, checking a note, …);
 *  - count: "Open drawer to count" while closing the shift — once per shift;
 *    any later one is recorded as no_sale;
 *  - test: Test drawer under Settings → Printers.
 * For cash (0042), written in the same transaction as the cash:
 *  - sale: a cash payment (also cash collected on delivery or at the table);
 *  - refund: cash handed back;
 *  - float: the float at shift open;
 *  - payin / payout / tip_out: cash in, cash out, a rider's tip.
 */
export type DrawerOpenKind =
  | 'no_sale'
  | 'count'
  | 'test'
  | 'sale'
  | 'refund'
  | 'float'
  | 'payin'
  | 'payout'
  | 'tip_out';

/**
 * What happened when the till pulsed the drawer for a drawer_opens row
 * (0042). Null on the row while nobody knows yet.
 *  - opened: the printer took the pulse;
 *  - already_open: a later pulse (another sale, Open drawer) opened it first;
 *  - not_opened: it surely did not open (use the key);
 *  - unsure: the printer failed mid-way, or the till stopped first;
 *  - no_printer: no receipt printer is set up.
 */
export type DrawerOutcome = 'opened' | 'already_open' | 'not_opened' | 'unsure' | 'no_printer';

/** One drawer open, saved (and audited) before the drawer is pulsed. */
export interface DrawerOpen {
  id: UUID;
  /** The shift open on this till at the time; null when none was. */
  shiftId: UUID | null;
  kind: DrawerOpenKind;
  reason: string | null;
  /** Who pressed the button (who took or handed back the cash). */
  userId: UUID;
  /** The manager whose PIN let a cashier open it; null when a manager did it. */
  approvedByUserId: UUID | null;
  createdAt: string;
  /** The order the cash was for (sale, refund). */
  orderId?: UUID | null;
  /** The cash in / out it was for (payin, payout, tip_out). */
  cashMovementId?: UUID | null;
  /** Signed paisa: + into the drawer, − out of it; null for no_sale / count / test. */
  amountCents?: number | null;
  /** What the pulse did; null while not known. */
  outcome?: DrawerOutcome | null;
  outcomeNote?: string | null;
  settledAt?: string | null;
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
