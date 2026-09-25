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
