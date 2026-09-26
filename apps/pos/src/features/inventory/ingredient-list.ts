/**
 * Pure rules for the Ingredients list: what a search looks through, the
 * three sorts, the stock filter, and how much to reorder. Tested in
 * ingredient-list.test.ts.
 */

import type { Ingredient } from '@cheeseoclock/shared-types';
import { ingredientCategoryLabel, stockStatus, stockUrgency, stockValueCents } from '@cheeseoclock/pos-domain';
import { compareText } from '../../components/list/list-query';

export type IngredientSortKey = 'name' | 'stock' | 'value';
export type SortDirection = 'asc' | 'desc';
export interface IngredientSort {
  key: IngredientSortKey;
  dir: SortDirection;
}

/** The sorts offered in the "Sort by" pick, in the direction people want first. */
export const INGREDIENT_SORTS: ReadonlyArray<{ id: string; label: string; sort: IngredientSort }> = [
  { id: 'name', label: 'Name (A–Z)', sort: { key: 'name', dir: 'asc' } },
  { id: 'stock', label: 'Lowest stock first', sort: { key: 'stock', dir: 'asc' } },
  { id: 'value', label: 'Most stock value first', sort: { key: 'value', dir: 'desc' } },
];

/** Tapping a column header: same column flips direction, a new column starts its natural way. */
export function nextSort(current: IngredientSort, key: IngredientSortKey): IngredientSort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'value' ? 'desc' : 'asc' };
}

export function compareIngredients(sort: IngredientSort): (a: Ingredient, b: Ingredient) => number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return (a, b) => {
    let d = 0;
    if (sort.key === 'stock') d = stockUrgency(a) - stockUrgency(b);
    else if (sort.key === 'value') d = stockValueCents(a) - stockValueCents(b);
    // Name breaks ties in the same direction people read, whatever the sort.
    return d !== 0 ? sign * d : sort.key === 'name' ? sign * compareText(a.name, b.name) : compareText(a.name, b.name);
  };
}

export type StockFilter = 'all' | 'low' | 'out';

/** "Low" includes the ones that have run out — both need buying. */
export function matchesStockFilter(i: Ingredient, filter: StockFilter): boolean {
  if (filter === 'all') return true;
  const s = stockStatus(i);
  return filter === 'out' ? s === 'out' : s !== 'ok';
}

/** Everything someone might type to find an ingredient. */
export function ingredientSearchText(i: Ingredient, supplierName: string | undefined): string {
  return [
    i.name,
    ingredientCategoryLabel(i.category),
    i.sku ?? '',
    i.notes ?? '',
    supplierName ?? '',
    i.batchYield !== null ? 'made in house batch' : '',
  ].join(' · ');
}

/**
 * How much to put on a purchase order: enough to reach three times the
 * low-stock level (a full stock bar), rounded up to whole packs when the
 * ingredient is bought in packs. At least one unit (or pack).
 */
export function suggestReorderQty(i: Pick<Ingredient, 'currentQty' | 'lowThreshold' | 'packSize'>): number {
  const need = Math.max(1, i.lowThreshold * 3 - Math.max(0, i.currentQty));
  if (i.packSize && i.packSize > 0) return Math.ceil(need / i.packSize) * i.packSize;
  return need;
}
