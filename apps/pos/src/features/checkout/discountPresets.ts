import {
  allocateDiscount,
  computeDiscountCents,
  computeTax,
  formatCents,
  requiresManagerApproval,
} from '@cheeseoclock/pos-domain';

/**
 * The discount screen's one-tap choices and the live "what will the bill be"
 * preview. The preview works the total out exactly as the till does when the
 * discount is saved (order-repo recomputeOrderTotals): the discount split over
 * the lines in whole paisa, tax on what is left of each line.
 */

/** A discount as the till stores it: percent 0–100, or a flat amount in cents. */
export interface DiscountChoice {
  type: 'percent' | 'flat';
  value: number;
}

/** One-tap percentages (owner, 2026-09-26). */
export const PERCENT_PRESETS = [10, 20, 25, 50, 100] as const;
/** One-tap flat amounts, in rupees. */
export const FLAT_PRESETS_RUPEES = [100, 200, 500] as const;
/** One-tap reasons; the reason prints on the bill and shows in the discount report. */
export const REASON_PRESETS = ['Staff', 'Friends & family', 'Regular customer', 'Complaint'] as const;

export function percentChoice(pct: number): DiscountChoice {
  return { type: 'percent', value: pct };
}
export function flatChoiceRupees(rupees: number): DiscountChoice {
  return { type: 'flat', value: Math.round(rupees * 100) };
}

export function sameChoice(a: DiscountChoice | null, b: DiscountChoice | null): boolean {
  return !!a && !!b && a.type === b.type && a.value === b.value;
}

/**
 * What the cashier typed in the "Other amount" box, as a discount — or null
 * when it is empty or not a usable amount. Percent is 0–100 (decimals allowed,
 * e.g. 12.5); rupees become whole paisa.
 */
export function parseDiscountEntry(kind: 'percent' | 'flat', text: string): DiscountChoice | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (kind === 'percent') {
    if (n > 100) return null;
    return { type: 'percent', value: Math.round(n * 100) / 100 };
  }
  return flatChoiceRupees(n);
}

/** "10% off", "Rs 200 off". */
export function describeDiscount(d: DiscountChoice): string {
  return d.type === 'percent' ? `${d.value}% off` : `${formatCents(d.value)} off`;
}

export interface DiscountPreview {
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Needs a manager's PIN (same rule the till enforces when saving). */
  needsApproval: boolean;
  /** A flat amount bigger than the order: only the order's worth comes off. */
  capped: boolean;
}

/**
 * The bill if `choice` were applied now. `lines` are the order's lines in
 * ticket order (their line totals and tax rates); `subtotalCents` is their sum.
 * With no choice it is the bill with no discount.
 */
export function previewDiscount(
  lines: ReadonlyArray<{ lineTotalCents: number; taxRateBps?: number }>,
  subtotalCents: number,
  choice: DiscountChoice | null,
): DiscountPreview {
  const discountCents = choice ? computeDiscountCents(subtotalCents, choice) : 0;
  let taxCents = 0;
  if (subtotalCents > 0) {
    const shares = allocateDiscount(
      lines.map((l) => l.lineTotalCents),
      discountCents,
    );
    lines.forEach((line, i) => {
      const net = Math.max(0, line.lineTotalCents - (shares[i] ?? 0));
      taxCents += computeTax(net, line.taxRateBps ?? 0, 'exclusive').taxCents as number;
    });
  }
  return {
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
    needsApproval: choice ? requiresManagerApproval(choice, subtotalCents) : false,
    capped: !!choice && choice.type === 'flat' && choice.value > subtotalCents,
  };
}
