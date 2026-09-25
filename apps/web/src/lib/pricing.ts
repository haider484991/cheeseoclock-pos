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

export function priceOrder(lines: PricedLine[], discountPercent = 0): OrderTotals {
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const discount = percentDiscountCents(subtotal, discountPercent);
  let tax = 0;
  if (subtotal > 0) {
    const shares = allocateDiscount(lines.map((l) => l.lineTotalCents), discount);
    lines.forEach((line, i) => {
      const net = Math.max(0, line.lineTotalCents - (shares[i] ?? 0));
      tax += Math.round((net * line.taxRateBps) / 10_000);
    });
  }
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: subtotal - discount + tax,
  };
}
