/**
 * What stops the till costing the menu (costing spec, Costing → Missing
 * costs): each list is something a manager can fix in a minute, so the page
 * can reach zero.
 *   (a) ingredients used in recipes with no price ('unset');
 *   (b) food items with no recipe;
 *   (c) prices that are a guess ('estimate');
 *   (d) a per-gram / per-ml price rounded to whole paisa, with no pack
 *       (Rs 0.375 / g stored as 38 paisa): re-enter it per kg;
 *   (e) batches with inputs that have no price.
 * A price of Rs 0 marked 'free' is a known price and is never listed.
 * A dish that is off the menu (hidden on the till and not sold in the
 * window) counts nowhere: nobody sells it, so it must not keep the lists
 * from reaching zero.
 */

import type { PriceKind } from '@cheeseoclock/shared-types';
import { batchClosure, type BatchInputLine, type EffectivePrice, type PricedIngredient } from './ingredient-price.js';
import { shareBps } from './units.js';

export interface CostingMenuItem {
  id: string;
  name: string;
  categoryId: string;
  /** Every recipe line's ingredient (any choice). */
  ingredientIds: readonly string[];
  /** Item sales over the window (line totals), paisa. */
  salesCents: number;
  /** False for a retired dish (hidden on the till, not sold in the window): left out of every list. Default true. */
  onMenu?: boolean;
}

export interface MissingIngredient {
  ingredientId: string;
  /** Items using it, directly or through a batch. */
  itemIds: string[];
  salesShareBps: number | null;
}

export interface MissingCostLists {
  unpriced: MissingIngredient[];
  noRecipe: string[];
  guessed: MissingIngredient[];
  roundedPerGram: MissingIngredient[];
  batches: Array<{ ingredientId: string; unpricedInputIds: string[]; loop: boolean }>;
}

/** A stored per-gram (per-ml) price with no pack: rounded to whole paisa when it was saved. */
export function isRoundedPerGram(i: Pick<PricedIngredient, 'unit' | 'packSize' | 'packPriceCents' | 'costPerUnitCents'>): boolean {
  const pack = !!i.packSize && i.packSize > 0 && i.packPriceCents !== null;
  return !pack && (i.unit === 'g' || i.unit === 'ml') && i.costPerUnitCents > 0;
}

export function findMissingCosts(input: {
  ingredients: readonly PricedIngredient[];
  prices: ReadonlyMap<string, EffectivePrice>;
  batchLines: ReadonlyMap<string, readonly BatchInputLine[]>;
  items: readonly CostingMenuItem[];
  nonFoodCategoryIds: ReadonlySet<string>;
}): MissingCostLists {
  const food = input.items.filter((i) => i.onMenu !== false && !input.nonFoodCategoryIds.has(i.categoryId));
  const totalSales = food.reduce((s, i) => s + i.salesCents, 0);

  // Which items reach each ingredient (through batches too).
  const usedBy = new Map<string, Set<string>>();
  for (const item of food) {
    for (const direct of new Set(item.ingredientIds)) {
      for (const id of batchClosure(direct, input.batchLines)) {
        let s = usedBy.get(id);
        if (!s) usedBy.set(id, (s = new Set()));
        s.add(item.id);
      }
    }
  }
  const salesOf = new Map(food.map((i) => [i.id, i.salesCents]));
  const row = (ingredientId: string): MissingIngredient => {
    const itemIds = [...(usedBy.get(ingredientId) ?? [])];
    const sales = itemIds.reduce((s, id) => s + (salesOf.get(id) ?? 0), 0);
    return { ingredientId, itemIds, salesShareBps: shareBps(sales, totalSales) };
  };
  const bySales = (a: MissingIngredient, b: MissingIngredient) =>
    (b.salesShareBps ?? -1) - (a.salesShareBps ?? -1) || b.itemIds.length - a.itemIds.length;

  const unpriced: MissingIngredient[] = [];
  const guessed: MissingIngredient[] = [];
  const roundedPerGram: MissingIngredient[] = [];
  const batches: MissingCostLists['batches'] = [];
  for (const ing of input.ingredients) {
    const p = input.prices.get(ing.id);
    const isBatch = !!p?.batch;
    if (isBatch && p?.batch && !p.batch.complete) {
      batches.push({ ingredientId: ing.id, unpricedInputIds: p.batch.unpricedInputIds, loop: p.batch.loop });
    }
    if (!usedBy.has(ing.id)) continue;
    const kind: PriceKind = p?.kind ?? ing.priceKind;
    // A made-in-house ingredient is fixed through its inputs (list e), not priced itself.
    if (kind === 'unset' && !isBatch) unpriced.push(row(ing.id));
    if (kind === 'estimate' && !isBatch) guessed.push(row(ing.id));
    if (!isBatch && ing.priceKind !== 'unset' && isRoundedPerGram(ing)) roundedPerGram.push(row(ing.id));
  }

  const noRecipe = food.filter((i) => i.ingredientIds.length === 0).map((i) => i.id);
  return {
    unpriced: unpriced.sort(bySales),
    noRecipe,
    guessed: guessed.sort(bySales),
    roundedPerGram: roundedPerGram.sort(bySales),
    batches,
  };
}
