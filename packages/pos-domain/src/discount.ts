import { DEFAULT_DISCOUNT_APPROVAL, type ApprovalLimits, type Cents } from '@cheeseoclock/shared-types';
import { formatCents } from './money.js';

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

/**
 * Does this discount need a manager's PIN or password? THE one rule: the F3
 * screen's locks (limits from checkout:getRules), the IPC check and the
 * repository's save and cart-change re-check (both read the live
 * 'discounts.approval' setting in the main process) all call it, so they
 * can't disagree.
 *
 * A percent over `limits.percentOver` does. A flat amount does when it is
 * over `limits.flatOverCents` — or, given the order's subtotal, when it is
 * more than the same percent of that order (Rs 499 off a Rs 600 order is 83%
 * off and must not slip through as "under Rs 500"). A limit of 0 means every
 * discount of that kind needs a manager (a % limit of 0 holds rupee amounts
 * to 0% of the order too).
 *
 * `limits` defaults to the released default (10%, Rs 500) only for callers
 * that have no setting to hand (tests of today's numbers); every till path
 * passes the live setting (pinned by apps/pos
 * electron/ipc/handlers/owner-rules.db.test.ts).
 */
export function requiresManagerApproval(
  d: DiscountInput,
  subtotalCents?: Cents | number,
  limits: ApprovalLimits = DEFAULT_DISCOUNT_APPROVAL,
): boolean {
  if (d.type === 'percent') return d.value > limits.percentOver;
  if (d.value > limits.flatOverCents) return true;
  const subtotal = subtotalCents === undefined ? undefined : (subtotalCents as number);
  return subtotal !== undefined && subtotal > 0 && d.value * 100 > subtotal * limits.percentOver;
}

/**
 * The approval rule in plain words, built from the limits (the F3 screen,
 * the refusal): "Up to 10% off, or up to Rs 500 off if that is no more than
 * 10% of the order, without a manager." `of` is what the limit is checked
 * on, the same amount the discount is worked on: 'food' on an order with a
 * delivery charge a discount leaves alone (Settings → Money & discounts:
 * "A discount also comes off the delivery charge" No), so the words match
 * the lock — Rs 210 off Rs 2,000 of food and a Rs 200 charge is over 10% of
 * the food, though under 10% of the order.
 */
export function approvalRuleText(limits: ApprovalLimits, of: 'order' | 'food' = 'order'): string {
  const p = limits.percentOver;
  if (p === 0) return "Every discount needs a manager's PIN or password.";
  if (limits.flatOverCents === 0) {
    return `Up to ${p}% off${of === 'food' ? ' the food' : ''} without a manager. More, or any amount off in rupees, needs a manager's PIN or password.`;
  }
  return `Up to ${p}% off, or up to ${formatCents(limits.flatOverCents)} off if that is no more than ${p}% of the ${of}, without a manager. More needs a manager's PIN or password.`;
}

/**
 * The most a cashier can take off this order without a manager, in rupees:
 * the smaller of the rupee limit and the % limit of the order (for the
 * worked example on Settings → Money & discounts).
 */
export function mostOffWithoutManagerCents(limits: ApprovalLimits, subtotalCents: number): number {
  if (!(subtotalCents > 0)) return 0;
  return Math.min(limits.flatOverCents, Math.floor((subtotalCents * limits.percentOver) / 100));
}

/**
 * The weights a discount is split by: `masked` (a line the discount leaves
 * alone — a delivery charge — weighing 0), unless the discount is more than
 * those lines can carry. One worked on the food never is (it is at most the
 * food, and the paid bill is stored that way); only a till older than the
 * delivery-charge rule (0.7.25 or before) can store one, by re-working a
 * food-only discount over every line on a cart change and leaving the row's
 * rule as it found it. It is split over every line then (`totals`), as that
 * till split it, so the shares still add up to the stored discount.
 */
export function weightsThatCarry(
  totals: ReadonlyArray<number>,
  masked: ReadonlyArray<number>,
  discountCents: number,
): ReadonlyArray<number> {
  const carry = masked.reduce((s, w) => s + Math.max(0, w), 0);
  return Math.round(discountCents) > carry ? totals : masked;
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
