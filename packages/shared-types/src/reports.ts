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
import type { VarianceBand } from './stock-count.js';

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
  /**
   * The note typed when the shift was opened ("Morning shift, Ali on
   * register"), or null. A shift closed before migration 0039 keeps its one
   * note here.
   */
  openingNote: string | null;
  /** The note typed when the shift was closed ("Rs 100 short, change given wrong"), or null. */
  closingNote: string | null;
  /**
   * Unpaid orders carried over to the next shift when this one closed, with
   * the manager's reason (0 / null when none). Approved by `closedBy`.
   */
  carriedUnpaidCount: number;
  carryOverReason: string | null;
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

/**
 * Who a purchase was bought from, as Reports groups spend:
 *  - 'supplier':    a supplier on file (a purchase order or a purchase);
 *  - 'no_supplier': a purchase with no supplier named (a market run);
 *  - 'by_hand':     stock booked in by hand with no bill (valued at the price then).
 */
export type ReportPurchaseFrom = 'supplier' | 'no_supplier' | 'by_hand';

export interface ReportPurchaseSupplierLine {
  /** The supplier's id, or 'no_supplier' / 'by_hand'. */
  key: string;
  from: ReportPurchaseFrom;
  name: string;
  /** Bills (distinct purchase orders and purchases) in the period; 0 for stock booked in by hand, which has none. */
  bills: number;
  spendCents: number;
}

export interface ReportPurchaseIngredientLine {
  ingredientId: string;
  name: string;
  unit: string;
  /** Bought in the period, in the ingredient's unit now. */
  qty: number;
  /** How many times it was bought (delivery rows). */
  times: number;
  spendCents: number;
  /**
   * What one base unit cost on its latest PAID purchase in the period
   * (millicents; per gram it reads as paisa per kg). Null when it was only
   * booked in by hand or at a bill of Rs 0 (neither is a price paid).
   */
  lastUnitCostMc: number | null;
  /** …and on the paid purchase before that one (which may be before the period); null when there was none. */
  prevUnitCostMc: number | null;
}

/**
 * What was spent on stock (costing spec 4.5 Pur(P), Phase 5), from the stock
 * rows of deliveries and purchases on THIS till, at their bills. Dated by
 * when the stock came in. Σ bySupplier = Σ byIngredient = spendCents.
 */
export interface ReportPurchases {
  spendCents: number;
  /** Bills in the period: distinct purchases, never stock booked in by hand (see ReportPurchaseSupplierLine.bills). */
  bills: number;
  bySupplier: ReportPurchaseSupplierLine[];
  byIngredient: ReportPurchaseIngredientLine[];
  /** Of spendCents, stock booked in by hand with no bill, valued at the price then. */
  byHandCents: number;
  /** How many times stock was booked in by hand (no bill) in the period. */
  byHandEntries: number;
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
  /** Shift history: every shift open at some time in the period (still open, or closed at or after its start), newest first, capped. */
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

/**
 * When: sales by day (or month) and by Pakistan clock hour; from Phase 7 the
 * weekday × hour heatmap, the parts of the day and the period's day notes.
 */
export interface ReportWhenTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'orderCount' | 'netSalesCents'>;
  byDay: BusinessReport['byDay'];
  byHour: BusinessReport['byHour'];
  /** An average day by weekday and hour, closed days left out (costing spec Phase 7). */
  heatmap: ReportHeatmap;
  /** Lunch, afternoon, dinner, late (the owner's parts of the day). */
  dayparts: ReportDayparts;
  /** Notes on the period's days (Eid, rain, closed…), oldest first. */
  dayNotes: ReportDayNote[];
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

/** Food cost & stock (COST_CAPABILITY): food cost, waste, missing costs, food sent out unpaid, purchases. */
export interface ReportFoodStockTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'partialRefundCents'>;
  foodCost: ReportFoodCost;
  /** What was spent on stock, by supplier and by ingredient (costing spec Phase 5). */
  purchases: ReportPurchases;
}

/** Team & leakage: staff, shifts and cash, discounts, refunds, cancelled orders, drawer opens. */
export interface ReportTeamTab extends ReportTabBase {
  kpis: Pick<ReportKpis, 'netSalesCents' | 'menuSalesCents' | 'partialRefundCents' | 'fullRefundCents' | 'voidCount' | 'voidCents'>;
  staff: ReportStaffLine[];
  /** Shift history: every shift open at some time in the period (still open, or closed at or after its start), newest first, capped. */
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

// ---------------------------------------------------------------------------
// The owner's week (costing spec Phase 7): trends, the heatmap, parts of the
// day, day notes, the Dashboard "This week" card and its "Do this" list.
// ---------------------------------------------------------------------------

/**
 * A part of the day (costing spec 4.10), in Pakistan clock hours: from the
 * start of `fromHour` to the end of `toHour` (Lunch 12–15 is 12:00–15:59).
 * A part whose `toHour` is before its `fromHour` runs across midnight (Late
 * 23–4 is 23:00–04:59, the same trading night).
 */
export interface Daypart {
  name: string;
  fromHour: number;
  toHour: number;
}

/** The till's parts of the day until the owner sets his own (business setting 'analytics.dayparts'). */
export const DEFAULT_DAYPARTS: readonly Daypart[] = [
  { name: 'Lunch', fromHour: 12, toHour: 15 },
  { name: 'Afternoon', fromHour: 16, toHour: 18 },
  { name: 'Dinner', fromHour: 19, toHour: 22 },
  { name: 'Late', fromHour: 23, toHour: 4 },
];

/** The clock hours a part of the day covers, in order (across midnight when toHour < fromHour). */
export function daypartHours(d: Pick<Daypart, 'fromHour' | 'toHour'>): number[] {
  const out: number[] = [];
  for (let h = d.fromHour; ; h = (h + 1) % 24) {
    out.push(h);
    if (h === d.toHour || out.length === 24) break;
  }
  return out;
}

/** The parts of the day as Reports uses them (Costing → Targets shows them; the owner edits them). */
export interface DaypartsView {
  dayparts: Daypart[];
  /** The till's own parts: the owner has not set any. */
  isDefault: boolean;
  savedAt: string | null;
}

/** What Costing → Targets saves (reports:setDayparts; the owner only). */
export interface SetDaypartsRequest {
  dayparts: Daypart[];
}

/**
 * What a day note says about a trading day (migration 0037). 'closed' days
 * are left out of the heatmap's averages (and, later, the forecast).
 * Checked in the schemas, not by a CHECK, so a newer till's tags still sync.
 */
export const DAY_NOTE_TAGS = ['closed', 'eid', 'ramadan', 'rain', 'load_shedding', 'cricket', 'event', 'other'] as const;
export type DayNoteTag = (typeof DAY_NOTE_TAGS)[number];

export function isDayNoteTag(x: unknown): x is DayNoteTag {
  return typeof x === 'string' && (DAY_NOTE_TAGS as readonly string[]).includes(x);
}

/** The owner's words for each tag (screen, paper and file). */
export const DAY_NOTE_TAG_LABEL: Record<DayNoteTag, string> = {
  closed: 'Closed',
  eid: 'Eid',
  ramadan: 'Ramadan',
  rain: 'Rain',
  load_shedding: 'Load-shedding',
  cricket: 'Cricket match',
  event: 'Event nearby',
  other: 'Other',
};

/** Days the till leaves out of forecasts unless told otherwise: nothing about them repeats week to week. */
export function excludedFromForecastByDefault(tag: DayNoteTag): boolean {
  return tag === 'closed' || tag === 'eid';
}

/** A note for a day, as added on Reports → When (report.view). */
export interface DayNoteInput {
  /** The trading day, YYYY-MM-DD. */
  day: string;
  tag: DayNoteTag;
  note?: string | null;
  /** Leave the day out of forecasts (costing spec Phase 12); the till suggests it for closed days and Eid. */
  excludeFromForecast?: boolean;
}

export interface ReportDayNote {
  id: string;
  day: string;
  /** A tag this till does not know (a newer till's) reads as 'other'. */
  tag: DayNoteTag;
  note: string | null;
  excludeFromForecast: boolean;
  /** Who added it (their name); null when not known. */
  addedBy: string | null;
  createdAt: string;
}

/**
 * How a figure moved against the stretch it is compared with (costing spec
 * 4.10): 'pct' = (now − then) ÷ then in basis points (0 = the same); 'new'
 * when then was 0; 'noData' when this till has no figures for then (the
 * stretch starts before its first order).
 */
export type TrendChange = { kind: 'pct'; bps: number } | { kind: 'new' } | { kind: 'noData' };

/** Sales, orders and the average order of a stretch of time, from the counted orders' stored totals. */
export interface TrendFigures {
  /** Net sales (billed − part refunds), tax included: the same "Sales" as the Overview. */
  netSalesCents: number;
  orderCount: number;
  avgOrderCents: number;
}

export type ReportTrendPeriod = 'today' | 'week' | 'month' | 'year';

export interface TrendSpan {
  sinceIso: string;
  untilIso: string;
}

export interface TrendComparison extends TrendSpan {
  /** Null: this till has no figures for then ("no data then"). */
  figures: TrendFigures | null;
  change: { sales: TrendChange; orders: TrendChange; avgOrder: TrendChange };
}

/** One line of the trend strip: today / this week / this month / this year so far, against the stretches it is compared with. */
export interface ReportTrendLine {
  period: ReportTrendPeriod;
  current: TrendSpan & { figures: TrendFigures };
  /** Same weekday last week / last week / last month / last year, as far into it as we are now. */
  previous: TrendComparison;
  /** The same day / week / month a year ago; null for the year (its comparison already is last year). */
  lastYear: TrendComparison | null;
}

export interface ReportDayPoint {
  /** Trading day, YYYY-MM-DD. */
  day: string;
  orderCount: number;
  netSalesCents: number;
}

export interface ReportMonthPoint extends TrendFigures {
  /** YYYY-MM. */
  month: string;
  sinceIso: string;
  untilIso: string;
  /** This till had orders for the whole month (false before its first order: "no data then"). */
  hadData: boolean;
}

/** A month's food cost (COST_CAPABILITY only), as Reports → Food cost & stock works it out. */
export interface ReportMonthCost {
  month: string;
  foodCostBps: number | null;
  coverageBps: number | null;
}

/**
 * Reports → Overview's trend strip and 12-month chart (costing spec 4.10),
 * for the orders on THIS till. Not tied to the period picker: always today,
 * this week, month and year so far.
 */
export interface ReportTrends {
  nowIso: string;
  engine: ReportEngine;
  /** When this till's first order was started; null with none yet. */
  firstOrderAt: string | null;
  lines: ReportTrendLine[];
  /** The last 56 trading days (8 weeks), oldest first, every day (0 when nothing sold). */
  recentDays: ReportDayPoint[];
  /** The last 12 calendar months, oldest first (this month so far last). */
  months: ReportMonthPoint[];
  /** Each month's food cost; null for a login without COST_CAPABILITY. */
  monthCosts: ReportMonthCost[] | null;
  /**
   * Worked out on the till itself (the Reports worker is not running): only
   * stretches of 31 days or less, so the year line, the 8 weeks and the 12
   * months are left out.
   */
  partial: boolean;
}

export interface ReportHeatCell {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Pakistan clock hour. */
  hour: number;
  orderCount: number;
  netSalesCents: number;
  /** An average day: net sales ÷ the days counted for that weekday, to the paisa. */
  avgNetSalesCents: number;
  /** An average day's orders, in tenths (2.5 orders = 25). */
  avgOrdersTenths: number;
}

/**
 * Weekday × hour (costing spec 4.10): an average day's sales in each hour of
 * each weekday over the period, leaving out days marked closed and days
 * before this till's first order or still to come.
 */
export interface ReportHeatmap {
  /** How many trading days of each weekday (0 = Monday) the averages are over. */
  dayCounts: number[];
  /** Days in the period marked closed, left out. */
  closedDays: number;
  /** The hours shown, in trading-day order (5 am … 4 am), first to last hour with a sale. */
  hours: number[];
  /** Every weekday × every hour shown, Monday first. */
  cells: ReportHeatCell[];
}

export interface ReportDaypartLine {
  name: string;
  /** −1 for "Other hours" (every hour outside the parts). */
  fromHour: number;
  toHour: number;
  orderCount: number;
  netSalesCents: number;
  avgOrderCents: number;
  /** Share of the period's sales, basis points; null with no sales. */
  shareBps: number | null;
}

export interface ReportDayparts {
  lines: ReportDaypartLine[];
  /** Hours outside every part, when something sold then. */
  other: ReportDaypartLine | null;
  isDefault: boolean;
}

/** Which week the owner's week is: this one so far, or last week in full. */
export type OwnerWeekWhich = 'this' | 'last';

export interface OwnerWeekRequest {
  week?: OwnerWeekWhich;
  /**
   * For the printed weekly sheet: its dishes, waste by reason and last
   * week's food cost and waste too. The Dashboard card leaves it off (it
   * shows none of them, and must come back fast).
   */
  sheet?: boolean;
}

interface DoThisBase {
  /** Stable within the list (React key). */
  key: string;
  /** What it costs (or would bring) per week, paisa; null when it has no rupee figure (low stock). */
  weekCents: number | null;
  /** Pinned first, whatever the rupees (a key ingredient running out). */
  pinned: boolean;
  /** It carries costs: only for a login with COST_CAPABILITY (the main process drops the rest). */
  cost: boolean;
}

/**
 * One line of the Dashboard's ranked "Do this" list (costing spec 4.17),
 * each with its rupees per week and where to fix it. Later phases add their
 * own kinds (stock variance in Phase 8, leakage flags in Phase 10).
 */
export type DoThisItem =
  /** A key ingredient at or under its low-stock level: pinned first. */
  | (DoThisBase & { kind: 'low_stock'; ingredientId: string; name: string; unit: string; currentQty: number; lowThreshold: number })
  /** A dish over its food-cost target (red): n̄ per week × (cost − target × price). */
  | (DoThisBase & {
      kind: 'red_item';
      menuItemId: string;
      name: string;
      foodCostBps: number;
      targetBps: number;
      soldLast28: number;
    })
  /** Costs still missing: sales of the dishes it touches per week × their category's target (a proxy). */
  | (DoThisBase & { kind: 'missing_costs'; things: number; dishes: number })
  /** A price alert not seen yet (Costing → Alerts): its rupees per week. */
  | (DoThisBase & {
      kind: 'price_alert';
      alertId: string;
      alertKind: 'price_jump' | 'weekly_digest';
      /** The ingredient that moved; null for the Monday digest. */
      ingredientName: string | null;
      changeBps: number | null;
      dishes: number;
    })
  /**
   * The last two stock takes: more stock went than sales, batches and logged
   * waste explain — over 3% of food sales (costing spec 4.17, Phase 8). Its
   * rupees per week are what went unexplained, spread over the weeks
   * between the two stock takes.
   */
  | (DoThisBase & {
      kind: 'stock_variance';
      fromCountId: string;
      toCountId: string;
      /** Σ unexplained ÷ food sales over the window. */
      varianceBps: number;
      /** What went unexplained in the whole window. */
      totalCents: number;
      /** The ingredient that explains least (the most rupees), when there is one. */
      topIngredient: string | null;
      /** When the later stock take was finished. */
      countedAt: string;
    });

export type DoThisKind = DoThisItem['kind'];

/** Food cost and waste for the week (COST_CAPABILITY only). */
export interface OwnerWeekCosts {
  /** Food cost of the sales with a known cost; null when none is known. */
  foodCostBps: number | null;
  /** "Costs known for 94% of sales"; null with no food sales. */
  coverageBps: number | null;
  wasteCents: number;
  /** Some cost or waste figure is above Rs 0 (prices are set). */
  hasCosts: boolean;
}

/** A dish on the printed sheet: what it earns per sale ranks it; the sheet prints no rupee profit (Phase 9's, profit.view). */
export interface OwnerWeekItem {
  menuItemId: string;
  name: string;
  soldThisWeek: number;
  foodCostBps: number | null;
}

/** The printed weekly sheet's cost lines (COST_CAPABILITY only). */
export interface OwnerWeekSheet {
  /** Sold this week and fully costed: the three that earn the most per sale, most first … */
  earnsMost: OwnerWeekItem[];
  /** … and the three that earn the least, least first (never the same dish twice). */
  earnsLeast: OwnerWeekItem[];
  wasteByReason: ReportWasteLine[];
  /**
   * Food cost and waste over the stretch the sales are compared with (last
   * week by now, or the week before in full), so the sheet's five numbers are
   * all "vs last week"; null when this till has no figures for then.
   */
  previousCosts: OwnerWeekCosts | null;
  /**
   * The last stock-take variance (costing spec §5, Phase 8): between the
   * latest two stock takes, what went that sales, batches and logged waste
   * don't explain. Null with fewer than two stock takes, or when two tills
   * take orders with the link off (switched off).
   */
  lastStockTake: OwnerWeekStockTake | null;
}

/** "Used vs should have used" between the latest two stock takes, as the weekly sheet prints it. */
export interface OwnerWeekStockTake {
  /** When the earlier and the later stock take were finished. */
  sinceIso: string;
  untilIso: string;
  /** Ingredients counted on both. 0: nothing was compared — no figure, no rating ("Nothing was counted on both stock takes"). */
  compared: number;
  /** What went unexplained, in rupees at the prices then (below 0: more on the shelves than expected). */
  totalCents: number;
  /** …as a share of food sales between the two; null with none. */
  varianceBps: number | null;
  band: VarianceBand | null;
  topIngredient: string | null;
}

/**
 * The owner's week (costing spec Phase 7): the Dashboard "This week" card
 * and the printed weekly sheet. At most five numbers — sales, orders and the
 * average order against last week (report.view), food cost and waste
 * (COST_CAPABILITY) — and ONE ranked "Do this" list. Never rupee profit.
 * For the orders on THIS till.
 */
export interface OwnerWeek {
  week: OwnerWeekWhich;
  sinceIso: string;
  untilIso: string;
  compareSinceIso: string;
  compareUntilIso: string;
  /** First and last trading day of the week, YYYY-MM-DD. */
  firstDay: string;
  lastDay: string;
  /** This week, still running. */
  isCurrent: boolean;
  engine: ReportEngine;
  current: TrendFigures;
  /** Last week (as far into it as we are now); null when this till has no figures for then. */
  previous: TrendFigures | null;
  change: { sales: TrendChange; orders: TrendChange; avgOrder: TrendChange };
  /** Null for a login without COST_CAPABILITY. */
  costs: OwnerWeekCosts | null;
  /** Ranked: pinned first, then the most rupees a week; at most five. */
  doThis: DoThisItem[];
  /** How many more lines there were beyond the five. */
  doThisMore: number;
  /** Checks that could not run this time (their kinds), so the list may be short. */
  doThisFailed: string[];
  /** The printed sheet's cost lines: only when asked for the sheet, and null for a login without COST_CAPABILITY. */
  sheet: OwnerWeekSheet | null;
}
