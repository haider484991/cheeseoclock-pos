/**
 * The cost kept with a sale (costing spec Phase 2, 4.2 and 4.5): pure math
 * only — the repositories write the rows, Reports reads them.
 *
 *  - costSaleLine: the cost rows ONE order line keeps (order_item_costs),
 *    worked out by expandRecipe, the same rule the stock is taken by, at the
 *    effective price (a batch at its rolled-up price) the moment it leaves;
 *  - stockValueAt: what a stock row is worth at a price, signed like its
 *    quantity, so a take and its put-back net to exactly 0;
 *  - lineNetsExTax: an order's lines at what the customer paid, before tax,
 *    the order's discount and part refunds shared out exactly as the till
 *    shares the discount for tax and FBR (allocateDiscount, lines in order);
 *  - tallyFoodCost: one counted order added into Reports' food cost — the
 *    cost kept with it, or (for an order with none) an estimate from the
 *    stock it took, and which of its sales have a known cost.
 *
 * Integer arithmetic throughout (paisa; unit prices in millicents), every
 * stored figure rounded once, half away from zero.
 */

import type {
  CostBasis,
  OrderItemCostStatus,
  PriceKind,
  ReportMissingCostLine,
  ReportMissingCostWhy,
  ReportWasteReason,
  StockMovement,
  WasteReason,
  WasteReasonId,
} from '@cheeseoclock/shared-types';
import { WASTE_REASONS } from '@cheeseoclock/shared-types';
import { splitOrderLines } from './profit.js';
import { BASE_PART, expandRecipe, type ExpandedLine, type PickedChoice, type RecipeLine } from './recipe-expand.js';
import { costLines, type PriceOf } from './plate-cost.js';
import { unitCostMc, valueCents, type Pack } from './units.js';

// ------------------------------------------------------ the cost of a line --

/** One cost row kept with a sale (order_item_costs), before it gets its id. */
export interface SaleCostPart {
  /** BASE_PART, or the id of the choice picked. */
  part: string;
  modifierId: string | null;
  /** The cost of the WHOLE line quantity, paisa. */
  costCents: number;
  status: OrderItemCostStatus;
  /** Lines with no price (they add Rs 0). */
  missingLines: number;
  /** Lines priced with a guess. */
  estimateLines: number;
}

export interface SaleLineCost {
  parts: SaleCostPart[];
  /** What the line takes from stock (the same expansion, for the stock rows). */
  expanded: ExpandedLine[];
}

/**
 * The cost rows of one order line:
 *  - always a 'base' row (the lines with no choice); status 'none' and Rs 0
 *    when the item has no recipe lines at all;
 *  - one row per choice picked that has recipe lines on this item (a veggie,
 *    a deal's pizza, a dip, a paid extra) — also when a leave-out picked
 *    beside it took all its lines off (then Rs 0);
 *  - a "leave out" pick has no lines of its own, so no row: its effect is
 *    inside the others.
 * Each part: round(Σ round(qty × P × 1000 ÷ S) ÷ 1000) over its lines, the
 * same figure the Costing page shows; an unpriced line adds Rs 0 and makes
 * the part 'partial'.
 */
export function costSaleLine(
  recipe: readonly RecipeLine[],
  picks: readonly PickedChoice[],
  quantity: number,
  priceOf: PriceOf,
): SaleLineCost {
  const expanded = expandRecipe(recipe, picks, quantity);
  const hasRecipe = recipe.length > 0;
  const withLines = new Set<string>();
  for (const r of recipe) if (r.modifierId !== null) withLines.add(r.modifierId);
  const partIds: string[] = [BASE_PART];
  for (const p of picks) {
    if (withLines.has(p.modifierId) && !partIds.includes(p.modifierId)) partIds.push(p.modifierId);
  }
  const parts = partIds.map((part): SaleCostPart => {
    const c = costLines(
      expanded.filter((l) => l.part === part),
      priceOf,
    );
    return {
      part,
      modifierId: part === BASE_PART ? null : part,
      costCents: c.costCents,
      status: !hasRecipe ? 'none' : c.missingLines > 0 ? 'partial' : 'full',
      missingLines: c.missingLines,
      estimateLines: c.estimateLines,
    };
  });
  return { parts, expanded };
}

/**
 * A line's status from its cost rows: 'failed' over 'partial' over 'none'
 * over 'full'. Null when no row was kept.
 */
export function lineCostStatus(statuses: readonly OrderItemCostStatus[]): OrderItemCostStatus | null {
  if (statuses.length === 0) return null;
  for (const s of ['failed', 'partial', 'none'] as const) if (statuses.includes(s)) return s;
  return 'full';
}

// -------------------------------------------------- what a stock row is worth --

export interface StockValue {
  /** Signed like the quantity. */
  valueCents: number;
  /** One unit's price, millicents; null when there is none. */
  unitCostMc: number | null;
  basis: CostBasis;
}

/**
 * What `q` units of an ingredient are worth at its effective price, for a
 * stock row: sign(q) × round(|q| × P ÷ S). An ingredient with no price is
 * worth Rs 0, marked 'none' (never guessed; never revalued later).
 */
export function stockValueAt(q: number, price: { pack: Pack; kind: PriceKind } | undefined): StockValue {
  if (!price || price.kind === 'unset') return { valueCents: 0, unitCostMc: null, basis: 'none' };
  return { valueCents: valueCents(q, price.pack), unitCostMc: unitCostMc(price.pack), basis: 'price' };
}

// --------------------------------------------------------- what was paid --

/**
 * An order's lines at what the customer paid, before tax (spec 4.4), in the
 * order the till lists them ((created_at, id), as recomputeOrderTotals):
 * the discount shared out by allocateDiscount, then the part refunds, taken
 * off before tax (ref × (sub − disc) ÷ total), shared out the same way. The
 * nets add up to (sub − disc) − refund-before-tax exactly. `discountSkips`:
 * the lines that took none of the discount under its frozen rule (a delivery
 * charge; profit.ts splitOrderLines).
 */
export function lineNetsExTax(
  lineTotalsCents: readonly number[],
  discountCents: number,
  totalCents: number,
  refundedCents: number,
  discountSkips?: readonly boolean[],
): number[] {
  // The one allocation (costing spec 4.4), shared with Profit.
  return splitOrderLines(lineTotalsCents, discountCents, totalCents, refundedCents, discountSkips).nets;
}

// ------------------------------------------------------------ food cost --

export interface FoodCostLine {
  /** Menu item id, or 'name:' + the sold name. */
  key: string;
  name: string;
  quantity: number;
  lineTotalCents: number;
  /** A delivery charge or a non-food category: not food sales. */
  isFee: boolean;
  /**
   * The line took none of the order's discount: a delivery charge the
   * discount's FROZEN rule left alone (the row's rule_json and the name the
   * line was sold under — discount-base.ts discountSkipMask; never `isFee`,
   * which follows the live "not food" categories). Absent = it took its
   * share (every discount before 0.7.26).
   */
  skipsDiscount?: boolean;
  /** Cost rows kept with the sale for this line (0 when none). */
  parts: number;
  costCents: number;
  /** The line's status from its rows (lineCostStatus); null when none were kept. */
  status: OrderItemCostStatus | null;
  /** The item has a recipe today (for an order with no cost kept). */
  hasRecipeNow: boolean;
}

/** An order with no cost kept, estimated from the stock rows it took. */
export interface FoodCostEstimate {
  /** What it took, net of anything put back (take values, else today's prices). */
  costCents: number;
  /** Every ingredient it took had a price. */
  priced: boolean;
  /** It took any stock at all. */
  tookStock: boolean;
}

export interface FoodCostOrder {
  discountCents: number;
  totalCents: number;
  refundedCents: number;
  /** In the order the till lists them ((created_at, id)). */
  lines: FoodCostLine[];
  /** Only read when no line kept a cost row. */
  estimate: FoodCostEstimate | null;
}

export interface FoodCostTally {
  foodSalesCents: number;
  feeSalesCents: number;
  costOfSalesCents: number;
  knownSalesCents: number;
  /** The same lines at menu price (before discounts and refunds): the Costing page's basis. */
  knownMenuSalesCents: number;
  knownCostCents: number;
  estimatedOrders: number;
  estimatedCostCents: number;
  /** Keyed by item key + why. */
  missing: Map<string, ReportMissingCostLine>;
  /** Some line kept a cost row, or some estimated order took stock. */
  hasUsage: boolean;
}

export function emptyFoodCostTally(): FoodCostTally {
  return {
    foodSalesCents: 0,
    feeSalesCents: 0,
    costOfSalesCents: 0,
    knownSalesCents: 0,
    knownMenuSalesCents: 0,
    knownCostCents: 0,
    estimatedOrders: 0,
    estimatedCostCents: 0,
    missing: new Map(),
    hasUsage: false,
  };
}

/**
 * Does an order keep its cost, or is it estimated from the stock it took?
 * It keeps it when any line has a cost row that did not fail: an order whose
 * costing failed altogether is estimated like one from before costing
 * (costing spec §7).
 */
export function orderKeptCost(lines: readonly Pick<FoodCostLine, 'parts' | 'status'>[]): boolean {
  return lines.some((l) => l.parts > 0 && l.status !== 'failed');
}

function addMissing(t: FoodCostTally, l: FoodCostLine, why: ReportMissingCostWhy, net: number): void {
  const k = `${l.key}|${why}`;
  const cur = t.missing.get(k);
  if (cur) {
    cur.quantity += l.quantity;
    cur.salesCents += net;
  } else t.missing.set(k, { key: l.key, name: l.name, why, quantity: l.quantity, salesCents: net });
}

/** One counted order's food cost (orderFoodCost): what tallyFoodCost adds, with each line's part. */
export interface OrderFoodCost {
  /** Each line at what the customer paid, before tax (lineNetsExTax), in the order given. */
  nets: number[];
  /**
   * Each line's cost is known: a FULL line of an order that kept its cost;
   * for an estimated order, a line with a recipe when everything it took had
   * a price (its cost is then only known as the order's whole estimate).
   */
  known: boolean[];
  /** Why each line's cost is not known (null for a known line or a fee). */
  why: Array<ReportMissingCostWhy | null>;
  foodSalesCents: number;
  feeSalesCents: number;
  costOfSalesCents: number;
  knownSalesCents: number;
  knownMenuSalesCents: number;
  knownCostCents: number;
  /** It kept no cost and was estimated from the stock it took. */
  estimated: boolean;
  estimatedCostCents: number;
  hasUsage: boolean;
}

/**
 * One counted order's food cost (spec 4.5):
 *  - food sales = its non-fee lines at what the customer paid, before tax;
 *  - an order that kept its cost adds each food line's cost; a FULL line's
 *    sales and cost are "known" (the food cost % is worked on those), any
 *    other is a sale with a missing cost;
 *  - an order that kept none adds its estimate; its lines are "known" only
 *    when every ingredient it took had a price and the item has a recipe
 *    today (then the estimate is their cost).
 * Part refunds lower the sales, never the cost: the food was made.
 */
export function orderFoodCost(o: FoodCostOrder): OrderFoodCost {
  const nets = lineNetsExTax(
    o.lines.map((l) => l.lineTotalCents),
    o.discountCents,
    o.totalCents,
    o.refundedCents,
    o.lines.some((l) => l.skipsDiscount === true) ? o.lines.map((l) => l.skipsDiscount === true) : undefined,
  );
  const r: OrderFoodCost = {
    nets,
    known: o.lines.map(() => false),
    why: o.lines.map(() => null),
    foodSalesCents: 0,
    feeSalesCents: 0,
    costOfSalesCents: 0,
    knownSalesCents: 0,
    knownMenuSalesCents: 0,
    knownCostCents: 0,
    estimated: false,
    estimatedCostCents: 0,
    hasUsage: false,
  };
  const kept = orderKeptCost(o.lines);
  let knownNet = 0;
  let knownMenu = 0;
  let anyKnown = false;
  o.lines.forEach((l, i) => {
    const net = nets[i] ?? 0;
    if (l.isFee) {
      r.feeSalesCents += net;
      return;
    }
    r.foodSalesCents += net;
    if (kept) {
      r.costOfSalesCents += l.costCents;
      if (l.parts > 0) r.hasUsage = true;
      if (l.status === 'full') {
        r.known[i] = true;
        r.knownSalesCents += net;
        r.knownMenuSalesCents += l.lineTotalCents;
        r.knownCostCents += l.costCents;
      } else {
        r.why[i] = l.status === 'none' ? 'no_recipe' : l.status === 'partial' ? 'no_price' : 'not_recorded';
      }
      return;
    }
    const e = o.estimate;
    if (!l.hasRecipeNow) r.why[i] = 'no_recipe';
    else if (!e || !e.tookStock) r.why[i] = 'not_recorded';
    else if (!e.priced) r.why[i] = 'no_price';
    else {
      r.known[i] = true;
      knownNet += net;
      knownMenu += l.lineTotalCents;
      anyKnown = true;
    }
  });
  if (kept) return r;
  const e = o.estimate;
  // Estimated only when there is something to estimate from: an order that
  // took no stock (no recipe, a delivery charge alone) is a missing cost,
  // not "estimated at the prices of the time".
  if (!e || !e.tookStock) {
    r.known = r.known.map(() => false);
    return r;
  }
  r.estimated = true;
  r.hasUsage = true;
  r.costOfSalesCents += e.costCents;
  r.estimatedCostCents += e.costCents;
  // The estimate is the cost of the lines with a recipe: known only as a whole.
  if (anyKnown) {
    r.knownSalesCents += knownNet;
    r.knownMenuSalesCents += knownMenu;
    r.knownCostCents += e.costCents;
  }
  return r;
}

/** Add one order's food cost (orderFoodCost) into a tally, its missing-cost lines listed. */
export function addOrderFoodCost(t: FoodCostTally, o: FoodCostOrder, r: OrderFoodCost): void {
  t.foodSalesCents += r.foodSalesCents;
  t.feeSalesCents += r.feeSalesCents;
  t.costOfSalesCents += r.costOfSalesCents;
  t.knownSalesCents += r.knownSalesCents;
  t.knownMenuSalesCents += r.knownMenuSalesCents;
  t.knownCostCents += r.knownCostCents;
  if (r.estimated) {
    t.estimatedOrders += 1;
    t.estimatedCostCents += r.estimatedCostCents;
  }
  if (r.hasUsage) t.hasUsage = true;
  o.lines.forEach((l, i) => {
    const why = r.why[i];
    if (why) addMissing(t, l, why, r.nets[i] ?? 0);
  });
}

/**
 * Add one counted order into the food cost (spec 4.5; see orderFoodCost for
 * the rules).
 */
export function tallyFoodCost(t: FoodCostTally, o: FoodCostOrder): void {
  addOrderFoodCost(t, o, orderFoodCost(o));
}

/**
 * The plain orders of a period at once: counted orders with nothing to share
 * out (no discount, no part refund — each line's net is its menu price) that
 * kept their cost. Reports adds these up in SQL — their food and fee sales,
 * the cost of their food lines — and reads only the food lines that are NOT
 * fully costed, one by one (`notFull`: no row, or a row that is partial,
 * 'none' or failed). The result is exactly what tallyFoodCost gives order by
 * order: everything else is known.
 */
export interface PlainOrders {
  /** Their lines, food and fee (0: there are none). */
  lineCount: number;
  foodSalesCents: number;
  feeSalesCents: number;
  /** The cost rows of their food lines. */
  foodCostCents: number;
  /** Their food lines that are not fully costed (parts / status as kept). */
  notFull: FoodCostLine[];
}

export function tallyPlainOrders(t: FoodCostTally, p: PlainOrders): void {
  if (p.lineCount === 0) return;
  t.foodSalesCents += p.foodSalesCents;
  t.feeSalesCents += p.feeSalesCents;
  t.costOfSalesCents += p.foodCostCents;
  let gapSales = 0;
  let gapCost = 0;
  for (const l of p.notFull) {
    gapSales += l.lineTotalCents;
    gapCost += l.costCents;
    const why: ReportMissingCostWhy = l.status === 'none' ? 'no_recipe' : l.status === 'partial' ? 'no_price' : 'not_recorded';
    addMissing(t, l, why, l.lineTotalCents);
  }
  t.knownSalesCents += p.foodSalesCents - gapSales;
  t.knownMenuSalesCents += p.foodSalesCents - gapSales;
  t.knownCostCents += p.foodCostCents - gapCost;
  t.hasUsage = true;
}

// ---------------------------------------------------------------- waste --

/**
 * The reason a waste row counts under in Reports: food made for an order
 * that was then cancelled or refunded, or the reason picked on the Waste
 * screen, by the id the row keeps ("other" when none was given — rows from
 * before reasons existed — or when it is not one of `known`). `known`: the
 * reasons on the owner's list (Settings → Kitchen & stock, hidden ones
 * too); the seven built in when not given. A renamed reason keeps its id,
 * so its old rows count under it, with its new name.
 */
export function wasteReasonOf(
  detail: string | null | undefined,
  refOrderId: string | null | undefined,
  known: Iterable<WasteReasonId> = WASTE_REASONS,
): ReportWasteReason | WasteReasonId {
  if (detail === 'cancel_made' || (refOrderId !== null && refOrderId !== undefined && refOrderId !== '')) return 'cancelled_made';
  const m = /^waste:(.+)$/.exec(detail ?? '');
  const r = m?.[1];
  const ids = known instanceof Set ? (known as ReadonlySet<string>) : new Set<string>(known);
  return r && ids.has(r) ? (r as WasteReason | WasteReasonId) : 'other';
}

// ------------------------------------------------- what a login may read --

/**
 * A stock row without its costs (value, unit price, how it was valued), for
 * a login without COST_CAPABILITY. The quantity, reason and waste reason stay.
 */
export function movementWithoutCosts<T extends StockMovement>(m: T): T {
  const { valueCents: _v, unitCostMc: _u, costBasis: _b, ...rest } = m;
  return rest as T;
}
