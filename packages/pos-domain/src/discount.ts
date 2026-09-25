import type { Cents } from '@cheeseoclock/shared-types';

export type DiscountType = 'percent' | 'flat';

export interface DiscountInput {
  type: DiscountType;
  /** For 'percent': 0-100. For 'flat': cents. */
  value: number;
}

/**
 * Compute the discount amount in cents for a given subtotal.
 * Caps the discount at the subtotal (no negative totals).
 */
export function computeDiscountCents(subtotalCents: Cents | number, d: DiscountInput): Cents {
  const subtotal = subtotalCents as number;
  if (subtotal <= 0) return 0 as Cents;
  let amount = 0;
  if (d.type === 'percent') {
    const pct = Math.max(0, Math.min(100, d.value));
    amount = Math.round((subtotal * pct) / 100);
  } else {
    amount = Math.max(0, Math.round(d.value));
  }
  return Math.min(amount, subtotal) as Cents;
}

/** Discount threshold beyond which manager approval is required (configurable later). */
export const MANAGER_APPROVAL_PERCENT_THRESHOLD = 10;
export const MANAGER_APPROVAL_FLAT_CENTS_THRESHOLD = 50_000; // PKR 500

/**
 * Does this discount need a manager's PIN? A percent over the threshold does.
 * A flat amount does when it is over Rs 500 — or, given the order's subtotal,
 * when it is more than the same threshold percent of that order (Rs 499 off a
 * Rs 600 order is 83% off and must not slip through as "under Rs 500").
 */
export function requiresManagerApproval(d: DiscountInput, subtotalCents?: Cents | number): boolean {
  if (d.type === 'percent') return d.value > MANAGER_APPROVAL_PERCENT_THRESHOLD;
  if (d.value > MANAGER_APPROVAL_FLAT_CENTS_THRESHOLD) return true;
  const subtotal = subtotalCents === undefined ? undefined : (subtotalCents as number);
  return (
    subtotal !== undefined &&
    subtotal > 0 &&
    d.value * 100 > subtotal * MANAGER_APPROVAL_PERCENT_THRESHOLD
  );
}

/**
 * Split an order-level discount over its lines by weight, in whole paisa, so
 * the pieces add up to the discount exactly. Rounding each line on its own
 * (Rs 1 over three equal lines = 33 + 33 + 33) lost or invented a paisa, and
 * the per-line figures the tax and the FBR invoice are built from no longer
 * summed to the discount on the bill. The paisa left after flooring go to the
 * lines with the biggest remainders (ties: the bigger line, then the earlier).
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
