/**
 * Profit (costing spec 4.4 and 4.7, Phase 9, profit.view): what the shop
 * keeps, worked out in the Reports worker thread for the orders on THIS till.
 *
 * ONE pass over a period's counted orders (readSales) feeds everything:
 *  - food sales and their cost per order type and delivery area — the same
 *    rules as Reports → Food cost & stock (pos-domain orderFoodCost /
 *    tallyPlainOrders), so the Profit tab's food cost is that tab's: the cost
 *    each sale kept, orders with none estimated from the stock they took;
 *  - each item's sales and, over the lines whose cost is FULLY known, what
 *    they cost (item and category profit start the day costing started);
 * and one read of the orders themselves (readOrders) for what the lines
 * don't say: foodpanda's commission and price uplift, payment fees, and the
 * rider (the zone's rate, else the delivery charge at menu price).
 *
 * foodpanda's money per order is pos-domain foodpandaOrderMoney — THE rule
 * Reports → Channels' foodpanda block uses too (business-report
 * getFoodpanda): the prices kept at payment; the commission, fees and tax
 * kept then when the commission was confirmed, else Settings → foodpanda's
 * fees now (the one reader, readShopSetting); less part refunds, as the
 * sales here are. So the Profit tab's "foodpanda commission and fees"
 * (commission + tax on it + the fee per order + its % of the total) and
 * uplift are the Channels block's, to the paisa. foodpanda's part of the
 * deal is neither added nor taken off: sales are the stored subtotal −
 * discount (the shop's part only), which already holds it.
 *
 * Speed, as Food cost & stock (costing spec §6): orders with nothing to share
 * out (no discount, no part refund) that kept their cost are added up in SQL,
 * a line's cost rows folded into one number by an indexed look-up
 * (idx_order_item_costs_line_part); only the others are read line by line,
 * each with its discount and part refunds shared out (pos-domain
 * splitOrderLines — the one allocation the till has; a delivery charge the
 * discount's FROZEN rule left alone takes none of it, from the rule on the
 * discount row and the name the line was sold under, never the live setting).
 *
 * The waterfall: sales before tax − food cost of the sales whose cost is
 * known − the sales whose cost is NOT known (set aside, never costed at Rs 0)
 * − waste − food sent out unpaid − stock that went unexplained (only between
 * two full stock takes) − foodpanda commission + its price uplift − payment
 * fees − rider = profit before overheads. An order whose food cost is only
 * partly known keeps its commission, rider, charges and fees in the share
 * its known food is of its food (setAside): the rest goes into the
 * unknown-cost bar with that food, so neither the waterfall nor what each
 * order type or area earns charges the unknown part's costs to the rest.
 *
 * Read-only; never loads Electron (the worker loads it).
 */
import {
  DEFAULT_CHANNEL_FEES,
  DEFAULT_RIDER_COST,
  type BusinessReportRequest,
  type FoodpandaFees,
  type PaymentFees,
  type ProfitFees,
  type ReportCategoryProfit,
  type ReportChannel,
  type ReportChannelProfit,
  type ReportDeliveryException,
  type ReportLineCost,
  type ReportMenuCosts,
  type ReportPaymentGroup,
  type ReportProfitStockLoss,
  type ReportTabFigures,
  type RiderCostSetting,
  type TillLinkState,
} from '@cheeseoclock/shared-types';
import {
  addOrderFoodCost,
  contributionCents,
  emptyFoodCostTally,
  foodpandaOrderMoney,
  isNoRateDelivery,
  knownOrderShare,
  knownShareCents,
  mulDivRound,
  orderFoodCost,
  orderKeptCost,
  paymentFeeCents,
  perKnownOrderCents,
  profitWaterfall,
  riderCost,
  WHOLE_ORDER,
  shareBps,
  storedDiscountSkips,
  tallyPlainOrders,
  type FoodCostLine,
  type FoodCostOrder,
  type FoodCostTally,
  type TaxedDiscountLine,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getBusinessSetting, readShopSetting } from '../../db/business-settings-read.js';
import {
  DISCOUNT_RULE,
  FEE_LINE,
  KEPT_TERMS_COLUMNS,
  PLAIN_KEPT,
  REPORT_LIST_CAP,
  costingStartedAt,
  estimateOrders,
  getWasteAndUnpaid,
  keptTermsOf,
  lazyPricing,
  menuLookup,
  type MenuLookup,
  type Pricing,
  type ReportRange,
} from '../business-report.js';
import { COUNTED, IN_RANGE, REFUNDED, channelOf, paymentGroup } from './sql.js';
import { areaOf, deliveryAreas, repeatCustomers, useReportZones } from './delivery-areas.js';
import { buildVariance } from './stock-control.js';

const LINK_OFF: TillLinkState = { on: false, stale: false, lastHeardAt: null };

// ---------------------------------------------------------------- settings --

export interface ProfitSettings {
  /**
   * The card and wallet fees ('channels.fees'; its retired foodpanda part is
   * never used here). The "Foodpanda" one is always 0 here: foodpanda's fee
   * on its orders is Settings → foodpanda's (paymentFeeBps), inside what
   * foodpanda keeps — never charged twice.
   */
  fees: PaymentFees;
  riderCost: RiderCostSetting;
  /** foodpanda's terms in force now: Settings → foodpanda, through the one reader. */
  foodpanda: FoodpandaFees;
  /** Neither the card fees nor the rider cost saved yet: the defaults (no fees, the zone's rate for a rider). */
  isDefault: boolean;
  savedAt: string | null;
}

/** Payment fees, the rider cost and foodpanda's terms in force (business settings, or the defaults). */
export function loadProfitSettings(db: AppDatabase): ProfitSettings {
  const fees = getBusinessSetting(db, 'channels.fees');
  const rider = getBusinessSetting(db, 'delivery.riderCost');
  const saved = [fees?.updatedAt, rider?.updatedAt].filter((x): x is string => typeof x === 'string').sort();
  return {
    fees: { paymentFeeBps: { ...(fees?.value ?? DEFAULT_CHANNEL_FEES).paymentFeeBps, foodpanda: 0 } },
    riderCost: rider?.value ?? DEFAULT_RIDER_COST,
    foodpanda: readShopSetting(db, 'foodpanda.fees').value,
    isDefault: fees === null && rider === null,
    savedAt: saved[saved.length - 1] ?? null,
  };
}

/** The fees a report was worked with, for the notes under it. */
export function profitFees(settings: ProfitSettings): ProfitFees {
  return { paymentFeeBps: settings.fees.paymentFeeBps, foodpanda: settings.foodpanda };
}

// ------------------------------------------------------------------ the pass --

/** The area on a delivery's address (JSON; json_valid guards rows written before it was JSON). Alias `o`. */
const AREA = `CASE WHEN o.mode = 'delivery' AND json_valid(o.delivery_address_snapshot)
                   THEN CAST(json_extract(o.delivery_address_snapshot, '$.area') AS TEXT) END`;

/**
 * The plain orders' lines (no discount, no part refund, cost kept: a line's
 * net is its menu price), one row each — added up in JS: summing them in
 * SQL sorts every line of the period, which costs more than reading them.
 * Each order's type and delivery area come as ONE key (mode, source and
 * area joined by char(1)), worked out once per order; a line's cost rows are
 * folded into ONE number by an indexed look-up (idx_order_item_costs_line_part):
 * Σ cost × 8 + the worst status (0 full, 1 no recipe, 2 partial, 3 failed;
 * 7 no row). The sold name only for a line with no menu item. The order's
 * rowid (a number: cheaper to read than its id) says which lines are one
 * order's, for the orders whose food cost is only partly known. Params:
 * since, until, fee items (JSON).
 */
export const PROFIT_PLAIN_SQL = `
  WITH po AS MATERIALIZED (
         SELECT o.rowid AS oid, o.id AS id, o.mode || char(1) || o.source || char(1) || COALESCE(${AREA}, '') AS grp
           FROM orders o WHERE ${IN_RANGE} AND ${COUNTED} AND ${PLAIN_KEPT})
  SELECT po.oid AS oid, po.grp AS grp, oi.menu_item_id AS itemId,
         CASE WHEN oi.menu_item_id IS NULL THEN oi.menu_item_name END AS soldName,
         ${FEE_LINE} AS isFee, oi.quantity AS qty, oi.line_total_cents AS lineTotal,
         (SELECT COALESCE(SUM(c.cost_cents), 0) * 8
                 + COALESCE(MAX(CASE c.status WHEN 'failed' THEN 3 WHEN 'partial' THEN 2 WHEN 'none' THEN 1 WHEN 'full' THEN 0 END), 7)
            FROM order_item_costs c
           WHERE c.order_item_id = oi.id AND c.deleted_at IS NULL) AS packed
    FROM po CROSS JOIN order_items oi
   WHERE oi.order_id = po.id AND oi.deleted_at IS NULL`;

/**
 * The other counted orders (a discount or part refund to share out, or no
 * cost kept), line by line, each line's cost rows folded into one number as
 * the plain orders' are. Neither grouped nor sorted in SQL: with every order
 * estimated (a year from before costing started) that sort was a fifth of
 * the tab. readSales puts each order's lines in the order the till lists
 * them ((created_at, id), as recomputeOrderTotals shares the discount).
 * Params: since, until, fee items (JSON).
 */
export const PROFIT_REST_SQL = `
  WITH ro AS MATERIALIZED (
         SELECT o.rowid AS oid, o.id AS id, o.discount_cents AS disc, o.tax_cents AS tax, o.total_cents AS tot, ${REFUNDED} AS ref,
                o.mode AS mode, o.source AS source, ${AREA} AS area, ${DISCOUNT_RULE} AS drule
           FROM orders o WHERE ${IN_RANGE} AND ${COUNTED} AND NOT ${PLAIN_KEPT})
  SELECT ro.oid AS oid, ro.id AS orderId, ro.disc AS disc, ro.tax AS tax, ro.tot AS tot, ro.ref AS ref, ro.mode AS mode, ro.source AS source, ro.area AS area,
         ro.drule AS drule,
         oi.id AS lineId, oi.created_at AS at,
         oi.menu_item_id AS itemId, oi.menu_item_name AS soldName, oi.quantity AS qty, oi.line_total_cents AS lineTotal,
         oi.tax_rate_bps_snapshot AS rate,
         ${FEE_LINE} AS isFee,
         (SELECT COALESCE(SUM(c.cost_cents), 0) * 8
                 + COALESCE(MAX(CASE c.status WHEN 'failed' THEN 3 WHEN 'partial' THEN 2 WHEN 'none' THEN 1 WHEN 'full' THEN 0 END), 7)
            FROM order_item_costs c
           WHERE c.order_item_id = oi.id AND c.deleted_at IS NULL) AS packed
    FROM ro CROSS JOIN order_items oi
   WHERE oi.order_id = ro.id AND oi.deleted_at IS NULL`;

/** Food and fee sales, and their cost, of one order type in one delivery area. */
export interface SalesGroup {
  mode: string;
  source: string;
  /** The area on a delivery's address as typed; null for anything else. */
  area: string | null;
  tally: FoodCostTally;
}

/** One item's sales in the period, and the part whose cost is fully known. */
export interface ItemSales {
  key: string;
  itemId: string | null;
  name: string;
  /** A delivery charge or an item of a category marked "not food". */
  isFee: boolean;
  units: number;
  /** Before tax, after discounts and part refunds. */
  salesCents: number;
  knownUnits: number;
  knownSalesCents: number;
  /** The same known lines at menu price (the menu map's basis). */
  knownMenuSalesCents: number;
  costCents: number;
}

/**
 * An order whose food cost is only partly known (costing spec 4.7): its
 * food, the part of it whose cost is known, and its delivery charges, so
 * what goes with the unknown part (its share of the charges, rider,
 * commission and fees) is set aside with it (setAside).
 */
export interface PartlyKnownOrder {
  mode: string;
  source: string;
  area: string | null;
  foodCents: number;
  knownFoodCents: number;
  feeCents: number;
}

export interface SalesPass {
  groups: Map<string, SalesGroup>;
  items: Map<string, ItemSales>;
  /** By the order's rowid: the counted orders with food whose cost is not (all) known. */
  partlyKnown: Map<number, PartlyKnownOrder>;
  menu: MenuLookup;
  pricing: () => Pricing;
}

const STATUS_OF_RANK: Record<number, FoodCostLine['status']> = { 0: 'full', 1: 'none', 2: 'partial', 3: 'failed', 7: null };

/** A line's cost rows as the SQL folds them (Σ cost × 8 + the worst status): whether it has any, their cost, the worst status. */
function unpack(packed: number): { parts: number; cost: number; status: FoodCostLine['status'] } {
  const worst = packed % 8;
  return { parts: worst === 7 ? 0 : 1, cost: (packed - worst) / 8, status: worst === 7 ? null : (STATUS_OF_RANK[worst] ?? 'failed') };
}

function groupKey(mode: string, source: string, area: string | null): string {
  return `${mode}\u0001${source}\u0001${area ?? ''}`;
}

/**
 * The period's counted orders, added up per order type and delivery area and
 * per item (see the file comment). `estimates`: estimate the orders that
 * kept no cost from the stock they took (the Profit tab's and the channels'
 * food cost); off, those orders' lines are simply not known (items).
 */
export function readSales(db: AppDatabase, range: ReportRange, opts: { estimates: boolean; pricing?: () => Pricing; menu?: MenuLookup }): SalesPass {
  const menu = opts.menu ?? menuLookup(db);
  const pricing = opts.pricing ?? lazyPricing(db);
  const groups = new Map<string, SalesGroup>();
  const items = new Map<string, ItemSales>();
  const group = (mode: string, source: string, area: string | null): SalesGroup => {
    const k = groupKey(mode, source, area || null);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { mode, source, area: area || null, tally: emptyFoodCostTally() }));
    return g;
  };
  const item = (itemId: string | null, soldName: string, isFee: boolean): ItemSales => {
    const key = itemId ?? `name:${soldName}`;
    let it = items.get(key);
    if (!it) {
      items.set(
        key,
        (it = {
          key,
          itemId,
          name: menu.item(itemId)?.name ?? (soldName || 'An item no longer on the menu'),
          isFee,
          units: 0,
          salesCents: 0,
          knownUnits: 0,
          knownSalesCents: 0,
          knownMenuSalesCents: 0,
          costCents: 0,
        }),
      );
    }
    if (isFee) it.isFee = true;
    return it;
  };

  // The counted orders with food whose cost is not (all) known, by rowid, found while their lines are read.
  const partlyKnown = new Map<number, PartlyKnownOrder>();

  // 1. The plain orders: their lines added up per order type and area, item, fee or not and how fully costed…
  const plainOrders = new Map<number, { grp: string; food: number; known: number; fee: number }>();
  interface Sum {
    grp: string;
    itemId: string | null;
    soldName: string;
    isFee: boolean;
    worst: number;
    lines: number;
    qty: number;
    sales: number;
    cost: number;
  }
  const sums = new Map<string, Sum>();
  for (const r of db.prepare(PROFIT_PLAIN_SQL).all(range.sinceIso, range.untilIso, menu.feeItemsJson) as Array<{
    oid: number;
    grp: string;
    itemId: string | null;
    soldName: string | null;
    isFee: number;
    qty: number;
    lineTotal: number;
    packed: number;
  }>) {
    const packed = Number(r.packed);
    const worst = packed % 8;
    const isFee = Number(r.isFee) === 1;
    const oid = Number(r.oid);
    let po = plainOrders.get(oid);
    if (!po) plainOrders.set(oid, (po = { grp: r.grp, food: 0, known: 0, fee: 0 }));
    if (isFee) po.fee += Number(r.lineTotal);
    else {
      po.food += Number(r.lineTotal);
      if (worst === 0) po.known += Number(r.lineTotal);
    }
    const itemKey = r.itemId ?? `name:${r.soldName ?? ''}`;
    const k = `${r.grp}\u0002${itemKey}\u0002${isFee ? 1 : 0}${worst}`;
    const sum = sums.get(k);
    if (sum) {
      sum.lines += 1;
      sum.qty += Number(r.qty);
      sum.sales += Number(r.lineTotal);
      sum.cost += (packed - worst) / 8;
    } else {
      sums.set(k, {
        grp: r.grp,
        itemId: r.itemId,
        soldName: r.soldName ?? '',
        isFee,
        worst,
        lines: 1,
        qty: Number(r.qty),
        sales: Number(r.lineTotal),
        cost: (packed - worst) / 8,
      });
    }
  }
  // …then each sum into its group's food cost (pos-domain tallyPlainOrders, as Food cost & stock) and its item.
  const grpParts = new Map<string, [string, string, string | null]>();
  const partsOf = (grp: string): [string, string, string | null] => {
    let parts = grpParts.get(grp);
    if (!parts) {
      const [mode = '', source = '', area = ''] = grp.split('\u0001');
      grpParts.set(grp, (parts = [mode, source, area === '' ? null : area]));
    }
    return parts;
  };
  for (const [oid, po] of plainOrders) {
    if (po.food <= 0 || po.known >= po.food) continue;
    const [mode, source, area] = partsOf(po.grp);
    partlyKnown.set(oid, { mode, source, area, foodCents: po.food, knownFoodCents: po.known, feeCents: po.fee });
  }
  for (const r of sums.values()) {
    const parts = partsOf(r.grp);
    const { isFee, worst, qty, sales, cost } = r;
    const it = item(r.itemId, r.soldName, isFee);
    const status = STATUS_OF_RANK[worst] ?? 'failed';
    tallyPlainOrders(group(parts[0], parts[1], parts[2]).tally, {
      lineCount: Number(r.lines),
      foodSalesCents: isFee ? 0 : sales,
      feeSalesCents: isFee ? sales : 0,
      foodCostCents: isFee ? 0 : cost,
      notFull:
        isFee || status === 'full'
          ? []
          : [
              {
                key: it.key,
                name: it.name,
                quantity: qty,
                lineTotalCents: sales,
                isFee: false,
                parts: worst === 7 ? 0 : 1,
                costCents: cost,
                status,
                hasRecipeNow: r.itemId !== null && menu.withRecipe.has(r.itemId),
              },
            ],
    });
    it.units += qty;
    it.salesCents += sales;
    if (!isFee && status === 'full') {
      it.knownUnits += qty;
      it.knownSalesCents += sales;
      it.knownMenuSalesCents += sales;
      it.costCents += cost;
    }
  }

  // 2. The rest, line by line: each order's lines gathered, then put in the order the till lists them.
  const rows = db.prepare(PROFIT_REST_SQL).all(range.sinceIso, range.untilIso, menu.feeItemsJson) as Array<{
    oid: number;
    orderId: string;
    disc: number;
    tax: number;
    tot: number;
    ref: number;
    mode: string;
    source: string;
    area: string | null;
    drule: string | null;
    lineId: string;
    at: string;
    itemId: string | null;
    soldName: string;
    qty: number;
    lineTotal: number;
    rate: number;
    isFee: number;
    packed: number;
  }>;
  interface RestLine {
    at: string;
    id: string;
    itemId: string | null;
    line: FoodCostLine;
    /** As the discount maths sees it: what it came to, the name it was SOLD under, its tax rate. */
    sold: TaxedDiscountLine;
  }
  interface RestOrder {
    oid: number;
    id: string;
    mode: string;
    source: string;
    area: string | null;
    /** The rule frozen on the order's discount row (null: none — it came off every line, as before 0.7.26). */
    drule: string | null;
    /** The stored tax, to read the rule against the stored bill. */
    tax: number;
    order: FoodCostOrder;
    lines: RestLine[];
  }
  const byOrder = new Map<number, RestOrder>();
  for (const r of rows) {
    const oid = Number(r.oid);
    let o = byOrder.get(oid);
    if (!o) {
      o = {
        oid,
        id: r.orderId,
        mode: r.mode,
        source: r.source,
        area: r.area,
        drule: r.drule,
        tax: Number(r.tax),
        order: { discountCents: Number(r.disc), totalCents: Number(r.tot), refundedCents: Number(r.ref), lines: [], estimate: null },
        lines: [],
      };
      byOrder.set(oid, o);
    }
    const c = unpack(Number(r.packed));
    o.lines.push({
      at: r.at,
      id: r.lineId,
      itemId: r.itemId,
      line: {
        key: r.itemId ?? `name:${r.soldName}`,
        name: menu.item(r.itemId)?.name ?? r.soldName,
        quantity: Number(r.qty),
        lineTotalCents: Number(r.lineTotal),
        isFee: Number(r.isFee) === 1,
        parts: c.parts,
        costCents: c.cost,
        status: c.status,
        hasRecipeNow: r.itemId !== null && menu.withRecipe.has(r.itemId),
      },
      sold: { lineTotalCents: Number(r.lineTotal), menuItemName: r.soldName, taxRateBps: Number(r.rate) },
    });
  }
  const orders = [...byOrder.values()];
  const tillOrder = (a: RestLine, b: RestLine) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const o of orders) {
    if (o.lines.length > 1) o.lines.sort(tillOrder);
    o.order.lines = o.lines.map((l) => l.line);
    // The lines that took none of the discount: a delivery charge its frozen
    // rule left alone, by the name it was SOLD under (never the live menu or
    // "not food" categories), read against the stored bill.
    if (o.order.discountCents > 0) {
      const skips = storedDiscountSkips(o.drule, o.lines.map((l) => l.sold), o.order.discountCents, o.tax);
      o.lines.forEach((l, i) => {
        if (skips[i]) l.line.skipsDiscount = true;
      });
    }
  }
  const estimates = opts.estimates
    ? estimateOrders(
        db,
        orders.filter((o) => !orderKeptCost(o.order.lines)).map((o) => o.id),
        pricing,
      )
    : new Map();
  for (const o of orders) {
    o.order.estimate = estimates.get(o.id) ?? null;
    const r = orderFoodCost(o.order);
    addOrderFoodCost(group(o.mode, o.source, o.area).tally, o.order, r);
    if (r.foodSalesCents > 0 && r.knownSalesCents < r.foodSalesCents) {
      partlyKnown.set(o.oid, {
        mode: o.mode,
        source: o.source,
        area: o.area || null,
        foodCents: r.foodSalesCents,
        knownFoodCents: r.knownSalesCents,
        feeCents: r.feeSalesCents,
      });
    }
    const kept = orderKeptCost(o.order.lines);
    o.order.lines.forEach((l, i) => {
      const it = item(o.lines[i]?.itemId ?? null, l.name, l.isFee);
      const net = r.nets[i] ?? 0;
      it.units += l.quantity;
      it.salesCents += net;
      // Per item only what the sale itself kept: an estimate is the whole order's, never split.
      if (kept && !l.isFee && l.status === 'full') {
        it.knownUnits += l.quantity;
        it.knownSalesCents += net;
        it.knownMenuSalesCents += l.lineTotalCents;
        it.costCents += l.costCents;
      }
    });
  }
  return { groups, items, partlyKnown, menu, pricing };
}

// ---------------------------------------------------------------- the orders --

/**
 * The period's own-rider deliveries and foodpanda orders, one row each (by
 * the orders' date index) — the only orders with a commission or a rider:
 * their stored money, for a delivery the area and the delivery-charge lines
 * at menu price, for a foodpanda order the terms it kept at payment
 * (order_channel_terms: one live row per order at most). Params:
 * delivery-charge items (JSON), since, until.
 */
export const PROFIT_ORDERS_SQL = `
  SELECT o.rowid AS oid, o.id AS id, o.order_number AS number, o.created_at AS createdAt, o.mode AS mode, o.source AS source,
         o.subtotal_cents AS sub, o.discount_cents AS disc, o.total_cents AS tot, ${REFUNDED} AS ref,
         ${KEPT_TERMS_COLUMNS},
         ${AREA} AS area,
         CASE WHEN o.mode = 'delivery' THEN
           (SELECT SUM(x.line_total_cents) FROM order_items x
             WHERE x.order_id = o.id AND x.deleted_at IS NULL
               AND (TRIM(x.menu_item_name) LIKE 'delivery charge%' OR x.menu_item_id IN (SELECT value FROM json_each(?))))
         END AS charge,
         CASE WHEN o.mode = 'delivery' AND o.dispatched_at IS NOT NULL AND o.delivered_at >= o.dispatched_at
              THEN (julianday(o.delivered_at) - julianday(o.dispatched_at)) * 1440.0 END AS minutesOut
    FROM orders o
    LEFT JOIN order_channel_terms t ON o.mode = 'foodpanda' AND t.order_id = o.id AND t.deleted_at IS NULL
   WHERE ${IN_RANGE} AND ${COUNTED} AND o.mode IN ('delivery', 'foodpanda')`;

/** How many counted orders of each type. Params: since, until. */
export const PROFIT_ORDER_COUNTS_SQL = `
  SELECT o.mode AS mode, o.source AS source, COUNT(*) AS n
    FROM orders o
   WHERE ${IN_RANGE} AND ${COUNTED}
   GROUP BY o.mode, o.source`;

/** Money by way of paying on the counted orders (read only when a payment fee is set). Params: since, until. */
export const PROFIT_PAYMENTS_SQL = `
  SELECT o.rowid AS oid, o.mode AS mode, o.source AS source, p.method AS method, SUM(p.amount_cents) AS cents
    FROM orders o
    JOIN payments p ON p.order_id = o.id AND p.deleted_at IS NULL
   WHERE ${IN_RANGE} AND ${COUNTED}
   GROUP BY p.order_id, p.method`;

/** A delivery or foodpanda order with what the lines don't say: its commission, uplift, payment fees and rider. */
export interface OrderCosts {
  /** The order's rowid (SalesPass.partlyKnown's key). */
  oid: number;
  id: string;
  number: string;
  createdAt: string;
  channel: ReportChannel;
  /** Tax included, less part refunds (the rest of Reports' "sales"). */
  netSalesCents: number;
  delivery: boolean;
  /** The area as typed (deliveries). */
  area: string | null;
  areaKey: string | null;
  minutesOut: number | null;
  /** foodpanda: what it keeps (commission + fee + tax on the commission), pos-domain foodpandaOrderMoney. */
  commissionCents: number;
  upliftCents: number;
  paymentFeeCents: number;
  riderCents: number;
  noRate: boolean;
}

/** Every order type's counted orders and what taking their money cost. */
export type ChannelCounts = Map<ReportChannel, { orderCount: number; paymentFeeCents: number }>;

export interface OrderCostsRead {
  /** The deliveries and foodpanda orders. */
  orders: OrderCosts[];
  /** Every order type's orders and payment fees. */
  byChannel: ChannelCounts;
  /** Each order's payment fees, by its rowid (none read while no fee is set). */
  paymentFeeOf: Map<number, number>;
}

export function readOrderCosts(db: AppDatabase, range: ReportRange, menu: MenuLookup, settings: ProfitSettings): OrderCostsRead {
  // The owner's areas as this worker reads them now (a renamed area's old name still counts as it).
  useReportZones(db);
  const fp = settings.foodpanda;
  const byChannel: ChannelCounts = new Map();
  const channel = (c: ReportChannel) => {
    let x = byChannel.get(c);
    if (!x) byChannel.set(c, (x = { orderCount: 0, paymentFeeCents: 0 }));
    return x;
  };
  for (const r of db.prepare(PROFIT_ORDER_COUNTS_SQL).all(range.sinceIso, range.untilIso) as Array<{ mode: string; source: string; n: number }>) {
    channel(channelOf(r.mode, r.source)).orderCount += Number(r.n);
  }
  // Payment fees (none by default: not read then), per order — rounded per order and way of paying.
  const feeOf = new Map<number, number>();
  if (Object.values(settings.fees.paymentFeeBps).some((b) => b > 0)) {
    const paid = new Map<number, { channel: ReportChannel; byGroup: Partial<Record<ReportPaymentGroup, number>> }>();
    for (const p of db.prepare(PROFIT_PAYMENTS_SQL).all(range.sinceIso, range.untilIso) as Array<{
      oid: number;
      mode: string;
      source: string;
      method: string;
      cents: number;
    }>) {
      const oid = Number(p.oid);
      const o = paid.get(oid) ?? { channel: channelOf(p.mode, p.source), byGroup: {} };
      const g = paymentGroup(p.method);
      o.byGroup[g] = (o.byGroup[g] ?? 0) + Number(p.cents);
      paid.set(oid, o);
    }
    for (const [id, o] of paid) {
      const fee = paymentFeeCents(o.byGroup, settings.fees.paymentFeeBps);
      feeOf.set(id, fee);
      channel(o.channel).paymentFeeCents += fee;
    }
  }
  const out: OrderCosts[] = [];
  for (const r of db.prepare(PROFIT_ORDERS_SQL).all(menu.chargeItemsJson, range.sinceIso, range.untilIso) as Array<{
    oid: number;
    id: string;
    number: string;
    createdAt: string;
    mode: string;
    source: string;
    sub: number;
    disc: number;
    tot: number;
    ref: number;
    termsId: string | null;
    confirmed: number | null;
    commission: number | null;
    fee: number | null;
    commissionTax: number | null;
    paymentFee: number | null;
    upliftBps: number | null;
    payout: number | null;
    area: string | null;
    charge: number | null;
    minutesOut: number | null;
  }>) {
    const money = { subtotalCents: Number(r.sub), discountCents: Number(r.disc), totalCents: Number(r.tot), refundedCents: Number(r.ref) };
    const foodpanda = r.mode === 'foodpanda';
    // The one per-order rule (the Channels tab's foodpanda block uses it too).
    const fpMoney = foodpanda ? foodpandaOrderMoney(money, keptTermsOf(r), fp) : null;
    const delivery = r.mode === 'delivery';
    const where = delivery ? areaOf(r.area) : null;
    const rider = { delivery, zoneFeeCents: where?.zoneFeeCents ?? null, chargeCents: r.charge === null ? null : Number(r.charge) };
    out.push({
      oid: Number(r.oid),
      id: r.id,
      number: r.number,
      createdAt: r.createdAt,
      channel: channelOf(r.mode, r.source),
      netSalesCents: money.totalCents - money.refundedCents,
      delivery,
      area: r.area,
      areaKey: where?.key ?? null,
      minutesOut: r.minutesOut === null ? null : Number(r.minutesOut),
      commissionCents: fpMoney?.foodpandaKeepsCents ?? 0,
      upliftCents: fpMoney?.upliftCents ?? 0,
      paymentFeeCents: feeOf.get(Number(r.oid)) ?? 0,
      riderCents: riderCost(settings.riderCost, rider).cents,
      noRate: isNoRateDelivery(rider),
    });
  }
  return { orders: out, byChannel, paymentFeeOf: feeOf };
}

// ------------------------------------------------ partly costed orders --

/** What goes with food of unknown cost (costing spec 4.7), for one channel or one delivery area. */
export interface SetAside {
  /**
   * Of the orders whose food cost is only partly known: the share of their
   * delivery charges less rider, commission and payment fees (plus uplift)
   * that goes with that food — set aside with it (signed).
   */
  cents: number;
  /** How many orders' worth is set aside with it, in thousandths (WHOLE_ORDER an order). */
  orderThousandths: number;
}

export interface SetAsides {
  byChannel: Map<ReportChannel, SetAside>;
  /** By delivery area key (areaOf), own-rider deliveries only. */
  byArea: Map<string, SetAside>;
  /** Every order's: what the waterfall's unknown-cost bar sets aside besides the food itself. */
  totalCents: number;
}

/**
 * Unknown costs are never guessed (costing spec 4.7), and neither is what
 * goes with them charged to the rest: an order whose food cost is only
 * partly known keeps, of its delivery charges, rider, commission, uplift
 * and payment fees, the share its known food is of its food
 * (knownShareCents); the rest is set aside with the food of unknown cost.
 * So "what each order type earns" and "per order" compare foodpanda and own
 * delivery on the same footing whatever share of either is costed.
 */
export function setAside(pass: Pick<SalesPass, 'partlyKnown'>, read: OrderCostsRead): SetAsides {
  const byChannel = new Map<ReportChannel, SetAside>();
  const byArea = new Map<string, SetAside>();
  let totalCents = 0;
  if (pass.partlyKnown.size === 0) return { byChannel, byArea, totalCents };
  const costsOf = new Map(read.orders.map((o) => [o.oid, o]));
  const add = <K,>(m: Map<K, SetAside>, k: K, cents: number, thousandths: number) => {
    const x = m.get(k) ?? { cents: 0, orderThousandths: 0 };
    x.cents += cents;
    x.orderThousandths += thousandths;
    m.set(k, x);
  };
  for (const [oid, p] of pass.partlyKnown) {
    const c = costsOf.get(oid);
    const other = p.feeCents - (c?.riderCents ?? 0) - (c?.commissionCents ?? 0) + (c?.upliftCents ?? 0) - (read.paymentFeeOf.get(oid) ?? 0);
    const cents = other - knownShareCents(other, p.knownFoodCents, p.foodCents);
    const thousandths = WHOLE_ORDER - knownOrderShare(p.knownFoodCents, p.foodCents);
    totalCents += cents;
    add(byChannel, channelOf(p.mode, p.source), cents, thousandths);
    if (p.mode === 'delivery') add(byArea, areaOf(p.area).key, cents, thousandths);
  }
  return { byChannel, byArea, totalCents };
}

/** Deliveries with no area and no delivery charge, newest first, capped (the total is the count). */
export function noRateDeliveries(orders: readonly OrderCosts[]): { list: ReportDeliveryException[]; count: number } {
  const all = orders.filter((o) => o.noRate).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return {
    list: all.slice(0, REPORT_LIST_CAP).map((o) => ({ orderId: o.id, orderNumber: o.number, createdAt: o.createdAt, area: o.area?.trim() || null, channel: o.channel })),
    count: all.length,
  };
}

// ---------------------------------------------------------------- channels --

type ChannelAcc = Omit<ReportChannelProfit, 'contributionCents' | 'contributionPerOrderCents'> & { setAsideOrders: number };

function emptyChannel(channel: ReportChannel): ChannelAcc {
  return {
    channel,
    orderCount: 0,
    salesCents: 0,
    feeSalesCents: 0,
    knownFoodSalesCents: 0,
    foodCostCents: 0,
    unknownSalesCents: 0,
    commissionCents: 0,
    upliftCents: 0,
    paymentFeeCents: 0,
    riderCents: 0,
    setAsideCents: 0,
    setAsideOrders: 0,
  };
}

/** Add a group's food and fee sales into a channel's (or an area's) figures. */
export function addGroup(acc: Pick<ChannelAcc, 'salesCents' | 'feeSalesCents' | 'knownFoodSalesCents' | 'foodCostCents' | 'unknownSalesCents'>, t: FoodCostTally): void {
  acc.salesCents += t.foodSalesCents + t.feeSalesCents;
  acc.feeSalesCents += t.feeSalesCents;
  acc.knownFoodSalesCents += t.knownSalesCents;
  acc.foodCostCents += t.knownCostCents;
  acc.unknownSalesCents += t.foodSalesCents - t.knownSalesCents;
}

/** Add a delivery's or foodpanda order's commission, uplift and rider into a channel's figures. */
function addOrder(acc: Pick<ChannelAcc, 'commissionCents' | 'upliftCents' | 'riderCents'>, o: OrderCosts): void {
  acc.commissionCents += o.commissionCents;
  acc.upliftCents += o.upliftCents;
  acc.riderCents += o.riderCents;
}

function finish(acc: ChannelAcc): ReportChannelProfit {
  const { setAsideOrders, ...rest } = acc;
  const contribution =
    contributionCents({
      knownFoodSalesCents: acc.knownFoodSalesCents,
      foodCostCents: acc.foodCostCents,
      feeSalesCents: acc.feeSalesCents,
      riderCents: acc.riderCents,
      commissionCents: acc.commissionCents,
      paymentFeeCents: acc.paymentFeeCents,
      upliftCents: acc.upliftCents,
    }) - acc.setAsideCents;
  return {
    ...rest,
    contributionCents: contribution,
    // Over the known part of its orders (an order half known counts as half), rounded half away from zero.
    contributionPerOrderCents: perKnownOrderCents(contribution, acc.orderCount * WHOLE_ORDER - setAsideOrders),
  };
}

/** What each order type earns (costing spec 4.7), most sales first. `aside`: setAside(pass, read), when already worked out. */
export function channelProfits(pass: SalesPass, read: OrderCostsRead, aside: SetAsides = setAside(pass, read)): ReportChannelProfit[] {
  const by = new Map<ReportChannel, ChannelAcc>();
  const acc = (c: ReportChannel) => {
    let a = by.get(c);
    if (!a) by.set(c, (a = emptyChannel(c)));
    return a;
  };
  for (const g of pass.groups.values()) addGroup(acc(channelOf(g.mode, g.source)), g.tally);
  for (const [c, x] of read.byChannel) {
    const a = acc(c);
    a.orderCount += x.orderCount;
    a.paymentFeeCents += x.paymentFeeCents;
  }
  for (const o of read.orders) addOrder(acc(o.channel), o);
  for (const [c, x] of aside.byChannel) {
    const a = acc(c);
    a.setAsideCents += x.cents;
    a.setAsideOrders += x.orderThousandths;
  }
  return [...by.values()].map(finish).sort((a, b) => b.salesCents - a.salesCents || b.orderCount - a.orderCount);
}

// -------------------------------------------------------- items, categories --

/**
 * An item's (or category's) cost line: what its fully costed sales cost and,
 * for profit.view, earned before channel costs.
 */
export function lineCostOf(x: Pick<ItemSales, 'units' | 'salesCents' | 'knownUnits' | 'knownSalesCents' | 'costCents'>, withProfit: boolean): ReportLineCost {
  const profit = x.knownUnits > 0 ? x.knownSalesCents - x.costCents : null;
  return {
    units: x.units,
    salesCents: x.salesCents,
    knownUnits: x.knownUnits,
    knownSalesCents: x.knownSalesCents,
    costCents: x.costCents,
    foodCostBps: x.knownUnits > 0 ? shareBps(x.costCents, x.knownSalesCents) : null,
    coverageBps: shareBps(x.knownSalesCents, x.salesCents),
    profitCents: withProfit ? profit : null,
    // Half away from zero: a loss rounds like a gain (costing spec D10).
    profitPerSaleCents: withProfit && profit !== null ? mulDivRound(profit, 1, x.knownUnits) : null,
  };
}

interface CategoryAcc {
  categoryId: string | null;
  name: string;
  units: number;
  salesCents: number;
  knownUnits: number;
  knownSalesCents: number;
  costCents: number;
}

/**
 * The food items rolled up into their CURRENT category (as Reports → Menu
 * does: an item keeps the category it has now), keyed like that tab's
 * categories: the category id, or 'name:' + its name. Delivery charges and
 * categories marked "not food" are left out.
 */
export function categoryCosts(db: AppDatabase, pass: SalesPass): Map<string, CategoryAcc> {
  // Deleted categories keep their names for history.
  const names = new Map((db.prepare(`SELECT id, name FROM categories`).all() as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const out = new Map<string, CategoryAcc>();
  for (const it of pass.items.values()) {
    if (it.isFee) continue;
    const catId = pass.menu.item(it.itemId)?.categoryId ?? null;
    if (catId !== null && pass.menu.nonFoodCategoryIds.has(catId)) continue;
    const name = catId !== null ? (names.get(catId) ?? 'No category') : 'No category';
    const id = catId !== null && names.has(catId) ? catId : null;
    const key = id ?? `name:${name}`;
    const acc = out.get(key) ?? { categoryId: id, name, units: 0, salesCents: 0, knownUnits: 0, knownSalesCents: 0, costCents: 0 };
    acc.units += it.units;
    acc.salesCents += it.salesCents;
    acc.knownUnits += it.knownUnits;
    acc.knownSalesCents += it.knownSalesCents;
    acc.costCents += it.costCents;
    out.set(key, acc);
  }
  return out;
}

/** Reports → Menu's cost and profit columns (COST_CAPABILITY; the profit inside for profit.view). */
export function menuCosts(db: AppDatabase, range: ReportRange, withProfit: boolean): ReportMenuCosts {
  const pass = readSales(db, range, { estimates: false });
  const items: Record<string, ReportLineCost> = {};
  for (const it of pass.items.values()) {
    if (it.isFee) continue;
    const catId = pass.menu.item(it.itemId)?.categoryId;
    if (catId !== undefined && pass.menu.nonFoodCategoryIds.has(catId)) continue;
    items[it.key] = lineCostOf(it, withProfit);
  }
  const categories: Record<string, ReportLineCost> = {};
  for (const [key, c] of categoryCosts(db, pass)) categories[key] = lineCostOf(c, withProfit);
  return { items, categories, costingStartedAt: costingStartedAt(db) };
}

// ------------------------------------------------------------------ the tab --

/** A tab's period as the main process sends it: with whether the login may see profit, and the till link. */
export interface ProfitJob extends BusinessReportRequest {
  link?: TillLinkState;
}

/** A millisecond either way: the window a "Between stock takes" period runs over is (from, to], each end + 1 ms. */
function sameInstant(a: string, bMs: number): boolean {
  return Math.abs(Date.parse(a) - bMs) <= 1;
}

/**
 * The stock-loss step (costing spec 4.7): only when the period is "Between
 * stock takes" and BOTH were full counts — a key-items count leaves most of
 * the shelf out.
 */
export function stockLossOf(db: AppDatabase, job: ProfitJob): ReportProfitStockLoss {
  const notBetween: ReportProfitStockLoss = {
    state: 'not_between',
    cents: null,
    scopes: null,
    message: 'Stock that went missing is taken off only for "Between stock takes", when both were full counts.',
  };
  if (!job.stockTakes) return notBetween;
  const v = buildVariance(db, { fromCountId: job.stockTakes.fromCountId, toCountId: job.stockTakes.toCountId, link: job.link ?? LINK_OFF });
  if (v.state === 'other_till_missing') return { state: 'other_till_missing', cents: null, scopes: null, message: v.message };
  if (v.state !== 'ok' || !v.from || !v.to) return { state: 'no_counts', cents: null, scopes: null, message: v.message };
  if (!sameInstant(job.sinceIso, Date.parse(v.from.finishedAt) + 1) || !sameInstant(job.untilIso, Date.parse(v.to.finishedAt) + 1)) return notBetween;
  const scopes = { from: v.from.scope, to: v.to.scope };
  if (v.from.scope !== 'full' || v.to.scope !== 'full') {
    return {
      state: 'not_full',
      cents: null,
      scopes,
      message: 'Stock that went missing is taken off only when both stock takes were full counts: a key-items count leaves most of the shelf out.',
    };
  }
  return { state: 'counted', cents: v.totalCents, scopes, message: null };
}

/**
 * Reports → Profit (costing spec Phase 9, profit.view): the waterfall from
 * sales to profit before overheads, what each order type earns, and each
 * category's profit on its fully costed sales.
 */
export function buildProfitTab(db: AppDatabase, req: BusinessReportRequest): ReportTabFigures<'profit'> {
  const job = req as ProfitJob;
  const range = { sinceIso: req.sinceIso, untilIso: req.untilIso };
  const settings = loadProfitSettings(db);
  const pricing = lazyPricing(db);
  const pass = readSales(db, range, { estimates: true, pricing });
  const read = readOrderCosts(db, range, pass.menu, settings);
  const aside = setAside(pass, read);
  const channels = channelProfits(pass, read, aside);
  const total = emptyFoodCostTally();
  for (const g of pass.groups.values()) {
    total.foodSalesCents += g.tally.foodSalesCents;
    total.feeSalesCents += g.tally.feeSalesCents;
    total.knownSalesCents += g.tally.knownSalesCents;
    total.knownCostCents += g.tally.knownCostCents;
    total.estimatedOrders += g.tally.estimatedOrders;
  }
  const sum = (f: (c: ReportChannelProfit) => number) => channels.reduce((s, c) => s + f(c), 0);
  const waste = getWasteAndUnpaid(db, range, pricing);
  const stockLoss = stockLossOf(db, job);
  const w = profitWaterfall({
    salesCents: total.foodSalesCents + total.feeSalesCents,
    foodCostCents: total.knownCostCents,
    unknownSalesCents: total.foodSalesCents - total.knownSalesCents,
    unknownOtherCents: aside.totalCents,
    wasteCents: waste.wasteCents,
    sentNotPaidCents: waste.sentNotPaid.costCents,
    stockLossCents: stockLoss.state === 'counted' ? stockLoss.cents : null,
    commissionCents: sum((c) => c.commissionCents),
    // Its own step while foodpanda is dearer now, or any order in the period kept a dearer price.
    upliftCents: settings.foodpanda.upliftBps > 0 || channels.some((c) => c.upliftCents !== 0) ? sum((c) => c.upliftCents) : null,
    paymentFeeCents: sum((c) => c.paymentFeeCents),
    riderCents: sum((c) => c.riderCents),
  });
  const categories: ReportCategoryProfit[] = [...categoryCosts(db, pass).values()]
    .map((c) => ({ categoryId: c.categoryId, name: c.name, ...lineCostOf(c, true) }))
    .sort((a, b) => b.salesCents - a.salesCents || a.name.localeCompare(b.name));
  return {
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    steps: w.steps,
    profitCents: w.profitCents,
    wasteByReason: waste.wasteByReason,
    ...(waste.wasteLabels ? { wasteLabels: waste.wasteLabels } : {}),
    sentNotPaid: waste.sentNotPaid,
    stockLoss,
    channels,
    categories,
    unknownSalesCents: total.foodSalesCents - total.knownSalesCents,
    coverageBps: shareBps(total.knownSalesCents, total.foodSalesCents),
    estimatedOrders: total.estimatedOrders,
    costingStartedAt: costingStartedAt(db),
    fees: profitFees(settings),
    riderCost: settings.riderCost,
    noRateCount: read.orders.filter((o) => o.noRate).length,
  };
}

/**
 * The waterfall's figures without the tables: profit before overheads and the
 * food sales left out for an unknown cost (the printed weekly sheet, Phase 9).
 */
export function profitBeforeOverheads(db: AppDatabase, range: ReportRange): { profitCents: number; unknownSalesCents: number } {
  const t = buildProfitTab(db, range);
  return { profitCents: t.profitCents, unknownSalesCents: t.unknownSalesCents };
}

// ---------------------------------------------------------- channels tab --

/**
 * Reports → Channels & delivery's Phase 9 parts: the delivery areas
 * (report.view; rider cost and what an order earns for profit.view only),
 * deliveries with no area and no delivery charge, and — for profit.view —
 * what each order type earns.
 */
export function channelsExtras(
  db: AppDatabase,
  range: ReportRange,
  withProfit: boolean,
): Pick<ReportTabFigures<'channels'>, 'areas' | 'noRateDeliveries' | 'noRateCount' | 'profit'> {
  const settings = loadProfitSettings(db);
  // Delivery charges collected need no estimates; what an order type earns does (its food cost).
  const pass = readSales(db, range, { estimates: withProfit });
  const read = readOrderCosts(db, range, pass.menu, settings);
  const aside = withProfit ? setAside(pass, read) : null;
  const areas = deliveryAreas(
    read.orders.filter((o) => o.delivery),
    [...pass.groups.values()].filter((g) => g.mode === 'delivery'),
    repeatCustomers(db, range),
    withProfit,
    aside?.byArea,
  );
  const noRate = noRateDeliveries(read.orders);
  return {
    areas,
    noRateDeliveries: noRate.list,
    noRateCount: noRate.count,
    profit: withProfit && aside ? { channels: channelProfits(pass, read, aside), fees: profitFees(settings), riderCost: settings.riderCost } : null,
  };
}
