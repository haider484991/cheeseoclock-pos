import type {
  BusinessReport,
  BusinessReportRequest,
  ReportCategoryLine,
  ReportChannel,
  ReportChannelLine,
  ReportDeliveries,
  ReportDiscountLine,
  ReportDiscounts,
  ReportDrawerOpenLine,
  ReportFoodCost,
  ReportItemLine,
  ReportKpis,
  ReportOrderStock,
  ReportPaymentGroup,
  ReportRefundLine,
  ReportStaffLine,
  ReportVoidLine,
} from '@cheeseoclock/shared-types';
import { ingredientCostCents, noteKindAnswer, orderStockNoteKind, unitFactor } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import { withBillPrinted, withHandPrints } from './print-report.js';

/**
 * The Reports page, in one call (`reports:business`).
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
 */

/** Pakistan is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MS = 5 * 3_600_000;
/** The trading day starts at 05:00 Pakistan time = 00:00 UTC. */
const TRADING_DAY_OFFSET_MS = 5 * 3_600_000 - PKT_OFFSET_MS;
const DAY_MS = 86_400_000;

const IN_RANGE = `o.created_at >= ? AND o.created_at < ?`;
const COUNTED = `o.deleted_at IS NULL AND o.paid_at IS NOT NULL AND o.status NOT IN ('void', 'refunded')`;
/** Money handed back on an order (a positive number): its negative payment rows. */
const REFUNDED = `COALESCE((SELECT -SUM(rp.amount_cents) FROM payments rp
                    WHERE rp.order_id = o.id AND rp.amount_cents < 0 AND rp.deleted_at IS NULL), 0)`;

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

export function paymentGroup(method: string): ReportPaymentGroup {
  if (method === 'cash' || method === 'card' || method === 'foodpanda') return method;
  return 'transfer'; // easypaisa, jazzcash, bank_transfer
}

/** Where an order came from, in the owner's words. */
export function channelOf(mode: string, source: string): ReportChannel {
  if (mode === 'foodpanda') return 'foodpanda';
  if (source === 'web') return mode === 'takeaway' ? 'web_pickup' : 'web_delivery';
  if (mode === 'delivery' || mode === 'takeaway' || mode === 'dine_in') return mode;
  return 'online';
}

/** The trading day (YYYY-MM-DD) an instant belongs to. */
export function tradingDayOf(iso: string): string {
  return new Date(Date.parse(iso) - TRADING_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Pakistan clock hour (0–23) of an instant. */
export function pakistanHourOf(iso: string): number {
  return new Date(Date.parse(iso) + PKT_OFFSET_MS).getUTCHours();
}

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

/** Discount lines rolled up by reason and by who gave them. */
export function summarizeDiscounts(lines: ReportDiscountLine[], cap = REPORT_LIST_CAP): ReportDiscounts {
  const byReason = new Map<string, { reason: string; count: number; amountCents: number }>();
  const byPerson = new Map<string, { name: string; count: number; amountCents: number; approvedCount: number }>();
  let totalCents = 0;
  for (const l of lines) {
    totalCents += l.amountCents;
    const rKey = l.reason.trim().toLowerCase();
    const r = byReason.get(rKey) ?? { reason: l.reason, count: 0, amountCents: 0 };
    r.count += 1;
    r.amountCents += l.amountCents;
    byReason.set(rKey, r);
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
    recent: lines.slice(0, cap),
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
    const s = staff.get(staffKey);
    if (s) {
      s.orderCount += 1;
      s.netSalesCents += net;
      s.discountCents += r.discount;
    } else staff.set(staffKey, { orderCount: 1, netSalesCents: net, discountCents: r.discount });

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
  const rows = getSaleRows(db, range);
  const agg = aggregateSales(rows, { user: () => null, rider: () => null });
  const items = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity), 0) AS n
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        WHERE ${IN_RANGE} AND ${COUNTED}`,
    )
    .get(...args(range)) as { n: number };
  return buildKpis(agg.totals, items.n, getPaymentSplit(db, range), getNonSales(db, range));
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
): ReportStaffLine[] {
  const voidCounts = new Map<string, number>();
  for (const v of voids) voidCounts.set(v.staffKey, (voidCounts.get(v.staffKey) ?? 0) + 1);
  const lines: ReportStaffLine[] = staff.map((s) => ({
    ...s,
    voidCount: voidCounts.get(s.key) ?? 0,
    noSaleOpens: noSaleOpens.get(s.key) ?? 0,
  }));
  for (const key of new Set([...voidCounts.keys(), ...noSaleOpens.keys()])) {
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

/** How many manual drawer opens (all kinds) the period had — the list below is capped. */
function getDrawerOpenCount(db: AppDatabase, range: ReportRange): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drawer_opens
        WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL`,
    )
    .get(...args(range)) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** Every manual drawer open in the period (all kinds), newest first, capped. */
function getDrawerOpens(db: AppDatabase, range: ReportRange): ReportDrawerOpenLine[] {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.created_at AS createdAt, d.kind AS kind, d.reason AS reason,
              COALESCE(u.full_name, 'Unknown') AS openedBy, ua.full_name AS approvedBy,
              d.approved_by_user_id AS approverId, d.shift_id AS shiftId
         FROM drawer_opens d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN users ua ON ua.id = d.approved_by_user_id
        WHERE d.created_at >= ? AND d.created_at < ? AND d.deleted_at IS NULL
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
    // A kind this till doesn't know yet (from a newer one) reads as a no-sale open.
    kind: r.kind === 'count' || r.kind === 'test' ? r.kind : 'no_sale',
    reason: r.reason,
    openedBy: r.openedBy,
    approvedBy: r.approverId === null ? null : (r.approvedBy ?? 'Unknown'),
    outsideShift: r.shiftId === null,
  }));
}

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
                WHERE d.shift_id = s.id AND d.deleted_at IS NULL AND d.kind IN ${NO_SALE_KINDS}) AS noSaleOpens
         FROM shifts s
         LEFT JOIN users uo ON uo.id = s.opened_by_user_id
         LEFT JOIN users uc ON uc.id = s.closed_by_user_id
        WHERE s.opened_at >= ? AND s.opened_at < ? AND s.deleted_at IS NULL
        ORDER BY s.opened_at DESC
        LIMIT ${REPORT_LIST_CAP}`,
    )
    .all(...args(range)) as BusinessReport['shifts'];
}

function getDiscountLines(db: AppDatabase, range: ReportRange): ReportDiscountLine[] {
  // One line per discounted counted order, for the order's STORED discount
  // (so the lines add up to the KPI), described by its latest discount row.
  const rows = db
    .prepare(
      `SELECT o.id AS orderId, o.order_number AS orderNumber, o.created_at AS createdAt,
              o.discount_cents AS amountCents,
              d.discount_type AS type, d.value AS value, d.reason AS reason,
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

/** Where an ingredient's price and unit are read for valuing stock rows. */
interface PricedIngredient {
  unit: string;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
}

/** A stock row's quantity, in the ingredient's unit now (rows written before a Convert were in kg). */
function inUnitNow(qty: number, rowUnit: string | null, ing: PricedIngredient): number {
  return qty * (unitFactor(rowUnit, ing.unit) ?? 1);
}

/**
 * What cancelling / refunding in full did to each order's stock ("Was the
 * food made?", order-stock-repo.ts): put back, or wasted (and at what cost
 * today), from the order's settle rows. The ANSWER comes from the order-level
 * audit row where this till wrote one (else from what the settle rows' notes
 * stand for — the other till's audit trail stays there), with the status it
 * was in and whether it went against the till's hint. The flag follows the
 * answer, not the rows: a correct "Made" where only sealed drinks moved put
 * stock back, and is no false alarm. Two indexed reads over the listed orders
 * (idx_movements_order, idx_audit_entity).
 */
export function getOrderStockOutcomes(db: AppDatabase, orderIds: string[]): Map<string, ReportOrderStock> {
  const out = new Map<string, ReportOrderStock>();
  if (orderIds.length === 0) return out;
  const ids = JSON.stringify(orderIds);
  const rows = db
    .prepare(
      `SELECT m.ref_order_id AS orderId, m.reason AS reason, m.unit AS rowUnit, m.notes AS notes,
              COALESCE(SUM(m.delta_qty), 0) AS qty,
              i.unit AS unit, i.cost_per_unit_cents AS costPerUnitCents,
              i.pack_size AS packSize, i.pack_price_cents AS packPriceCents
         FROM stock_movements m
         LEFT JOIN ingredients i ON i.id = m.ingredient_id
        WHERE m.ref_order_id IN (SELECT value FROM json_each(?)) AND m.deleted_at IS NULL
          -- unary +: look rows up by order (idx_movements_order), never by reason
          AND (+m.reason IN ('waste', 'count') OR (+m.reason = 'sale' AND m.delta_qty > 0))
        GROUP BY m.ref_order_id, m.ingredient_id, m.unit, m.reason, m.notes`,
    )
    .all(ids) as Array<{
    orderId: string;
    reason: string;
    rowUnit: string | null;
    notes: string | null;
    qty: number;
    unit: string | null;
    costPerUnitCents: number | null;
    packSize: number | null;
    packPriceCents: number | null;
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
      if (r.unit !== null) {
        const ing: PricedIngredient = {
          unit: r.unit,
          costPerUnitCents: r.costPerUnitCents ?? 0,
          packSize: r.packSize,
          packPriceCents: r.packPriceCents,
        };
        cur.wasteCents += ingredientCostCents(inUnitNow(-Number(r.qty), r.rowUnit, ing), ing);
      }
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

/**
 * Orders that took their stock in the period: their first 'sale' take falls
 * in it. Everything written against such an order — the take, and whatever
 * settled it when it was cancelled or refunded, maybe on a later day from
 * Order History — counts on that day, so a late cancel moves nothing between
 * days (the day of the sale shows the food as waste, not as food sold).
 * Params: since, until, since.
 *
 * The per-order probes carry a unary + on everything but ref_order_id, so
 * SQLite looks them up by order (idx_movements_order); left to itself it
 * picked idx_movements_reason_time, walking every earlier sale for each row.
 */
const ORDERS_TAKEN_IN_RANGE = `
  SELECT DISTINCT m.ref_order_id AS oid
    FROM stock_movements m
   WHERE m.reason = 'sale' AND m.delta_qty < 0 AND m.ref_order_id IS NOT NULL
     AND m.occurred_at >= ? AND m.occurred_at < ? AND m.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM stock_movements e
                      WHERE e.ref_order_id = m.ref_order_id AND +e.reason = 'sale' AND +e.delta_qty < 0
                        AND e.deleted_at IS NULL AND +e.occurred_at < ?)`;

/** Food cost per ingredient and row unit. Params: since, until, since (taken), since, until. */
export const FOOD_COST_SQL = `WITH taken AS (${ORDERS_TAKEN_IN_RANGE}),
            mv AS (
              SELECT m.ingredient_id AS ingredientId, m.unit AS rowUnit, m.reason AS reason,
                     m.delta_qty AS delta, 0 AS fromOrder
                FROM stock_movements m
               WHERE m.reason IN ('sale', 'waste') AND m.occurred_at >= ? AND m.occurred_at < ?
                 AND m.deleted_at IS NULL AND m.ref_order_id IS NULL
              UNION ALL
              SELECT m.ingredient_id, m.unit, m.reason, m.delta_qty, 1
                FROM taken t
                JOIN stock_movements m ON m.ref_order_id = t.oid
               WHERE +m.reason IN ('sale', 'waste') AND m.deleted_at IS NULL)
       SELECT i.id AS ingredientId, i.name AS name, i.unit AS unit,
              i.cost_per_unit_cents AS costPerUnitCents, i.pack_size AS packSize,
              i.pack_price_cents AS packPriceCents, a.rowUnit AS rowUnit,
              a.usedQty AS usedQty, a.wastedQty AS wastedQty, a.orderWastedQty AS orderWastedQty
         FROM (SELECT ingredientId, rowUnit,
                      COALESCE(SUM(CASE WHEN reason = 'sale' THEN -delta ELSE 0 END), 0) AS usedQty,
                      COALESCE(SUM(CASE WHEN reason = 'waste' THEN -delta ELSE 0 END), 0) AS wastedQty,
                      COALESCE(SUM(CASE WHEN reason = 'waste' AND fromOrder = 1 THEN -delta ELSE 0 END), 0) AS orderWastedQty
                 FROM mv
                GROUP BY ingredientId, rowUnit) a
         JOIN ingredients i ON i.id = a.ingredientId`;

/** Cancelled / refunded orders whose food was booked as waste. Params: since, until, since. */
export const CANCELLED_WASTE_ORDERS_SQL = `WITH taken AS (${ORDERS_TAKEN_IN_RANGE})
       SELECT COUNT(DISTINCT m.ref_order_id) AS n
         FROM taken t JOIN stock_movements m ON m.ref_order_id = t.oid
        WHERE +m.reason = 'waste' AND m.deleted_at IS NULL`;

function getFoodCost(db: AppDatabase, range: ReportRange): ReportFoodCost {
  // Stock leaves when the kitchen gets the order ('sale' movements). A
  // cancelled or refunded order is settled against itself: put back as a
  // positive 'sale' (so the sum nets out), or — food that was made — moved
  // from 'sale' to 'waste' (order-stock-repo.ts). Valued at the ingredient's
  // price on file TODAY (movements carry no cost of their own), so this is an
  // estimate, and labelled as one. A row written before a Convert (kg → g) is
  // scaled into the unit the ingredient has now.
  // Rows with no order: by when they happened (idx_movements_reason_time).
  // Order rows: by the day the order took its stock (idx_movements_order).
  const [since, until] = args(range);
  const rows = db.prepare(FOOD_COST_SQL).all(since, until, since, since, until) as Array<{
    ingredientId: string;
    name: string;
    unit: string;
    costPerUnitCents: number;
    packSize: number | null;
    packPriceCents: number | null;
    rowUnit: string | null;
    usedQty: number;
    wastedQty: number;
    orderWastedQty: number;
  }>;
  // One line per ingredient, whatever units its rows were written in.
  const byIngredient = new Map<
    string,
    { ingredientId: string; name: string; unit: string; ing: PricedIngredient; used: number; wasted: number; orderWasted: number }
  >();
  for (const r of rows) {
    const ing: PricedIngredient = {
      unit: r.unit,
      costPerUnitCents: r.costPerUnitCents,
      packSize: r.packSize,
      packPriceCents: r.packPriceCents,
    };
    const cur = byIngredient.get(r.ingredientId) ?? {
      ingredientId: r.ingredientId,
      name: r.name,
      unit: r.unit,
      ing,
      used: 0,
      wasted: 0,
      orderWasted: 0,
    };
    cur.used += inUnitNow(Number(r.usedQty), r.rowUnit, ing);
    cur.wasted += inUnitNow(Number(r.wastedQty), r.rowUnit, ing);
    cur.orderWasted += inUnitNow(Number(r.orderWastedQty), r.rowUnit, ing);
    byIngredient.set(r.ingredientId, cur);
  }
  let usedCents = 0;
  let wasteCents = 0;
  let cancelledWasteCents = 0;
  const ingredients = [...byIngredient.values()]
    .filter((r) => r.used !== 0 || r.wasted !== 0)
    .map((r) => {
      const used = ingredientCostCents(r.used, r.ing);
      const wasted = ingredientCostCents(r.wasted, r.ing);
      usedCents += used;
      wasteCents += wasted;
      cancelledWasteCents += ingredientCostCents(r.orderWasted, r.ing);
      return {
        ingredientId: r.ingredientId,
        name: r.name,
        unit: r.unit,
        usedQty: r.used,
        wastedQty: r.wasted,
        usedCents: used,
        wastedCents: wasted,
      };
    })
    .sort((a, b) => b.usedCents + b.wastedCents - (a.usedCents + a.wastedCents) || a.name.localeCompare(b.name));
  const cancelled = db.prepare(CANCELLED_WASTE_ORDERS_SQL).get(since, until, since) as { n: number } | undefined;
  return {
    usedCents,
    wasteCents,
    cancelledWasteCents,
    cancelledOrderCount: Number(cancelled?.n ?? 0),
    // Filled in by getBusinessReport from the cancelled / refunded orders.
    putBackAfterCookingCount: 0,
    hasCosts: ingredients.some((i) => i.usedCents !== 0 || i.wastedCents !== 0),
    hasUsage: ingredients.length > 0,
    ingredients,
  };
}

/** The whole Reports page for one period. Read-only. */
export function getBusinessReport(db: AppDatabase, req: BusinessReportRequest): BusinessReport {
  const range = { sinceIso: req.sinceIso, untilIso: req.untilIso };
  const compare =
    req.compareSinceIso && req.compareUntilIso
      ? { sinceIso: req.compareSinceIso, untilIso: req.compareUntilIso }
      : null;
  // One read transaction: every figure on the page sees the same snapshot,
  // even if a sale lands (from another connection) while it is put together.
  const build = db.transaction((): BusinessReport => {
    const names = nameLookups(db);
    const sales = aggregateSales(getSaleRows(db, range), names);
    const items = getItems(db, range);
    const itemCount = items.reduce((s, i) => s + i.quantity, 0);
    const stockOf = (ids: string[]) => getOrderStockOutcomes(db, ids);
    const voidRows = getVoids(db, range, stockOf);
    const refunds = getRefunds(db, range, stockOf);
    const foodCost = getFoodCost(db, range);
    // Answered "Not made" although cooking had been marked: worth the owner's look.
    foodCost.putBackAfterCookingCount = [...voidRows, ...refunds].filter((l) => l.stock !== null && putBackAfterCooking(l.stock)).length;
    return {
      sinceIso: range.sinceIso,
      untilIso: range.untilIso,
      kpis: buildKpis(sales.totals, itemCount, getPaymentSplit(db, range), getNonSales(db, range)),
      previous: compare ? getReportKpis(db, compare) : null,
      byDay: sales.byDay,
      byHour: sales.byHour,
      items,
      categories: rollUpCategories(items),
      channels: sales.channels,
      staff: withHandPrints(db, range, withStaffCounts(sales.staff, voidRows, getNoSaleOpensByUser(db, range), names.user), names.user),
      shifts: getShifts(db, range),
      discounts: summarizeDiscounts(getDiscountLines(db, range)),
      refunds: refunds.slice(0, REPORT_LIST_CAP),
      voids: withBillPrinted(db, voidRows.slice(0, REPORT_LIST_CAP).map(({ staffKey: _staffKey, ...v }) => v)),
      drawerOpens: getDrawerOpens(db, range),
      drawerOpenCount: getDrawerOpenCount(db, range),
      foodCost,
      deliveries: sales.deliveries,
    };
  });
  return build();
}
