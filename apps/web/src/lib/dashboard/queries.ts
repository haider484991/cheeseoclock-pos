import type {
  DashDayFigures,
  DashLive,
  DashMenu,
  DashOrderDoc,
  DashShiftDoc,
} from '@cheeseoclock/shared-types';
import { sql } from '@/lib/db';
import { ensureDashSchema } from './schema';

/**
 * Everything the dashboard's pages read, in one place. Each figure is a sum
 * of what the tills sent (shared-types dashboard.ts NUMBERS ARE THE TILL'S):
 *  - a sale is an order with `counted` (the till's COUNTED), its money
 *    `net_cents` (total − partial refunds), dated by `trading_day`;
 *  - payment methods and items are read out of each counted order's own
 *    document (its payments and lines, as sold);
 *  - food cost, waste and profit are the tills' day figures, added up.
 * Callers check who may see what (perms.ts) BEFORE asking.
 */

type Stamp = Date | string;
const iso = (v: Stamp | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

// ---------------------------------------------------------------------------
// Tills
// ---------------------------------------------------------------------------

export interface TillState {
  deviceId: string;
  name: string;
  appVersion: string | null;
  lastPushAt: string;
  firstPushAt: string;
  caughtUp: boolean;
  live: DashLive | null;
}

export async function getTills(): Promise<TillState[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT device_id, device_name, app_version, last_push_at, first_push_at, caught_up, live
      FROM dash_tills ORDER BY last_push_at DESC`) as Array<{
    device_id: string;
    device_name: string | null;
    app_version: string | null;
    last_push_at: Stamp;
    first_push_at: Stamp;
    caught_up: boolean;
    live: DashLive | null;
  }>;
  return rows.map((r, i) => ({
    deviceId: r.device_id,
    name: r.device_name?.trim() || `Till ${i + 1}`,
    appVersion: r.app_version,
    lastPushAt: iso(r.last_push_at) ?? '',
    firstPushAt: iso(r.first_push_at) ?? '',
    caughtUp: r.caught_up === true,
    live: r.live,
  }));
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export interface SalesSummary {
  orders: number;
  netCents: number;
  /** Items at menu price (stored subtotals). */
  menuSalesCents: number;
  taxCents: number;
  discountCents: number;
  discountedOrders: number;
  partRefundCents: number;
  partRefundOrders: number;
  fullRefunds: number;
  fullRefundCents: number;
  cancels: number;
  cancelCents: number;
  unpaid: number;
  unpaidCents: number;
  items: number;
  /** net ÷ orders, rounded as the till rounds (Math.round). */
  avgCents: number;
}

export async function getSalesSummary(from: string, to: string): Promise<SalesSummary> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT
      count(*) FILTER (WHERE counted) AS orders,
      COALESCE(sum(net_cents) FILTER (WHERE counted), 0) AS net,
      COALESCE(sum(subtotal_cents) FILTER (WHERE counted), 0) AS menu_sales,
      COALESCE(sum(tax_cents) FILTER (WHERE counted), 0) AS tax,
      COALESCE(sum(discount_cents) FILTER (WHERE counted), 0) AS discounts,
      count(*) FILTER (WHERE counted AND discount_cents > 0) AS discounted,
      COALESCE(sum(refunded_cents) FILTER (WHERE counted), 0) AS part_refunds,
      count(*) FILTER (WHERE counted AND refunded_cents > 0) AS part_refund_orders,
      count(*) FILTER (WHERE deleted IS NULL AND status = 'refunded') AS full_refunds,
      COALESCE(sum(refunded_cents) FILTER (WHERE deleted IS NULL AND status = 'refunded'), 0) AS full_refund_cents,
      count(*) FILTER (WHERE deleted IS NULL AND status = 'void') AS cancels,
      COALESCE(sum(total_cents) FILTER (WHERE deleted IS NULL AND status = 'void'), 0) AS cancel_cents,
      count(*) FILTER (WHERE deleted IS NULL AND paid_at IS NULL AND status NOT IN ('void', 'refunded') AND total_cents > 0) AS unpaid,
      COALESCE(sum(total_cents) FILTER (WHERE deleted IS NULL AND paid_at IS NULL AND status NOT IN ('void', 'refunded') AND total_cents > 0), 0) AS unpaid_cents,
      COALESCE(sum(item_count) FILTER (WHERE counted), 0) AS items
    FROM dash_orders
    WHERE trading_day BETWEEN ${from}::date AND ${to}::date`) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const orders = n(r['orders']);
  const net = n(r['net']);
  return {
    orders,
    netCents: net,
    menuSalesCents: n(r['menu_sales']),
    taxCents: n(r['tax']),
    discountCents: n(r['discounts']),
    discountedOrders: n(r['discounted']),
    partRefundCents: n(r['part_refunds']),
    partRefundOrders: n(r['part_refund_orders']),
    fullRefunds: n(r['full_refunds']),
    fullRefundCents: n(r['full_refund_cents']),
    cancels: n(r['cancels']),
    cancelCents: n(r['cancel_cents']),
    unpaid: n(r['unpaid']),
    unpaidCents: n(r['unpaid_cents']),
    items: n(r['items']),
    avgCents: orders > 0 ? Math.round(net / orders) : 0,
  };
}

/**
 * One day's sales of orders started before an instant: "today so far"
 * against the same weekday last week up to the same time, a fair compare
 * before the day is over.
 */
export async function getSalesUntil(day: string, untilIso: string): Promise<{ orders: number; netCents: number }> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day = ${day}::date AND counted AND created_at < ${untilIso}::timestamptz`) as Array<{ orders: unknown; net: unknown }>;
  return { orders: n(rows[0]?.orders), netCents: n(rows[0]?.net) };
}

/** The first trading day any till sent an order for (null: none yet) — a comparison before it has nothing to compare. */
export async function getFirstDay(): Promise<string | null> {
  await ensureDashSchema();
  const rows = (await sql()`SELECT to_char(min(trading_day), 'YYYY-MM-DD') AS day FROM dash_orders WHERE deleted IS NULL`) as Array<{ day: string | null }>;
  return rows[0]?.day ?? null;
}

export interface DayPoint {
  day: string;
  orders: number;
  netCents: number;
}

export async function getSalesByDay(from: string, to: string): Promise<DayPoint[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT to_char(trading_day, 'YYYY-MM-DD') AS day, count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted
     GROUP BY trading_day ORDER BY trading_day`) as Array<{ day: string; orders: unknown; net: unknown }>;
  return rows.map((r) => ({ day: r.day, orders: n(r.orders), netCents: n(r.net) }));
}

export interface HourPoint {
  hour: number;
  orders: number;
  netCents: number;
}

export async function getSalesByHour(from: string, to: string): Promise<HourPoint[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT hour, count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted
     GROUP BY hour ORDER BY hour`) as Array<{ hour: unknown; orders: unknown; net: unknown }>;
  return rows.map((r) => ({ hour: n(r.hour), orders: n(r.orders), netCents: n(r.net) }));
}

export interface HeatCell {
  /** 1 Monday … 7 Sunday (of the trading day). */
  dow: number;
  hour: number;
  orders: number;
  netCents: number;
}

export async function getHeatmap(from: string, to: string): Promise<HeatCell[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT extract(isodow FROM trading_day)::int AS dow, hour, count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted
     GROUP BY 1, 2`) as Array<{ dow: unknown; hour: unknown; orders: unknown; net: unknown }>;
  return rows.map((r) => ({ dow: n(r.dow), hour: n(r.hour), orders: n(r.orders), netCents: n(r.net) }));
}

export interface Slice {
  key: string;
  orders: number;
  netCents: number;
}

export async function getChannels(from: string, to: string): Promise<Slice[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT channel AS key, count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted
     GROUP BY channel ORDER BY 3 DESC`) as Array<{ key: string; orders: unknown; net: unknown }>;
  return rows.map((r) => ({ key: r.key, orders: n(r.orders), netCents: n(r.net) }));
}

/** How the orders came in; a website or foodpanda order needs no asking (the till's Channels tab reads it so too). */
export async function getCameBy(from: string, to: string): Promise<Slice[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT COALESCE(came_by, CASE WHEN source = 'web' THEN 'website' WHEN mode = 'foodpanda' THEN 'foodpanda' ELSE 'not_asked' END) AS key,
           count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted
     GROUP BY 1 ORDER BY 3 DESC`) as Array<{ key: string; orders: unknown; net: unknown }>;
  return rows.map((r) => ({ key: r.key, orders: n(r.orders), netCents: n(r.net) }));
}

export interface MethodTotal {
  method: string;
  /** Refunds included as money handed back (below 0). */
  cents: number;
  orders: number;
}

export async function getPaymentMethods(from: string, to: string): Promise<MethodTotal[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT p->>'method' AS method, COALESCE(sum((p->>'amountCents')::bigint), 0) AS cents, count(DISTINCT o.id) AS orders
      FROM dash_orders o, jsonb_array_elements(o.doc->'payments') p
     WHERE o.trading_day BETWEEN ${from}::date AND ${to}::date AND o.counted
     GROUP BY 1 ORDER BY 2 DESC`) as Array<{ method: string; cents: unknown; orders: unknown }>;
  return rows.map((r) => ({ method: r.method, cents: n(r.cents), orders: n(r.orders) }));
}

export interface ItemTotal {
  key: string;
  name: string;
  category: string | null;
  qty: number;
  /** At menu price (line totals), as the till's Menu tab. */
  salesCents: number;
}

/** Best sellers by what they took at menu price; delivery charges left out. */
export async function getTopItems(from: string, to: string, limit = 15): Promise<ItemTotal[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT COALESCE(l->>'menuItemId', 'name:' || (l->>'name')) AS key,
           (array_agg(l->>'name' ORDER BY o.created_at DESC))[1] AS name,
           (array_agg(l->>'category' ORDER BY o.created_at DESC))[1] AS category,
           sum((l->>'qty')::int) AS qty,
           COALESCE(sum((l->>'lineTotalCents')::bigint), 0) AS sales
      FROM dash_orders o, jsonb_array_elements(o.doc->'lines') l
     WHERE o.trading_day BETWEEN ${from}::date AND ${to}::date AND o.counted
       AND COALESCE((l->>'isFee')::boolean, false) = false
     GROUP BY 1 ORDER BY 5 DESC, 4 DESC LIMIT ${limit}::int`) as Array<{
    key: string;
    name: string;
    category: string | null;
    qty: unknown;
    sales: unknown;
  }>;
  return rows.map((r) => ({ key: r.key, name: r.name, category: r.category, qty: n(r.qty), salesCents: n(r.sales) }));
}

export async function getCategories(from: string, to: string): Promise<Slice[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT COALESCE(l->>'category', 'No category') AS key, sum((l->>'qty')::int) AS orders,
           COALESCE(sum((l->>'lineTotalCents')::bigint), 0) AS net
      FROM dash_orders o, jsonb_array_elements(o.doc->'lines') l
     WHERE o.trading_day BETWEEN ${from}::date AND ${to}::date AND o.counted
       AND COALESCE((l->>'isFee')::boolean, false) = false
     GROUP BY 1 ORDER BY 3 DESC`) as Array<{ key: string; orders: unknown; net: unknown }>;
  // `orders` here is the items sold in the category.
  return rows.map((r) => ({ key: r.key, orders: n(r.orders), netCents: n(r.net) }));
}

/** Delivery charges taken (the lines the till marks as charges). */
export async function getDeliveryCharges(from: string, to: string): Promise<{ count: number; cents: number }> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT COALESCE(sum((l->>'qty')::int), 0) AS qty, COALESCE(sum((l->>'lineTotalCents')::bigint), 0) AS cents
      FROM dash_orders o, jsonb_array_elements(o.doc->'lines') l
     WHERE o.trading_day BETWEEN ${from}::date AND ${to}::date AND o.counted
       AND COALESCE((l->>'isFee')::boolean, false) = true`) as Array<{ qty: unknown; cents: unknown }>;
  return { count: n(rows[0]?.qty), cents: n(rows[0]?.cents) };
}

export interface StaffTotal {
  name: string;
  orders: number;
  netCents: number;
  discountCents: number;
  cancels: number;
}

export async function getStaff(from: string, to: string): Promise<StaffTotal[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT CASE WHEN source = 'web' THEN 'Website' ELSE COALESCE(cashier, 'Unknown') END AS name,
           count(*) FILTER (WHERE counted) AS orders,
           COALESCE(sum(net_cents) FILTER (WHERE counted), 0) AS net,
           COALESCE(sum(discount_cents) FILTER (WHERE counted), 0) AS discounts,
           count(*) FILTER (WHERE deleted IS NULL AND status = 'void') AS cancels
      FROM dash_orders
     WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND deleted IS NULL
     GROUP BY 1 HAVING count(*) FILTER (WHERE counted) > 0 OR count(*) FILTER (WHERE status = 'void') > 0
     ORDER BY 3 DESC`) as Array<{ name: string; orders: unknown; net: unknown; discounts: unknown; cancels: unknown }>;
  return rows.map((r) => ({
    name: r.name,
    orders: n(r.orders),
    netCents: n(r.net),
    discountCents: n(r.discounts),
    cancels: n(r.cancels),
  }));
}

/** Deliveries by area (phone, WhatsApp and website deliveries), and by rider. */
export async function getDeliveries(from: string, to: string): Promise<{ areas: Slice[]; riders: Slice[] }> {
  await ensureDashSchema();
  const [areas, riders] = await Promise.all([
    sql()`
      SELECT COALESCE(NULLIF(trim(area), ''), 'No area') AS key, count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
        FROM dash_orders
       WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted AND channel IN ('delivery', 'web_delivery')
       GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
    sql()`
      SELECT COALESCE(rider, CASE WHEN (doc->>'riderKeepsCents') IS NOT NULL THEN 'Outside rider' ELSE 'No rider' END) AS key,
             count(*) AS orders, COALESCE(sum(net_cents), 0) AS net
        FROM dash_orders
       WHERE trading_day BETWEEN ${from}::date AND ${to}::date AND counted AND channel IN ('delivery', 'web_delivery')
       GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
  ]);
  const map = (rows: unknown) =>
    (rows as Array<{ key: string; orders: unknown; net: unknown }>).map((r) => ({ key: r.key, orders: n(r.orders), netCents: n(r.net) }));
  return { areas: map(areas), riders: map(riders) };
}

// ---------------------------------------------------------------------------
// Food cost, waste and profit: the tills' day figures, added up
// ---------------------------------------------------------------------------

export interface FoodFigures {
  daysWithFigures: number;
  foodSalesCents: number;
  feeSalesCents: number;
  costOfSalesCents: number;
  knownSalesCents: number;
  knownCostCents: number;
  knownMenuSalesCents: number;
  estimatedOrders: number;
  estimatedCostCents: number;
  missingSalesCents: number;
  wasteCents: number;
  cancelledWasteCents: number;
  wasteByReason: Array<{ reason: string; times: number; cents: number }>;
  purchasesCents: number;
  /** null when any day had no profit figures (an older till, or it could not work them out). */
  profit: { profitCents: number; steps: Array<{ key: string; cents: number }>; unknownSalesCents: number } | null;
}

/**
 * Per day: when a till's Reports cover every till (shopWide), that one
 * till's figures ARE the day (the newest such); otherwise each till's own
 * figures are added. Then the days are added.
 */
export function addUpDays(rows: ReadonlyArray<{ day: string; shopWide: boolean; doc: DashDayFigures; workedOutAt: string }>): FoodFigures {
  const byDay = new Map<string, Array<{ shopWide: boolean; doc: DashDayFigures; workedOutAt: string }>>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  const out: FoodFigures = {
    daysWithFigures: 0,
    foodSalesCents: 0,
    feeSalesCents: 0,
    costOfSalesCents: 0,
    knownSalesCents: 0,
    knownCostCents: 0,
    knownMenuSalesCents: 0,
    estimatedOrders: 0,
    estimatedCostCents: 0,
    missingSalesCents: 0,
    wasteCents: 0,
    cancelledWasteCents: 0,
    wasteByReason: [],
    purchasesCents: 0,
    profit: { profitCents: 0, steps: [], unknownSalesCents: 0 },
  };
  const waste = new Map<string, { times: number; cents: number }>();
  const steps = new Map<string, number>();
  const stepOrder: string[] = [];
  for (const list of byDay.values()) {
    const wide = list.filter((r) => r.shopWide).sort((a, b) => b.workedOutAt.localeCompare(a.workedOutAt));
    const use = wide.length > 0 ? [wide[0]!] : list;
    out.daysWithFigures += 1;
    for (const { doc } of use) {
      const f = doc.food;
      out.foodSalesCents += f.foodSalesCents;
      out.feeSalesCents += f.feeSalesCents;
      out.costOfSalesCents += f.costOfSalesCents;
      out.knownSalesCents += f.knownSalesCents;
      out.knownCostCents += f.knownCostCents;
      out.knownMenuSalesCents += f.knownMenuSalesCents;
      out.estimatedOrders += f.estimatedOrders;
      out.estimatedCostCents += f.estimatedCostCents;
      out.missingSalesCents += f.missingSalesCents;
      out.wasteCents += f.wasteCents;
      out.cancelledWasteCents += f.cancelledWasteCents;
      for (const w of f.wasteByReason) {
        const cur = waste.get(w.reason) ?? { times: 0, cents: 0 };
        cur.times += w.times;
        cur.cents += w.cents;
        waste.set(w.reason, cur);
      }
      out.purchasesCents += doc.purchasesCents;
      if (doc.profit === null) out.profit = null;
      else if (out.profit) {
        out.profit.profitCents += doc.profit.profitCents;
        out.profit.unknownSalesCents += doc.profit.unknownSalesCents;
        for (const s of doc.profit.steps) {
          if (!steps.has(s.key)) stepOrder.push(s.key);
          steps.set(s.key, (steps.get(s.key) ?? 0) + s.cents);
        }
      }
    }
  }
  // Waste is money lost, kept positive (the till's Reports): the biggest first.
  out.wasteByReason = [...waste.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.cents - a.cents);
  if (out.profit) out.profit.steps = stepOrder.map((key) => ({ key, cents: steps.get(key) ?? 0 }));
  return out;
}

export async function getFoodFigures(from: string, to: string): Promise<FoodFigures> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, shop_wide, doc, worked_out_at
      FROM dash_days WHERE day BETWEEN ${from}::date AND ${to}::date`) as Array<{
    day: string;
    shop_wide: boolean;
    doc: DashDayFigures;
    worked_out_at: Stamp;
  }>;
  return addUpDays(rows.map((r) => ({ day: r.day, shopWide: r.shop_wide === true, doc: r.doc, workedOutAt: iso(r.worked_out_at) ?? '' })));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const ORDER_FILTERS = ['all', 'open', 'paid', 'unpaid', 'cancelled', 'refunded', 'deleted'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

export interface OrderRow {
  id: string;
  deviceId: string;
  number: string;
  status: string;
  channel: string;
  createdAt: string;
  paidAt: string | null;
  totalCents: number;
  netCents: number;
  refundedCents: number;
  counted: boolean;
  deleted: string | null;
  customerName: string | null;
  area: string | null;
  cashier: string | null;
  itemCount: number;
  /** "2× Fajita — Large, Fries" */
  summary: string;
  methods: string[];
}

export interface OrderQuery {
  from: string;
  to: string;
  filter: OrderFilter;
  channel: string | null;
  q: string | null;
  /** Older than this order (created_at, id) — the next page. */
  before: { at: string; id: string } | null;
  limit: number;
}

const ACTIVE = ['sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery'];

export async function listOrders(query: OrderQuery): Promise<OrderRow[]> {
  await ensureDashSchema();
  const q = query.q?.trim() ? query.q.trim().slice(0, 40) : null;
  // A phone is matched on its national digits: "0300 444…" finds "+92300444…".
  const digits = q ? q.replace(/\D/g, '').replace(/^(92|0)/, '') : '';
  const rows = (await sql()`
    SELECT id, device_id, number, status, channel, created_at, paid_at, total_cents, net_cents, refunded_cents,
           counted, deleted, customer_name, area, cashier, item_count,
           (SELECT string_agg(CASE WHEN (l->>'qty')::int > 1 THEN (l->>'qty') || '× ' ELSE '' END || (l->>'name'), ', ')
              FROM jsonb_array_elements(doc->'lines') l WHERE COALESCE((l->>'isFee')::boolean, false) = false) AS summary,
           (SELECT array_agg(DISTINCT p->>'method') FROM jsonb_array_elements(doc->'payments') p
             WHERE (p->>'amountCents')::bigint > 0) AS methods
      FROM dash_orders
     WHERE trading_day BETWEEN ${query.from}::date AND ${query.to}::date
       AND (${query.filter}::text = 'deleted' AND deleted = 'test'
            OR ${query.filter}::text <> 'deleted' AND deleted IS NULL AND NOT (status = 'open' AND total_cents = 0))
       AND (${query.filter}::text IN ('all', 'deleted')
            OR ${query.filter}::text = 'open' AND status = ANY(${ACTIVE}::text[])
            OR ${query.filter}::text = 'paid' AND counted
            OR ${query.filter}::text = 'unpaid' AND paid_at IS NULL AND status NOT IN ('void', 'refunded')
            OR ${query.filter}::text = 'cancelled' AND status = 'void'
            OR ${query.filter}::text = 'refunded' AND (status = 'refunded' OR refunded_cents > 0))
       AND (${query.channel}::text IS NULL OR channel = ${query.channel}::text)
       AND (${q}::text IS NULL
            OR number ILIKE '%' || ${q}::text || '%'
            OR customer_name ILIKE '%' || ${q}::text || '%'
            OR (${digits}::text <> '' AND length(${digits}::text) >= 3
                AND regexp_replace(regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g'), '^(92|0)', '') LIKE '%' || ${digits}::text || '%'))
       AND (${query.before?.at ?? null}::timestamptz IS NULL
            OR (created_at, id) < (${query.before?.at ?? null}::timestamptz, ${query.before?.id ?? ''}::text))
     ORDER BY created_at DESC, id DESC
     LIMIT ${query.limit}::int`) as Array<{
    id: string;
    device_id: string;
    number: string;
    status: string;
    channel: string;
    created_at: Stamp;
    paid_at: Stamp | null;
    total_cents: unknown;
    net_cents: unknown;
    refunded_cents: unknown;
    counted: boolean;
    deleted: string | null;
    customer_name: string | null;
    area: string | null;
    cashier: string | null;
    item_count: unknown;
    summary: string | null;
    methods: string[] | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    number: r.number,
    status: r.status,
    channel: r.channel,
    createdAt: iso(r.created_at) ?? '',
    paidAt: iso(r.paid_at),
    totalCents: n(r.total_cents),
    netCents: n(r.net_cents),
    refundedCents: n(r.refunded_cents),
    counted: r.counted === true,
    deleted: r.deleted,
    customerName: r.customer_name,
    area: r.area,
    cashier: r.cashier,
    itemCount: n(r.item_count),
    summary: r.summary ?? '',
    methods: (r.methods ?? []).filter((m): m is string => typeof m === 'string'),
  }));
}

/** Orders on the board right now (in the kitchen, ready, out), oldest first, as the tills last sent them. */
export async function listActiveOrders(limit = 30): Promise<OrderRow[]> {
  await ensureDashSchema();
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const rows = (await sql()`
    SELECT id FROM dash_orders
     WHERE deleted IS NULL AND status = ANY(${ACTIVE}::text[]) AND created_at > ${since}::timestamptz
     ORDER BY created_at LIMIT ${limit}::int`) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const all = await listOrdersByIds(rows.map((r) => r.id));
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function listOrdersByIds(ids: string[]): Promise<OrderRow[]> {
  const rows = (await sql()`SELECT doc FROM dash_orders WHERE id = ANY(${ids}::text[])`) as Array<{ doc: DashOrderDoc }>;
  return rows.map((r) => rowOfDoc(r.doc));
}

export function rowOfDoc(d: DashOrderDoc): OrderRow {
  const food = d.lines.filter((l) => !l.isFee);
  return {
    id: d.id,
    deviceId: d.deviceId,
    number: d.number,
    status: d.status,
    channel: d.channel,
    createdAt: d.createdAt,
    paidAt: d.paidAt,
    totalCents: d.totalCents,
    netCents: d.netCents,
    refundedCents: d.refundedCents,
    counted: d.counted,
    deleted: d.deleted,
    customerName: d.customer?.name ?? null,
    area: d.customer?.area ?? null,
    cashier: d.cashier,
    itemCount: food.reduce((s, l) => s + l.qty, 0),
    summary: food.map((l) => `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}`).join(', '),
    methods: [...new Set(d.payments.filter((p) => p.amountCents > 0).map((p) => p.method))],
  };
}

export async function getOrder(id: string): Promise<DashOrderDoc | null> {
  await ensureDashSchema();
  const rows = (await sql()`SELECT doc FROM dash_orders WHERE id = ${id}::text`) as Array<{ doc: DashOrderDoc }>;
  return rows[0]?.doc ?? null;
}

// ---------------------------------------------------------------------------
// Shifts and cash
// ---------------------------------------------------------------------------

export interface ShiftRow {
  id: string;
  deviceId: string;
  openedAt: string;
  closedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  openingCashCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  varianceCents: number | null;
}

export async function listShifts(from: string, to: string, limit = 100): Promise<ShiftRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, device_id, opened_at, closed_at, opened_by, closed_by, opening_cash_cents, expected_cash_cents,
           counted_cash_cents, variance_cents
      FROM dash_shifts
     WHERE opened_at >= (${from}::date::timestamp AT TIME ZONE 'UTC') AND opened_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'UTC')
        OR closed_at IS NULL
     ORDER BY opened_at DESC LIMIT ${limit}::int`) as Array<{
    id: string;
    device_id: string;
    opened_at: Stamp;
    closed_at: Stamp | null;
    opened_by: string | null;
    closed_by: string | null;
    opening_cash_cents: unknown;
    expected_cash_cents: unknown;
    counted_cash_cents: unknown;
    variance_cents: unknown;
  }>;
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    openedAt: iso(r.opened_at) ?? '',
    closedAt: iso(r.closed_at),
    openedBy: r.opened_by,
    closedBy: r.closed_by,
    openingCashCents: n(r.opening_cash_cents),
    expectedCashCents: r.expected_cash_cents === null ? null : n(r.expected_cash_cents),
    countedCashCents: r.counted_cash_cents === null ? null : n(r.counted_cash_cents),
    varianceCents: r.variance_cents === null ? null : n(r.variance_cents),
  }));
}

export async function getShift(id: string): Promise<DashShiftDoc | null> {
  await ensureDashSchema();
  const rows = (await sql()`SELECT doc FROM dash_shifts WHERE id = ${id}::text`) as Array<{ doc: DashShiftDoc }>;
  return rows[0]?.doc ?? null;
}

export interface CashMoveRow {
  id: string;
  shiftId: string;
  deviceId: string;
  type: string;
  amountCents: number;
  reason: string;
  by: string | null;
  approvedBy: string | null;
  orderId: string | null;
  purchase: boolean;
  createdAt: string;
}

export async function listCashMoves(opts: { from?: string; to?: string; shiftId?: string }): Promise<CashMoveRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, shift_id, device_id, type, amount_cents, reason, by_name, approved_by, order_id, purchase, created_at
      FROM dash_cash_moves
     WHERE NOT deleted
       AND (${opts.shiftId ?? null}::text IS NULL OR shift_id = ${opts.shiftId ?? null}::text)
       AND (${opts.from ?? null}::date IS NULL OR created_at >= (${opts.from ?? null}::date::timestamp AT TIME ZONE 'UTC'))
       AND (${opts.to ?? null}::date IS NULL OR created_at < ((${opts.to ?? null}::date + 1)::timestamp AT TIME ZONE 'UTC'))
     ORDER BY created_at DESC LIMIT 300`) as Array<{
    id: string;
    shift_id: string;
    device_id: string;
    type: string;
    amount_cents: unknown;
    reason: string;
    by_name: string | null;
    approved_by: string | null;
    order_id: string | null;
    purchase: boolean;
    created_at: Stamp;
  }>;
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    deviceId: r.device_id,
    type: r.type,
    amountCents: n(r.amount_cents),
    reason: r.reason,
    by: r.by_name,
    approvedBy: r.approved_by,
    orderId: r.order_id,
    purchase: r.purchase === true,
    createdAt: iso(r.created_at) ?? '',
  }));
}

export interface DrawerOpenRow {
  id: string;
  shiftId: string | null;
  kind: string;
  reason: string | null;
  by: string | null;
  approvedBy: string | null;
  amountCents: number | null;
  outcome: string | null;
  createdAt: string;
}

export async function listDrawerOpens(opts: { from?: string; to?: string; shiftId?: string }): Promise<DrawerOpenRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, shift_id, kind, reason, by_name, approved_by, amount_cents, outcome, created_at
      FROM dash_drawer_opens
     WHERE (${opts.shiftId ?? null}::text IS NULL OR shift_id = ${opts.shiftId ?? null}::text)
       AND (${opts.from ?? null}::date IS NULL OR created_at >= (${opts.from ?? null}::date::timestamp AT TIME ZONE 'UTC'))
       AND (${opts.to ?? null}::date IS NULL OR created_at < ((${opts.to ?? null}::date + 1)::timestamp AT TIME ZONE 'UTC'))
     ORDER BY created_at DESC LIMIT 300`) as Array<{
    id: string;
    shift_id: string | null;
    kind: string;
    reason: string | null;
    by_name: string | null;
    approved_by: string | null;
    amount_cents: unknown;
    outcome: string | null;
    created_at: Stamp;
  }>;
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    kind: r.kind,
    reason: r.reason,
    by: r.by_name,
    approvedBy: r.approved_by,
    amountCents: r.amount_cents === null ? null : n(r.amount_cents),
    outcome: r.outcome,
    createdAt: iso(r.created_at) ?? '',
  }));
}

/** A shift's orders: those it took money for (payments.shift_id), newest first. */
export async function listShiftOrders(shiftId: string): Promise<OrderRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT doc FROM dash_orders o
     WHERE o.deleted IS NULL
       AND (o.shift_id = ${shiftId}::text
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(o.doc->'payments') p WHERE p->>'shiftId' = ${shiftId}::text))
     ORDER BY o.created_at DESC LIMIT 400`) as Array<{ doc: DashOrderDoc }>;
  return rows.map((r) => rowOfDoc(r.doc)).filter((r) => !(r.status === 'open' && r.totalCents === 0));
}

// ---------------------------------------------------------------------------
// Stock and the menu (per till)
// ---------------------------------------------------------------------------

export interface StockRow {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  onHand: number;
  lowAt: number | null;
  pricePerThousandCents: number | null;
  priceKind: string | null;
  keyItem: boolean;
  batch: boolean;
  active: boolean;
  updatedAt: string;
}

export async function getStock(deviceId: string): Promise<StockRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, name, unit, category, on_hand, low_at, price_per_thousand_cents, price_kind, key_item, batch, active, updated_at
      FROM dash_stock WHERE device_id = ${deviceId}::text ORDER BY lower(name)`) as Array<{
    id: string;
    name: string;
    unit: string;
    category: string | null;
    on_hand: unknown;
    low_at: unknown;
    price_per_thousand_cents: unknown;
    price_kind: string | null;
    key_item: boolean;
    batch: boolean;
    active: boolean;
    updated_at: Stamp;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    category: r.category,
    onHand: n(r.on_hand),
    lowAt: r.low_at === null ? null : n(r.low_at),
    pricePerThousandCents: r.price_per_thousand_cents === null ? null : n(r.price_per_thousand_cents),
    priceKind: r.price_kind,
    keyItem: r.key_item === true,
    batch: r.batch === true,
    active: r.active === true,
    updatedAt: iso(r.updated_at) ?? '',
  }));
}

export interface StockMoveRow {
  id: string;
  ingredient: string;
  delta: number;
  unit: string;
  reason: string;
  detail: string | null;
  valueCents: number | null;
  note: string | null;
  by: string | null;
  at: string;
  orderId: string | null;
}

export async function listStockMoves(opts: { deviceId: string; from: string; to: string; reasons: string[] }): Promise<StockMoveRow[]> {
  await ensureDashSchema();
  const rows = (await sql()`
    SELECT id, ingredient, delta, unit, reason, detail, value_cents, note, by_name, at, order_id
      FROM dash_stock_moves
     WHERE device_id = ${opts.deviceId}::text AND NOT deleted
       AND at >= (${opts.from}::date::timestamp AT TIME ZONE 'UTC') AND at < ((${opts.to}::date + 1)::timestamp AT TIME ZONE 'UTC')
       AND reason = ANY(${opts.reasons}::text[])
     ORDER BY at DESC LIMIT 300`) as Array<{
    id: string;
    ingredient: string;
    delta: unknown;
    unit: string;
    reason: string;
    detail: string | null;
    value_cents: unknown;
    note: string | null;
    by_name: string | null;
    at: Stamp;
    order_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ingredient: r.ingredient,
    delta: n(r.delta),
    unit: r.unit,
    reason: r.reason,
    detail: r.detail,
    valueCents: r.value_cents === null ? null : n(r.value_cents),
    note: r.note,
    by: r.by_name,
    at: iso(r.at) ?? '',
    orderId: r.order_id,
  }));
}

export async function getMenu(deviceId: string): Promise<{ menu: DashMenu; receivedAt: string } | null> {
  await ensureDashSchema();
  const rows = (await sql()`SELECT doc, received_at FROM dash_menu WHERE device_id = ${deviceId}::text`) as Array<{
    doc: DashMenu;
    received_at: Stamp;
  }>;
  const r = rows[0];
  return r ? { menu: r.doc, receivedAt: iso(r.received_at) ?? '' } : null;
}

/** The tills that have sent stock / a menu, newest first (a page shows the first unless asked). */
export async function tillsWith(kind: 'stock' | 'menu'): Promise<string[]> {
  await ensureDashSchema();
  const rows = (
    kind === 'stock'
      ? await sql()`SELECT device_id, max(updated_at) AS at FROM dash_stock GROUP BY device_id ORDER BY 2 DESC`
      : await sql()`SELECT device_id, received_at AS at FROM dash_menu ORDER BY 2 DESC`
  ) as Array<{ device_id: string }>;
  return rows.map((r) => r.device_id);
}
