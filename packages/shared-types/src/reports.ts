/**
 * The Reports page: one period's figures in one round trip (`reports:business`).
 *
 * Every money figure is integer cents taken from STORED order totals
 * (subtotal / discount / tax / total) and the payments ledger — nothing is
 * re-priced at read time. Orders belong to the trading day they were started
 * in (05:00 → 05:00 Pakistan time).
 *
 * "Counted" orders are the sales: paid, not cancelled (void) and not refunded
 * in full. A fully refunded order is left out of every sales figure and shows
 * up only under refunds; a partly refunded one stays in, less what was handed
 * back.
 */

/** Where an order came from, in the owner's words. */
export type ReportChannel =
  | 'takeaway'
  | 'delivery'
  | 'foodpanda'
  | 'web_delivery'
  | 'web_pickup'
  | 'dine_in'
  | 'online';

/** How customers paid, grouped the way the owner counts money. */
export type ReportPaymentGroup = 'cash' | 'card' | 'foodpanda' | 'transfer';

export interface ReportKpis {
  /** Counted orders (see the file header). */
  orderCount: number;
  itemCount: number;
  /** Σ subtotal — items at menu price, before any discount. */
  menuSalesCents: number;
  discountCents: number;
  discountedOrderCount: number;
  taxCents: number;
  /** Σ stored total of the counted orders, as billed (menu − discount + tax). */
  billedCents: number;
  /** Money handed back on orders that still count (partial refunds). */
  partialRefundCents: number;
  partialRefundOrderCount: number;
  /** billed − partial refunds. The headline "sales" number. */
  netSalesCents: number;
  /** netSales ÷ orders, rounded to the paisa. */
  avgOrderCents: number;
  /** Orders refunded in full — money handed back, and left out of the sales. */
  fullRefundCount: number;
  fullRefundCents: number;
  /** Orders cancelled before anyone paid (void). Never money in or out. */
  voidCount: number;
  voidCents: number;
  /** Started in the period, not paid yet (e.g. a delivery still on the road). */
  unpaidCount: number;
  unpaidCents: number;
  /** Net money by how it was paid (refunds taken off the method they went back on). */
  payments: Record<ReportPaymentGroup, number>;
  /**
   * netSales − Σ payments. Zero unless an order was stamped paid without
   * matching payment rows (very old data); shown so the split always adds up.
   */
  unrecordedPaymentCents: number;
}

export interface ReportItemLine {
  /** Menu item id (or the sold name when the item is gone from the menu). */
  key: string;
  name: string;
  categoryId: string | null;
  categoryName: string;
  quantity: number;
  /** Σ line totals at menu price, before the order's discount. */
  salesCents: number;
}

export interface ReportCategoryLine {
  categoryId: string | null;
  name: string;
  quantity: number;
  salesCents: number;
}

export interface ReportChannelLine {
  channel: ReportChannel;
  orderCount: number;
  netSalesCents: number;
}

export interface ReportStaffLine {
  /** User id, or 'web' for orders that came in from the website. */
  key: string;
  name: string;
  isWebsite: boolean;
  orderCount: number;
  netSalesCents: number;
  discountCents: number;
  /** Orders this person started that were cancelled before payment. */
  voidCount: number;
}

export interface ReportShiftLine {
  id: string;
  openedAt: string;
  closedAt: string | null;
  openedBy: string;
  closedBy: string | null;
  openingCashCents: number;
  /** Stored at close — null while the shift is still open. */
  expectedCashCents: number | null;
  countedCashCents: number | null;
  /** counted − expected, stored at close. Negative = short. */
  varianceCents: number | null;
  cashInCents: number;
  cashOutCents: number;
}

export interface ReportDiscountLine {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  amountCents: number;
  /** "10%" / "Rs 200" — how it was entered. Null when no discount row is on file. */
  entered: string | null;
  reason: string;
  givenBy: string;
  approvedBy: string | null;
}

export interface ReportDiscounts {
  /** Σ equals kpis.discountCents: one line per discounted counted order. */
  totalCount: number;
  totalCents: number;
  byReason: Array<{ reason: string; count: number; amountCents: number }>;
  byPerson: Array<{ name: string; count: number; amountCents: number; approvedCount: number }>;
  /** Most recent first, capped. */
  recent: ReportDiscountLine[];
}

export interface ReportRefundLine {
  orderId: string;
  orderNumber: string;
  orderCreatedAt: string;
  refundedAt: string;
  amountCents: number;
  method: string;
  /** True when the whole order was refunded (it no longer counts as a sale). */
  full: boolean;
  reason: string;
  approvedBy: string;
}

export interface ReportVoidLine {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  voidedAt: string | null;
  amountCents: number;
  reason: string;
  approvedBy: string;
  takenBy: string;
}

export interface ReportIngredientLine {
  ingredientId: string;
  name: string;
  unit: string;
  usedQty: number;
  wastedQty: number;
  usedCents: number;
  wastedCents: number;
}

export interface ReportFoodCost {
  /** Ingredients that went out with sales, valued at today's stored prices. */
  usedCents: number;
  wasteCents: number;
  /** False when no ingredient used has a price on file (nothing to show). */
  hasCosts: boolean;
  /** Stock movements exist at all in the period (recipes are set up). */
  hasUsage: boolean;
  ingredients: ReportIngredientLine[];
}

export interface ReportDeliveries {
  byRider: Array<{
    riderId: string | null;
    name: string;
    deliveries: number;
    netSalesCents: number;
    /** Average minutes from "out for delivery" to "delivered", when both were marked. */
    avgMinutesOut: number | null;
  }>;
  byArea: Array<{ area: string; orderCount: number; netSalesCents: number }>;
}

export interface BusinessReport {
  sinceIso: string;
  untilIso: string;
  kpis: ReportKpis;
  /** The comparison period's figures, when one was asked for. */
  previous: ReportKpis | null;
  /** Trading day (YYYY-MM-DD) → counted orders and net sales. Days with none are absent. */
  byDay: Array<{ day: string; orderCount: number; netSalesCents: number }>;
  /** Pakistan clock hour 0–23 → counted orders and net sales. Hours with none are absent. */
  byHour: Array<{ hour: number; orderCount: number; netSalesCents: number }>;
  /** Every item sold, best seller (by sales) first. Σ salesCents = kpis.menuSalesCents. */
  items: ReportItemLine[];
  categories: ReportCategoryLine[];
  channels: ReportChannelLine[];
  staff: ReportStaffLine[];
  shifts: ReportShiftLine[];
  discounts: ReportDiscounts;
  /** Newest first, capped. Σ amountCents = partial + full refunds when not capped. */
  refunds: ReportRefundLine[];
  /** Newest first, capped. */
  voids: ReportVoidLine[];
  foodCost: ReportFoodCost;
  deliveries: ReportDeliveries;
}

export interface BusinessReportRequest {
  sinceIso: string;
  untilIso: string;
  /** Optional comparison period (e.g. "same time yesterday"). */
  compareSinceIso?: string;
  compareUntilIso?: string;
}
