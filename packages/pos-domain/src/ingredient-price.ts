/**
 * The price costing uses for each ingredient (costing spec 4.1,
 * effectiveUnitPrice): its stored price, or — for a sauce, dough or mix the
 * kitchen makes — the price rolled up from its inputs NOW, so a dearer
 * tomato shows in the pizza sauce and in every pizza at once. The plate cost
 * (Costing page) and, from Phase 2, the cost kept with each sale both read
 * this one function, so what the screen shows and what history keeps agree.
 */

import { PRICE_KINDS, type PriceKind } from '@cheeseoclock/shared-types';
import { effectivePack, lineCostMc, mcToCents, type Pack } from './units.js';

export interface PricedIngredient {
  id: string;
  name: string;
  unit: string;
  priceKind: PriceKind;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  /** Made in-house: one batch makes this many base units (null = bought in). */
  batchYield: number | null;
}

export interface BatchInputLine {
  inputId: string;
  /** How much ONE batch uses, in the input's base unit. */
  qty: number;
}

export interface BatchRollUp {
  /** Every input has a price (none 'unset', none missing, no loop). */
  complete: boolean;
  /** One batch's cost from its inputs now (unpriced inputs add nothing), paisa. */
  rolledCostCents: number;
  /** The same, unrounded, in millicents. */
  rolledCostMc: number;
  /** The price stored on the ingredient itself (the sheet's or a typed one). */
  storedPack: Pack;
  storedKind: PriceKind;
  /** Direct inputs with no price (or no longer there). */
  unpricedInputIds: string[];
  /** Direct inputs priced with a guess. */
  estimateInputIds: string[];
  /** Its inputs lead back to itself: it cannot be rolled up. */
  loop: boolean;
}

export interface EffectivePrice {
  pack: Pack;
  kind: PriceKind;
  /** 'batch': rolled up from its inputs; 'stored': the price on the ingredient. */
  source: 'stored' | 'batch';
  /** Only for an ingredient with a batch recipe. */
  batch: BatchRollUp | null;
}

/**
 * Every ingredient's effective price. A batch (yield Y, inputs j) is
 * complete when every input has a price; then its pack is
 * (Y, round(Σ_j round(qty_j × P_j × 1000 ÷ S_j) ÷ 1000)), worked bottom-up
 * through inputs made in-house too. An incomplete batch keeps its stored
 * price and is flagged. A loop (A needs B needs A) is guarded, never
 * followed round.
 */
export function effectivePrices(
  ingredients: readonly PricedIngredient[],
  batchLines: ReadonlyMap<string, readonly BatchInputLine[]>,
): Map<string, EffectivePrice> {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const done = new Map<string, EffectivePrice>();
  const onPath = new Set<string>();

  const resolve = (id: string): EffectivePrice | null => {
    const hit = done.get(id);
    if (hit) return hit;
    const ing = byId.get(id);
    if (!ing) return null;
    const stored: EffectivePrice = { pack: effectivePack(ing), kind: ing.priceKind, source: 'stored', batch: null };
    const lines = batchLines.get(id) ?? [];
    if (!ing.batchYield || ing.batchYield <= 0 || lines.length === 0) {
      done.set(id, stored);
      return stored;
    }
    onPath.add(id);
    let mc = 0;
    let loop = false;
    let allFree = true;
    const unpriced: string[] = [];
    const estimates: string[] = [];
    for (const l of lines) {
      if (onPath.has(l.inputId)) {
        loop = true;
        continue;
      }
      const p = resolve(l.inputId);
      if (!p || p.kind === 'unset') {
        unpriced.push(l.inputId);
        allFree = false;
        continue;
      }
      if (p.kind === 'estimate') estimates.push(l.inputId);
      if (p.kind !== 'free') allFree = false;
      mc += lineCostMc(l.qty, p.pack);
    }
    onPath.delete(id);
    const complete = !loop && unpriced.length === 0;
    const rolledCostCents = mcToCents(mc);
    const batch: BatchRollUp = {
      complete,
      rolledCostCents,
      rolledCostMc: mc,
      storedPack: stored.pack,
      storedKind: stored.kind,
      unpricedInputIds: unpriced,
      estimateInputIds: estimates,
      loop,
    };
    const out: EffectivePrice = complete
      ? {
          pack: { size: ing.batchYield, priceCents: rolledCostCents },
          kind: estimates.length > 0 ? 'estimate' : allFree && rolledCostCents === 0 ? 'free' : 'set',
          source: 'batch',
          batch,
        }
      : { ...stored, batch };
    done.set(id, out);
    return out;
  };

  for (const i of ingredients) resolve(i.id);
  return done;
}

/** A stored price_kind as the type; anything unknown (a newer till's value) reads as 'set'. */
export function toPriceKind(v: string | null | undefined): PriceKind {
  return (PRICE_KINDS as readonly string[]).includes(v ?? '') ? (v as PriceKind) : 'set';
}

/** A price above Rs 0: the pack's price when there is a pack, else the per-unit cost. */
export function hasPrice(i: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null }): boolean {
  if (i.packSize && i.packSize > 0 && i.packPriceCents !== null) return i.packPriceCents > 0;
  return i.costPerUnitCents > 0;
}

/**
 * What an ingredient's price is once a price is saved (spec D1). `asked` is
 * what the person (or the menu file) said; without it the kind follows the
 * price: Rs 0 stays 'free' if it was free and is 'unset' otherwise; a price
 * above Rs 0 stays a guess if it was one and is 'set' otherwise. A guess or
 * a price of Rs 0 is never 'set'.
 */
export function priceKindAfter(previous: PriceKind | null, priced: boolean, asked?: PriceKind): PriceKind {
  switch (asked) {
    case 'free':
      return 'free';
    case 'estimate':
      return priced ? 'estimate' : 'unset';
    case 'set':
    case 'unset':
      return priced ? 'set' : 'unset';
    default:
      if (priced) return previous === 'estimate' ? 'estimate' : 'set';
      return previous === 'free' ? 'free' : 'unset';
  }
}

/**
 * Every ingredient `id` reaches through batch recipes (itself included): an
 * item using pizza sauce also uses the tomatoes the sauce is made of. Loops
 * are walked once.
 */
export function batchClosure(id: string, batchLines: ReadonlyMap<string, readonly BatchInputLine[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of batchLines.get(cur) ?? []) stack.push(l.inputId);
  }
  return seen;
}
