/**
 * Delivery areas (costing spec 4.11, Phase 9): Reports → Channels &
 * delivery, own-rider deliveries (phone and website) by the area on the
 * order's address — recognised as a delivery zone (the owner's areas,
 * Settings → Delivery areas, read by this worker from its own connection:
 * useReportZones; a renamed area's old name still counts as it) where it
 * can be, else as typed, else "Area not recorded". The rider's rate for a
 * zone stays the rider service's rate card (the compiled list) until
 * costing Phase 9 copies rider pay onto each order: the owner's charge
 * changing must not rewrite past profit.
 *
 * Per area: orders, sales, the average order, delivery charges collected,
 * minutes on the road, how many of its customers came back (costing spec
 * 4.11: 2 or more orders — of any kind, delivered anywhere or not — in the
 * 90 days up to the period's end), and — for profit.view — the rider's cost
 * and what an order earns after its food, delivery charge, rider and fees
 * (analytics/profit.ts works those out), over the known part of the orders.
 *
 * Read-only; never loads Electron (the worker loads it).
 */
import { DEFAULT_DELIVERY_ZONES, feeForZones, findZone, type ReportDeliveryArea } from '@cheeseoclock/shared-types';
import {
  WHOLE_ORDER,
  contributionCents,
  deliveryAreas as areasFor,
  mulDivRound,
  normalizePhone,
  perKnownOrderCents,
  shareBps,
  type DeliveryAreas,
  type FoodCostTally,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { readDeliveryZones } from '../../db/business-settings-read.js';
import type { ReportRange } from '../business-report.js';
import { COUNTED, DAY_MS } from './sql.js';

/** Where a delivery went, as the tab groups it. */
export interface OrderArea {
  /** 'zone:' + the zone id, 'text:' + the area as typed (lower case), or 'none'. */
  key: string;
  label: string;
  zoneId: string | null;
  /** The zone's fee — the rider service's rate — when the area pins one fee (one zone, or zones that agree). */
  zoneFeeCents: number | null;
}

const NOT_RECORDED: OrderArea = { key: 'none', label: 'Area not recorded', zoneId: null, zoneFeeCents: null };

/** The areas a report recognises: the owner's, read at the start of each report (useReportZones). */
let reportAreas: DeliveryAreas = areasFor(DEFAULT_DELIVERY_ZONES.zones);

/**
 * Read the owner's areas for this report (Settings → Delivery areas; the
 * worker's own connection). Called where a report reads its orders, before
 * any areaOf.
 */
export function useReportZones(db: AppDatabase): void {
  reportAreas = areasFor(readDeliveryZones(db));
}

/** Areas are typed a few dozen ways at most: each is recognised once per zone list (never across a Save). */
const seen = new WeakMap<DeliveryAreas, Map<string, OrderArea>>();

/**
 * The area on a delivery's address, recognised (costing spec 4.11: the
 * zone's names and spellings, a renamed zone's old name included), else as
 * typed. `zoneFeeCents` is the rider service's rate for it (the compiled
 * rate card), null for an area the owner added.
 */
export function areaOf(text: string | null | undefined, areas: DeliveryAreas = reportAreas): OrderArea {
  const t = (text ?? '').trim();
  if (!t) return NOT_RECORDED;
  let memo = seen.get(areas);
  if (!memo) seen.set(areas, (memo = new Map()));
  const hit = memo.get(t);
  if (hit) return hit;
  const r = areas.resolveAreaText(t);
  const one = r.zoneIds.length === 1 ? areas.findZone(r.zoneIds[0]) : undefined;
  const out: OrderArea = one
    ? { key: `zone:${one.id}`, label: one.name, zoneId: one.id, zoneFeeCents: findZone(one.id)?.feeCents ?? null }
    : { key: `text:${t.toLowerCase()}`, label: t, zoneId: null, zoneFeeCents: r.zoneIds.length > 1 ? feeForZones(r.zoneIds) : null };
  if (memo.size > 5_000) memo.clear();
  memo.set(t, out);
  return out;
}

/**
 * The counted orders of [since, until) that name a customer (an account or
 * a phone), of any kind, with — for an own-rider delivery — the area it
 * went to. Params: since, until.
 */
export const AREA_CUSTOMERS_SQL = `
  SELECT o.customer_id AS customerId, o.customer_phone_snapshot AS phone, o.created_at AS at,
         CASE WHEN o.mode = 'delivery' AND json_valid(o.delivery_address_snapshot)
              THEN CAST(json_extract(o.delivery_address_snapshot, '$.area') AS TEXT) END AS area,
         o.mode = 'delivery' AS isDelivery
    FROM orders o
   WHERE o.created_at >= ? AND o.created_at < ? AND ${COUNTED}
     AND (o.customer_id IS NOT NULL OR NULLIF(TRIM(o.customer_phone_snapshot), '') IS NOT NULL)`;

/** The 90 days customers are counted over (costing spec 4.11). */
export const REPEAT_WINDOW_DAYS = 90;

/**
 * Per area (costing spec 4.11): its customers — by account, else phone —
 * with a delivery there in the period, and of them those with 2 or more
 * orders in the 90 days up to the period's end (or the whole period, when
 * it is longer): counted orders of ANY kind — a takeaway, a foodpanda
 * order, a delivery to another area or with the area typed another way all
 * count. Orders with no account and no phone are not counted.
 */
export function repeatCustomers(db: AppDatabase, range: ReportRange): Map<string, { customers: number; repeat: number }> {
  useReportZones(db);
  const untilMs = Date.parse(range.untilIso);
  const fromMs = Math.min(Date.parse(range.sinceIso), untilMs - REPEAT_WINDOW_DAYS * DAY_MS);
  /** Every customer's counted orders over the window. */
  const orders = new Map<string, number>();
  const inPeriod = new Map<string, Set<string>>();
  for (const r of db.prepare(AREA_CUSTOMERS_SQL).all(new Date(fromMs).toISOString(), range.untilIso) as Array<{
    customerId: string | null;
    phone: string | null;
    at: string;
    area: string | null;
    isDelivery: number;
  }>) {
    const phone = r.customerId ? null : normalizePhone(r.phone);
    const who = r.customerId ? `c:${r.customerId}` : phone ? `p:${phone}` : null;
    if (!who) continue;
    orders.set(who, (orders.get(who) ?? 0) + 1);
    // The area's customers: those with an own-rider delivery there in the period.
    if (Number(r.isDelivery) === 1 && r.at >= range.sinceIso) {
      const area = areaOf(r.area).key;
      const s = inPeriod.get(area) ?? new Set<string>();
      s.add(who);
      inPeriod.set(area, s);
    }
  }
  const out = new Map<string, { customers: number; repeat: number }>();
  for (const [area, who] of inPeriod) {
    out.set(area, { customers: who.size, repeat: [...who].filter((k) => (orders.get(k) ?? 0) >= 2).length });
  }
  return out;
}

/** One delivery order as the areas need it (analytics/profit.ts OrderCosts). */
export interface AreaOrder {
  area: string | null;
  netSalesCents: number;
  minutesOut: number | null;
  riderCents: number;
  paymentFeeCents: number;
}

/**
 * The areas of the period's own-rider deliveries, most orders first.
 * `groups`: the food and fee sales of the delivery orders per area as typed
 * (analytics/profit.ts readSales). Rider cost and what an order earns only
 * `withProfit` (profit.view): null otherwise. `aside`: per area key, what of
 * its partly costed orders' charges, rider and fees goes with their food of
 * unknown cost (analytics/profit.ts setAside) — left out of what an order
 * earns, like that food, and "per order" is over the known part of them.
 */
export function deliveryAreas(
  orders: readonly AreaOrder[],
  groups: ReadonlyArray<{ area: string | null; tally: FoodCostTally }>,
  repeat: ReadonlyMap<string, { customers: number; repeat: number }>,
  withProfit: boolean,
  aside?: ReadonlyMap<string, { cents: number; orderThousandths: number }>,
): ReportDeliveryArea[] {
  interface Acc {
    a: ReturnType<typeof areaOf>;
    orders: number;
    net: number;
    minutes: number;
    timed: number;
    rider: number;
    payFees: number;
    fees: number;
    knownFood: number;
    cost: number;
  }
  const by = new Map<string, Acc>();
  const acc = (text: string | null): Acc => {
    const a = areaOf(text);
    let x = by.get(a.key);
    if (!x) by.set(a.key, (x = { a, orders: 0, net: 0, minutes: 0, timed: 0, rider: 0, payFees: 0, fees: 0, knownFood: 0, cost: 0 }));
    return x;
  };
  for (const o of orders) {
    const x = acc(o.area);
    x.orders += 1;
    x.net += o.netSalesCents;
    if (o.minutesOut !== null) {
      x.minutes += o.minutesOut;
      x.timed += 1;
    }
    x.rider += o.riderCents;
    x.payFees += o.paymentFeeCents;
  }
  for (const g of groups) {
    const x = acc(g.area);
    x.fees += g.tally.feeSalesCents;
    x.knownFood += g.tally.knownSalesCents;
    x.cost += g.tally.knownCostCents;
  }
  return [...by.values()]
    .filter((x) => x.orders > 0)
    .map((x): ReportDeliveryArea => {
      const r = repeat.get(x.a.key) ?? { customers: 0, repeat: 0 };
      const set = aside?.get(x.a.key) ?? { cents: 0, orderThousandths: 0 };
      const contribution =
        contributionCents({
          knownFoodSalesCents: x.knownFood,
          foodCostCents: x.cost,
          feeSalesCents: x.fees,
          riderCents: x.rider,
          commissionCents: 0,
          paymentFeeCents: x.payFees,
          upliftCents: 0,
        }) - set.cents;
      return {
        key: x.a.key,
        area: x.a.label,
        zoneId: x.a.zoneId,
        orderCount: x.orders,
        netSalesCents: x.net,
        avgOrderCents: mulDivRound(x.net, 1, x.orders),
        feesCollectedCents: x.fees,
        avgMinutesOut: x.timed > 0 ? Math.round(x.minutes / x.timed) : null,
        customers: r.customers,
        repeatCustomers: r.repeat,
        repeatRateBps: shareBps(r.repeat, r.customers),
        riderCents: withProfit ? x.rider : null,
        // Over the known part of the orders, half away from zero (a loss rounds like a gain).
        contributionPerOrderCents: withProfit ? perKnownOrderCents(contribution, x.orders * WHOLE_ORDER - set.orderThousandths) : null,
      };
    })
    .sort((a, b) => b.orderCount - a.orderCount || b.netSalesCents - a.netSalesCents || a.area.localeCompare(b.area));
}
