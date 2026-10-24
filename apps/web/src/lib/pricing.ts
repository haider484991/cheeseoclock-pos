import {
  cleanCategoryPercents,
  discountPartsToSend,
  websiteDiscountParts,
  type WebDiscountPart,
  type WebsiteCategoryPercent,
} from '@cheeseoclock/shared-types';

/**
 * Order totals the way the till computes them, so the estimate a customer
 * sees is the bill the rider or the counter asks for.
 *
 * Mirrors apps/pos (order-repo recomputeOrderTotals + pos-domain
 * computeDiscountCents / computeTax, exclusive tax): a percent discount is
 * rounded once on its base — the lines the menu does not mark no-discount
 * (value deals, shared-types web-bridge.ts NO DISCOUNT ON VALUE DEALS), as
 * pos-domain discount-base.ts leaves a line out of the base — then spread
 * over those lines by weight, and each line is taxed on what is left of it.
 * Nothing marked: the base is the subtotal, exactly as before.
 *
 * A category with its own % (v0.7.50, shared-types website-category-discount:
 * Pizza 20% beside 10% off the rest) is a part of its own: its % rounded once
 * on its lines and spread over them, the main % on the food it left — the
 * till's offers engine, rule for rule. An order with none of its lines is
 * priced exactly as before.
 *
 * A price that includes its tax (0057, the menu's `taxIncluded`: the owner's
 * deal menu, "THE PRICE YOU SEE IS THE PRICE YOU PAY") adds none to the bill:
 * its tax is the part of what is left of it the rate makes up
 * (`includedTaxCents`, shown, never added) — pos-domain lineTaxOf.
 *
 * pricing.test.ts runs the POS's own functions next to these to keep the two
 * from drifting.
 */

export interface PricedLine {
  lineTotalCents: number;
  taxRateBps: number;
  /** Its menu item is marked no-discount (PublishedMenuItem.noDiscount): it takes no share of the %. */
  noDiscount?: boolean;
  /** Its menu item's category (the published menu's posCategoryId): a category with its own % (v0.7.50) prices it so. */
  categoryId?: string | null;
  /** Its price includes the tax (PublishedMenuItem.taxIncluded, 0057): it adds none to the bill. */
  taxIncluded?: boolean;
}

export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  /** The tax ADDED to the bill (total = subtotal − discount + tax). */
  taxCents: number;
  totalCents: number;
  /** The tax already inside the tax-included lines' prices (0057), shown, never added; absent with none. */
  includedTaxCents?: number;
  /**
   * v0.7.50: the parts the order carries to the till, when a category's own %
   * took something off (shared-types discountPartsToSend). Absent otherwise —
   * the totals are then exactly the one-% ones, as before.
   */
  discountParts?: WebDiscountPart[];
}

/** pos-domain computeDiscountCents, percent form. */
export function percentDiscountCents(subtotalCents: number, percent: number): number {
  if (subtotalCents <= 0) return 0;
  const pct = Math.max(0, Math.min(100, percent));
  return Math.min(Math.round((subtotalCents * pct) / 100), subtotalCents);
}

/**
 * pos-domain allocateDiscount: the discount split over the lines by weight in
 * whole paisa that add up to it exactly (largest remainder).
 */
export function allocateDiscount(lineTotalsCents: ReadonlyArray<number>, discountCents: number): number[] {
  const subtotal = lineTotalsCents.reduce((s, t) => s + Math.max(0, t), 0);
  if (subtotal <= 0 || discountCents <= 0) return lineTotalsCents.map(() => 0);
  const discount = Math.min(Math.round(discountCents), subtotal);
  const shares = lineTotalsCents.map((t) => Math.floor((discount * Math.max(0, t)) / subtotal));
  let left = discount - shares.reduce((s, x) => s + x, 0);
  const byRemainder = lineTotalsCents
    .map((t, i) => ({ i, t: Math.max(0, t), rem: (discount * Math.max(0, t)) % subtotal }))
    .sort((a, b) => b.rem - a.rem || b.t - a.t || a.i - b.i);
  for (const line of byRemainder) {
    if (left <= 0) break;
    if (shares[line.i]! < line.t) {
      shares[line.i] = shares[line.i]! + 1;
      left -= 1;
    }
  }
  return shares;
}

/**
 * Each line's weight in the split (pos-domain discountWeights): its total,
 * or 0 for a line marked no-discount. Their sum is what the % is worked on.
 */
export function discountWeights(lines: ReadonlyArray<PricedLine>): number[] {
  return lines.map((l) => (l.noDiscount === true ? 0 : l.lineTotalCents));
}

export function priceOrder(
  lines: PricedLine[],
  discountPercent = 0,
  categoryPercents: ReadonlyArray<WebsiteCategoryPercent> = [],
): OrderTotals {
  const own = cleanCategoryPercents(categoryPercents);
  if (own.length > 0) {
    const plans = websiteDiscountParts(lines, discountPercent, own);
    const parts = discountPartsToSend(plans);
    // A category part took something off: each part over its own lines, as the till's offers engine bills them.
    if (parts !== null) return priceByParts(lines, plans, parts);
  }
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const weights = discountWeights(lines);
  const discount = percentDiscountCents(weights.reduce((s, w) => s + w, 0), discountPercent);
  let tax = 0;
  let included = 0;
  if (subtotal > 0) {
    const shares = allocateDiscount(weights, discount);
    lines.forEach((line, i) => {
      const t = lineTax(line, shares[i] ?? 0);
      tax += t.added;
      included += t.included;
    });
  }
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
    ...(included > 0 ? { includedTaxCents: included } : {}),
  };
}

/**
 * One line's tax on what is left of it after its share (pos-domain lineTaxOf): added on top, or —
 * its price including the tax (0057) — the part of it the rate makes up, added to nothing.
 */
function lineTax(line: PricedLine, share: number): { added: number; included: number } {
  const net = Math.max(0, line.lineTotalCents - share);
  if (line.taxIncluded === true) {
    return { added: 0, included: net - Math.round((net * 10_000) / (10_000 + line.taxRateBps)) };
  }
  return { added: Math.round((net * line.taxRateBps) / 10_000), included: 0 };
}

/** The totals of an order whose discount came in parts (v0.7.50): each part spread over its own lines, each line taxed on what is left. */
function priceByParts(
  lines: ReadonlyArray<PricedLine>,
  plans: ReturnType<typeof websiteDiscountParts>,
  parts: WebDiscountPart[],
): OrderTotals {
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const shares = lines.map(() => 0);
  let discount = 0;
  for (const p of plans) {
    if (p.amountCents <= 0) continue;
    discount += p.amountCents;
    const weights = lines.map((l, i) => (p.lineIndexes.includes(i) ? l.lineTotalCents : 0));
    allocateDiscount(weights, p.amountCents).forEach((x, i) => {
      shares[i] = (shares[i] ?? 0) + x;
    });
  }
  let tax = 0;
  let included = 0;
  if (subtotal > 0) {
    lines.forEach((line, i) => {
      const t = lineTax(line, shares[i] ?? 0);
      tax += t.added;
      included += t.included;
    });
  }
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
    ...(included > 0 ? { includedTaxCents: included } : {}),
    discountParts: parts,
  };
}
