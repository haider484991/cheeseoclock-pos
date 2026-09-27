/**
 * What-if (costing spec 4.9, Phase 9): try new ingredient prices and new
 * menu prices and see what they do per week — pure, so it is tested; NOTHING
 * here writes a price anywhere. The till prints the answer as a "price
 * change list" for whoever keeps the costing sheet, the printed menu and the
 * website.
 *
 *  - An ingredient's new price flows through everything made from it: the
 *    batches are rolled up again (effectivePrices), so a dearer cheese moves
 *    the Cheese Mix and every pizza with it.
 *  - Each dish's typical plate is costed before and after at the same
 *    customer picks (the last 4 weeks' mix), and its typical price with the
 *    new menu price.
 *  - Per week = n̄ × (what one sale earns after − before), n̄ = the average
 *    week of the last 4 (a quarter of the last 28 days' units), one rounding.
 *  - A menu price change also says how far sales could move before it stops
 *    paying (break-even volume, 4.8).
 */
import { breakEvenVolumeBps } from './menu-engineering.js';
import { batchesUsing, effectivePrices, type BatchInputLine, type EffectivePrice, type PricedIngredient } from './ingredient-price.js';
import { plateCost, priceToHitTarget, type PickMix, type PlateCost, type PlateGroup, type PriceOf } from './plate-cost.js';
import type { RecipeLine } from './recipe-expand.js';
import type { Pack } from './units.js';

function divRound(n: bigint, d: bigint): number {
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const q = (2n * mag + d) / (2n * d);
  return Number(neg ? -q : q);
}

export interface WhatIfDishInput {
  id: string;
  basePriceCents: number;
  recipe: readonly RecipeLine[];
  groups: readonly PlateGroup[];
  /** The customers' picks over the last 4 weeks (null: none sold — the usual fallback). */
  mix: PickMix | null;
  /** Units sold in the last 28 days. */
  unitsLast28: number;
  /** Its category's food-cost target (bps), for the price that hits it. */
  targetBps: number;
}

export interface WhatIfChanges {
  /** New prices to try, as a pack per ingredient. */
  packs: ReadonlyMap<string, Pack>;
  /** New menu prices to try (the item's own price, before tax). */
  basePrices: ReadonlyMap<string, number>;
}

export interface WhatIfPrices {
  before: ReadonlyMap<string, EffectivePrice>;
  after: ReadonlyMap<string, EffectivePrice>;
  /** The ingredients typed, and every batch made from them (directly or through another batch). */
  moved: string[];
}

/**
 * Every ingredient's price before and with the prices tried. A typed price
 * is used as it is — also for something made in-house (its own recipe is
 * then set aside for the what-if) — and marked as a real price ('set').
 */
export function whatIfPrices(
  ingredients: readonly PricedIngredient[],
  batchLines: ReadonlyMap<string, readonly BatchInputLine[]>,
  packs: ReadonlyMap<string, Pack>,
  before: ReadonlyMap<string, EffectivePrice> = effectivePrices(ingredients, batchLines),
): WhatIfPrices {
  if (packs.size === 0) return { before, after: before, moved: [] };
  const tried = ingredients.map((i) => {
    const p = packs.get(i.id);
    return p ? { ...i, packSize: p.size, packPriceCents: p.priceCents, costPerUnitCents: 0, priceKind: 'set' as const } : i;
  });
  const lines = new Map([...batchLines].filter(([id]) => !packs.has(id)));
  const after = effectivePrices(tried, lines);
  const typed = [...packs.keys()].filter((id) => ingredients.some((i) => i.id === id));
  return { before, after, moved: [...typed, ...batchesUsing(typed, lines).filter((id) => !packs.has(id))] };
}

/** A price map as a PriceOf. */
export function priceOfPrices(prices: ReadonlyMap<string, EffectivePrice>): PriceOf {
  return (id) => {
    const p = prices.get(id);
    return p ? { pack: p.pack, kind: p.kind } : undefined;
  };
}

export interface WhatIfDish {
  id: string;
  before: PlateCost;
  after: PlateCost;
  newBasePriceCents: number;
  /** Units a week, tenths (12.5 = 125). */
  weeklyUnitsTenths: number;
  /** Per week at the same sales: above 0 the shop keeps more. */
  weekCents: number;
  /** A menu price change only: break-even volume, bps (null: no volume makes up for it, or no price change). */
  breakEvenBps: number | null;
  /** The item's own price that brings it to its target at the costs after (null: can't be worked out). */
  priceToHitCents: number | null;
  /** Its price or its cost moves. */
  changed: boolean;
}

/** Units a week from the last 28 days' units: a quarter, in tenths. */
export function weeklyUnitsTenths(unitsLast28: number): number {
  return unitsLast28 > 0 ? divRound(BigInt(unitsLast28) * 10n, 4n) : 0;
}

/**
 * What a change to one sale's earnings comes to per week (costing spec 4.9):
 * n̄ × ((price after − cost after) − (price before − cost before)), n̄ a
 * quarter of the last 28 days' units. Millicents in, paisa out, one rounding.
 */
export function whatIfWeekCents(unitsLast28: number, before: { priceMc: number; costMc: number }, after: { priceMc: number; costMc: number }): number {
  if (!(unitsLast28 > 0)) return 0;
  const delta = after.priceMc - after.costMc - (before.priceMc - before.costMc);
  return divRound(BigInt(unitsLast28) * BigInt(delta), 4_000n);
}

/** One dish, before and with the changes (see the file comment). */
export function whatIfDish(dish: WhatIfDishInput, prices: WhatIfPrices, changes: WhatIfChanges, stepCents: number): WhatIfDish {
  const newBase = changes.basePrices.get(dish.id) ?? dish.basePriceCents;
  const input = { basePriceCents: dish.basePriceCents, recipe: dish.recipe, groups: dish.groups, mix: dish.mix };
  const before = plateCost(input, priceOfPrices(prices.before));
  const after = prices.after === prices.before && newBase === dish.basePriceCents ? before : plateCost({ ...input, basePriceCents: newBase }, priceOfPrices(prices.after));
  const priceChanged = newBase !== dish.basePriceCents;
  const changed = priceChanged || after.typicalCostMc !== before.typicalCostMc;
  return {
    id: dish.id,
    before,
    after,
    newBasePriceCents: newBase,
    weeklyUnitsTenths: weeklyUnitsTenths(dish.unitsLast28),
    weekCents: whatIfWeekCents(
      dish.unitsLast28,
      { priceMc: before.typicalPriceMc, costMc: before.typicalCostMc },
      { priceMc: after.typicalPriceMc, costMc: after.typicalCostMc },
    ),
    breakEvenBps: priceChanged
      ? breakEvenVolumeBps(
          after.typicalPriceMc - after.typicalCostMc - (before.typicalPriceMc - before.typicalCostMc),
          before.typicalPriceMc - before.typicalCostMc,
        )
      : null,
    priceToHitCents: after.hasRecipe && after.missingLines === 0 ? priceToHitTarget(after.typicalCostMc, dish.targetBps, after.groupsPriceMc, stepCents) : null,
    changed,
  };
}
