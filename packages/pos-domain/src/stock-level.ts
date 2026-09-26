/**
 * How much of an ingredient there is, said the way the kitchen says it:
 * "12.5 kg", not "12500 g"; "Low" or "Out", not a number to compare in your
 * head. Pure, so the stock screen and reports agree.
 */

export type StockStatus = 'out' | 'low' | 'ok';

interface Stocked {
  currentQty: number;
  lowThreshold: number;
}

/** Out at zero or below; low at or under the low-stock level; otherwise fine. */
export function stockStatus(i: Stocked): StockStatus {
  if (i.currentQty <= 0) return 'out';
  if (i.currentQty <= i.lowThreshold) return 'low';
  return 'ok';
}

/**
 * 0…1 for a stock bar: the low-stock level sits a third of the way along, so
 * a full bar means "three times what you call low". With no low level set, a
 * bar is full while there is any stock at all.
 */
export function stockFill(i: Stocked): number {
  if (i.currentQty <= 0) return 0;
  if (i.lowThreshold <= 0) return 1;
  return Math.min(1, i.currentQty / (i.lowThreshold * 3));
}

/**
 * Sort key for "lowest stock first": out, then low, then fine — and inside
 * each, the one closest to (or furthest under) its low level first. Units
 * differ between ingredients, so raw quantities cannot be compared; how many
 * "low levels" are left can.
 */
export function stockUrgency(i: Stocked): number {
  const rank = { out: 0, low: 1, ok: 2 }[stockStatus(i)];
  const cover = i.lowThreshold > 0 ? i.currentQty / i.lowThreshold : i.currentQty > 0 ? 1e6 : 0;
  // rank dominates; cover orders inside a rank (capped so it never crosses ranks)
  return rank * 1e7 + Math.max(-1e6, Math.min(cover, 1e6));
}

/**
 * What the stock on hand is worth, in paisa: from the pack price when there
 * is one (exact — "6,000 g for Rs 2,250"), else the per-unit cost. Stock
 * below zero is worth nothing, not a negative amount.
 */
export function stockValueCents(i: {
  currentQty: number;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
}): number {
  const qty = Math.max(0, i.currentQty);
  if (i.packSize && i.packSize > 0 && i.packPriceCents !== null) {
    return Math.round((qty * i.packPriceCents) / i.packSize);
  }
  return qty * i.costPerUnitCents;
}

const whole = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const upToTwo = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 });

/**
 * A quantity in its unit, in the biggest unit that reads well:
 * 12500 g → "12.5 kg", 750 g → "750 g", 1500 ml → "1.5 L", 40 pcs → "40 pcs".
 */
export function formatQty(qty: number, unit: string): string {
  const abs = Math.abs(qty);
  if (unit === 'g' && abs >= 1000) return `${upToTwo.format(qty / 1000)} kg`;
  if (unit === 'ml' && abs >= 1000) return `${upToTwo.format(qty / 1000)} L`;
  return `${whole.format(qty)} ${unit}`;
}
