/**
 * Profit (costing spec 4.4 and 4.7, Phase 9): pure money math, so it is
 * tested on its own.
 *
 *  - splitOrderLines: an order's lines at what the customer paid, before tax
 *    — the order's discount shared out by allocateDiscount in the order the
 *    till lists the lines (the same shares its tax and FBR invoice use; a
 *    delivery charge the discount's frozen rule left alone takes none), then
 *    the part refunds, taken off before tax, shared out the same way. There
 *    is no other allocation: Reports' food cost uses these same nets.
 *  - foodpanda's commission and price uplift are NOT here: one per-order
 *    rule serves every report (foodpanda.ts foodpandaOrderMoney, Settings →
 *    foodpanda's terms);
 *  - payment fees; what a delivery costs in rider;
 *  - an order's contribution, and the profit waterfall.
 *
 * Integer paisa throughout, every figure rounded once, half away from zero.
 * Stored order totals are only read, never changed.
 */
import type { ProfitStepKey, ReportPaymentGroup, RiderCostSetting } from '@cheeseoclock/shared-types';
import { allocateDiscount, weightsThatCarry } from './discount.js';
import { mulDivRound } from './units.js';

/** round(n ÷ d), half away from zero, d > 0. */
function divRound(n: bigint, d: bigint): number {
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const q = (2n * mag + d) / (2n * d);
  return Number(neg ? -q : q);
}

// ------------------------------------------------------------ allocation --

/** An order's money as the till stored it (paisa; refunds as a positive amount). */
export interface OrderMoney {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  refundedCents: number;
}

export interface OrderSplit {
  /** Each line's share of the order's discount. */
  discounts: number[];
  /** Each line's share of the part refunds, before tax. */
  refunds: number[];
  /** Each line at what the customer paid, before tax: line total − discount share − refund share. */
  nets: number[];
  /** The part refunds before tax: round(refunded × (sub − discount) ÷ total); 0 when the total is 0. */
  refundExTaxCents: number;
  /** Σ nets: the order's sales before tax (rev_o). */
  salesExTaxCents: number;
}

/**
 * Costing spec 4.4: disc_ℓ = allocateDiscount(line totals, discount)[ℓ];
 * lineNet_ℓ = line total − disc_ℓ; ref_ℓ = allocateDiscount(lineNets,
 * ref_ex)[ℓ] with ref_ex = round(refunded × Σ lineNet ÷ total); net_ℓ =
 * lineNet_ℓ − ref_ℓ. The lines must be in the till's order ((created_at, id),
 * as recomputeOrderTotals shares the discount). Σ nets = sales before tax exactly.
 *
 * `discountSkips[ℓ]`: line ℓ took none of the discount — a delivery charge
 * the discount's FROZEN rule left alone (discount-base.ts
 * discountSkipMask), weight 0 in the discount's split exactly as the till
 * split it. Absent = every line (every discount before 0.7.26). Part refunds
 * are still spread over every line's net, the delivery charge included.
 */
export function splitOrderLines(
  lineTotalsCents: readonly number[],
  discountCents: number,
  totalCents: number,
  refundedCents: number,
  discountSkips?: readonly boolean[],
): OrderSplit {
  // A discount more than the lines it may come off (only an older till
  // stores one) is split over every line, as that till split it.
  const discounts = allocateDiscount(
    discountSkips
      ? weightsThatCarry(lineTotalsCents, lineTotalsCents.map((t, i) => (discountSkips[i] ? 0 : t)), discountCents)
      : lineTotalsCents,
    discountCents,
  );
  const lineNets = lineTotalsCents.map((t, i) => t - (discounts[i] ?? 0));
  const afterDiscount = lineNets.reduce((s, x) => s + x, 0);
  const refundExTaxCents = totalCents > 0 && refundedCents > 0 ? mulDivRound(refundedCents, afterDiscount, totalCents) : 0;
  const refunds = allocateDiscount(lineNets, refundExTaxCents);
  const nets = lineNets.map((n, i) => n - (refunds[i] ?? 0));
  return { discounts, refunds, nets, refundExTaxCents, salesExTaxCents: nets.reduce((s, x) => s + x, 0) };
}

/**
 * An order's sales before tax from its stored money alone — the same figure
 * as Σ splitOrderLines' nets when its lines add up to its stored subtotal
 * (they do: the till stores the subtotal from them). For the orders read
 * without their lines (a plain order's commission).
 */
export function orderSalesExTaxCents(m: OrderMoney): number {
  const sub = Math.max(0, m.subtotalCents);
  const disc = m.discountCents > 0 && sub > 0 ? Math.min(Math.round(m.discountCents), sub) : 0;
  const afterDiscount = sub - disc;
  const refundExTax = m.totalCents > 0 && m.refundedCents > 0 ? mulDivRound(m.refundedCents, afterDiscount, m.totalCents) : 0;
  return afterDiscount - Math.min(refundExTax, afterDiscount);
}

// --------------------------------------------------------- payment fees --

/**
 * What taking the money cost: per way of paying, round(fee × what was paid
 * that way net of refunds), added up. 0 with no fees set (the default).
 */
export function paymentFeeCents(
  paidByGroup: Partial<Record<ReportPaymentGroup, number>>,
  feeBps: Readonly<Record<ReportPaymentGroup, number>>,
): number {
  let fee = 0;
  for (const [g, cents] of Object.entries(paidByGroup) as Array<[ReportPaymentGroup, number]>) {
    const bps = feeBps[g] ?? 0;
    if (bps > 0 && cents !== 0) fee += divRound(BigInt(cents) * BigInt(bps), 10_000n);
  }
  return fee;
}

// ---------------------------------------------------------------- rider --

/**
 * Where a delivery's rider cost came from:
 *  - 'zone':    the rider service's rate for the order's area;
 *  - 'charge':  no area recognised: the delivery charge on the bill, at menu price;
 *  - 'fixed':   the owner's fixed amount per trip;
 *  - 'none':    not a delivery, or the shop's own salaried riders;
 *  - 'no_rate': no area and no delivery charge: Rs 0, and listed.
 */
export type RiderCostSource = 'zone' | 'charge' | 'fixed' | 'none' | 'no_rate';

export interface RiderCostInput {
  /** An own-rider delivery (phone or website); foodpanda brings its own. */
  delivery: boolean;
  /** The fee of the delivery zone the order's area is in; null when it names none (or zones that differ). */
  zoneFeeCents: number | null;
  /** The delivery-charge lines on the bill at menu price (never the discounted fee); null when there is none. */
  chargeCents: number | null;
}

/**
 * A delivery's rider cost (costing spec 4.7): by default the zone's rate —
 * even when the delivery charge was discounted or left off — else the
 * delivery charge at menu price, else Rs 0 ('no_rate', listed for the owner).
 */
export function riderCost(setting: RiderCostSetting, o: RiderCostInput): { cents: number; source: RiderCostSource } {
  if (!o.delivery) return { cents: 0, source: 'none' };
  switch (setting.mode) {
    case 'none':
      return { cents: 0, source: 'none' };
    case 'fixed':
      return { cents: setting.fixedCents, source: 'fixed' };
    case 'zone_rate':
      if (o.zoneFeeCents !== null) return { cents: o.zoneFeeCents, source: 'zone' };
      if (o.chargeCents !== null) return { cents: o.chargeCents, source: 'charge' };
      return { cents: 0, source: 'no_rate' };
  }
}

/** A delivery with no area recognised and no delivery charge on the bill (costing spec 4.14), whatever the rider mode. */
export function isNoRateDelivery(o: RiderCostInput): boolean {
  return o.delivery && o.zoneFeeCents === null && o.chargeCents === null;
}

// --------------------------------------------------------- contribution --

/** What one order (or a channel's orders) adds up to, before waste, unpaid food and stock loss. */
export interface ContributionParts {
  /** Food sales whose cost is known, before tax. */
  knownFoodSalesCents: number;
  /** What that food cost. */
  foodCostCents: number;
  /** Delivery charges and other non-food lines, before tax. */
  feeSalesCents: number;
  riderCents: number;
  commissionCents: number;
  paymentFeeCents: number;
  upliftCents: number;
}

/**
 * Contribution (costing spec 4.7) = food sales − food cost + fee sales −
 * rider − commission − payment fees (+ uplift), on the food whose cost is
 * KNOWN: sales with no known cost are never costed at Rs 0 — they are left
 * out (and shown on their own). For a channel or an area whose orders are
 * partly costed, take off the part of their other money that goes with the
 * food of unknown cost (knownShareCents, set aside with it).
 */
export function contributionCents(p: ContributionParts): number {
  return p.knownFoodSalesCents - p.foodCostCents + p.feeSalesCents - p.riderCents - p.commissionCents - p.paymentFeeCents + p.upliftCents;
}

/** One whole order, in thousandths: "per order" is worked over the known part of each order. */
export const WHOLE_ORDER = 1_000;

/**
 * An order whose food cost is only partly known (costing spec 4.7: unknown
 * costs are never guessed, and what goes with them is not charged to the
 * rest): the share of `amountCents` — its delivery charge less rider,
 * commission, uplift and payment fees — that goes with its food of KNOWN
 * cost, round(amount × known food ÷ food), half away from zero. All of it
 * when all its food is known (or it has none); none when none is.
 */
export function knownShareCents(amountCents: number, knownFoodCents: number, foodCents: number): number {
  if (foodCents <= 0 || knownFoodCents >= foodCents) return amountCents;
  if (knownFoodCents <= 0) return 0;
  return mulDivRound(amountCents, knownFoodCents, foodCents);
}

/** How much of an order is known, in thousandths of an order (WHOLE_ORDER when all its food cost is known). */
export function knownOrderShare(knownFoodCents: number, foodCents: number): number {
  return knownShareCents(WHOLE_ORDER, knownFoodCents, foodCents);
}

/**
 * "Per order" over the known part of the orders: what they earn ÷ the
 * orders counted in thousandths (knownOrderShare), half away from zero, so
 * a loss rounds like a gain. Null when no order's cost is known at all.
 */
export function perKnownOrderCents(earnsCents: number, knownOrderThousandths: number): number | null {
  if (knownOrderThousandths <= 0) return null;
  return mulDivRound(earnsCents, WHOLE_ORDER, knownOrderThousandths);
}

// ------------------------------------------------------------ waterfall --

export interface WaterfallInput {
  /** Sales before tax, after discounts and part refunds (fees included). */
  salesCents: number;
  /** Food cost of the sales whose cost is known. */
  foodCostCents: number;
  /** Food sales whose cost is not known: set aside. */
  unknownSalesCents: number;
  /**
   * The rest of those orders' money that goes with that food (knownShareCents'
   * remainder: delivery charges less rider, commission and payment fees, plus
   * uplift; signed), set aside with it. 0 when left out.
   */
  unknownOtherCents?: number;
  wasteCents: number;
  sentNotPaidCents: number;
  /** Unexplained stock between two full stock takes; null: not this period (no step). */
  stockLossCents: number | null;
  commissionCents: number;
  /** foodpanda's dearer prices (estimated); null: the till's prices (no step). */
  upliftCents: number | null;
  paymentFeeCents: number;
  riderCents: number;
}

export interface Waterfall {
  steps: Array<{ key: ProfitStepKey; cents: number }>;
  /** Profit before overheads: Σ steps. */
  profitCents: number;
}

/**
 * The profit waterfall (costing spec 4.7), in order: sales before tax; −
 * food cost; − the sales with an unknown cost (set aside, never costed at
 * Rs 0, with the part of their orders' charges, commission, fees and rider
 * that goes with them); − waste; − food sent, not paid; − stock loss (only between two full
 * stock takes); − foodpanda commission, + its price uplift, − payment fees;
 * − rider cost; = profit before overheads. The steps always add up to it.
 */
export function profitWaterfall(x: WaterfallInput): Waterfall {
  const steps: Waterfall['steps'] = [
    { key: 'sales', cents: x.salesCents },
    { key: 'food_cost', cents: -x.foodCostCents },
    { key: 'unknown_cost', cents: -(x.unknownSalesCents + (x.unknownOtherCents ?? 0)) },
    { key: 'waste', cents: -x.wasteCents },
    { key: 'sent_not_paid', cents: -x.sentNotPaidCents },
  ];
  if (x.stockLossCents !== null) steps.push({ key: 'stock_loss', cents: -x.stockLossCents });
  steps.push({ key: 'commission', cents: -x.commissionCents });
  if (x.upliftCents !== null) steps.push({ key: 'uplift', cents: x.upliftCents });
  steps.push({ key: 'payment_fees', cents: -x.paymentFeeCents }, { key: 'rider', cents: -x.riderCents });
  // -0 is 0 on paper.
  for (const s of steps) if (s.cents === 0) s.cents = 0;
  return { steps, profitCents: steps.reduce((s, x2) => s + x2.cents, 0) };
}
