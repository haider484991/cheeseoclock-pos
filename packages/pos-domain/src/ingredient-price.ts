/**
 * The price costing uses for each ingredient (costing spec 4.1,
 * effectiveUnitPrice): its stored price, or — for a sauce, dough or mix the
 * kitchen makes — the price rolled up from its inputs NOW, so a dearer
 * tomato shows in the pizza sauce and in every pizza at once. The plate cost
 * (Costing page) and, from Phase 2, the cost kept with each sale both read
 * this one function, so what the screen shows and what history keeps agree.
 */

import { PRICE_KINDS, type PriceKind } from '@cheeseoclock/shared-types';
import { convertPack, costPerUnitFromPack, effectivePack, lineCostMc, mcToCents, mulDivRound, type Pack } from './units.js';

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

// -----------------------------------------------------------------------------
// The price as the ingredient keeps it (costing spec Phase 4)
// -----------------------------------------------------------------------------

/** An ingredient's own price columns. */
export interface StoredPrice {
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  priceKind: PriceKind;
}

/**
 * A price as the ingredient keeps it: the ONE rule behind every way a price
 * is written (typed, the menu file, a bill, a Convert, a batch rolled up).
 *  - An exact pack, when there is one, decides the per-unit cost, which is
 *    kept in whole paisa only for older screens; the pack is what costing
 *    uses (effectivePack). Half a pack (a size with no price) is no pack.
 *  - The kind follows priceKindAfter: a price above Rs 0 is 'set' (or stays
 *    a guess), Rs 0 is 'unset' unless it is 'free'.
 *  - 'free' is Rs 0 with no pack.
 */
export function storedPriceOf(
  price: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null },
  previous: PriceKind | null,
  asked?: PriceKind,
): StoredPrice {
  const pack = price.packSize !== null && price.packSize > 0 && price.packPriceCents !== null;
  const cols = pack
    ? { costPerUnitCents: costPerUnitFromPack(price.packPriceCents!, price.packSize!), packSize: price.packSize, packPriceCents: price.packPriceCents }
    : { costPerUnitCents: price.costPerUnitCents, packSize: null, packPriceCents: null };
  const priceKind = priceKindAfter(previous, hasPrice(cols), asked);
  if (priceKind === 'free') return { costPerUnitCents: 0, packSize: null, packPriceCents: null, priceKind };
  return { ...cols, priceKind };
}

/** The same price, column for column. */
export function sameStoredPrice(a: StoredPrice, b: StoredPrice): boolean {
  return (
    a.costPerUnitCents === b.costPerUnitCents &&
    a.packSize === b.packSize &&
    a.packPriceCents === b.packPriceCents &&
    a.priceKind === b.priceKind
  );
}

/**
 * The price after a Convert that counts `factor`× as many units (kg → g,
 * l → ml), exactly: a pack holds factor× as many units for the same money
 * (convertPack), and a price typed per kg becomes a pack of 1,000 g — no
 * per-gram cost rounded to whole paisa, so every value stays the same.
 * Nothing to scale on an unpriced or free ingredient.
 */
export function convertedStoredPrice(p: StoredPrice, factor: number): StoredPrice {
  if (p.priceKind === 'unset' || p.priceKind === 'free') {
    return { costPerUnitCents: 0, packSize: null, packPriceCents: null, priceKind: p.priceKind };
  }
  const pack = convertPack(effectivePack(p), factor);
  return storedPriceOf({ costPerUnitCents: 0, packSize: pack.size, packPriceCents: pack.priceCents }, p.priceKind, p.priceKind);
}

/**
 * The price in force at `at` from a price history sorted oldest first (ties
 * in the order written): the latest entry at or before it, else the EARLIEST
 * one — a take from before the history started is priced at the first price
 * known (the starting price, costing spec D8). Undefined for no history.
 */
export function priceInForce<T extends { effectiveAt: string }>(history: readonly T[], at: string): T | undefined {
  if (history.length === 0) return undefined;
  let lo = 0;
  let hi = history.length; // first index with effectiveAt > at
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid]!.effectiveAt <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? history[0] : history[lo - 1];
}

/**
 * The KNOWN price in force at `at`, for valuing a take (Reports' estimates,
 * costing spec 4.5): as priceInForce, over the entries that say what it
 * cost — an entry "no price yet" ('unset') is no price at all. So an
 * ingredient still unpriced when price history started, priced later, has
 * its older takes valued at that first price (the first known price stands
 * in for anything older, as the starting price does), not left "not priced"
 * forever. Undefined when no entry has a price.
 */
export function knownPriceInForce<T extends { effectiveAt: string; kind: PriceKind }>(history: readonly T[], at: string): T | undefined {
  return priceInForce(knownPrices(history), at);
}

/** The entries of a price history that say what it cost (none 'unset'), in their order: knownPriceInForce's list, kept once. */
export function knownPrices<T extends { kind: PriceKind }>(history: readonly T[]): T[] {
  return history.filter((h) => h.kind !== 'unset');
}

/**
 * The change from one price to the next, in basis points of the old one
 * (+1,000 = 10% dearer); null when there is no earlier price above Rs 0 to
 * compare with.
 */
export function priceChangeBps(prevUnitCostMc: number | null, unitCostMc: number): number | null {
  if (prevUnitCostMc === null || !(prevUnitCostMc > 0)) return null;
  return mulDivRound(unitCostMc - prevUnitCostMc, 10_000, prevUnitCostMc);
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

/**
 * The batches made from any of `ids`, directly or through other batches
 * (Cheese Mix from mozzarella, then anything made with Cheese Mix), in the
 * order a changed price rolls up: bottom-up, each batch after every batch
 * of the list it is made from, ties by id so every till writes them in the
 * same order. The ids themselves are left out unless one is made from
 * another. A loop (A needs B needs A) is guarded: walked once, never round.
 */
export function batchesUsing(ids: Iterable<string>, batchLines: ReadonlyMap<string, readonly BatchInputLine[]>): string[] {
  const usedIn = new Map<string, string[]>();
  for (const [batch, lines] of batchLines) {
    for (const l of lines) {
      let list = usedIn.get(l.inputId);
      if (!list) usedIn.set(l.inputId, (list = []));
      list.push(batch);
    }
  }
  const reached = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const b of usedIn.get(cur) ?? []) {
      if (reached.has(b)) continue;
      reached.add(b);
      queue.push(b);
    }
  }
  // How many batches of the list lie below each one (0 = made only from the changed ones).
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const depthOf = (b: string): number => {
    const hit = depth.get(b);
    if (hit !== undefined) return hit;
    onPath.add(b);
    let d = 0;
    for (const l of batchLines.get(b) ?? []) {
      if (!reached.has(l.inputId) || onPath.has(l.inputId)) continue;
      d = Math.max(d, depthOf(l.inputId) + 1);
    }
    onPath.delete(b);
    depth.set(b, d);
    return d;
  };
  const byId = [...reached].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const b of byId) depthOf(b); // in one fixed order, so a loop settles the same way on every till
  return byId.sort((a, b) => depth.get(a)! - depth.get(b)!); // stable: ties stay by id
}
