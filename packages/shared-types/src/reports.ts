/**
 * The Reports page: one period's figures, a tab at a time (costing spec
 * Phase 3: `reports:overview`, `reports:when`, … — see ReportTabData below).
 * Each tab is worked out off the till's main thread, in the Reports worker.
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

import type { WasteReason } from './inventory.js';

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
  /** Times this person opened the cash drawer with no sale (Open drawer, Test drawer). */
  noSaleOpens: number;
  /** Receipts / bills / slips this person printed again by hand (the print log). */
  reprints?: number;
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
  /** How many cash in / cash out / rider tip entries — each one opened the drawer. */
  cashMovementCount: number;
  /** Times the drawer was opened by hand with no sale (not the one count at close). */
  noSaleOpens: number;
}

/** One time the cash drawer was opened by hand, for the owner to check. */
export interface ReportDrawerOpenLine {
  id: string;
  createdAt: string;
  kind: 'no_sale' | 'count' | 'test';
  reason: string | null;
  openedBy: string;
  /** The manager whose PIN let a cashier open it; null when a manager or the owner did it. */
  approvedBy: string | null;
  /** No shift was open on that till at the time. */
  outsideShift: boolean;
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
  /**
   * What the refund did to the order's stock. Only on the refund line that
   * settled it (the latest one of a whole-order refund); null on every other.
   */
  stock: ReportOrderStock | null;
}

/** What a cancel or whole-order refund did to the order's stock ("Was the food made?"). */
export interface ReportOrderStock {
  /**
   * What happened to the stock. 'returned': it went back on the shelf;
   * 'wasted': booked as waste (sealed drinks may have gone back). A "Made"
   * answer where only sealed drinks moved is 'returned' with answer 'made'.
   */
  outcome: 'returned' | 'wasted';
  /** The answer to "Was the food made?" (from the till's record, or the stock rows' notes). */
  answer: 'made' | 'not_made' | null;
  /**
   * Waste, at what the stock cost when the order took it (orders from before
   * costing: at today's prices). 0 when put back, no prices are set, or this
   * login may not see costs.
   */
  wasteCents: number;
  /** The order's status when it was cancelled / refunded, when recorded. */
  statusBefore: string | null;
  /**
   * Worth a look: answered "Not made" (put back) although cooking had been
   * marked (preparing or ready), or the answer went against the hint the till
   * showed.
   */
  flagged: boolean;
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
  /** What the cancel did to the order's stock; null when it held none (or before this was asked). */
  stock: ReportOrderStock | null;
  /** A bill (NOT PAID) had been printed for it before it was cancelled — worth the owner's look. */
  billPrinted?: boolean;
}

/** One ingredient thrown away in the period: how much, and what it cost when it was taken. */
export interface ReportWasteIngredientLine {
  ingredientId: string;
  name: string;
  unit: string;
  wastedQty: number;
  wastedCents: number;
}

/**
 * Why food was thrown away, as Reports groups it: the reasons picked on the
 * Waste screen, plus food made for orders that were then cancelled or
 * refunded ('cancelled_made').
 */
export type ReportWasteReason = WasteReason | 'cancelled_made';

export interface ReportWasteLine {
  reason: ReportWasteReason;
  /**
   * How many times, as the owner counts them: for food cancelled after
   * cooking, the orders it came from (not their ingredient rows); for waste
   * booked by hand, the entries (one ingredient each).
   */
  times: number;
  cents: number;
}

/** Why a sale's cost is not known. */
export type ReportMissingCostWhy =
  /** The item has no recipe (nothing was taken from stock for it). */
  | 'no_recipe'
  /** An ingredient it used has no price in Inventory. */
  | 'no_price'
  /** No cost was kept with the sale and none could be worked out (costing failed, or no stock was taken). */
  | 'not_recorded';

/** Food sold whose cost is not (fully) known, per item and reason. */
export interface ReportMissingCostLine {
  /** Menu item id (or 'name:' + the sold name when the item is gone from the menu). */
  key: string;
  name: string;
  why: ReportMissingCostWhy;
  quantity: number;
  /** What customers paid for it, before tax (after discounts and part refunds). */
  salesCents: number;
}

/** Orders whose food went out but that are not sales (yet). */
export interface ReportUnpaidFood {
  orderCount: number;
  /** What their food cost (kept with the sale, or estimated). */
  costCents: number;
  /** Of `orderCount`, estimated (no cost kept with the order). */
  estimatedOrders: number;
}

/**
 * Food cost (costing spec 4.5, Phase 2), for the orders saved on THIS till.
 *
 * From the day costing started every sale keeps what its food cost that day
 * (order_item_costs), so a price change later never moves an earlier period.
 * Orders from before that, or with no cost kept, are ESTIMATED from what they
 * took from stock at today's prices, and labelled.
 *
 * Money in paisa; percentages in basis points. Sales here are before tax, at
 * what customers paid (after discounts and part refunds). Delivery charges
 * and other non-food lines are left out of food sales.
 */
export interface ReportFoodCost {
  /** Food sales of the counted orders, before tax, after discounts and part refunds. */
  foodSalesCents: number;
  /** Delivery charges and other non-food lines, left out of food sales. */
  feeSalesCents: number;
  /** Food cost of sales: the cost kept with each sale, plus estimates for orders with none. */
  costOfSalesCents: number;
  /** The food sales whose cost is fully known — what the food cost % is worked on. */
  knownSalesCents: number;
  /** What those sales cost. */
  knownCostCents: number;
  /** knownCost ÷ knownSales; null when no sale's cost is known. */
  foodCostBps: number | null;
  /**
   * The same known sales at menu price (before discounts and part refunds),
   * and the food cost on that basis — as the Costing page works it — so the
   * two figures reconcile: "at menu prices 27.1% → after discounts 28.9%".
   */
  knownMenuSalesCents: number;
  menuFoodCostBps: number | null;
  /** knownSales ÷ foodSales ("costs known for 94% of sales"); null with no food sales. */
  coverageBps: number | null;
  /** Counted orders with no cost kept with the sale: estimated from the stock they took, at today's prices. */
  estimatedOrders: number;
  /** Of costOfSalesCents, the estimated part. */
  estimatedCostCents: number;
  /** When this till first kept a sale's cost; null before any. */
  costingStartedAt: string | null;
  /** Food sold whose cost is not known, biggest first (capped; the total covers all). */
  missingSales: ReportMissingCostLine[];
  missingSalesCents: number;
  /**
   * Food thrown away: waste booked by hand (dated by when it happened) and
   * food made for orders then cancelled or refunded (dated by the ORDER's
   * day, so a late cancel moves nothing between days). At what the stock
   * cost when it was taken; rows from before costing at today's prices.
   */
  wasteCents: number;
  wasteByReason: ReportWasteLine[];
  wasteIngredients: ReportWasteIngredientLine[];
  /** The part of `wasteCents` made for orders that were then cancelled or refunded. */
  cancelledWasteCents: number;
  /** How many cancelled / refunded orders that waste came from. */
  cancelledOrderCount: number;
  /** Cancelled orders whose stock was put back although cooking had been marked — worth a look. */
  putBackAfterCookingCount: number;
  /** Food that went out on orders closed without payment (served / delivered, never paid). */
  sentNotPaid: ReportUnpaidFood;
  /** Orders from an earlier day still on the board, not paid: their food is out, not yet a sale. */
  stillOpen: ReportUnpaidFood;
  /** Some cost or waste figure is above Rs 0 (prices are set). */
  hasCosts: boolean;
  /** Stock was taken for sales, or wasted, in the period (recipes are set up). */
  hasUsage: boolean;
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

/**
 * The whole page for one period in one read: every tab's figures together.
 * The till no longer sends it to the screen (each tab is its own channel);
 * the main process builds it from the tab builders for the tests and the
 * bench, which check that every breakdown adds up.
 */
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
  /** Every time the cash drawer was opened by hand (no sale), newest first, capped. */
  drawerOpens: ReportDrawerOpenLine[];
  /** How many times it was opened by hand in all — drawerOpens stops at the cap. */
  drawerOpenCount: number;
  /**
   * Food cost, waste and food sent unpaid. Costs are the owner's business
   * figures: null for a login without COST_CAPABILITY (the main process
   * leaves them out, not only the screen).
   */
  foodCost: ReportFoodCost | null;
  deliveries: ReportDeliveries;
}

export interface BusinessReportRequest {
  sinceIso: string;
  untilIso: string;
  /** Optional comparison period (e.g. "same time yesterday"). */
  compareSinceIso?: string;
  compareUntilIso?: string;
}

// ---------------------------------------------------------------------------
// The tabs (costing spec Phase 3)
// ---------------------------------------------------------------------------

/**
 * The Reports page's tabs, in the order they show. Each is one IPC channel
 * (`reports:<tab>`), checked in the main process, and loads only its own
 * figures. Food cost & stock is for a login that may see costs
 * (COST_CAPABILITY) as well as reports.
 */
export const REPORT_TABS = ['overview', 'when', 'menu', 'channels', 'foodStock', 'team'] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

/** The owner's names for the tabs (screen, paper and file). */
export const REPORT_TAB_LABEL: Record<ReportTab, string> = {
  overview: 'Overview',
  when: 'When',
  menu: 'Menu',
  channels: 'Channels & delivery',
  foodStock: 'Food cost & stock',
  team: 'Team & leakage',
};

/** A tab asks for the same period (and comparison) as the whole page did. */
export type ReportTabRequest = BusinessReportRequest;

/**
 * Where a tab's figures were worked out: 'worker' — the Reports worker
 * thread, so the till never waits; 'main' — the till's main process, the
 * fallback when that worker could not start (periods of 31 days or less
 * only; the page says so).
 */
export type ReportEngine = 'worker' | 'main';

interface ReportTabBase {
  sinceIso: string;
  untilIso: string;
  engine: ReportEngine;
}

/** Overview: the headline figures, how customers paid, how the sales add up, website vs till. */
export interface ReportOverviewTab extends ReportTabBase {
  kpis: ReportKpis;
  /** The comparison period's figures, when one was asked for. */
  previous: ReportKpis | null;
  /** Sales by order type — for "website vs till" (the full table is on Channels & delivery). */
  channels: ReportChannelLine[];
}

/** When: sales by day (or month) and by Pakistan clock hour. */
export interface ReportWhenTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'orderCount' | 'netSalesCents'>;
  byDay: BusinessReport['byDay'];
  byHour: BusinessReport['byHour'];
}

/** Menu: what sells, by item and by category. */
export interface ReportMenuTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'menuSalesCents' | 'itemCount'>;
  items: ReportItemLine[];
  categories: ReportCategoryLine[];
}

/** Channels & delivery: order types, riders and delivery areas. */
export interface ReportChannelsTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'orderCount' | 'netSalesCents' | 'avgOrderCents'>;
  channels: ReportChannelLine[];
  deliveries: ReportDeliveries;
}

/** Food cost & stock (COST_CAPABILITY): food cost, waste, missing costs, food sent out unpaid. */
export interface ReportFoodStockTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'partialRefundCents'>;
  foodCost: ReportFoodCost;
}

/** Team & leakage: staff, shifts and cash, discounts, refunds, cancelled orders, drawer opens. */
export interface ReportTeamTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'netSalesCents' | 'menuSalesCents' | 'partialRefundCents' | 'fullRefundCents' | 'voidCount' | 'voidCents'>;
  staff: ReportStaffLine[];
  shifts: ReportShiftLine[];
  discounts: ReportDiscounts;
  /** Newest first, capped. */
  refunds: ReportRefundLine[];
  /** Newest first, capped. */
  voids: ReportVoidLine[];
  drawerOpens: ReportDrawerOpenLine[];
  drawerOpenCount: number;
  /**
   * Whether the Stock column may show what wasted food cost ("Wasted · Rs
   * 180"): null for a login without COST_CAPABILITY (those rupees are 0).
   */
  foodCost: Pick<ReportFoodCost, 'hasCosts'> | null;
}

export interface ReportTabData {
  overview: ReportOverviewTab;
  when: ReportWhenTab;
  menu: ReportMenuTab;
  channels: ReportChannelsTab;
  foodStock: ReportFoodStockTab;
  team: ReportTeamTab;
}

/** A tab's figures as the builders make them, before the main process says where they were worked out. */
export type ReportTabFigures<K extends ReportTab> = Omit<ReportTabData[K], 'engine'>;
