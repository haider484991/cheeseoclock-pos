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

/**
 * Why the Discount dialog was opened: 'change' (F3, the discount line, Add
 * discount) or 'removeDeal' (the × on the owner's foodpanda deal line — the
 * deal comes off only with a manager's PIN, so the dialog asks for it).
 */
export type DiscountDialogIntent = 'change' | 'removeDeal';

/** The order's discount as the dialog sees it (the snapshot's latest discount row). */
export interface CurrentDiscount {
  discountType: 'percent' | 'flat';
  value: number;
  reason: string | null;
  source?: string | null;
}

/**
 * Where the Discount dialog starts. A staff discount opens on itself (its
 * choice and its reason), so a tap changes it. The owner's foodpanda deal
 * opens on NOTHING: re-applying its own % would turn the deal into a staff
 * discount without its minimum and most-off, under the manager's name — and
 * its label ("Foodpanda deal 20% off") is not the reason for any other
 * discount a manager types in its place.
 */
export function discountDialogStart(current: CurrentDiscount | null): { picked: DiscountChoice | null; reason: string } {
  if (!current || current.source === 'foodpanda') return { picked: null, reason: '' };
  return { picked: { type: current.discountType, value: current.value }, reason: current.reason ?? '' };
}

/**
 * What Enter (and the big button) does: take the deal off when the dialog
 * was opened from the deal's × and nothing else is picked; otherwise apply
 * the choice.
 */
export function discountDialogPrimary(p: { dealOn: boolean; intent: DiscountDialogIntent; hasChoice: boolean }): 'apply' | 'remove' {
  return p.dealOn && p.intent === 'removeDeal' && !p.hasChoice ? 'remove' : 'apply';
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
