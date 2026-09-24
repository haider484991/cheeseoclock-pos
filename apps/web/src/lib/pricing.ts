/**
 * Order totals the way the till computes them, so the estimate a customer
 * sees is the bill the rider or the counter asks for.
 *
 * Mirrors apps/pos (order-repo recomputeOrderTotals + pos-domain
 * computeDiscountCents / computeTax, exclusive tax): a percent discount is
 * rounded once on the subtotal, then spread over the lines by weight, and
 * each line is taxed on what is left of it. pricing.test.ts runs the POS's
 * own functions next to these to keep the two from drifting.
 */

export interface PricedLine {
  lineTotalCents: number;
  taxRateBps: number;
}

export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/** pos-domain computeDiscountCents, percent form. */
export function percentDiscountCents(subtotalCents: number, percent: number): number {
  if (subtotalCents <= 0) return 0;
  const pct = Math.max(0, Math.min(100, percent));
  return Math.min(Math.round((subtotalCents * pct) / 100), subtotalCents);
}

export function priceOrder(lines: PricedLine[], discountPercent = 0): OrderTotals {
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const discount = percentDiscountCents(subtotal, discountPercent);
  let tax = 0;
  if (subtotal > 0) {
    for (const line of lines) {
      const lineDiscount = Math.round(discount * (line.lineTotalCents / subtotal));
      const net = Math.max(0, line.lineTotalCents - lineDiscount);
      tax += Math.round((net * line.taxRateBps) / 10_000);
    }
  }
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
  };
}
