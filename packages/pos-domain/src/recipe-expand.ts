/**
 * Which recipe lines one order line uses (costing spec 4.2): ONE pure
 * function for the stock taken at the kitchen, the cost kept with a sale
 * (Phase 2) and the plate cost on the Costing page, so the three never
 * disagree. It is an exact mirror of the stock SQL in decrementForOrder
 * (stock-movement-repo.ts), tested against it on a real database:
 *
 *  - every line with no choice, plus the lines of each choice picked (a
 *    choice's lines count once per order line, however many times it is
 *    picked — as the SQL's EXISTS does);
 *  - a "leave out" pick ("No onion") keeps that ingredient off: its lines
 *    with no choice, and the lines of a FREE choice that brings it (a deal's
 *    pizza, a veggie pick). A paid extra the customer asked for ("Extra
 *    onion", above Rs 0) is still used.
 */

/** A recipe line: `qtyPerUnit` base units per ONE sold, always or only with `modifierId` picked. */
export interface RecipeLine {
  ingredientId: string;
  qtyPerUnit: number;
  modifierId: string | null;
}

/** A choice picked on the order line. */
export interface PickedChoice {
  modifierId: string;
  /** The price the choice was sold at (the order line's copy). */
  priceDeltaCents: number;
  /** A "leave out" choice: the ingredient it takes off. */
  removesIngredientId: string | null;
}

/** The part of a line an amount belongs to: every sale, or a choice. */
export const BASE_PART = 'base';

export interface ExpandedLine {
  ingredientId: string;
  /** qtyPerUnit × the order line's quantity. */
  qty: number;
  /** BASE_PART, or the id of the choice that brought it. */
  part: string;
}

export function expandRecipe(
  lines: readonly RecipeLine[],
  picks: readonly PickedChoice[],
  quantity: number,
): ExpandedLine[] {
  const picked = new Set<string>();
  const pickedFree = new Set<string>();
  const removed = new Set<string>();
  for (const p of picks) {
    picked.add(p.modifierId);
    if (p.priceDeltaCents <= 0) pickedFree.add(p.modifierId);
    if (p.removesIngredientId) removed.add(p.removesIngredientId);
  }
  const out: ExpandedLine[] = [];
  for (const r of lines) {
    if (r.modifierId !== null && !picked.has(r.modifierId)) continue;
    if (removed.has(r.ingredientId) && (r.modifierId === null || pickedFree.has(r.modifierId))) continue;
    out.push({ ingredientId: r.ingredientId, qty: r.qtyPerUnit * quantity, part: r.modifierId ?? BASE_PART });
  }
  return out;
}

/** The amounts per ingredient, all parts together (what the stock movement takes). */
export function totalsByIngredient(lines: readonly ExpandedLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.ingredientId, (out.get(l.ingredientId) ?? 0) + l.qty);
  return out;
}
