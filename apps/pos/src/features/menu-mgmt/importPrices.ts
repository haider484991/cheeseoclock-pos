/**
 * The menu import's price details (costing spec Phase 6): behind the ONE
 * summary line, each ingredient grouped by what happens to its price — the
 * till's price beside the sheet's. Pure, so the wording is tested.
 */
import { hasPrice } from '@cheeseoclock/pos-domain';
import type { MenuImportIngredientPlan, MenuImportPriceOutcome, MenuImportSummary } from '@cheeseoclock/shared-types';
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

/** The counts the question before an import reads. */
export type ImportQuestionCounts = Pick<
  MenuImportSummary,
  'newItems' | 'updatedItems' | 'priceChanges' | 'choicePriceChanges' | 'recipesSet' | 'newIngredients' | 'updatedIngredients' | 'priceLine' | 'keptLine'
>;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The question before an import (Menu → Import's own file, and a file from
 * the costing PC): what changes, then — plainly — which prices change to the
 * file's (menu item prices and choice charges, as far as the owner's import
 * rules let them: menu.importPolicy) and which stay the till's (ingredient
 * prices, except a new ingredient or one with no price yet, which takes the
 * file's; and whatever the owner's rules keep, in the "Kept on the till" line).
 */
export function importApplyQuestion(s: ImportQuestionCounts): string {
  const follow = [
    ...(s.priceChanges > 0 ? [count(s.priceChanges, 'menu item price', 'menu item prices')] : []),
    ...(s.choicePriceChanges > 0 ? [count(s.choicePriceChanges, 'choice charge', 'choice charges')] : []),
  ];
  return [
    'Apply this menu file?',
    `${count(s.newItems, 'new item', 'new items')}, ${s.updatedItems} ${s.updatedItems === 1 ? 'item' : 'items'} changed, ${count(s.recipesSet, 'recipe', 'recipes')}, ${s.newIngredients} new and ${s.updatedIngredients} changed ingredients.`,
    `Prices that change to the file’s: ${follow.length > 0 ? follow.join(' and ') : 'none'}.\nPrices that stay the till’s: every ingredient price, except a new ingredient or one with no price yet, which takes the file’s (the file’s price is kept beside the till’s in Inventory). ${s.priceLine}`,
    ...(s.keptLine ? [s.keptLine] : []),
  ].join('\n\n');
}

/** "sheet Rs 1,500 / kg", "sheet: Rs 0 (no price)". */
export function sheetPriceText(r: Pick<MenuImportIngredientPlan, 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'sheetUnitCostMc' | 'unit'>): string {
  if (!hasPrice(r)) return 'sheet: Rs 0 (no price)';
  return `sheet ${formatUnitPrice(r.sheetUnitCostMc, r.unit)}`;
}
