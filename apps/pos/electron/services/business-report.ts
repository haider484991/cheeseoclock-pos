import type {
  BusinessReport,
  BusinessReportRequest,
  PriceKind,
  ReportCategoryLine,
  ReportChannel,
  ReportChannelLine,
  ReportDeliveries,
  ReportDiscountLine,
  ReportDiscounts,
  ReportFoodpanda,
  ReportFoodpandaCheckLine,
  ReportDrawerOpenLine,
  ReportFoodCost,
  ReportItemLine,
  ReportKpis,
  ReportOrderStock,
  ReportPaymentGroup,
  ReportPurchases,
  ReportPurchaseIngredientLine,
  ReportPurchaseSupplierLine,
  ReportRefundLine,
  ReportStaffLine,
  ReportUnpaidFood,
  ReportVoidLine,
  ReportWasteIngredientLine,
  ReportWasteLine,
  ReportWasteReason,
  WasteReasonLabels,
  OrderItemCostStatus,
  ReportTabFigures,
} from '@cheeseoclock/shared-types';
import { isDeliveryChargeName } from '@cheeseoclock/shared-types';
import { FOODPANDA_TABLET_TOLERANCE_CENTS } from '@cheeseoclock/shared-types';
import {
  emptyFoodCostTally,
  type FoodCostTally,
  ingredientCostCents,
  mulDivRound,
  noteKindAnswer,
  orderKeptCost,
  orderStockNoteKind,
  packInUnit,
  resolveTargets,
  shareBps,
  tallyFoodCost,
  tallyPlainOrders,
  unitFactor,
  wasteReasonOf,
  ownerWasteLabels,
  dealAmount,
  discountBaseCents,
  foodpandaOrderMoney,
  parseFoodpandaDealRule,
  storedDiscountAlsoOffDeliveryCharge,
  storedDiscountSkips,
  type FoodCostEstimate,
  type TaxedDiscountLine,
  type KeptFoodpandaTerms,
  type FoodCostLine,
  type Pack,
  type PriceOf,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
// Read-only modules only, none of them loading Electron: this file also runs
// in the Reports worker thread (analytics/worker.ts). A test walks its imports.
import { loadPriceBook, priceOfBook, safeStockValue } from '../db/price-book.js';
import { loadPriceHistory, type DatedPrice } from '../db/price-history-read.js';
import { getBusinessSetting, readShopSetting, readStockRules } from '../db/business-settings-read.js';
import { withBillPrinted, withHandPrints } from './print-report.js';
import { whenExtras } from './analytics/heatmap.js';
import {
  COUNTED,
  DAY_MS,
  IN_RANGE,
  PKT_OFFSET_MS,
  REFUNDED,
  TRADING_DAY_OFFSET_MS,
  channelOf,
  pakistanHourOf,
  paymentGroup,
  tradingDayOf,
} from './analytics/sql.js';

/**
 * The Reports page's figures, a builder per tab (costing spec Phase 3; see
 * "The tabs" below), run in the Reports worker thread (analytics/worker.ts).
 *
 * Rules every figure here follows (CLAUDE.md):
 *  - Money comes from STORED order totals (subtotal / discount / tax / total)
 *    and the payments ledger. Nothing is re-priced at read time.
 *  - An order belongs to the trading day it was started in. The shop trades
 *    noon – 1 am, so a trading day runs 05:00 → 05:00 Pakistan time, which is
 *    exactly 00:00 → 00:00 UTC: the UTC date of `created_at` IS the trading day.
 *  - A "counted" order (a sale) is paid, not void, not refunded in full. A
 *    partial refund stays in, less what was handed back.
 *
 * Every breakdown (by day, hour, order type, staff, rider, payment) sums to
 * the same net sales figure, and items / categories sum to the menu-price
 * figure — business-report.test.ts runs this on the real migrations and checks.
 *
 * Speed: the counted orders are read ONCE per period (one indexed range scan
 * on idx_orders_created) and every per-order breakdown is added up in that
 * single pass; items and stock are aggregated before they are joined to the
 * menu / ingredient names. A year of orders stays well under a second.
 *
 * Food cost (costing spec 4.5) comes from the cost each sale kept
 * (order_item_costs), read with the counted orders' lines; only orders that
 * kept none read their own stock rows (idx_movements_order). Waste is read
 * by reason and time (idx_movements_reason_time) and, for cancelled or
 * refunded orders, by the order. Nothing walks the whole ledger.
 *
 * The shared pieces (what counts as a sale, the trading day, order types,
 * payment groups) live in analytics/sql.ts; they are re-exported here for
 * the callers that have always imported them from this file.
 */

export { COUNTED, channelOf, pakistanHourOf, paymentGroup, tradingDayOf };

/** Caps on the detail lists sent to the screen (the totals always cover everything). */
export const REPORT_LIST_CAP = 300;

export interface ReportRange {
  sinceIso: string;
  untilIso: string;
}

/** One counted order, as the single pass reads it. */
export interface SaleRow {
  createdAt: string;
  mode: string;
  source: string;
  cashierId: string;
  subtotal: number;
  discount: number;
  /**
   * Where the order's discount came from (its latest live discount row):
   * 'foodpanda' = the owner's standing deal, put on by the till; null = typed
   * by staff, or no discount. Only a staff discount counts against the person.
   */
  discountSource: string | null;
  tax: number;
  total: number;
  refunded: number;
  riderId: string | null;
  /** Dispatched → delivered, when both were marked. */
  minutesOut: number | null;
  /** From the delivery address snapshot (deliveries only). */
  area: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * The refund's reason. Partial refunds carry it in the payment's reference
 * ("partial-refund: cold pizza", "refund-rest: …"); a full refund's rows say
 * "refund-of:<payment id>" and the reason sits on the order.
 */
export function refundReason(referenceNo: string | null, orderReason: string | null): string {
  const ref = (referenceNo ?? '').trim();
  const m = /^(?:partial-refund|refund-rest):\s*([\s\S]*)$/.exec(ref);
  const fromRef = m?.[1]?.trim();
  if (fromRef) return fromRef;
  const fromOrder = (orderReason ?? '').trim();
  return fromOrder || 'No reason given';
}

/** Moved to pos-domain (the till's stock dialogs price with it too); kept here for callers. */
export { ingredientCostCents };

/** Categories rolled up from the item lines, so the two always agree. Biggest first. */
export function rollUpCategories(items: ReportItemLine[]): ReportCategoryLine[] {
  const byKey = new Map<string, ReportCategoryLine>();
  for (const it of items) {
    const key = it.categoryId ?? `name:${it.categoryName}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.quantity += it.quantity;
      cur.salesCents += it.salesCents;
    } else {
      byKey.set(key, {
        categoryId: it.categoryId,
        name: it.categoryName,
        quantity: it.quantity,
        salesCents: it.salesCents,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.salesCents - a.salesCents || b.quantity - a.quantity);
}

/** "10%" / "Rs 200" — how a discount was entered. */
function discountEntered(type: string | null, value: number | null): string | null {
  if (type === null || value === null) return null;
  if (type === 'percent') return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
  return `Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(value / 100)}`;
}

/** What a standing offer is called on Team & leakage, by its source. */
const STANDING_OFFER_NAME: Record<string, string> = { foodpanda: 'foodpanda deal (set by the owner)' };

/**
 * Discount lines rolled up by reason and by who gave them. The shop's
 * standing offers (the foodpanda deal, put on automatically) are listed
 * apart, as "Standing offers": they are not the cashier's, and counting them
 * under whoever rang the order — in "Who gave them" or in "Each discount" —
 * would read as staff leakage. `recent` is therefore the staff's discounts
 * only; each deal order is on Channels → "foodpanda orders to check".
 */
export function summarizeDiscounts(lines: ReportDiscountLine[], cap = REPORT_LIST_CAP): ReportDiscounts {
  const byReason = new Map<string, { reason: string; count: number; amountCents: number }>();
  const byPerson = new Map<string, { name: string; count: number; amountCents: number; approvedCount: number }>();
  const standing = new Map<string, { name: string; count: number; amountCents: number }>();
  const staffLines: ReportDiscountLine[] = [];
  let totalCents = 0;
  for (const l of lines) {
    totalCents += l.amountCents;
    const rKey = l.reason.trim().toLowerCase();
    const r = byReason.get(rKey) ?? { reason: l.reason, count: 0, amountCents: 0 };
    r.count += 1;
    r.amountCents += l.amountCents;
    byReason.set(rKey, r);
    if (l.source) {
      const o = standing.get(l.source) ?? { name: STANDING_OFFER_NAME[l.source] ?? l.source, count: 0, amountCents: 0 };
      o.count += 1;
      o.amountCents += l.amountCents;
      standing.set(l.source, o);
      continue;
    }
    staffLines.push(l);
    const p = byPerson.get(l.givenBy) ?? { name: l.givenBy, count: 0, amountCents: 0, approvedCount: 0 };
    p.count += 1;
    p.amountCents += l.amountCents;
    if (l.approvedBy) p.approvedCount += 1;
    byPerson.set(l.givenBy, p);
  }
  const biggest = <T extends { amountCents: number; count: number }>(a: T, b: T) =>
    b.amountCents - a.amountCents || b.count - a.count;
  return {
    totalCount: lines.length,
    totalCents,
    byReason: [...byReason.values()].sort(biggest),
    byPerson: [...byPerson.values()].sort(biggest),
    standing: [...standing.values()].sort(biggest),
    staffCount: staffLines.length,
    recent: staffLines.slice(0, cap),
  };
}

interface Tally {
  orderCount: number;
  netSalesCents: number;
}

function tally<K>(map: Map<K, Tally>, key: K, net: number): void {
  const t = map.get(key);
  if (t) {
    t.orderCount += 1;
    t.netSalesCents += net;
  } else map.set(key, { orderCount: 1, netSalesCents: net });
}

/** A staff line as the sales pass makes it, before the counts from other tables. */
type SalesStaffLine = Omit<ReportStaffLine, 'voidCount' | 'noSaleOpens'>;

/** Everything that is added up per counted order, in one pass. */
export function aggregateSales(
  rows: SaleRow[],
  names: { user: (id: string) => string | null; rider: (id: string) => string | null },
): {
  totals: Pick<
    ReportKpis,
    | 'orderCount'
    | 'menuSalesCents'
    | 'discountCents'
    | 'discountedOrderCount'
    | 'taxCents'
    | 'billedCents'
    | 'partialRefundCents'
    | 'partialRefundOrderCount'
  >;
  byDay: BusinessReport['byDay'];
  byHour: BusinessReport['byHour'];
  channels: ReportChannelLine[];
  staff: SalesStaffLine[];
  deliveries: ReportDeliveries;
} {
  const totals = {
    orderCount: 0,
    menuSalesCents: 0,
    discountCents: 0,
    discountedOrderCount: 0,
    taxCents: 0,
    billedCents: 0,
    partialRefundCents: 0,
    partialRefundOrderCount: 0,
  };
  // Keyed by day NUMBER (days since 1970 of the trading day) and turned into
  // YYYY-MM-DD once per day at the end: one Date.parse per order, not three.
  const days = new Map<number, Tally>();
  const hours = new Map<number, Tally>();
  const channels = new Map<ReportChannel, Tally>();
  const staff = new Map<string, Tally & { discountCents: number }>();
  const riders = new Map<string | null, Tally & { minutes: number; timed: number }>();
  const areas = new Map<string, Tally & { area: string }>();

  for (const r of rows) {
    const net = r.total - r.refunded;
    totals.orderCount += 1;
    totals.menuSalesCents += r.subtotal;
    totals.discountCents += r.discount;
    if (r.discount > 0) totals.discountedOrderCount += 1;
    totals.taxCents += r.tax;
    totals.billedCents += r.total;
    totals.partialRefundCents += r.refunded;
    if (r.refunded > 0) totals.partialRefundOrderCount += 1;

    const at = Date.parse(r.createdAt);
    tally(days, Math.floor((at - TRADING_DAY_OFFSET_MS) / DAY_MS), net);
    tally(hours, Math.floor((((at + PKT_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 3_600_000), net);
    tally(channels, channelOf(r.mode, r.source), net);

    // Website orders are booked under whichever manager the bridge ran as;
    // they get their own line instead of inflating that person's sales.
    const staffKey = r.source === 'web' ? 'web' : r.cashierId;
    // The owner's standing deal (the foodpanda deal) is not the cashier's
    // discount: it counts in the shop's totals and under "Standing offers",
    // never against whoever rang the order.
    const staffDiscount = r.discountSource ? 0 : r.discount;
    const s = staff.get(staffKey);
    if (s) {
      s.orderCount += 1;
      s.netSalesCents += net;
      s.discountCents += staffDiscount;
    } else staff.set(staffKey, { orderCount: 1, netSalesCents: net, discountCents: staffDiscount });

    // Own-rider deliveries (phone and website). Foodpanda brings its own riders.
    if (r.mode === 'delivery') {
      const rd = riders.get(r.riderId);
      const timed = r.minutesOut !== null ? 1 : 0;
      const minutes = r.minutesOut ?? 0;
      if (rd) {
        rd.orderCount += 1;
        rd.netSalesCents += net;
        rd.minutes += minutes;
        rd.timed += timed;
      } else riders.set(r.riderId, { orderCount: 1, netSalesCents: net, minutes, timed });

      const area = (r.area ?? '').trim();
      const areaKey = area.toLowerCase();
      const a = areas.get(areaKey);
      if (a) {
        a.orderCount += 1;
        a.netSalesCents += net;
      } else areas.set(areaKey, { orderCount: 1, netSalesCents: net, area: area || 'Area not recorded' });
    }
  }

  const bySales = <T extends { netSalesCents: number }>(a: T, b: T) => b.netSalesCents - a.netSalesCents;
  return {
    totals,
    byDay: [...days]
      .sort((a, b) => a[0] - b[0])
      .map(([dayNumber, t]) => ({ day: new Date(dayNumber * DAY_MS).toISOString().slice(0, 10), ...t })),
    byHour: [...hours].map(([hour, t]) => ({ hour, ...t })).sort((a, b) => a.hour - b.hour),
    channels: [...channels].map(([channel, t]) => ({ channel, ...t })).sort(bySales),
    staff: [...staff]
      .map(([key, t]) => ({
        key,
        name: key === 'web' ? 'Website orders' : (names.user(key) ?? 'Unknown'),
        isWebsite: key === 'web',
        ...t,
      }))
      .sort(bySales),
    deliveries: {
      byRider: [...riders]
        .map(([riderId, t]) => ({
          riderId,
          name: riderId === null ? 'No rider recorded' : (names.rider(riderId) ?? 'Unknown rider'),
          deliveries: t.orderCount,
          netSalesCents: t.netSalesCents,
          avgMinutesOut: t.timed > 0 ? Math.round(t.minutes / t.timed) : null,
        }))
        .sort((a, b) => b.deliveries - a.deliveries || b.netSalesCents - a.netSalesCents),
      byArea: [...areas]
        .map(([, t]) => ({ area: t.area, orderCount: t.orderCount, netSalesCents: t.netSalesCents }))
        .sort((a, b) => b.orderCount - a.orderCount || b.netSalesCents - a.netSalesCents),
    },
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function args(r: ReportRange): [string, string] {
  return [r.sinceIso, r.untilIso];
}

function getSaleRows(db: AppDatabase, range: ReportRange): SaleRow[] {
  // The area lives inside the address snapshot (JSON); json_valid guards rows
  // written before the snapshot was JSON — json_extract would throw on them.
  return db
    .prepare(
      `SELECT o.created_at AS createdAt, o.mode AS mode, o.source AS source, o.cashier_id AS cashierId,
              o.subtotal_cents AS subtotal, o.discount_cents AS discount, o.tax_cents AS tax,
              -- The latest live discount row describes the stored discount (as getDiscountLines reads it).
              CASE WHEN o.discount_cents > 0 THEN (
                SELECT d.source FROM order_discounts d
                 WHERE d.order_id = o.id AND d.deleted_at IS NULL
                 ORDER BY d.created_at DESC, d.id DESC LIMIT 1) END AS discountSource,
              o.total_cents AS total, ${REFUNDED} AS refunded,
              o.assigned_rider_id AS riderId,
              CASE WHEN o.dispatched_at IS NOT NULL AND o.delivered_at >= o.dispatched_at
                   THEN (julianday(o.delivered_at) - julianday(o.dispatched_at)) * 1440.0 END AS minutesOut,
              CASE WHEN o.mode = 'delivery' AND json_valid(o.delivery_address_snapshot)
                   THEN CAST(json_extract(o.delivery_address_snapshot, '$.area') AS TEXT) END AS area
         FROM orders o
        WHERE ${IN_RANGE} AND ${COUNTED}`,
    )
    .all(...args(range)) as SaleRow[];
}

function nameLookups(db: AppDatabase): { user: (id: string) => string | null; rider: (id: string) => string | null } {
  // Deleted people keep their name in history, so no deleted_at filter.
  const users = new Map(
    (db.prepare(`SELECT id, full_name AS name FROM users`).all() as Array<{ id: string; name: string }>).map((u) => [
      u.id,
      u.name,
    ]),
  );
  const riders = new Map(
    (db.prepare(`SELECT id, name FROM riders`).all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]),
  );
  return { user: (id) => users.get(id) ?? null, rider: (id) => riders.get(id) ?? null };
}

/** Money-by-method on the counted orders: sales and refunds, so it adds up to net sales. */
function getPaymentSplit(db: AppDatabase, range: ReportRange): Record<ReportPaymentGroup, number> {
  const methods = db
    .prepare(
      `SELECT p.method AS method, COALESCE(SUM(p.amount_cents), 0) AS cents
         FROM orders o
         JOIN payments p ON p.order_id = o.id AND p.deleted_at IS NULL
        WHERE ${IN_RANGE} AND ${COUNTED}
        GROUP BY p.method`,
    )
    .all(...args(range)) as Array<{ method: string; cents: number }>;
  const payments: Record<ReportPaymentGroup, number> = { cash: 0, card: 0, foodpanda: 0, transfer: 0 };
  for (const m of methods) payments[paymentGroup(m.method)] += m.cents;
  return payments;
}

/** Full refunds, cancellations and still-unpaid orders of the period. */
function getNonSales(
  db: AppDatabase,
  range: ReportRange,
): Pick<ReportKpis, 'fullRefundCount' | 'fullRefundCents' | 'voidCount' | 'voidCents' | 'unpaidCount' | 'unpaidCents'> {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.status = 'refunded' THEN 1 ELSE 0 END), 0) AS fullRefundCount,
              COALESCE(SUM(CASE WHEN o.status = 'refunded' THEN ${REFUNDED} ELSE 0 END), 0) AS fullRefundCents,
              COALESCE(SUM(CASE WHEN o.status = 'void' THEN 1 ELSE 0 END), 0) AS voidCount,
              COALESCE(SUM(CASE WHEN o.status = 'void' THEN o.total_cents ELSE 0 END), 0) AS voidCents,
              -- Empty carts (total 0) are not "waiting for payment"; they are nothing yet.
              COALESCE(SUM(CASE WHEN o.paid_at IS NULL AND o.status NOT IN ('void', 'refunded') AND o.total_cents > 0
                                THEN 1 ELSE 0 END), 0) AS unpaidCount,
              COALESCE(SUM(CASE WHEN o.paid_at IS NULL AND o.status NOT IN ('void', 'refunded') AND o.total_cents > 0
                                THEN o.total_cents ELSE 0 END), 0) AS unpaidCents
         FROM orders o
        WHERE ${IN_RANGE} AND o.deleted_at IS NULL
          AND (o.status IN ('refunded', 'void') OR o.paid_at IS NULL)`,
    )
    .get(...args(range)) as ReturnType<typeof getNonSales>;
  return row;
}

function buildKpis(
  totals: ReturnType<typeof aggregateSales>['totals'],
  itemCount: number,
  payments: Record<ReportPaymentGroup, number>,
  nonSales: ReturnType<typeof getNonSales>,
): ReportKpis {
  const netSalesCents = totals.billedCents - totals.partialRefundCents;
  const paid = payments.cash + payments.card + payments.foodpanda + payments.transfer;
  return {
    ...totals,
    itemCount,
    netSalesCents,
    avgOrderCents: totals.orderCount > 0 ? Math.round(netSalesCents / totals.orderCount) : 0,
    ...nonSales,
    payments,
    unrecordedPaymentCents: netSalesCents - paid,
  };
}

/** The headline figures alone (used for the comparison period). */
export function getReportKpis(db: AppDatabase, range: ReportRange): ReportKpis {
  return kpisOf(db, range, aggregateSales(getSaleRows(db, range), { user: () => null, rider: () => null }).totals);
}

/** The headline figures of a period whose sales pass is done: add items sold, payments, cancels and refunds. */
function kpisOf(db: AppDatabase, range: ReportRange, totals: ReturnType<typeof aggregateSales>['totals']): ReportKpis {
  const items = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS n
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        WHERE ${IN_RANGE} AND ${COUNTED}`,
    )
    .get(...args(range)) as { n: number };
  return buildKpis(totals, Number(items.n), getPaymentSplit(db, range), getNonSales(db, range));
}

function getItems(db: AppDatabase, range: ReportRange): ReportItemLine[] {
  // Added up per sold item first, then named: from the menu as it is now when
  // the item still exists (a rename shows the new name), else the sold-name
  // snapshot. LEFT JOINs: an item gone from the menu must not drop out.
  return db
    .prepare(
      `SELECT a.key AS key,
              COALESCE(mi.name, a.soldName) AS name,
              c.id AS categoryId,
              COALESCE(c.name, 'No category') AS categoryName,
              a.quantity AS quantity,
              a.salesCents AS salesCents
         FROM (SELECT COALESCE(oi.menu_item_id, 'name:' || oi.menu_item_name) AS key,
                      MAX(oi.menu_item_id) AS menuItemId,
                      MAX(oi.menu_item_name) AS soldName,
                      SUM(oi.quantity) AS quantity,
                      SUM(oi.line_total_cents) AS salesCents
                 FROM orders o
                 JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
                WHERE ${IN_RANGE} AND ${COUNTED}
                GROUP BY key) a
         LEFT JOIN menu_items mi ON mi.id = a.menuItemId
         LEFT JOIN categories c ON c.id = mi.category_id
        ORDER BY a.salesCents DESC, a.quantity DESC, name`,
    )
    .all(...args(range)) as ReportItemLine[];
}

function getVoids(
  db: AppDatabase,
  range: ReportRange,
  stockOf: (orderIds: string[]) => Map<string, ReportOrderStock>,
): Array<ReportVoidLine & { staffKey: string }> {
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.created_at AS createdAt,
              o.voided_at AS voidedAt, o.total_cents AS amountCents, o.void_reason AS reason,
              uv.full_name AS approvedBy, uc.full_name AS takenBy,
              CASE WHEN o.source = 'web' THEN 'web' ELSE o.cashier_id END AS staffKey
         FROM orders o
         LEFT JOIN users uv ON uv.id = o.voided_by
         LEFT JOIN users uc ON uc.id = o.cashier_id
        WHERE ${IN_RANGE} AND o.deleted_at IS NULL AND o.status = 'void'
        ORDER BY COALESCE(o.voided_at, o.created_at) DESC`,
    )
    .all(...args(range)) as Array<{
    orderId: string;
    orderNumber: string;
    createdAt: string;
    voidedAt: string | null;
    amountCents: number;
    reason: string | null;
    approvedBy: string | null;
    takenBy: string | null;
    staffKey: string;
  }>;
  const stock = stockOf(rows.map((r) => r.orderId));
  return rows.map((r) => ({
    ...r,
    reason: r.reason?.trim() || 'No reason given',
    approvedBy: r.approvedBy ?? 'Unknown',
    takenBy: r.staffKey === 'web' ? 'Website' : (r.takenBy ?? 'Unknown'),
    stock: stock.get(r.orderId) ?? null,
  }));
}

/**
 * Staff lines with each person's cancellations and no-sale drawer opens;
 * someone whose every order was cancelled, or who only opened the drawer,
 * still shows.
 */
function withStaffCounts(
  staff: SalesStaffLine[],
  voids: Array<{ staffKey: string }>,
  noSaleOpens: Map<string, number>,
  userName: (id: string) => string | null,
  drawerOpens: Map<string, number> = new Map(),
): ReportStaffLine[] {
  const voidCounts = new Map<string, number>();
  for (const v of voids) voidCounts.set(v.staffKey, (voidCounts.get(v.staffKey) ?? 0) + 1);
  const lines: ReportStaffLine[] = staff.map((s) => ({
    ...s,
    voidCount: voidCounts.get(s.key) ?? 0,
    noSaleOpens: noSaleOpens.get(s.key) ?? 0,
    drawerOpens: drawerOpens.get(s.key) ?? 0,
  }));
  for (const key of new Set([...voidCounts.keys(), ...noSaleOpens.keys(), ...drawerOpens.keys()])) {
    if (lines.some((l) => l.key === key)) continue;
    lines.push({
      key,
      name: key === 'web' ? 'Website orders' : (userName(key) ?? 'Unknown'),
      isWebsite: key === 'web',
      orderCount: 0,
      netSalesCents: 0,
      discountCents: 0,
      voidCount: voidCounts.get(key) ?? 0,
      noSaleOpens: noSaleOpens.get(key) ?? 0,
      drawerOpens: drawerOpens.get(key) ?? 0,
    });
  }
  return lines;
}

/**
 * Manual drawer opens that count as "no sale": the Open drawer button and
 * Test drawer. A shift's one "open to count" is part of closing it (a second
 * one is saved as no_sale — see drawer-open-repo).
 */
const NO_SALE_KINDS = `('no_sale', 'test')`;

/**
 * The opens BY HAND — the Open drawer button, "Open drawer to count" and Test
 * drawer. Since the drawer log (0042) drawer_opens also holds every cash
 * sale, refund, float and cash in / out, so the "opened by hand" figure and
 * list name these kinds; the whole log is reports:drawerLog.
 */
const MANUAL_KINDS = `('no_sale', 'count', 'test')`;

/** Who opened the drawer with no sale in the period, and how often. */
function getNoSaleOpensByUser(db: AppDatabase, range: ReportRange): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS n FROM drawer_opens
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND kind IN ${NO_SALE_KINDS}
        GROUP BY user_id`,
    )
    .all(...args(range)) as Array<{ userId: string; n: number }>;
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

/** Who had the drawer opened in the period, and how often — every kind (the drawer log, 0042). */
function getDrawerOpensByUser(db: AppDatabase, range: ReportRange): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS n FROM drawer_opens
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL
        GROUP BY user_id`,
    )
    .all(...args(range)) as Array<{ userId: string; n: number }>;
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

/** How many drawer opens BY HAND (no sale, count, test) the period had — the list below is capped. */
function getDrawerOpenCount(db: AppDatabase, range: ReportRange): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drawer_opens
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND kind IN ${MANUAL_KINDS}`,
    )
    .get(...args(range)) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Every drawer open BY HAND (no sale, count, test) in the period, newest first, capped. */
function getDrawerOpens(db: AppDatabase, range: ReportRange): ReportDrawerOpenLine[] {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.created_at AS createdAt, d.kind AS kind, d.reason AS reason,
              COALESCE(u.full_name, 'Unknown') AS openedBy, ua.full_name AS approvedBy,
              d.approved_by_user_id AS approverId, d.shift_id AS shiftId
         FROM drawer_opens d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN users ua ON ua.id = d.approved_by_user_id
        WHERE d.created_at >= ? AND d.created_at < ? AND d.deleted_at IS NULL AND d.kind IN ${MANUAL_KINDS}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${REPORT_LIST_CAP}`,
    )
    .all(...args(range)) as Array<{
    id: string;
    createdAt: string;
    kind: string;
    reason: string | null;
    openedBy: string;
    approvedBy: string | null;
    approverId: string | null;
    shiftId: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    // Only the kinds by hand reach here; anything else (a till's bug) is 'Other', never 'no sale'.
    kind: r.kind === 'no_sale' || r.kind === 'count' || r.kind === 'test' ? r.kind : 'other',
    reason: r.reason,
    openedBy: r.openedBy,
    approvedBy: r.approverId === null ? null : (r.approvedBy ?? 'Unknown'),
    outsideShift: r.shiftId === null,
  }));
}

/**
 * Shift history: every shift that was open at some time in the period —
 * opened before the period ends, and still open or closed at or after it
 * starts — newest first, capped. So Today shows the shift opened last night
 * and still running, or closed this morning (the owner's "I can't see the
 * shift history", 2026-09-27: it used to list only shifts OPENED in the
 * period). Each shift's drawer figures are the ones saved when it was
 * closed; a shift still open has none yet. The notes typed when it was
 * opened and when it was closed come with it, each on its own, and the
 * unpaid orders its close carried over, with the reason (0039); every
 * opening of its drawer (0042); and, never rewriting what was saved, the
 * cash of its test orders the owner deleted after it closed and how many of
 * the orders it carried over were later deleted as tests (0043).
 */
function getShifts(db: AppDatabase, range: ReportRange): BusinessReport['shifts'] {
  return db
    .prepare(
      `SELECT s.id AS id, s.opened_at AS openedAt, s.closed_at AS closedAt,
              COALESCE(uo.full_name, 'Unknown') AS openedBy, uc.full_name AS closedBy,
              s.opening_cash_cents AS openingCashCents,
              s.expected_cash_cents AS expectedCashCents,
              s.counted_cash_cents AS countedCashCents,
              s.variance_cents AS varianceCents,
              COALESCE((SELECT SUM(m.amount_cents) FROM cash_movements m
                         WHERE m.shift_id = s.id AND m.deleted_at IS NULL AND m.type = 'payin'), 0) AS cashInCents,
              COALESCE((SELECT SUM(m.amount_cents) FROM cash_movements m
                         WHERE m.shift_id = s.id AND m.deleted_at IS NULL AND m.type IN ('payout', 'tip_out')), 0) AS cashOutCents,
              (SELECT COUNT(*) FROM cash_movements m
                WHERE m.shift_id = s.id AND m.deleted_at IS NULL) AS cashMovementCount,
              (SELECT COUNT(*) FROM drawer_opens d
                WHERE d.shift_id = s.id AND d.deleted_at IS NULL AND d.kind IN ${NO_SALE_KINDS}) AS noSaleOpens,
              (SELECT COUNT(*) FROM drawer_opens d
                WHERE d.shift_id = s.id AND d.deleted_at IS NULL) AS drawerOpenCount,
              -- Test orders deleted AFTER the shift closed (0043): the saved
              -- expected / counted / short-over are never rewritten, so the
              -- cash is noted instead (signed: sales less refunds).
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                          JOIN orders o ON o.id = p.order_id
                         WHERE COALESCE(p.shift_id, o.shift_id) = s.id AND p.method = 'cash'
                           AND p.deleted_at IS NOT NULL AND s.closed_at IS NOT NULL AND p.deleted_at > s.closed_at
                           AND o.delete_kind = 'test'), 0) AS testDeletedCashCents,
              NULLIF(TRIM(s.notes), '') AS openingNote,
              NULLIF(TRIM(s.close_notes), '') AS closingNote,
              COALESCE(s.carried_unpaid_count, 0) AS carriedUnpaidCount,
              NULLIF(TRIM(s.carry_over_reason), '') AS carryOverReason,
              -- Of the orders its close carried over (0039: one audit row each,
              -- 'carried_over_unpaid'), those the owner later deleted as tests
              -- (0043). Deleted test orders are few: walked by their own index,
              -- then each one's audit rows by entity. Only for a close that
              -- carried any.
              CASE WHEN COALESCE(s.carried_unpaid_count, 0) > 0 THEN
                (SELECT COUNT(DISTINCT o.id) FROM orders o
                   JOIN audit_log a ON a.entity_type = 'orders' AND a.entity_id = o.id
                  WHERE o.deleted_at IS NOT NULL AND o.delete_kind = 'test'
                    AND a.action = 'carried_over_unpaid' AND json_valid(a.after_json)
                    AND json_extract(a.after_json, '$.shiftId') = s.id)
              ELSE 0 END AS carriedTestDeletedCount
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE s.opened_at < ? AND (s.closed_at IS NULL OR s.closed_at >= ?) AND s.deleted_at IS NULL
        ORDER BY s.opened_at DESC, s.id DESC
        LIMIT ${REPORT_LIST_CAP}`,
    )
    .all(range.untilIso, range.sinceIso) as BusinessReport['shifts'];
}

function getDiscountLines(db: AppDatabase, range: ReportRange): ReportDiscountLine[] {
  // One line per discounted counted order, for the order's STORED discount
  // (so the lines add up to the KPI), described by its latest discount row.
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.created_at AS createdAt,
              o.discount_cents AS amountCents,
              d.discount_type AS type, d.value AS value, d.reason AS reason, d.source AS source,
              ua.full_name AS givenBy, uap.full_name AS approvedBy
         FROM orders o
         LEFT JOIN order_discounts d ON d.id = (
                SELECT d2.id FROM order_discounts d2
                 WHERE d2.order_id = o.id AND d2.deleted_at IS NULL
                 ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1)
         LEFT JOIN users ua ON ua.id = d.applied_by_user_id
         LEFT JOIN users uap ON uap.id = d.approved_by_user_id
        WHERE ${IN_RANGE} AND ${COUNTED} AND o.discount_cents > 0
        ORDER BY o.created_at DESC`,
    )
    .all(...args(range)) as Array<{
    orderId: string;
    orderNumber: string;
    createdAt: string;
    amountCents: number;
    type: string | null;
    value: number | null;
    reason: string | null;
    source: string | null;
    givenBy: string | null;
    approvedBy: string | null;
  }>;
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    createdAt: r.createdAt,
    amountCents: r.amountCents,
    entered: discountEntered(r.type, r.value),
    reason: r.reason?.trim() || 'No reason given',
    givenBy: r.givenBy ?? 'Unknown',
    approvedBy: r.approvedBy,
    source: r.source === 'foodpanda' ? 'foodpanda' : null,
  }));
}

function getRefunds(
  db: AppDatabase,
  range: ReportRange,
  stockOf: (orderIds: string[]) => Map<string, ReportOrderStock>,
): ReportRefundLine[] {
  // Refunds on orders from this period (the same orders the sales figures
  // cover), whenever the money went back. The approver is who handed it back.
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.created_at AS orderCreatedAt,
              o.status AS status, o.void_reason AS orderReason,
              p.method AS method, -p.amount_cents AS amountCents, p.paid_at AS refundedAt,
              p.reference_no AS referenceNo, u.full_name AS approvedBy
         FROM orders o
         JOIN payments p ON p.order_id = o.id AND p.amount_cents < 0 AND p.deleted_at IS NULL
         LEFT JOIN users u ON u.id = p.received_by_user_id
        WHERE ${IN_RANGE} AND o.deleted_at IS NULL AND o.paid_at IS NOT NULL AND o.status <> 'void'
        ORDER BY p.paid_at DESC, p.id DESC`,
    )
    .all(...args(range)) as Array<{
    orderId: string;
    orderNumber: string;
    orderCreatedAt: string;
    status: string;
    orderReason: string | null;
    method: string;
    amountCents: number;
    refundedAt: string;
    referenceNo: string | null;
    approvedBy: string | null;
  }>;
  // What the refund did to stock goes on ONE line per order: the latest of a
  // whole-order refund (the one that settled it). A split cash + card order
  // refunded in full has two lines; its waste must not count twice.
  const stock = stockOf([...new Set(rows.filter((r) => r.status === 'refunded').map((r) => r.orderId))]);
  const placed = new Set<string>();
  return rows.map((r) => {
    const full = r.status === 'refunded';
    let lineStock: ReportOrderStock | null = null;
    if (full && !placed.has(r.orderId)) {
      placed.add(r.orderId);
      lineStock = stock.get(r.orderId) ?? null;
    }
    return {
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      orderCreatedAt: r.orderCreatedAt,
      refundedAt: r.refundedAt,
      amountCents: r.amountCents,
      method: r.method,
      full,
      reason: refundReason(r.referenceNo, r.orderReason),
      approvedBy: r.approvedBy ?? 'Unknown',
      stock: lineStock,
    };
  });
}

// ---------------------------------------------------------------------------
// What stock rows are worth
// ---------------------------------------------------------------------------

/**
 * Prices for stock rows written before costing started (no value of their
 * own), which are valued like estimates, read once per report and only
 * when needed: the price in force when the stock was TAKEN, from the price
 * history (costing spec 4.5, Phase 4: the starting price for anything
 * older), else — an ingredient with no history at all — today's price. And
 * the ingredients' units now.
 */
export interface Pricing {
  priceOf: PriceOf;
  unitOf: (ingredientId: string) => string | undefined;
  /** The price in force at a time, from the price history; undefined when the ingredient has none. */
  priceThen: (ingredientId: string, atIso: string) => DatedPrice | undefined;
}
export function lazyPricing(db: AppDatabase): () => Pricing {
  let p: Pricing | null = null;
  return () => {
    if (p) return p;
    const book = loadPriceBook(db);
    const history = loadPriceHistory(db);
    const now = priceOfBook(book);
    // One answer object per ingredient, so its unit conversion is worked out once (inRowUnit).
    const todays = new Map<string, ReturnType<PriceOf>>();
    const priceOf: PriceOf = (id) => {
      if (!todays.has(id)) todays.set(id, now(id));
      return todays.get(id);
    };
    p = { priceOf, unitOf: (id) => book.ingredients.get(id)?.unit, priceThen: history.priceAt };
    return p;
  };
}

/**
 * The price a row from before costing is valued at, as a pack in the unit
 * the row was written in (a row written in kg before a Convert, a price
 * kept in g…): the price in force at `takenAt`, else today's. Null when it
 * can't be (a deleted ingredient, units that don't convert).
 */
function priceForRow(
  r: { ingredientId: string; rowUnit: string | null },
  takenAt: string | null,
  pricing: () => Pricing,
): RowPrice | null {
  const p = pricing();
  const unitNow = p.unitOf(r.ingredientId);
  if (unitNow === undefined) return null;
  // A row with no unit (before 0029) was written in the unit now.
  const rowUnit = r.rowUnit ?? unitNow;
  const then = takenAt !== null ? p.priceThen(r.ingredientId, takenAt) : undefined;
  if (then) return inRowUnit(then, then.pack, then.unit, then.kind, rowUnit);
  const today = p.priceOf(r.ingredientId);
  if (!today) return NO_PRICE;
  return inRowUnit(today, today.pack, unitNow, today.kind, rowUnit);
}

/**
 * A price in the unit a row was written in, with what quantities have come
 * to at it so far (the exact value, worked in BigInt, is the same for the
 * same quantity at the same price: a year of estimates values "60 g of
 * cheese" thousands of times).
 */
interface RowPrice {
  price: ReturnType<PriceOf>;
  values: Map<number, number | null>;
}
/** No price anywhere (an ingredient never priced): worth Rs 0, and not priced. */
const NO_PRICE: RowPrice = { price: undefined, values: new Map() };

/**
 * A price turned into the unit a row was written in, worked out once per
 * price and unit (most rows are in the unit the price is kept in, and a
 * year of estimates looks the same few prices up again and again).
 */
const inUnitCache = new WeakMap<object, Map<string, RowPrice | null>>();
function inRowUnit(key: object, pack: Pack, unit: string, kind: PriceKind, rowUnit: string): RowPrice | null {
  let byUnit = inUnitCache.get(key);
  if (!byUnit) inUnitCache.set(key, (byUnit = new Map()));
  const hit = byUnit.get(rowUnit);
  if (hit !== undefined) return hit;
  const inUnit = packInUnit(pack, unit, rowUnit);
  const out = inUnit === null ? null : { price: { pack: inUnit, kind }, values: new Map<number, number | null>() };
  byUnit.set(rowUnit, out);
  return out;
}

/**
 * What one stock row is worth, signed like its quantity, and whether that is
 * a price at all: the value it kept when written (priced unless its basis
 * was 'none'), else (a row from before costing) its quantity at the price
 * in force when the stock was taken (`takenAt`; priceForRow), in the unit it
 * was written in — looked up ONCE per row (a year of estimated orders is
 * hundreds of thousands of rows). Value null when it can't be valued (a
 * deleted ingredient, a unit that can't be converted).
 */
function rowCost(
  r: { ingredientId: string; qty: number; rowUnit: string | null; value: number | null; basis?: string | null },
  pricing: () => Pricing,
  takenAt: string | null,
): { value: number | null; priced: boolean } {
  if (r.value !== null) return { value: r.value, priced: r.basis !== 'none' };
  const at = priceForRow(r, takenAt, pricing);
  if (at === null) return { value: null, priced: false };
  let value = at.values.get(r.qty);
  if (value === undefined) {
    value = safeStockValue(r.qty, at.price).valueCents;
    at.values.set(r.qty, value);
  }
  return { value, priced: at.price !== undefined && at.price.kind !== 'unset' };
}

/** What one stock row is worth (rowCost's value). */
function rowValue(
  r: { ingredientId: string; qty: number; rowUnit: string | null; value: number | null },
  pricing: () => Pricing,
  takenAt: string | null,
): number | null {
  return rowCost(r, pricing, takenAt).value;
}

/**
 * What cancelling / refunding in full did to each order's stock ("Was the
 * food made?", order-stock-repo.ts): put back, or wasted (and what that
 * waste cost when the order took it — rows from before costing at today's
 * prices), from the order's settle rows. The ANSWER comes from the
 * order-level audit row where this till wrote one (else from what the
 * settle rows' notes stand for — the other till's audit trail stays there),
 * with the status it was in and whether it went against the till's hint.
 * The flag follows the answer, not the rows: a correct "Made" where only
 * sealed drinks moved put stock back, and is no false alarm. Two indexed
 * reads over the listed orders (idx_movements_order, idx_audit_entity).
 */
export function getOrderStockOutcomes(
  db: AppDatabase,
  orderIds: string[],
  pricing: () => Pricing = lazyPricing(db),
): Map<string, ReportOrderStock> {
  const out = new Map<string, ReportOrderStock>();
  if (orderIds.length === 0) return out;
  const ids = JSON.stringify(orderIds);
  const rows = db
    .prepare(
      `SELECT m.ref_order_id AS orderId, m.reason AS reason, m.unit AS rowUnit, m.notes AS notes,
              m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.value_cents AS value,
              COALESCE(m.ref_taken_at, m.occurred_at) AS takenAt
         FROM stock_movements m
        WHERE m.ref_order_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL
          -- unary +: look rows up by order (idx_movements_order), never by reason
          AND (+m.reason IN ('waste', 'count') OR (+m.reason = 'sale' AND m.delta_qty > 0))`,
    )
    .all(ids) as Array<{
    orderId: string;
    reason: string;
    rowUnit: string | null;
    notes: string | null;
    ingredientId: string;
    qty: number;
    value: number | null;
    takenAt: string | null;
  }>;
  for (const r of rows) {
    const cur: ReportOrderStock = out.get(r.orderId) ?? {
      outcome: 'returned',
      answer: null,
      wasteCents: 0,
      statusBefore: null,
      flagged: false,
    };
    // A "made" settle can put sealed drinks back too; "not made" never wastes.
    const said = noteKindAnswer(orderStockNoteKind(r.notes));
    if (said === 'made' || (said === 'not_made' && cur.answer === null)) cur.answer = said;
    if (r.reason === 'waste') {
      cur.outcome = 'wasted';
      cur.wasteCents += -(rowValue({ ...r, qty: Number(r.qty), value: r.value === null ? null : Number(r.value) }, pricing, r.takenAt) ?? 0);
    }
    out.set(r.orderId, cur);
  }
  const audits = db
    .prepare(
      `SELECT entity_id AS orderId, before_json AS beforeJson, after_json AS afterJson
         FROM audit_log
        WHERE entity_type = 'orders' AND entity_id IN (SELECT value FROM json_each(?))
          AND action IN ('stock_put_back', 'stock_to_waste')
        ORDER BY rowid`,
    )
    .all(ids) as Array<{ orderId: string; beforeJson: string | null; afterJson: string | null }>;
  for (const a of audits) {
    const cur = out.get(a.orderId);
    if (!cur) continue;
    const before = safeJson(a.beforeJson);
    const after = safeJson(a.afterJson);
    const status = typeof before['status'] === 'string' ? before['status'] : null;
    cur.statusBefore = status;
    if (after['outcome'] === 'made' || after['outcome'] === 'not_made') cur.answer = after['outcome'];
    cur.flagged = putBackAfterCooking(cur) || after['againstHint'] === true;
  }
  return out;
}

/** "Not made" although cooking had been marked (preparing or ready): worth the owner's look. */
export function putBackAfterCooking(stock: Pick<ReportOrderStock, 'answer' | 'statusBefore'>): boolean {
  return stock.answer === 'not_made' && (stock.statusBefore === 'preparing' || stock.statusBefore === 'ready');
}

function safeJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Food cost (costing spec 4.5)
// ---------------------------------------------------------------------------

/** Order ids per query: json_each keeps the statement the same, chunks keep it small. */
const ID_CHUNK = 500;

export function chunks<T>(xs: readonly T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const STATUS_RANK: Record<number, OrderItemCostStatus> = { 0: 'full', 1: 'none', 2: 'partial', 3: 'failed' };

/**
 * A line that is not food (alias `oi`; ONE param, the ids of the fee items
 * as JSON — menuLookup): a delivery charge by the name it was sold under,
 * or an item that is a delivery charge or in a category the owner marked
 * "not food". Worked out in SQL so every path below reads it the same way.
 */
export const FEE_LINE = `(TRIM(oi.menu_item_name) LIKE 'delivery charge%' OR oi.menu_item_id IN (SELECT value FROM json_each(?)))`;

/**
 * An order's live lines as they were sold (what each came to, the name it
 * was sold under), in the till's order — for re-working a discount from the
 * rule frozen on it (pos-domain discount-base.ts).
 */
function soldLinesOf(db: AppDatabase, orderId: string): TaxedDiscountLine[] {
  const rows = db
    .prepare(
      `SELECT line_total_cents AS t, menu_item_name AS n, tax_rate_bps_snapshot AS r FROM order_items
        WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    )
    .all(orderId) as Array<{ t: number; n: string; r: number }>;
  return rows.map((r) => ({ lineTotalCents: Number(r.t), menuItemName: r.n, taxRateBps: Number(r.r) }));
}

/**
 * A counted order with nothing to share out — no discount, no refund, so
 * every line's net is its menu price — that kept its cost with the sale
 * (alias `o`). These are added up in SQL; only the others are read line by
 * line.
 */
export const PLAIN_KEPT = `(o.discount_cents = 0
    AND NOT EXISTS (SELECT 1 FROM payments rp
                     WHERE rp.order_id = o.id AND rp.amount_cents < 0 AND rp.deleted_at IS NULL)
    AND EXISTS (SELECT 1 FROM order_item_costs k
                 WHERE k.order_id = o.id AND k.status <> 'failed' AND k.deleted_at IS NULL))`;

/**
 * The period's counted orders, split once (MATERIALIZED: each order's checks
 * run once, not once per line): `po` the plain ones, `ro` the rest (a
 * discount or part refund to share out, or no cost kept). By the orders'
 * date index. Two params: since, until.
 */
const PLAIN_ORDERS = `po AS MATERIALIZED (
    SELECT o.id AS id FROM orders o WHERE ${IN_RANGE} AND ${COUNTED} AND ${PLAIN_KEPT})`;

/**
 * The rule frozen on an order's discount (alias `o`): its newest live
 * discount row's rule_json, read only when the order has a discount
 * (idx_order_discounts_order). A reader re-splitting the discount decides
 * from THIS alone whether a delivery-charge line took a share (pos-domain
 * discountRuleAlsoOffDeliveryCharge; no rule = it did, as before 0.7.26),
 * never from the live setting, so turning the switch never moves history.
 */
export const DISCOUNT_RULE = `CASE WHEN o.discount_cents > 0 THEN
      (SELECT d.rule_json FROM order_discounts d
        WHERE d.order_id = o.id AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC, d.id DESC LIMIT 1) END`;

const REST_ORDERS = `ro AS MATERIALIZED (
    SELECT o.id AS id, o.discount_cents AS disc, o.tax_cents AS tax, o.total_cents AS tot, ${REFUNDED} AS ref, ${DISCOUNT_RULE} AS drule
      FROM orders o WHERE ${IN_RANGE} AND ${COUNTED} AND NOT ${PLAIN_KEPT})`;

/** A line's cost rows, added up (with the LEFT JOIN of order_item_costs `c`, grouped by line). */
export const LINE_COSTS = `COUNT(c.id) AS parts, COALESCE(SUM(c.cost_cents), 0) AS cost,
         MAX(CASE c.status WHEN 'failed' THEN 3 WHEN 'partial' THEN 2 WHEN 'none' THEN 1 WHEN 'full' THEN 0 END) AS worst`;

/**
 * The lines of the orders that need sharing out or kept no cost (`ro`),
 * each with its cost rows added up (idx_order_item_costs_line_part), in the
 * order the till lists them. Params: since, until, fee items (JSON).
 */
export const FOOD_COST_LINES_SQL = `
  WITH ${REST_ORDERS}
  SELECT ro.id AS orderId, ro.disc AS disc, ro.tax AS tax, ro.tot AS tot, ro.ref AS ref, ro.drule AS drule,
         oi.id AS lineId, oi.menu_item_id AS itemId, oi.menu_item_name AS soldName,
         oi.quantity AS qty, oi.line_total_cents AS lineTotal, oi.tax_rate_bps_snapshot AS rate, ${FEE_LINE} AS isFee,
         ${LINE_COSTS}
    FROM ro
    CROSS JOIN order_items oi
    LEFT JOIN order_item_costs c ON c.order_item_id = oi.id AND c.deleted_at IS NULL
   WHERE oi.order_id = ro.id AND oi.deleted_at IS NULL
   GROUP BY oi.id
   ORDER BY ro.id, oi.created_at, oi.id`;

/*
 * The plain orders (`po`) are added up in SQL with plain indexed scans — no
 * per-line grouping, which is what costs time over a year (costing spec §6)
 * — and only their food lines that are NOT fully costed are read one by one
 * (pos-domain tallyPlainOrders).
 */

/** Their food and fee sales, and what their fee lines cost. Params: since, until, fee items (JSON). */
export const FOOD_COST_PLAIN_SALES_SQL = `
  WITH ${PLAIN_ORDERS},
       l AS (SELECT oi.id AS lineId, oi.line_total_cents AS lineTotal, ${FEE_LINE} AS isFee
               FROM po CROSS JOIN order_items oi
              WHERE oi.order_id = po.id AND oi.deleted_at IS NULL)
  SELECT COUNT(*) AS lines,
         COALESCE(SUM(CASE WHEN isFee THEN 0 ELSE lineTotal END), 0) AS food,
         COALESCE(SUM(CASE WHEN isFee THEN lineTotal ELSE 0 END), 0) AS fee,
         COALESCE(SUM(CASE WHEN isFee THEN (SELECT COALESCE(SUM(fc.cost_cents), 0) FROM order_item_costs fc
                                             WHERE fc.order_item_id = l.lineId AND fc.deleted_at IS NULL)
                           ELSE 0 END), 0) AS feeCost
    FROM l`;

/**
 * Their food and fee sales, what their fee lines cost and what all their
 * kept cost rows add up to, in ONE pass over the period's orders (the two
 * queries above in one, for getFoodSales — "used vs should have used" reads
 * a whole window between two stock takes in the Reports worker, on a budget).
 * Params: since, until, fee items (JSON).
 */
export const FOOD_SALES_PLAIN_SQL = `
  WITH ${PLAIN_ORDERS},
       l AS (SELECT oi.id AS lineId, oi.line_total_cents AS lineTotal, ${FEE_LINE} AS isFee
               FROM po CROSS JOIN order_items oi
              WHERE oi.order_id = po.id AND oi.deleted_at IS NULL)
  SELECT COUNT(*) AS lines,
         COALESCE(SUM(CASE WHEN isFee THEN 0 ELSE lineTotal END), 0) AS food,
         COALESCE(SUM(CASE WHEN isFee THEN lineTotal ELSE 0 END), 0) AS fee,
         COALESCE(SUM(CASE WHEN isFee THEN (SELECT COALESCE(SUM(fc.cost_cents), 0) FROM order_item_costs fc
                                             WHERE fc.order_item_id = l.lineId AND fc.deleted_at IS NULL)
                           ELSE 0 END), 0) AS feeCost,
         (SELECT COALESCE(SUM(c.cost_cents), 0) FROM po CROSS JOIN order_item_costs c
           WHERE c.order_id = po.id AND c.deleted_at IS NULL) AS cost
    FROM l`;

/** What all their kept cost rows add up to (idx_order_item_costs_order). Params: since, until. */
export const FOOD_COST_PLAIN_COST_SQL = `
  WITH ${PLAIN_ORDERS}
  SELECT COALESCE(SUM(c.cost_cents), 0) AS cost
    FROM po CROSS JOIN order_item_costs c
   WHERE c.order_id = po.id AND c.deleted_at IS NULL`;

/**
 * Their food lines that are not fully costed — a row that is partial, 'none'
 * or failed (found through the orders' cost rows), or no row at all — one
 * row each, with their rows added up. Items with no recipe or an unpriced
 * ingredient. Params: since, until, fee items (JSON).
 */
export const FOOD_COST_PLAIN_GAPS_SQL = `
  WITH ${PLAIN_ORDERS},
       gap AS (SELECT c.order_item_id AS lineId FROM po CROSS JOIN order_item_costs c
                WHERE c.order_id = po.id AND c.deleted_at IS NULL AND c.status <> 'full'
               UNION
               SELECT oi.id FROM po CROSS JOIN order_items oi
                WHERE oi.order_id = po.id AND oi.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM order_item_costs x
                                   WHERE x.order_item_id = oi.id AND x.deleted_at IS NULL))
  SELECT oi.id AS lineId, oi.menu_item_id AS itemId, oi.menu_item_name AS soldName,
         oi.quantity AS qty, oi.line_total_cents AS lineTotal,
         ${LINE_COSTS}
    FROM gap
    CROSS JOIN order_items oi
    LEFT JOIN order_item_costs c ON c.order_item_id = oi.id AND c.deleted_at IS NULL
   WHERE oi.id = gap.lineId AND oi.deleted_at IS NULL AND NOT ${FEE_LINE}
   GROUP BY oi.id`;

export function lineStatus(parts: number, worst: number | null): OrderItemCostStatus | null {
  return parts > 0 && worst !== null ? (STATUS_RANK[Number(worst)] ?? 'failed') : null;
}

export interface MenuLookup {
  item: (id: string | null) => { name: string; categoryId: string } | undefined;
  /** Items that are not food (delivery charges, non-food categories), as JSON for FEE_LINE. */
  feeItemsJson: string;
  /** Of them, the delivery charges (by their name now): what a rider's cost falls back to (Profit). */
  chargeItemsJson: string;
  withRecipe: ReadonlySet<string>;
  /** The categories the owner marked "not food" (and the delivery charges' own). */
  nonFoodCategoryIds: ReadonlySet<string>;
}

export function menuLookup(db: AppDatabase): MenuLookup {
  // Deleted items keep their name and category for history.
  const items = new Map(
    (
      db.prepare(`SELECT id, name, category_id AS categoryId FROM menu_items`).all() as Array<{
        id: string;
        name: string;
        categoryId: string;
      }>
    ).map((i) => [i.id, i]),
  );
  const categories = db
    .prepare(`SELECT id, name FROM categories WHERE deleted_at IS NULL ORDER BY display_order, name`)
    .all() as Array<{ id: string; name: string }>;
  const targets = resolveTargets(getBusinessSetting(db, 'costing.targets')?.value ?? null, categories);
  const nonFood = new Set([...targets.byCategory].filter(([, t]) => t.nonFood).map(([id]) => id));
  const withRecipe = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT r.menu_item_id AS id FROM recipes r
             JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
            WHERE r.deleted_at IS NULL`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
  const feeItems = [...items.values()].filter((i) => isDeliveryChargeName(i.name) || nonFood.has(i.categoryId)).map((i) => i.id);
  const chargeItems = [...items.values()].filter((i) => isDeliveryChargeName(i.name)).map((i) => i.id);
  return {
    item: (id) => (id ? items.get(id) : undefined),
    feeItemsJson: JSON.stringify(feeItems),
    chargeItemsJson: JSON.stringify(chargeItems),
    withRecipe,
    nonFoodCategoryIds: nonFood,
  };
}

// ---------------------------------------------- estimates kept between asks --

/**
 * The Reports worker keeps each order's estimate between asks (costing spec
 * Phase 9): Profit, Channels & delivery, Food cost & stock, the trends and
 * the owner's week all estimate the same orders from before costing started,
 * and a year of them is most of a second to read. An estimate comes only
 * from the order's own stock rows — the ledger is insert-only, so an order
 * that gains a row (a put-back, a late send) is found by rowid and worked out
 * again — valued at the price book and price history: any change to an
 * ingredient's price, unit or pack, a price-history row or a batch recipe
 * drops them all. Only on a connection that asks (keepEstimates: the
 * worker's read connection); the till's own connection works them out each
 * time.
 */
interface EstimateCache {
  pricesKey: string;
  /** stock_movements' highest rowid when last looked. */
  lastRowid: number;
  /** null: the order has no sale rows (nothing to estimate from). */
  byOrder: Map<string, FoodCostEstimate | null>;
}

/** Past this many orders kept (years of them), the cache starts again. */
export const ESTIMATE_CACHE_MAX = 150_000;

const estimateCaches = new WeakMap<AppDatabase, EstimateCache>();

/** Keep estimates between asks on this connection (the Reports worker's). */
export function keepEstimates(db: AppDatabase): void {
  if (!estimateCaches.has(db)) estimateCaches.set(db, { pricesKey: '', lastRowid: -1, byOrder: new Map() });
}

/** How many orders' estimates are kept on this connection (tests). */
export function keptEstimateCount(db: AppDatabase): number {
  return estimateCaches.get(db)?.byOrder.size ?? 0;
}

/**
 * Everything an estimate's prices come from, as one string: the ingredients'
 * price, unit, pack and batch yield (not their running counts, which move
 * with every sale), and the price history and batch recipes' size and last
 * change. A few hundred small rows.
 */
function pricesKey(db: AppDatabase): string {
  const rows = db
    .prepare(
      `SELECT id, unit, price_kind, cost_per_unit_cents, pack_size, pack_price_cents, batch_yield, deleted_at
         FROM ingredients ORDER BY id`,
    )
    .all();
  const tails = db
    .prepare(
      `SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(MAX(updated_at), '') FROM ingredient_costs) AS history,
              (SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(MAX(updated_at), '') FROM batch_recipe_lines) AS batches`,
    )
    .get() as { history: string; batches: string };
  return `${tails.history}|${tails.batches}|${JSON.stringify(rows)}`;
}

/** Bring the kept estimates up to the ledger and prices this read sees. */
function refreshEstimates(db: AppDatabase, cache: EstimateCache): void {
  const top = Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS r FROM stock_movements`).get() as { r: number }).r);
  const key = pricesKey(db);
  if (key !== cache.pricesKey || top < cache.lastRowid) {
    cache.byOrder.clear();
    cache.pricesKey = key;
  } else if (top > cache.lastRowid && cache.byOrder.size > 0) {
    for (const r of db
      .prepare(`SELECT DISTINCT ref_order_id AS id FROM stock_movements WHERE rowid > ? AND ref_order_id IS NOT NULL`)
      .all(cache.lastRowid) as Array<{ id: string }>) {
      cache.byOrder.delete(r.id);
    }
  }
  cache.lastRowid = top;
}

/**
 * Orders that kept no cost with the sale, estimated from the stock rows they
 * took (their own rows, idx_movements_order): at the value each row kept,
 * else at the price in force when the order FIRST took its stock (spec 4.5
 * / D8: from the price history since Phase 4 — the starting price for
 * anything older — so a later price change never moves an old estimate).
 * A put-back is valued at that same take's price, so it nets exactly. Net
 * of anything put back. Kept between asks where the connection keeps them
 * (keepEstimates). The estimates handed back are shared: read them only.
 */
export function estimateOrders(db: AppDatabase, orderIds: string[], pricing: () => Pricing): Map<string, FoodCostEstimate> {
  const cache = estimateCaches.get(db);
  if (!cache) return estimateFromLedger(db, orderIds, pricing);
  refreshEstimates(db, cache);
  const out = new Map<string, FoodCostEstimate>();
  const missing: string[] = [];
  for (const id of orderIds) {
    const hit = cache.byOrder.get(id);
    if (hit === undefined) missing.push(id);
    else if (hit !== null) out.set(id, hit);
  }
  if (missing.length === 0) return out;
  const fresh = estimateFromLedger(db, missing, pricing);
  if (cache.byOrder.size + missing.length > ESTIMATE_CACHE_MAX) cache.byOrder.clear();
  for (const id of missing) {
    const e = fresh.get(id) ?? null;
    cache.byOrder.set(id, e);
    if (e) out.set(id, e);
  }
  return out;
}

/**
 * The counted orders of [since, until) that kept no cost with the sale: the
 * ones Reports estimates from their stock rows. By the orders' date index.
 * Params: since, until.
 */
export const ORDERS_WITHOUT_COST_SQL = `
  SELECT o.id AS id FROM orders o
   WHERE ${IN_RANGE} AND ${COUNTED}
     AND NOT EXISTS (SELECT 1 FROM order_item_costs k WHERE k.order_id = o.id AND k.status <> 'failed' AND k.deleted_at IS NULL)`;

export function ordersWithoutCost(db: AppDatabase, range: ReportRange): string[] {
  return (db.prepare(ORDERS_WITHOUT_COST_SQL).all(range.sinceIso, range.untilIso) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Work these orders' estimates out now and keep them (a connection that
 * keeps them: the Reports worker, between asks), in one read — so the first
 * Profit, Channels or Food cost & stock of a long period finds them kept.
 */
export function warmEstimates(db: AppDatabase, orderIds: string[]): void {
  if (orderIds.length === 0 || !estimateCaches.has(db)) return;
  db.transaction(() => estimateOrders(db, orderIds, lazyPricing(db)))();
}

/** estimateOrders' reading and valuing of the orders' stock rows, every time. */
function estimateFromLedger(db: AppDatabase, orderIds: string[], pricing: () => Pricing): Map<string, FoodCostEstimate> {
  const out = new Map<string, FoodCostEstimate>();
  for (const ids of chunks(orderIds)) {
    const rows = (
      db
        .prepare(
          `SELECT m.ref_order_id AS orderId, m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.unit AS rowUnit,
                  m.value_cents AS value, m.cost_basis AS basis, m.occurred_at AS at, m.ref_taken_at AS refTakenAt
             FROM stock_movements m
            WHERE m.ref_order_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND +m.reason = 'sale'`,
        )
        .all(JSON.stringify(ids)) as Array<{
        orderId: string;
        ingredientId: string;
        qty: number;
        rowUnit: string | null;
        value: number | null;
        basis: string | null;
        at: string;
        refTakenAt: string | null;
      }>
    ).map((r) => ({
      // Named, not spread: a year of estimates is hundreds of thousands of rows, and a
      // spread of a driver's row object costs several times these few reads.
      orderId: r.orderId,
      ingredientId: r.ingredientId,
      qty: Number(r.qty),
      rowUnit: r.rowUnit,
      value: r.value === null ? null : Number(r.value),
      basis: r.basis,
      at: r.at,
      refTakenAt: r.refTakenAt,
    }));
    // When each order first took stock: its earliest take.
    const firstTake = new Map<string, string>();
    for (const r of rows) {
      if (r.qty >= 0) continue;
      const t = firstTake.get(r.orderId);
      if (t === undefined || r.at < t) firstTake.set(r.orderId, r.at);
    }
    for (const row of rows) {
      const takenAt = firstTake.get(row.orderId) ?? row.refTakenAt ?? row.at;
      const cur = out.get(row.orderId) ?? { costCents: 0, priced: true, tookStock: false };
      const c = rowCost(row, pricing, takenAt);
      if (c.value === null) cur.priced = false;
      else cur.costCents += -c.value;
      if (!c.priced) cur.priced = false;
      if (row.qty < 0) cur.tookStock = true;
      out.set(row.orderId, cur);
    }
  }
  return out;
}

/**
 * Which of these orders took stock (a 'sale' row taking something off), by
 * each order's own rows (idx_movements_order — the unary + keeps SQLite off
 * the reason index, which would walk every sale in the ledger). One param:
 * the order ids as JSON.
 */
export const ORDERS_THAT_TOOK_STOCK_SQL = `
  SELECT DISTINCT m.ref_order_id AS orderId
    FROM stock_movements m
   WHERE m.ref_order_id IN (SELECT value FROM json_each(?)) AND +m.reason = 'sale' AND m.delta_qty < 0
     AND m.deleted_at IS NULL`;

function ordersThatTookStock(db: AppDatabase, orderIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const ids of chunks(orderIds)) {
    for (const r of db.prepare(ORDERS_THAT_TOOK_STOCK_SQL).all(JSON.stringify(ids)) as Array<{ orderId: string }>) {
      out.add(r.orderId);
    }
  }
  return out;
}

/**
 * What the food of these orders cost (spec 4.5: orders WITH A TAKE): the
 * cost each kept (rows that did not fail), else an estimate from what it
 * took. Orders that took no stock are left out, whether they kept a Rs 0
 * cost (Baked Wings, no recipe) or none — nothing of theirs left the shelf.
 */
function foodOfOrders(db: AppDatabase, orderIds: string[], pricing: () => Pricing): ReportUnpaidFood {
  const res: ReportUnpaidFood = { orderCount: 0, costCents: 0, estimatedOrders: 0 };
  if (orderIds.length === 0) return res;
  const kept = new Map<string, number>();
  for (const ids of chunks(orderIds)) {
    for (const r of db
      .prepare(
        `SELECT order_id AS orderId, SUM(cost_cents) AS cost
           FROM order_item_costs
          WHERE order_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND status <> 'failed'
          GROUP BY order_id`,
      )
      .all(JSON.stringify(ids)) as Array<{ orderId: string; cost: number }>) {
      kept.set(r.orderId, Number(r.cost));
    }
  }
  // A kept cost above Rs 0 is food that went out; at Rs 0 (no recipe, or
  // only unpriced ingredients) it counts only when the order took stock.
  const tookStock = ordersThatTookStock(
    db,
    [...kept].filter(([, k]) => k === 0).map(([id]) => id),
  );
  const estimates = estimateOrders(
    db,
    orderIds.filter((id) => !kept.has(id)),
    pricing,
  );
  for (const id of orderIds) {
    const k = kept.get(id);
    if (k !== undefined) {
      if (k === 0 && !tookStock.has(id)) continue;
      res.orderCount += 1;
      res.costCents += k;
      continue;
    }
    const e = estimates.get(id);
    if (!e || !e.tookStock) continue;
    res.orderCount += 1;
    res.estimatedOrders += 1;
    res.costCents += e.costCents;
  }
  return res;
}

/** Waste booked by hand in [since, until), by when it happened. */
export const HAND_WASTE_SQL = `
  SELECT NULL AS orderId, m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.unit AS rowUnit,
         m.value_cents AS value, m.detail AS detail, m.occurred_at AS takenAt
    FROM stock_movements m INDEXED BY idx_movements_reason_time
   WHERE m.reason = 'waste' AND m.occurred_at >= ? AND m.occurred_at < ?
     AND m.deleted_at IS NULL AND m.ref_order_id IS NULL`;

/** The waste of orders started in [since, until) that were cancelled or refunded, by the order. */
export const ORDER_WASTE_SQL = `
  SELECT m.ref_order_id AS orderId, m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.unit AS rowUnit,
         m.value_cents AS value, m.detail AS detail, COALESCE(m.ref_taken_at, m.occurred_at) AS takenAt
    FROM orders o
    JOIN stock_movements m ON m.ref_order_id = o.id
   WHERE o.status IN ('void', 'refunded') AND ${IN_RANGE} AND o.deleted_at IS NULL
     AND +m.reason = 'waste' AND m.deleted_at IS NULL`;

/**
 * The waste of test orders started in [since, until) that the owner deleted
 * (0043), whatever their status — "Don't put it back" books the food as
 * waste, and so may a cancel before the delete. Reason 'test_order'. The
 * query above keeps o.deleted_at IS NULL, so nothing is counted twice and
 * Waste still matches the waste the stock ledger holds.
 */
export const TEST_ORDER_WASTE_SQL = `
  SELECT m.ref_order_id AS orderId, m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.unit AS rowUnit,
         m.value_cents AS value, m.detail AS detail, COALESCE(m.ref_taken_at, m.occurred_at) AS takenAt
    FROM orders o
    JOIN stock_movements m ON m.ref_order_id = o.id
   WHERE o.deleted_at IS NOT NULL AND o.delete_kind = 'test' AND ${IN_RANGE}
     AND +m.reason = 'waste' AND m.deleted_at IS NULL`;

/** Reports' own groups come first; then the owner's reasons in his order (by default the seven, Other last). */
const WASTE_GROUPS_FIRST: readonly ReportWasteReason[] = ['cancelled_made', 'test_order'];

interface WasteTally {
  cents: number;
  cancelledCents: number;
  cancelledOrders: Set<string>;
  rows: number;
  byReason: Map<string, ReportWasteLine>;
  byIngredient: Map<string, { qty: number; cents: number }>;
  /** The order the lines are listed in. */
  order: string[];
  /** The owner's names where not the released ones (Settings → Kitchen & stock); null: none. */
  labels: WasteReasonLabels | null;
}

/** A period's waste lines, in the owner's order. */
function wasteLines(w: WasteTally): ReportWasteLine[] {
  return w.order.map((r) => w.byReason.get(r)).filter((l): l is ReportWasteLine => l !== undefined);
}

/**
 * Waste in the period (spec 4.5): rows booked by hand, by when they happened
 * (idx_movements_reason_time, named: left to itself SQLite may skip-scan the
 * ingredient index), and the food of orders started in the period that were
 * cancelled or refunded, by the ORDER's day (idx_orders_status_created, then
 * each order's own rows) — so a late cancel moves nothing between days.
 */
function getWaste(db: AppDatabase, range: ReportRange, pricing: () => Pricing): WasteTally {
  const [since, until] = args(range);
  type Row = {
    orderId: string | null;
    ingredientId: string;
    qty: number;
    rowUnit: string | null;
    value: number | null;
    detail: string | null;
    /** When the stock was taken (a cancelled order's: its first take, where the row says). */
    takenAt: string | null;
  };
  const handRows = db.prepare(HAND_WASTE_SQL).all(since, until) as Row[];
  const orderRows = db.prepare(ORDER_WASTE_SQL).all(since, until) as Row[];
  const testRows = (db.prepare(TEST_ORDER_WASTE_SQL).all(since, until) as Row[]).map((r) => ({ ...r, testOrder: true }));
  // Grouped by the reason id each row keeps (hidden reasons too): a renamed reason's old rows count under its new name.
  const reasons = readStockRules(db).wasteReasons;
  const known = new Set(reasons.map((r) => r.id));
  const t: WasteTally = {
    cents: 0,
    cancelledCents: 0,
    cancelledOrders: new Set(),
    rows: 0,
    byReason: new Map(),
    byIngredient: new Map(),
    order: [...WASTE_GROUPS_FIRST, ...reasons.map((r) => r.id), ...(known.has('other') ? [] : ['other'])],
    labels: ownerWasteLabels(reasons),
  };
  const ordersByReason = new Map<string, Set<string>>();
  for (const r of [...handRows, ...orderRows, ...testRows] as Array<Row & { testOrder?: boolean }>) {
    const row = { ...r, qty: Number(r.qty), value: r.value === null ? null : Number(r.value) };
    const cents = -(rowValue(row, pricing, r.takenAt) ?? 0);
    // A deleted test order's food is its own line ("Test orders (deleted)"), not a cancel.
    const reason: string = r.testOrder === true ? 'test_order' : wasteReasonOf(r.detail, r.orderId, known);
    t.cents += cents;
    t.rows += 1;
    if (r.orderId !== null && r.testOrder !== true) {
      t.cancelledCents += cents;
      t.cancelledOrders.add(r.orderId);
    }
    const line = t.byReason.get(reason) ?? { reason, times: 0, cents: 0 };
    // How many times, as the owner counts them: each order its cancelled
    // food came from once (it has a row per ingredient), each entry booked
    // by hand once (one ingredient each).
    if (r.orderId === null) line.times += 1;
    else {
      const seen = ordersByReason.get(reason) ?? new Set<string>();
      if (!seen.has(r.orderId)) {
        seen.add(r.orderId);
        line.times += 1;
      }
      ordersByReason.set(reason, seen);
    }
    line.cents += cents;
    t.byReason.set(reason, line);
    const unit = pricing().unitOf(r.ingredientId);
    const factor = unit === undefined ? 1 : (unitFactor(r.rowUnit, unit) ?? 1);
    const ing = t.byIngredient.get(r.ingredientId) ?? { qty: 0, cents: 0 };
    ing.qty += -row.qty * factor;
    ing.cents += cents;
    t.byIngredient.set(r.ingredientId, ing);
  }
  return t;
}

/**
 * Waste by reason and the food sent out but never paid for, over a period
 * (spec 4.5): the Profit tab's waste and unpaid-food steps, the same figures
 * as Food cost & stock's.
 */
export function getWasteAndUnpaid(
  db: AppDatabase,
  range: ReportRange,
  pricing: () => Pricing = lazyPricing(db),
): { wasteCents: number; wasteByReason: ReportWasteLine[]; wasteLabels?: WasteReasonLabels; sentNotPaid: ReportUnpaidFood } {
  const waste = getWaste(db, range, pricing);
  return {
    wasteCents: waste.cents,
    wasteByReason: wasteLines(waste),
    ...(waste.labels ? { wasteLabels: waste.labels } : {}),
    sentNotPaid: foodOfOrders(db, unpaidOrderIds(db, range, ['served', 'delivered']), pricing),
  };
}

/** When this till first kept a sale's cost (order_item_costs' first row); null before any. */
export function costingStartedAt(db: AppDatabase): string | null {
  const started = db.prepare(`SELECT costed_at AS at FROM order_item_costs ORDER BY rowid LIMIT 1`).get() as { at: string } | undefined;
  return started?.at ?? null;
}

function wasteIngredientLines(db: AppDatabase, w: WasteTally): ReportWasteIngredientLine[] {
  if (w.byIngredient.size === 0) return [];
  const names = new Map(
    (
      db
        .prepare(`SELECT id, name, unit FROM ingredients WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify([...w.byIngredient.keys()])) as Array<{ id: string; name: string; unit: string }>
    ).map((i) => [i.id, i]),
  );
  return [...w.byIngredient]
    .map(([id, v]) => ({
      ingredientId: id,
      name: names.get(id)?.name ?? 'Deleted ingredient',
      unit: names.get(id)?.unit ?? '',
      wastedQty: v.qty,
      wastedCents: v.cents,
    }))
    .filter((l) => l.wastedQty !== 0 || l.wastedCents !== 0)
    .sort((a, b) => b.wastedCents - a.wastedCents || a.name.localeCompare(b.name));
}

/** Orders of the period in these statuses, not paid (idx_orders_status_created). */
function unpaidOrderIds(db: AppDatabase, range: ReportRange, statuses: readonly string[], untilIso?: string): string[] {
  const until = untilIso !== undefined && untilIso < range.untilIso ? untilIso : range.untilIso;
  if (until <= range.sinceIso) return [];
  return (
    db
      .prepare(
        `SELECT o.id AS id FROM orders o
          WHERE o.status IN (SELECT value FROM json_each(?)) AND o.created_at >= ? AND o.created_at < ?
            AND o.deleted_at IS NULL AND o.paid_at IS NULL`,
      )
      .all(JSON.stringify(statuses), range.sinceIso, until) as Array<{ id: string }>
  ).map((r) => r.id);
}

/** Still on the board: sent, being made, ready or out with the rider. */
const IN_PROGRESS = ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'] as const;

/**
 * Food sales and what they cost (costing spec 4.5), without waste or unpaid
 * food: the cost each sale kept, and estimates for orders with none. What
 * getFoodCost starts from, and all "used vs should have used" needs of it
 * (stock-control.ts: food sales over the window, and what they should have
 * cost for the real food cost).
 */
function tallyFoodSales(db: AppDatabase, range: ReportRange, pricing: () => Pricing, opts: { known: boolean } = { known: true }): FoodCostTally {
  const menu = menuLookup(db);
  const [since, until] = args(range);
  const t = emptyFoodCostTally();

  // 1. Plain orders (nothing to share out, cost kept): each line's net is
  //    its menu price, so their sales and costs are added up in SQL; only
  //    their food lines that are not fully costed are read one by one.
  // Food sales alone (getFoodSales): the two sums in one pass over the orders.
  const one = opts.known
    ? null
    : (db.prepare(FOOD_SALES_PLAIN_SQL).get(since, until, menu.feeItemsJson) as { lines: number; food: number; fee: number; feeCost: number; cost: number });
  const sales = one ?? (db.prepare(FOOD_COST_PLAIN_SALES_SQL).get(since, until, menu.feeItemsJson) as {
    lines: number;
    food: number;
    fee: number;
    feeCost: number;
  });
  const allCost = one ?? (db.prepare(FOOD_COST_PLAIN_COST_SQL).get(since, until) as { cost: number });
  // Which of their lines are not fully costed: only for how much is known
  // (and the missing list) — food sales and their cost do not depend on it.
  const gaps = (opts.known ? db.prepare(FOOD_COST_PLAIN_GAPS_SQL).all(since, until, menu.feeItemsJson) : []) as Array<{
    itemId: string | null;
    soldName: string;
    qty: number;
    lineTotal: number;
    parts: number;
    cost: number;
    worst: number | null;
  }>;
  tallyPlainOrders(t, {
    lineCount: Number(sales.lines),
    foodSalesCents: Number(sales.food),
    feeSalesCents: Number(sales.fee),
    foodCostCents: Number(allCost.cost) - Number(sales.feeCost),
    notFull: gaps.map((g) => ({
      key: g.itemId ?? `name:${g.soldName}`,
      name: menu.item(g.itemId)?.name ?? g.soldName,
      quantity: Number(g.qty),
      lineTotalCents: Number(g.lineTotal),
      isFee: false,
      parts: Number(g.parts),
      costCents: Number(g.cost),
      status: lineStatus(Number(g.parts), g.worst),
      hasRecipeNow: g.itemId !== null && menu.withRecipe.has(g.itemId),
    })),
  });

  // 2. The rest, line by line: a discount or a part refund to share out, or
  //    no cost kept (estimated from the stock the order took).
  const rows = db.prepare(FOOD_COST_LINES_SQL).all(since, until, menu.feeItemsJson) as Array<{
    orderId: string;
    disc: number;
    tax: number;
    tot: number;
    ref: number;
    drule: string | null;
    lineId: string;
    itemId: string | null;
    soldName: string;
    qty: number;
    lineTotal: number;
    rate: number;
    isFee: number;
    parts: number;
    cost: number;
    worst: number | null;
  }>;

  // Group the lines per order (they arrive ordered by order).
  const orders: Array<{
    id: string;
    disc: number;
    tax: number;
    tot: number;
    ref: number;
    drule: string | null;
    lines: FoodCostLine[];
    sold: TaxedDiscountLine[];
  }> = [];
  for (const r of rows) {
    let o = orders[orders.length - 1];
    if (!o || o.id !== r.orderId) {
      o = { id: r.orderId, disc: Number(r.disc), tax: Number(r.tax), tot: Number(r.tot), ref: Number(r.ref), drule: r.drule, lines: [], sold: [] };
      orders.push(o);
    }
    const it = menu.item(r.itemId);
    const parts = Number(r.parts);
    o.lines.push({
      key: r.itemId ?? `name:${r.soldName}`,
      name: it?.name ?? r.soldName,
      quantity: Number(r.qty),
      lineTotalCents: Number(r.lineTotal),
      isFee: Number(r.isFee) === 1,
      parts,
      costCents: Number(r.cost),
      status: lineStatus(parts, r.worst),
      hasRecipeNow: r.itemId !== null && menu.withRecipe.has(r.itemId),
    });
    o.sold.push({ lineTotalCents: Number(r.lineTotal), menuItemName: r.soldName, taxRateBps: Number(r.rate) });
  }
  // The lines that took none of the discount: a delivery charge its frozen
  // rule left alone, by the name it was SOLD under (never the live menu or
  // categories), read against the stored bill (an older till's re-work).
  for (const o of orders) {
    if (o.disc <= 0) continue;
    const skips = storedDiscountSkips(o.drule, o.sold, o.disc, o.tax);
    o.lines.forEach((l, i) => {
      if (skips[i]) l.skipsDiscount = true;
    });
  }

  const estimates = estimateOrders(
    db,
    orders.filter((o) => !orderKeptCost(o.lines)).map((o) => o.id),
    pricing,
  );
  for (const o of orders) {
    tallyFoodCost(t, {
      discountCents: o.disc,
      totalCents: o.tot,
      refundedCents: o.ref,
      lines: o.lines,
      estimate: estimates.get(o.id) ?? null,
    });
  }

  return t;
}

/**
 * Food sales (before tax, after discounts and part refunds) and what they
 * cost, over a period — the same figures as getFoodCost's, without how much
 * of it is known, waste or unpaid food ("used vs should have used" needs no
 * more, and reads them for a whole window between two stock takes).
 */
export function getFoodSales(db: AppDatabase, range: ReportRange): Pick<ReportFoodCost, 'foodSalesCents' | 'costOfSalesCents'> {
  const t = tallyFoodSales(db, range, lazyPricing(db), { known: false });
  return { foodSalesCents: t.foodSalesCents, costOfSalesCents: t.costOfSalesCents };
}

/**
 * Food cost for one period (spec 4.5), for the orders saved on this till:
 *  - food cost of sales: the cost each counted order kept with its sale,
 *    plus, for orders that kept none, an estimate from the stock they took
 *    at the prices of the time (the price in force at each take, from the
 *    price history) — dated by the ORDER's trading day, like the sales;
 *  - the food cost % on the sales whose cost is fully known, with how much
 *    of the food sales that is ("costs known for 94%"), and the rest listed;
 *  - waste by reason, food sent out but never paid for, orders from earlier
 *    days still open.
 */
export function getFoodCost(db: AppDatabase, range: ReportRange, now = new Date()): ReportFoodCost {
  const pricing = lazyPricing(db);
  const t = tallyFoodSales(db, range, pricing);

  const waste = getWaste(db, range, pricing);
  const sentNotPaid = foodOfOrders(db, unpaidOrderIds(db, range, ['served', 'delivered']), pricing);
  // Before today's trading day started: a board order from then is stale.
  const todayStarts = new Date(Math.floor((now.getTime() - TRADING_DAY_OFFSET_MS) / DAY_MS) * DAY_MS + TRADING_DAY_OFFSET_MS).toISOString();
  const stillOpen = foodOfOrders(db, unpaidOrderIds(db, range, IN_PROGRESS, todayStarts), pricing);

  const missing = [...t.missing.values()].sort((a, b) => b.salesCents - a.salesCents || a.name.localeCompare(b.name));
  const started = db.prepare(`SELECT costed_at AS at FROM order_item_costs ORDER BY rowid LIMIT 1`).get() as
    | { at: string }
    | undefined;
  const wasteByReason = wasteLines(waste);
  return {
    foodSalesCents: t.foodSalesCents,
    feeSalesCents: t.feeSalesCents,
    costOfSalesCents: t.costOfSalesCents,
    knownSalesCents: t.knownSalesCents,
    knownCostCents: t.knownCostCents,
    foodCostBps: shareBps(t.knownCostCents, t.knownSalesCents),
    knownMenuSalesCents: t.knownMenuSalesCents,
    menuFoodCostBps: shareBps(t.knownCostCents, t.knownMenuSalesCents),
    coverageBps: shareBps(t.knownSalesCents, t.foodSalesCents),
    estimatedOrders: t.estimatedOrders,
    estimatedCostCents: t.estimatedCostCents,
    costingStartedAt: started?.at ?? null,
    missingSales: missing.slice(0, REPORT_LIST_CAP),
    missingSalesCents: missing.reduce((s, m) => s + m.salesCents, 0),
    wasteCents: waste.cents,
    wasteByReason,
    // The owner's names for the reasons, only where they are not the released ones.
    ...(waste.labels ? { wasteLabels: waste.labels } : {}),
    wasteIngredients: wasteIngredientLines(db, waste).slice(0, REPORT_LIST_CAP),
    cancelledWasteCents: waste.cancelledCents,
    cancelledOrderCount: waste.cancelledOrders.size,
    // Filled in by getBusinessReport from the cancelled / refunded orders.
    putBackAfterCookingCount: 0,
    sentNotPaid,
    stillOpen,
    hasCosts: t.costOfSalesCents !== 0 || waste.cents !== 0 || sentNotPaid.costCents !== 0 || stillOpen.costCents !== 0,
    hasUsage: t.hasUsage || waste.rows > 0 || sentNotPaid.orderCount > 0 || stillOpen.orderCount > 0,
  };
}

// ---------------------------------------------------------------------------
// Purchases (costing spec 4.5 Pur(P), Phase 5)
// ---------------------------------------------------------------------------

/**
 * Every delivery / purchase stock row up to the end of the period, oldest
 * first (idx_movements_reason_time): the period's rows are the spend, and
 * the ones before give "the purchase before" each ingredient's latest.
 * Deliveries are a few a day, so this stays small over years.
 */
export const PURCHASE_ROWS_SQL = `
  SELECT m.ingredient_id AS ingredientId, m.delta_qty AS qty, m.unit AS rowUnit, m.value_cents AS value,
         m.cost_basis AS basis, m.occurred_at AS at, m.ref_purchase_order_id AS poId, po.supplier_id AS supplierId
    FROM stock_movements m INDEXED BY idx_movements_reason_time
    LEFT JOIN purchase_orders po ON po.id = m.ref_purchase_order_id
   WHERE m.reason = 'delivery' AND m.occurred_at < ? AND m.deleted_at IS NULL
   ORDER BY m.occurred_at, m.rowid`;

const NO_SUPPLIER = 'no_supplier';
const BY_HAND = 'by_hand';

/**
 * What was spent on stock in a period, on THIS till (costing spec 4.5, Phase
 * 5): the stock rows of deliveries and purchases, at their bills (from Phase
 * 5 exact; before it, a purchase order line's price × what came), dated by
 * when the stock came in. By supplier (a purchase with no supplier, and
 * stock booked in by hand with no bill, each have their own line) and by
 * ingredient, with its latest price against the purchase before. A row
 * from before costing kept no value: it is valued at the price in force
 * then, like the estimates. Σ by supplier = Σ by ingredient = the spend.
 *
 * Bills are purchases (distinct purchase orders / purchases): stock booked
 * in by hand has none, so its line counts 0 bills and its entries are said
 * once (byHandEntries). The latest price and the one before come only from
 * PAID purchases: a bill of Rs 0 (a sample, a gift) and stock booked in by
 * hand (valued at the price then, not a price paid) are not prices.
 */
export function getPurchases(db: AppDatabase, range: ReportRange, pricing: () => Pricing = lazyPricing(db)): ReportPurchases {
  const rows = db.prepare(PURCHASE_ROWS_SQL).all(range.untilIso) as Array<{
    ingredientId: string;
    qty: number;
    rowUnit: string | null;
    value: number | null;
    basis: string | null;
    at: string;
    poId: string | null;
    supplierId: string | null;
  }>;
  const groups = new Map<string, { from: ReportPurchaseSupplierLine['from']; bills: Set<string>; spendCents: number }>();
  const lines = new Map<string, Omit<ReportPurchaseIngredientLine, 'name' | 'unit'>>();
  /** Each ingredient's price per base unit on its latest purchase so far, in its unit now. */
  const lastPrice = new Map<string, number | null>();
  let spendCents = 0;
  let byHandCents = 0;
  let byHandEntries = 0;
  for (const r of rows) {
    const qty = Number(r.qty);
    const value = rowValue({ ingredientId: r.ingredientId, qty, rowUnit: r.rowUnit, value: r.value === null ? null : Number(r.value) }, pricing, r.at) ?? 0;
    const unitNow = pricing().unitOf(r.ingredientId);
    const qtyNow = qty * (unitNow === undefined ? 1 : (unitFactor(r.rowUnit, unitNow) ?? 1));
    // A price paid: a purchase's row with money on it (not a Rs 0 bill, not stock booked in by hand).
    const unitMc = r.poId !== null && qtyNow > 0 && value > 0 ? mulDivRound(value, 1000, qtyNow) : null;
    const before = lastPrice.get(r.ingredientId) ?? null;
    if (unitMc !== null) lastPrice.set(r.ingredientId, unitMc);
    if (r.at < range.sinceIso) continue;

    spendCents += value;
    const key = r.poId === null ? BY_HAND : (r.supplierId ?? NO_SUPPLIER);
    const g = groups.get(key) ?? { from: key === BY_HAND ? 'by_hand' : key === NO_SUPPLIER ? 'no_supplier' : 'supplier', bills: new Set<string>(), spendCents: 0 };
    g.spendCents += value;
    if (r.poId === null) {
      byHandCents += value;
      byHandEntries += 1;
    } else g.bills.add(r.poId);
    groups.set(key, g);

    const l = lines.get(r.ingredientId) ?? { ingredientId: r.ingredientId, qty: 0, times: 0, spendCents: 0, lastUnitCostMc: null, prevUnitCostMc: null };
    l.qty += qtyNow;
    l.times += 1;
    l.spendCents += value;
    if (unitMc !== null) {
      l.lastUnitCostMc = unitMc;
      l.prevUnitCostMc = before;
    }
    lines.set(r.ingredientId, l);
  }

  const supplierIds = [...groups.keys()].filter((k) => k !== BY_HAND && k !== NO_SUPPLIER);
  const supplierNames = new Map(
    supplierIds.length === 0
      ? []
      : (
          db.prepare(`SELECT id, name FROM suppliers WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(supplierIds)) as Array<{
            id: string;
            name: string;
          }>
        ).map((s) => [s.id, s.name]),
  );
  const ingredients = new Map(
    lines.size === 0
      ? []
      : (
          db
            .prepare(`SELECT id, name, unit FROM ingredients WHERE id IN (SELECT value FROM json_each(?))`)
            .all(JSON.stringify([...lines.keys()])) as Array<{ id: string; name: string; unit: string }>
        ).map((i) => [i.id, i]),
  );
  const bySupplier: ReportPurchaseSupplierLine[] = [...groups].map(([key, g]) => ({
    key,
    from: g.from,
    name:
      g.from === 'by_hand'
        ? 'Booked in by hand (no bill)'
        : g.from === 'no_supplier'
          ? 'No supplier named'
          : (supplierNames.get(key) ?? 'Supplier no longer on file'),
    bills: g.bills.size,
    spendCents: g.spendCents,
  }));
  bySupplier.sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));
  const byIngredient: ReportPurchaseIngredientLine[] = [...lines.values()].map((l) => ({
    ...l,
    name: ingredients.get(l.ingredientId)?.name ?? 'Deleted ingredient',
    unit: ingredients.get(l.ingredientId)?.unit ?? '',
  }));
  byIngredient.sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));
  // A purchase has one supplier (or none), so the groups' bills are distinct purchases.
  return { spendCents, bills: bySupplier.reduce((s, g) => s + g.bills, 0), bySupplier, byIngredient, byHandCents, byHandEntries };
}

// ---------------------------------------------------------------------------
// The tabs (costing spec Phase 3): one builder per Reports tab
// ---------------------------------------------------------------------------

/*
 * Each Reports tab is its own IPC channel and loads only its own figures:
 * a builder per tab, sharing the queries above (and analytics/sql.ts), so a
 * figure on one tab is worked out exactly as the same figure on another.
 * They run in the Reports worker thread (analytics/worker.ts), or on the
 * main process as the fallback; analytics/report-tabs.ts runs each in one
 * read transaction. Read-only.
 */

function rangeOf(req: BusinessReportRequest): ReportRange {
  return { sinceIso: req.sinceIso, untilIso: req.untilIso };
}

function compareOf(req: BusinessReportRequest): ReportRange | null {
  return req.compareSinceIso && req.compareUntilIso ? { sinceIso: req.compareSinceIso, untilIso: req.compareUntilIso } : null;
}

/** Tabs that name nobody (no staff or rider lines) skip reading the people. */
const NO_NAMES = { user: () => null, rider: () => null };

/** Net sales from the sales pass's totals: billed less part refunds. */
function netOf(totals: ReturnType<typeof aggregateSales>['totals']): number {
  return totals.billedCents - totals.partialRefundCents;
}

/** Overview: the headline figures, the comparison period's, and the order types (website vs till). */
export function buildOverviewTab(db: AppDatabase, req: BusinessReportRequest): ReportTabFigures<'overview'> {
  const range = rangeOf(req);
  const compare = compareOf(req);
  const sales = aggregateSales(getSaleRows(db, range), NO_NAMES);
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: kpisOf(db, range, sales.totals),
    previous: compare ? getReportKpis(db, compare) : null,
    channels: sales.channels,
  };
}

/**
 * When: sales by trading day and by Pakistan clock hour; with Phase 7 the
 * weekday × hour heatmap (closed days left out), the parts of the day and the
 * period's day notes (analytics/heatmap.ts), from the same single read.
 */
export function buildWhenTab(db: AppDatabase, req: BusinessReportRequest, now = new Date()): ReportTabFigures<'when'> {
  const range = rangeOf(req);
  const rows = getSaleRows(db, range);
  const sales = aggregateSales(rows, NO_NAMES);
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: { orderCount: sales.totals.orderCount, netSalesCents: netOf(sales.totals) },
    byDay: sales.byDay,
    byHour: sales.byHour,
    ...whenExtras(db, range, rows, sales.byHour, now),
  };
}

/** Menu: every item sold and its category, at menu price (Phase 9's costs: analytics/profit.ts menuCosts). */
export function buildMenuTab(db: AppDatabase, req: BusinessReportRequest): Omit<ReportTabFigures<'menu'>, 'costs'> {
  const range = rangeOf(req);
  const items = getItems(db, range);
  // The stored subtotals (not the lines added up): the same figure as the
  // Overview's "Items at menu price".
  const menu = db
    .prepare(`SELECT COALESCE(SUM(o.subtotal_cents), 0) AS cents FROM orders o WHERE ${IN_RANGE} AND ${COUNTED}`)
    .get(...args(range)) as { cents: number };
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: { menuSalesCents: Number(menu.cents), itemCount: items.reduce((s, i) => s + i.quantity, 0) },
    items,
    categories: rollUpCategories(items),
  };
}

/**
 * Channels & delivery: order types, and own-rider deliveries by rider and by
 * area (Phase 9's delivery areas and profit: analytics/profit.ts channelsExtras).
 */
export function buildChannelsTab(
  db: AppDatabase,
  req: BusinessReportRequest,
): Omit<ReportTabFigures<'channels'>, 'areas' | 'noRateDeliveries' | 'noRateCount' | 'profit'> {
  const range = rangeOf(req);
  const sales = aggregateSales(getSaleRows(db, range), nameLookups(db));
  const net = netOf(sales.totals);
  const orders = sales.totals.orderCount;
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: { orderCount: orders, netSalesCents: net, avgOrderCents: orders > 0 ? Math.round(net / orders) : 0 },
    channels: sales.channels,
    deliveries: sales.deliveries,
    foodpanda: getFoodpanda(db, range),
  };
}

/**
 * The columns of a foodpanda order's kept terms (order_channel_terms, alias
 * `t`, LEFT JOINed: null when none) that keptTermsOf reads. Reports →
 * Channels (getFoodpanda) and Reports → Profit (analytics/profit
 * readOrderCosts) read the same ones.
 */
export const KEPT_TERMS_COLUMNS = `t.id AS termsId, t.commission_confirmed AS confirmed, t.commission_cents AS commission,
         t.fixed_fee_cents AS fee, t.commission_tax_cents AS commissionTax, t.payment_fee_cents AS paymentFee,
         t.uplift_bps AS upliftBps, t.expected_payout_cents AS payout`;

/** A kept-terms row as KEPT_TERMS_COLUMNS reads it, as pos-domain's KeptFoodpandaTerms (null: none kept). */
export function keptTermsOf(r: {
  termsId: string | null;
  confirmed: number | null;
  commission: number | null;
  fee: number | null;
  commissionTax: number | null;
  paymentFee: number | null;
  upliftBps: number | null;
  payout: number | null;
}): KeptFoodpandaTerms | null {
  if (r.termsId === null) return null;
  return {
    confirmed: Number(r.confirmed) === 1,
    commissionCents: Number(r.commission ?? 0),
    fixedFeeCents: Number(r.fee ?? 0),
    commissionTaxCents: Number(r.commissionTax ?? 0),
    paymentFeeCents: Number(r.paymentFee ?? 0),
    expectedPayoutCents: r.payout === null ? null : Number(r.payout),
    upliftBps: r.upliftBps === null ? null : Number(r.upliftBps),
  };
}

/**
 * foodpanda in one period (Settings → foodpanda): the counted foodpanda
 * orders with the terms each kept at payment (order_channel_terms). Sales
 * and the deal come from the STORED order totals; foodpanda's money per
 * order from pos-domain foodpandaOrderMoney — the same rule as Reports →
 * Profit, so the two agree to the paisa: the tablet total expected and the
 * uplift as kept at payment (a later uplift never moves a paid order, or
 * its place in the list to check); the kept commission, fees and tax when
 * the commission was CONFIRMED at payment, otherwise (paid before terms
 * were kept, or while the commission was only suggested) the fees in force
 * now — so confirming the real commission later corrects them — counted as
 * "estimated"; part refunds taken off as Profit takes them. A fully
 * refunded order is not counted, so it counts no commission. Food cost is
 * the cost each sale kept (order_item_costs); reportTabForLogin clears it
 * for a login without costs.
 */
export function getFoodpanda(db: AppDatabase, range: ReportRange, cap = REPORT_LIST_CAP): ReportFoodpanda | null {
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.created_at AS createdAt,
              o.subtotal_cents AS subtotal, o.discount_cents AS discount, o.tax_cents AS tax, o.total_cents AS total,
              ${REFUNDED} AS refunded,
              ${KEPT_TERMS_COLUMNS},
              t.platform_funded_cents AS platform, t.tablet_total_cents AS tablet,
              (SELECT p.reference_no FROM payments p
                WHERE p.order_id = o.id AND p.method = 'foodpanda' AND p.amount_cents > 0 AND p.deleted_at IS NULL
                ORDER BY p.paid_at LIMIT 1) AS code,
              (SELECT d.rule_json FROM order_discounts d
                WHERE d.order_id = o.id AND d.source = 'foodpanda' AND d.deleted_at IS NULL
                ORDER BY d.created_at DESC LIMIT 1) AS ruleJson,
              (SELECT COUNT(*) FROM order_item_costs c WHERE c.order_id = o.id AND c.deleted_at IS NULL) AS costRows,
              (SELECT COUNT(*) FROM order_item_costs c WHERE c.order_id = o.id AND c.deleted_at IS NULL AND c.status = 'failed') AS failedRows,
              (SELECT COALESCE(SUM(c.cost_cents), 0) FROM order_item_costs c WHERE c.order_id = o.id AND c.deleted_at IS NULL) AS cost
         FROM orders o
         LEFT JOIN order_channel_terms t ON t.order_id = o.id AND t.deleted_at IS NULL
        WHERE ${IN_RANGE} AND ${COUNTED} AND o.mode = 'foodpanda'
        ORDER BY o.created_at DESC, o.id DESC`,
    )
    .all(...args(range)) as Array<{
    orderId: string;
    orderNumber: string;
    createdAt: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    refunded: number;
    termsId: string | null;
    platform: number | null;
    commission: number | null;
    fee: number | null;
    commissionTax: number | null;
    paymentFee: number | null;
    upliftBps: number | null;
    payout: number | null;
    tablet: number | null;
    confirmed: number | null;
    code: string | null;
    ruleJson: string | null;
    costRows: number;
    failedRows: number;
    cost: number;
  }>;
  if (rows.length === 0) return null;

  // The fees in force now (the one reader), for orders that kept no confirmed commission.
  const feesNow = readShopSetting(db, 'foodpanda.fees').value;
  const out: ReportFoodpanda = {
    orderCount: 0,
    tillPriceSalesCents: 0,
    shopDealCents: 0,
    foodpandaDealCents: 0,
    taxCents: 0,
    commissionCents: 0,
    feeCents: 0,
    commissionTaxCents: 0,
    foodpandaKeepsCents: 0,
    upliftCents: 0,
    partRefundCents: 0,
    youKeepCents: 0,
    expectedPayoutCents: 0,
    estimatedOrders: 0,
    commissionSuggested: false,
    unconfirmedCommissionBps: null,
    foodCost: null,
    toCheck: [],
    missingCodeCount: 0,
    tabletDiffCount: 0,
  };
  let costedOrders = 0;
  let costCents = 0;
  let costedSales = 0;
  let costedKept = 0;
  const lines: Array<ReportFoodpandaCheckLine & { attention: boolean }> = [];
  for (const r of rows) {
    const sub = Number(r.subtotal);
    const disc = Number(r.discount);
    const total = Number(r.total);
    const refunded = Number(r.refunded);
    // foodpanda's part of the deal: as kept at payment, else from the deal frozen on the order.
    let platform: number;
    if (r.termsId !== null) platform = Number(r.platform ?? 0);
    else {
      const rule = parseFoodpandaDealRule(r.ruleJson);
      // Worked on what the frozen rule worked it on: the food, when it left
      // the delivery charge alone (read from the lines as sold, against the
      // stored bill); else the subtotal.
      const sold = rule && rule.alsoOffDeliveryCharge === false ? soldLinesOf(db, r.orderId) : null;
      const base =
        sold && !storedDiscountAlsoOffDeliveryCharge(false, sold, disc, Number(r.tax)) ? discountBaseCents(sold, false) : sub;
      platform = rule ? dealAmount(rule, base).platformCents : 0;
    }
    // The one per-order rule (Reports → Profit uses it too).
    const m = foodpandaOrderMoney(
      { subtotalCents: sub, discountCents: disc, totalCents: total, refundedCents: refunded },
      keptTermsOf(r),
      feesNow,
    );
    if (m.estimated) {
      out.estimatedOrders += 1;
      if (!feesNow.confirmed) {
        out.commissionSuggested = true;
        out.unconfirmedCommissionBps = feesNow.commissionBps;
      }
    }
    const kept = m.youKeepCents;
    out.orderCount += 1;
    out.tillPriceSalesCents += sub;
    out.shopDealCents += disc;
    out.foodpandaDealCents += platform;
    out.taxCents += Number(r.tax);
    out.commissionCents += m.commissionCents;
    out.feeCents += m.fixedFeeCents + m.paymentFeeCents;
    out.commissionTaxCents += m.commissionTaxCents;
    out.foodpandaKeepsCents += m.foodpandaKeepsCents;
    out.upliftCents += m.upliftCents;
    out.partRefundCents += refunded;
    out.youKeepCents += kept;
    out.expectedPayoutCents += m.expectedPayoutCents;
    if (Number(r.costRows) > 0 && Number(r.failedRows) === 0) {
      costedOrders += 1;
      costCents += Number(r.cost);
      costedSales += sub - disc;
      costedKept += kept;
    }

    const code = r.code?.trim() ? r.code.trim() : null;
    const tablet = r.tablet === null ? null : Number(r.tablet);
    // Against what the tablet should show (the till's total at foodpanda's prices, as kept at payment): as Pay checked it.
    const diff = tablet === null ? null : tablet - m.expectedTabletCents;
    const differs = diff !== null && Math.abs(diff) > FOODPANDA_TABLET_TOLERANCE_CENTS;
    if (code === null) out.missingCodeCount += 1;
    if (differs) out.tabletDiffCount += 1;
    lines.push({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      day: tradingDayOf(r.createdAt),
      createdAt: r.createdAt,
      foodpandaCode: code,
      tillTotalCents: total,
      expectedTabletCents: m.expectedTabletCents,
      tabletTotalCents: tablet,
      diffCents: diff,
      differs,
      attention: code === null || differs,
    });
  }
  out.foodCost =
    costedOrders > 0
      ? { costedOrders, costCents, ofSalesBps: shareBps(costCents, costedSales), ofKeptBps: shareBps(costCents, costedKept) }
      : null;
  // Newest day first; within a day, the ones to look at first, then newest first.
  lines.sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      Number(b.attention) - Number(a.attention) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.orderId.localeCompare(a.orderId),
  );
  out.toCheck = lines.slice(0, cap).map(({ attention: _attention, ...l }) => l);
  return out;
}

/** Food cost & stock (COST_CAPABILITY only: the main process refuses the rest before building it). */
export function buildFoodStockTab(db: AppDatabase, req: BusinessReportRequest, now = new Date()): ReportTabFigures<'foodStock'> {
  const range = rangeOf(req);
  const pricing = lazyPricing(db);
  const stockOf = (ids: string[]) => getOrderStockOutcomes(db, ids, pricing);
  const foodCost = getFoodCost(db, range, now);
  // Answered "Not made" although cooking had been marked: worth the owner's look.
  foodCost.putBackAfterCookingCount = [...getVoids(db, range, stockOf), ...getRefunds(db, range, stockOf)].filter(
    (l) => l.stock !== null && putBackAfterCooking(l.stock),
  ).length;
  // Part refunds on the counted orders (the note under the food cost): their negative payments.
  const refunded = db
    .prepare(
      `SELECT COALESCE(-SUM(p.amount_cents), 0) AS cents
         FROM orders o
         JOIN payments p ON p.order_id = o.id AND p.amount_cents < 0 AND p.deleted_at IS NULL
        WHERE ${IN_RANGE} AND ${COUNTED}`,
    )
    .get(...args(range)) as { cents: number };
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: { partialRefundCents: Number(refunded.cents) },
    foodCost,
    purchases: getPurchases(db, range, pricing),
  };
}

/** Team & leakage: staff, shifts and the cash drawer, discounts, refunds and cancelled orders. */
export function buildTeamTab(db: AppDatabase, req: BusinessReportRequest): ReportTabFigures<'team'> {
  const range = rangeOf(req);
  const names = nameLookups(db);
  const sales = aggregateSales(getSaleRows(db, range), names);
  const pricing = lazyPricing(db);
  const stockOf = (ids: string[]) => getOrderStockOutcomes(db, ids, pricing);
  const voidRows = getVoids(db, range, stockOf);
  const refunds = getRefunds(db, range, stockOf);
  const nonSales = getNonSales(db, range);
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    kpis: {
      netSalesCents: netOf(sales.totals),
      menuSalesCents: sales.totals.menuSalesCents,
      partialRefundCents: sales.totals.partialRefundCents,
      fullRefundCents: nonSales.fullRefundCents,
      voidCount: nonSales.voidCount,
      voidCents: nonSales.voidCents,
    },
    staff: withHandPrints(
      db,
      range,
      withStaffCounts(sales.staff, voidRows, getNoSaleOpensByUser(db, range), names.user, getDrawerOpensByUser(db, range)),
      names.user,
    ),
    shifts: getShifts(db, range),
    discounts: summarizeDiscounts(getDiscountLines(db, range)),
    refunds: refunds.slice(0, REPORT_LIST_CAP),
    voids: withBillPrinted(db, voidRows.slice(0, REPORT_LIST_CAP).map(({ staffKey: _staffKey, ...v }) => v)),
    drawerOpens: getDrawerOpens(db, range),
    drawerOpenCount: getDrawerOpenCount(db, range),
    // The Stock column shows what wasted food cost when a row has a figure;
    // reportTabForLogin clears it (and those figures) for a login without costs.
    foodCost: { hasCosts: [...voidRows, ...refunds].some((l) => (l.stock?.wasteCents ?? 0) > 0) },
  };
}

// ---------------------------------------------------------------------------
// The whole page (tests and the bench)
// ---------------------------------------------------------------------------

/**
 * The whole Reports page for one period, put together from the tab
 * builders in one read transaction (every figure sees the same snapshot).
 * The till's screens ask for one tab at a time; this is what the tests
 * reconcile (every breakdown adds up) and the bench times. Read-only.
 */
export function getBusinessReport(db: AppDatabase, req: BusinessReportRequest, now = new Date()): BusinessReport {
  const build = db.transaction((): BusinessReport => {
    const overview = buildOverviewTab(db, req);
    const when = buildWhenTab(db, req, now);
    const menu = buildMenuTab(db, req);
    const channels = buildChannelsTab(db, req);
    const food = buildFoodStockTab(db, req, now);
    const team = buildTeamTab(db, req);
    return {
      sinceIso: req.sinceIso,
      untilIso: req.untilIso,
      kpis: overview.kpis,
      previous: overview.previous,
      byDay: when.byDay,
      byHour: when.byHour,
      items: menu.items,
      categories: menu.categories,
      channels: channels.channels,
      staff: team.staff,
      shifts: team.shifts,
      discounts: team.discounts,
      refunds: team.refunds,
      voids: team.voids,
      drawerOpens: team.drawerOpens,
      drawerOpenCount: team.drawerOpenCount,
      foodCost: food.foodCost,
      deliveries: channels.deliveries,
    };
  });
  return build();
}

/**
 * The report as a login may read it (costing spec §2): without
 * COST_CAPABILITY the food cost is left out altogether, and what the waste
 * of a cancelled or refunded order cost is 0, in the main process, so the
 * printout and the file carry no costs either. Sales figures stay. The tabs
 * follow the same rule (analytics/report-tabs.ts reportTabForLogin).
 */
export function reportForLogin(report: BusinessReport, canSeeCosts: boolean): BusinessReport {
  if (canSeeCosts) return report;
  return {
    ...report,
    foodCost: null,
    voids: report.voids.map(withoutWasteCost),
    refunds: report.refunds.map(withoutWasteCost),
  };
}

/** A cancelled or refunded order's line with what its wasted food cost set to 0. */
export function withoutWasteCost<T extends { stock: ReportOrderStock | null }>(x: T): T {
  return x.stock ? { ...x, stock: { ...x.stock, wasteCents: 0 } } : x;
}
