import { formatCents } from '@cheeseoclock/pos-domain';
import type { OrderDiscount } from '@cheeseoclock/shared-types';

/**
 * How the owner's foodpanda deal reads on the cart and at Pay — also when it
 * takes nothing off the shop's bill: foodpanda pays all of it ("foodpanda
 * does" on the card), or the order is still under the deal's minimum. The
 * cashier always sees the deal is on the order (and why a discount needs a
 * manager), never a bare "Add discount".
 */
export interface DealLineText {
  /** The deal's own words: "Foodpanda deal 20% off (your part 10%)". */
  label: string;
  /** A smaller second line: foodpanda's part, or from how much the deal starts; null = nothing to add. */
  note: string | null;
}

export function foodpandaDealLine(
  d: Pick<OrderDiscount, 'reason' | 'amountCents' | 'foodpanda'>,
  subtotalCents: number,
): DealLineText {
  const fp = d.foodpanda ?? null;
  const label = d.reason?.trim() || (fp ? `Foodpanda deal ${fp.dealPercent}% off` : 'Foodpanda deal');
  if (!fp) return { label, note: null };
  if (fp.dealCents <= 0) {
    const min = fp.minOrderCents ?? null;
    return {
      label,
      note: min !== null && subtotalCents < min ? `Takes off from ${formatCents(min)} of food` : null,
    };
  }
  if (fp.platformCents <= 0) return { label, note: null };
  return {
    label,
    note:
      (d.amountCents as number) > 0
        ? `foodpanda pays another ${formatCents(fp.platformCents)}`
        : `foodpanda pays ${formatCents(fp.platformCents)} of the deal`,
  };
}
