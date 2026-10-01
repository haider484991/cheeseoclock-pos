/**
 * Food-cost targets per menu category (costing spec 4.3). Until the owner
 * says otherwise the till SUGGESTS a target from the category's name; a
 * suggestion shows the food cost % uncoloured ("target not confirmed") until
 * the owner taps "Use these" on the Targets screen, so nothing is called
 * red on a number nobody chose.
 */

import { VALUE_DEALS_NAME_RE, type CostingTargets } from '@cheeseoclock/shared-types';

/** Any category the names below don't place. */
export const DEFAULT_TARGET_BPS = 3000;
/** Up to 5 points over the target counts as "close". */
export const DEFAULT_AMBER_BPS = 500;
/** Prices are suggested in Rs 10 steps. */
export const DEFAULT_PRICE_STEP_CENTS = 1000;

const SUGGESTIONS: Array<[RegExp, number]> = [
  [/\bdrinks?\b|\bbeverages?\b/i, 6000],
  [/\bdips?\b|\bsauces?\b/i, 3000],
  // Value deals: the one deals rule, the same name test as "never discounted" (shared-types categoryNeverDiscounted).
  [VALUE_DEALS_NAME_RE, 3500],
  [/\bburgers?\b/i, 3500],
  [/\bfries\b|\bsides?\b/i, 3500],
  [/\bpizzas?\b/i, 3000],
];

/** The suggested target for a category, by its name: Pizza 30%, Burgers 35%, Fries & Sides 35%, Value Deals 35%, Dips 30%, Drinks 60%. */
export function suggestedTargetBps(categoryName: string, defaultBps = DEFAULT_TARGET_BPS): number {
  for (const [re, bps] of SUGGESTIONS) if (re.test(categoryName)) return bps;
  return defaultBps;
}

/** A category that is not food by its name ("Delivery Charges"): no food cost. */
export function suggestedNonFood(categoryName: string): boolean {
  return /\bdeliver(y|ies)\b/i.test(categoryName) && /\bcharges?\b|\bfees?\b/i.test(categoryName);
}

export interface ResolvedTarget {
  bps: number;
  suggestedBps: number;
  confirmed: boolean;
  nonFood: boolean;
}

export interface ResolvedTargets {
  defaultBps: number;
  amberBps: number;
  byCategory: Map<string, ResolvedTarget>;
}

/**
 * The targets in force: what was saved, and for any category with nothing
 * saved (all of them, before the first save) the suggestion, unconfirmed.
 * Which categories are not food: the saved list once there is one, else the
 * guess from the names.
 */
export function resolveTargets(
  saved: CostingTargets | null,
  categories: ReadonlyArray<{ id: string; name: string }>,
): ResolvedTargets {
  const defaultBps = saved?.defaultBps ?? DEFAULT_TARGET_BPS;
  const amberBps = saved?.amberBps ?? DEFAULT_AMBER_BPS;
  const nonFood = saved ? new Set(saved.nonFoodCategoryIds) : null;
  const byCategory = new Map<string, ResolvedTarget>();
  for (const c of categories) {
    const suggestedBps = suggestedTargetBps(c.name, defaultBps);
    const mine = saved?.perCategory[c.id];
    byCategory.set(c.id, {
      bps: mine?.bps ?? suggestedBps,
      suggestedBps,
      confirmed: mine?.confirmed ?? false,
      nonFood: nonFood ? nonFood.has(c.id) : suggestedNonFood(c.name),
    });
  }
  return { defaultBps, amberBps, byCategory };
}

/**
 * "Use these": every category's target as shown now, confirmed. What the
 * Targets screen saves when the owner accepts the suggestions.
 */
export function confirmAll(resolved: ResolvedTargets): CostingTargets {
  const perCategory: CostingTargets['perCategory'] = {};
  const nonFoodCategoryIds: string[] = [];
  for (const [id, t] of resolved.byCategory) {
    perCategory[id] = { bps: t.bps, confirmed: true };
    if (t.nonFood) nonFoodCategoryIds.push(id);
  }
  return { defaultBps: resolved.defaultBps, amberBps: resolved.amberBps, perCategory, nonFoodCategoryIds };
}
