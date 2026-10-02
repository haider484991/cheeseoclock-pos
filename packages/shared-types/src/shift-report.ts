/**
 * The shift report: the paper the till prints on its receipt printer when a
 * shift closes (the owner, 2 Oct 2026: "while closing there should full
 * sales from printer"; and on the sample paper: "all orders and totals also
 * add seetngs so we can customize").
 *
 * It is worked out once, inside the close, and saved with the shift as JSON
 * (shifts.close_report_json, migration 0051; written only through pos-domain
 * shiftReportJson, read through shared-schemas parseShiftReportJson). Every
 * print — at the close, Try again, Print again, Shift history — prints these
 * saved figures; nothing works them out again, so a later refund, a renamed
 * item or a deleted test order never changes a closed shift's paper.
 *
 * The saved report always holds EVERY section, the list of every order
 * included. The owner's switches (Settings → Printers → Shift report, per
 * till, owner only, all on at first; SHIFT_REPORT_SECTIONS) only change what
 * PRINTS, so a section switched on later prints from the saved figures.
 *
 * What each part covers (the bases):
 *  - sales, channels, discounts, items and orders: the orders SETTLED on
 *    this till in this shift (their money taken here), GROSS — an order
 *    refunded later, or in this shift, in full or in part, stays in them;
 *    its money comes off at sales.refunds, and the orders list flags it.
 *    (Reports instead leave a fully refunded order out of its sales.)
 *  - payments, paymentRefunds, refunds and the drawer: the money that
 *    changed hands on this till in this shift.
 *  - cancelled: this till's orders cancelled between the open and the close.
 *  - unpaid: the close's own list of orders carried over, and its reason.
 *
 * Money in integer cents throughout (a refund's or a payout's cents are
 * positive; the paper puts the minus sign). Times are ISO 8601 UTC; the
 * paper prints them in Pakistan time. Names are as they were at the close.
 * No food cost, waste rupees, commission or profit is anywhere in it: the
 * paper is for the drawer and the day's sales, and staff see it.
 */

import type { CashCount } from './shift.js';
import type { ReportChannel } from './reports.js';

/** The shape version of the saved report. A till reads only versions up to its own. */
export const SHIFT_REPORT_VERSION = 1;

/**
 * What kind of discount an order had, in the paper's order: the foodpanda
 * deal, a staff discount (a button, a preset or a typed amount), the
 * website's pick-up discount, an automatic offer.
 */
export type ShiftReportDiscountKind = 'foodpanda' | 'staff' | 'website' | 'offer';

/** The parts of the paper the owner can switch off (Settings → Printers → Shift report). */
export type ShiftReportSection =
  | 'sales'
  | 'moneyTaken'
  | 'channels'
  | 'cancelsRefunds'
  | 'drawer'
  | 'counted'
  | 'unpaid'
  | 'items'
  | 'orders';

/** One section switch: its key and the owner's words for it. */
export interface ShiftReportSectionInfo {
  readonly key: ShiftReportSection;
  readonly label: string;
}

/**
 * The nine sections in the order they print, with the labels of their
 * switches. All are on at first; switching one off only leaves it off the
 * paper (the saved report keeps it).
 */
export const SHIFT_REPORT_SECTIONS: readonly ShiftReportSectionInfo[] = [
  { key: 'sales', label: 'Sales' },
  { key: 'moneyTaken', label: 'Money taken' },
  { key: 'channels', label: 'By channel' },
  { key: 'cancelsRefunds', label: 'Cancelled and refunded' },
  { key: 'drawer', label: 'Cash drawer' },
  { key: 'counted', label: 'Cash counted' },
  { key: 'unpaid', label: 'Unpaid carried over' },
  { key: 'items', label: 'Items sold' },
  { key: 'orders', label: 'All orders' },
];

/** How many orders and how much money. */
export interface ShiftReportOrdersCents {
  orderCount: number;
  cents: number;
}

/** How many entries (cash movements) and how much money. */
export interface ShiftReportCountCents {
  count: number;
  cents: number;
}

/** One kind of discount: how many orders had it, and how much it took off. */
export interface ShiftReportDiscountLine {
  kind: ShiftReportDiscountKind;
  orderCount: number;
  cents: number;
}

/** SALES: the orders settled on this till in this shift, gross. */
export interface ShiftReportSales {
  /** Orders settled ('<n> orders paid'), refunded ones included. */
  orderCount: number;
  /** Food: Σ subtotal less the delivery-charge lines, before discounts and tax. */
  foodCents: number;
  /** The orders with a delivery charge, and the charges (before tax). */
  delivery: ShiftReportOrdersCents;
  /** Each kind with orders, in the order foodpanda, staff, website, offer. A Rs 0 discount never counts. */
  discounts: ShiftReportDiscountLine[];
  taxCents: number;
  /** The one non-zero tax rate of the lines in basis points (1500 = 15%); null when none or mixed. */
  taxRateBps: number | null;
  /** TOTAL (with tax): Σ the orders' stored totals. */
  billedCents: number;
  /** Money handed back in this shift (distinct orders; cents positive). */
  refunds: ShiftReportOrdersCents;
  /** NET SALES: billed − refunds. */
  netCents: number;
  /** Average bill: billed ÷ orders, rounded to the paisa; 0 with no orders. */
  averageCents: number;
}

/**
 * One payment method's money in this shift: how many orders and how much.
 * method is the stored method ('cash', 'card', 'easypaisa', 'jazzcash',
 * 'bank_transfer', 'foodpanda'); an unknown one is kept as stored.
 */
export interface ShiftReportMoneyLine {
  method: string;
  orderCount: number;
  cents: number;
}

/** One channel's settled orders; delivery and web_delivery split out the outside riders' part. */
export interface ShiftReportChannelLine {
  channel: ReportChannel;
  orderCount: number;
  billedCents: number;
  /** The orders sent out with an outside rider (rider_keeps_cents set); null when there were none. */
  outside: { orderCount: number; billedCents: number } | null;
}

/** An order of this till cancelled in this shift. */
export interface ShiftReportCancelled {
  orderNumber: string;
  /** When it was cancelled. */
  at: string;
  cents: number;
  /** Whether the kitchen had made the food ('made' = food wasted); null when nobody said. */
  made: 'made' | 'not_made' | null;
  reason: string | null;
}

/** A refund given on this till in this shift. */
export interface ShiftReportRefund {
  orderNumber: string;
  /** When the money was handed back. */
  at: string;
  method: string;
  /** Handed back, positive. */
  cents: number;
  /**
   * True when this refund by itself handed back the order's whole total;
   * false prints ', part' (v0.7.35 review: the row says what it did, so an
   * order refunded in two parts, or back through two methods, says part on
   * both rows). Whether the order ended refunded in full is ORDERS' flag.
   */
  full: boolean;
  reason: string | null;
}

/**
 * CASH DRAWER, copied from the close's own figures (never worked out again).
 * opening + cashSales − cashRefunds + cashIn − cashOut − riderKept +
 * otherCents = expected.
 */
export interface ShiftReportDrawer {
  /** The float counted when the shift was opened. */
  openingCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  /** Cash put in that is not a sale. */
  cashIn: ShiftReportCountCents;
  /**
   * Cash taken out that is not a refund or an outside rider's payout:
   * payouts typed by hand and rider tips (the close result's 'Cash taken
   * out', Shift history's 'Taken out').
   */
  cashOut: ShiftReportCountCents;
  /** The rider tips: a part of cashOut, printed under it and never taken off again. */
  riderTips: ShiftReportCountCents;
  /**
   * What the drawer paid outside riders: the payouts linked to an order —
   * a delivery charge he kept, or a trip (an order cancelled or refused at
   * the door after he went, or an add-on that went alone). tripCount says
   * how many of `count` were trips, as the close result says it
   * ('Paid to outside riders (5): 4 delivery charges kept, 1 trip').
   */
  riderKept: { count: number; cents: number; tripCount: number };
  /** A drawer change this version does not know (a newer till's movement type); 0 as a rule. */
  otherCents: number;
  expectedCents: number;
  countedCents: number;
  /** counted − expected (negative = short). */
  varianceCents: number;
  /** The count by note (migration 0050); null when it was not counted by note. */
  countedNotes: CashCount | null;
}

/** One order carried over unpaid at the close. */
export interface ShiftReportUnpaidOrder {
  orderNumber: string;
  /** When it was started. */
  at: string;
  /** Who took it ("Website" for a web order). */
  takenBy: string;
  cents: number;
}

/** UNPAID - CARRIED OVER: the close's own list and the manager's reason. */
export interface ShiftReportUnpaid {
  orders: ShiftReportUnpaidOrder[];
  reason: string | null;
}

/** One item sold: its name as sold, how many and for how much (line totals, before discounts and tax). */
export interface ShiftReportItem {
  name: string;
  quantity: number;
  cents: number;
}

/** ITEMS SOLD: one category, in the till's own category order, its items most sold first. */
export interface ShiftReportCategory {
  category: string;
  quantity: number;
  cents: number;
  items: ShiftReportItem[];
}

/** Whether an order of the list was refunded by the close. */
export type ShiftReportOrderRefunded = 'no' | 'part' | 'full';

/**
 * ORDERS (the owner's 'All orders'): one entry per settled order — the same
 * set as SALES, so there are sales.orderCount of them and their totals add up
 * to sales.billedCents — in the order they were paid.
 */
export interface ShiftReportOrder {
  orderNumber: string;
  /** When it was paid. */
  paidAt: string;
  channel: ReportChannel;
  /** Sent out with an outside rider. */
  outside: boolean;
  /** The order's payment methods as stored, in the paper's order (a split payment has two). */
  methods: string[];
  totalCents: number;
  refunded: ShiftReportOrderRefunded;
}

/** The shift report as saved at the close (see the file header). The keys are in the paper's order. */
export interface ShiftReport {
  v: typeof SHIFT_REPORT_VERSION;
  shiftId: string;
  /** The till that closed the shift. */
  deviceId: string;
  /** The till's name as the paper prints it ('Till: NAME'). */
  tillName: string;
  shopName: string;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  /** The cashier whose login the closing manager typed a PIN on; null when the closer was signed in. */
  pinOnLoginOf: string | null;
  sales: ShiftReportSales;
  /** MONEY TAKEN: the money in, per method, in the order cash, card, easypaisa, jazzcash, bank_transfer, foodpanda, then by name. */
  payments: ShiftReportMoneyLine[];
  /** The money handed back, per method in the same order (cents positive). */
  paymentRefunds: ShiftReportMoneyLine[];
  /** Σ every payment row of the shift, refunds taken off. */
  moneyTakenCents: number;
  /** moneyTaken − net sales: money for orders settled in another shift (a guard; 0 in every flow today). */
  partPaymentsCents: number;
  /** BY CHANNEL, in the order takeaway, delivery, web_pickup, web_delivery, foodpanda, dine_in, online; only those with orders. */
  channels: ShiftReportChannelLine[];
  cancelled: ShiftReportCancelled[];
  refunds: ShiftReportRefund[];
  drawer: ShiftReportDrawer;
  unpaid: ShiftReportUnpaid;
  items: ShiftReportCategory[];
  orders: ShiftReportOrder[];
}
