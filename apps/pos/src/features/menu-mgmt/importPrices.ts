/**
 * The menu import's price details (costing spec Phase 6): behind the ONE
 * summary line, each ingredient grouped by what happens to its price — the
 * till's price beside the sheet's. Pure, so the wording is tested.
 */
import { hasPrice } from '@cheeseoclock/pos-domain';
import type { MenuImportIngredientPlan, MenuImportPriceOutcome } from '@cheeseoclock/shared-types';
import { formatUnitPrice } from '../costing/costingFormat';

const GROUPS: Array<{ title: string; outcomes: MenuImportPriceOutcome[] }> = [
  { title: 'New from the sheet', outcomes: ['new_from_sheet'] },
  { title: 'Kept from deliveries', outcomes: ['kept_delivery'] },
  { title: 'Kept as typed', outcomes: ['kept_typed'] },
  { title: 'Kept as they are', outcomes: ['kept', 'kept_free'] },
  { title: 'Worked out from their batch recipe', outcomes: ['made_here'] },
  { title: 'Batches that keep their price (something in them has no price)', outcomes: ['batch_kept'] },
  { title: 'Still no price', outcomes: ['unpriced'] },
];

/** The ingredients by what happens to their price; within a group, the ones whose sheet price differs first. */
export function priceDetailGroups(rows: readonly MenuImportIngredientPlan[]): Array<{ title: string; rows: MenuImportIngredientPlan[] }> {
  return GROUPS.map((g) => ({
    title: g.title,
    rows: rows
      .filter((r) => r.price !== null && g.outcomes.includes(r.price))
      .sort((a, b) => Number(b.sheetDiffers) - Number(a.sheetDiffers) || (a.existingName ?? a.name).localeCompare(b.existingName ?? b.name)),
  })).filter((g) => g.rows.length > 0);
}

/** "till Rs 1,770 / kg", "till: free", "till: no price", "new" (not on the till yet). */
export function tillPriceText(r: Pick<MenuImportIngredientPlan, 'tillPrice' | 'unit' | 'price' | 'action'>): string {
  if (r.price === 'kept_free') return 'till: free';
  if (!r.tillPrice) return r.action === 'create' ? 'new' : 'till: no price';
  return `till ${formatUnitPrice(r.tillPrice.unitCostMc, r.unit)}`;
}

/** "sheet Rs 1,500 / kg", "sheet: Rs 0 (no price)". */
export function sheetPriceText(r: Pick<MenuImportIngredientPlan, 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'sheetUnitCostMc' | 'unit'>): string {
  if (!hasPrice(r)) return 'sheet: Rs 0 (no price)';
  return `sheet ${formatUnitPrice(r.sheetUnitCostMc, r.unit)}`;
}
