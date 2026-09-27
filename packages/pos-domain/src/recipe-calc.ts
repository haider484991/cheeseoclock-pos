/**
 * The recipe calculator's arithmetic (owner, 2026-09-27: "I want the batch
 * calculator to show, and make it more easy if a manager wants to see how
 * much ingredients a recipe needs for making anything like pizzas, burgers,
 * sauce, dips"). Pure, so every rule is tested:
 *
 *  - itemFirstLevel: what N of a menu item use, straight from its recipe —
 *    the lines every sale uses, plus the lines of each choice for as many
 *    as get it. Through expandRecipe, the ONE rule the stock takes by.
 *  - typicalPortions: "the till's usual picks" of a required choice (a
 *    deal's pizza, "Choose your dip", the veggies) for N, from the last 28
 *    days' picks when there are enough of them (the same trusted-mix rule
 *    as the plate cost), else spread evenly.
 *  - explodeNeeds: the batches in it, each made ONCE for everything asked
 *    (a sauce used by the pizza and by the dough is added up first), in the
 *    order to make them — what is already made on the shelf used first, so
 *    only the rest is made — and every bought-in ingredient from scratch. Every
 *    batch is scaled with scaleBatch's whole-unit rounding — exactly what
 *    "Make" (makeBatch) takes. A loop (A needs B needs A, possible only
 *    through the second till) is guarded, never followed round.
 *  - batchTree: what an amount of one batch takes, input by input, a few
 *    levels deep.
 *  - kitchenQty & co: amounts the way the kitchen says them ("1.25 kg",
 *    "2 packs of 2 kg + 500 g" only for a real pack).
 *  - prepListDocument / prepListText: the paper and the "Copy as text".
 *
 * Quantities only: nothing here knows a price.
 */

import {
  RECIPE_CALC_MAX_AMOUNT,
  RECIPE_CALC_MAX_COUNT,
  RECIPE_CALC_MAX_LINES,
  type PlainDocument,
  type PlainDocumentRow,
  type RecipeCalc,
  type RecipeCalcBatchRow,
  type RecipeCalcLineView,
  type RecipeCalcQtyRow,
} from '@cheeseoclock/shared-types';
import { BASE_PART, expandRecipe, type RecipeLine } from './recipe-expand.js';
import { scaleBatch, type ScaledBatch } from './batch-scale.js';
import { requiredPicks, trustedPickUnits, type PickMix } from './plate-cost.js';
import { mulDivRound, normalizeUnit, thousandSize } from './units.js';

/** The most of one menu item the calculator works out at once. */
export const MAX_CALC_COUNT = RECIPE_CALC_MAX_COUNT;
/** The most of one batch (in its base unit) it works out at once: 10,000 kg. */
export const MAX_CALC_AMOUNT = RECIPE_CALC_MAX_AMOUNT;
/** The most things worked out together. */
export const MAX_CALC_LINES = RECIPE_CALC_MAX_LINES;
/** How deep a batch inside a batch is opened up on screen and on paper. */
export const MAX_TREE_DEPTH = 4;

export interface QtyLine {
  ingredientId: string;
  qty: number;
}

/** How many of the line's count get one choice. */
export interface Portion {
  modifierId: string;
  count: number;
}

// ------------------------------------------------------------ first level --

/**
 * What `count` of a menu item use, first level (a sauce stays a sauce):
 * every line with no choice × count, and each choice's own lines × the
 * number that get it. Leave-outs are not portions (they only use less, and
 * what they take off depends on which unit got which pick): callers never
 * pass them. Ingredients in first-seen order.
 */
export function itemFirstLevel(recipe: readonly RecipeLine[], portions: readonly Portion[], count: number): QtyLine[] {
  const out = new Map<string, number>();
  const add = (lines: ReadonlyArray<{ ingredientId: string; qty: number }>) => {
    for (const l of lines) out.set(l.ingredientId, (out.get(l.ingredientId) ?? 0) + l.qty);
  };
  if (count > 0) add(expandRecipe(recipe, [], count).filter((l) => l.part === BASE_PART));
  for (const p of portions) {
    if (!(p.count > 0)) continue;
    add(
      expandRecipe(recipe, [{ modifierId: p.modifierId, priceDeltaCents: 0, removesIngredientId: null }], p.count).filter(
        (l) => l.part === p.modifierId,
      ),
    );
  }
  return [...out].map(([ingredientId, qty]) => ({ ingredientId, qty }));
}

/** First-level lines added up, first seen first. */
export function addQtyLines(...lists: ReadonlyArray<readonly QtyLine[]>): QtyLine[] {
  const out = new Map<string, number>();
  for (const list of lists) for (const l of list) out.set(l.ingredientId, (out.get(l.ingredientId) ?? 0) + l.qty);
  return [...out].map(([ingredientId, qty]) => ({ ingredientId, qty }));
}

// ------------------------------------------------------------ usual picks --

/** A choice group as the calculator needs it: its limits and its options' ids. */
export interface PortionGroup {
  id: string;
  selectionType: 'single' | 'multi';
  minSelect: number;
  /** 0 = no upper limit. */
  maxSelect: number;
  isRequired: boolean;
  options: ReadonlyArray<{ id: string }>;
}

export interface TypicalPortions {
  portions: Portion[];
  /** 'observed': the last 28 days' picks; 'even': too few sold, spread evenly. */
  basis: 'observed' | 'even';
}

/**
 * `total` shared out over `weights` in whole numbers (largest remainder,
 * ties to the first), none above `cap`; what a capped one cannot take goes
 * to the others by their weights. A weight of 0 gets nothing.
 */
export function apportion(total: number, weights: readonly number[], cap: number): number[] {
  const out = weights.map(() => 0);
  let left = Math.max(0, Math.floor(total));
  let open = weights.map((_, i) => i).filter((i) => weights[i]! > 0 && cap > 0);
  while (left > 0 && open.length > 0) {
    const sum = open.reduce((s, i) => s + BigInt(weights[i]!), 0n);
    const rems: Array<{ i: number; rem: bigint }> = [];
    let given = 0;
    for (const i of open) {
      const num = BigInt(left) * BigInt(weights[i]!);
      const add = Math.min(Number(num / sum), cap - out[i]!);
      out[i]! += add;
      given += add;
      rems.push({ i, rem: num % sum });
    }
    left -= given;
    rems.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
    for (const r of rems) {
      if (left === 0) break;
      if (out[r.i]! < cap) {
        out[r.i]! += 1;
        left -= 1;
      }
    }
    open = open.filter((i) => out[i]! < cap);
  }
  return out;
}

/**
 * The usual picks of a REQUIRED group for `count` (null for an optional
 * group: extras and dips on the side count only when chosen). With the
 * customers' picks trusted (plate-cost trustedPickUnits: at least 10 units
 * picked in the group, and at least its minimum each), T = round(count ×
 * ΣN_o ÷ U_g) picks shared by N_o; otherwise T = count × most picks, spread
 * evenly — the plate cost's "most picks × the average option". No option
 * above `count` (one each at most).
 */
export function typicalPortions(group: PortionGroup, mix: PickMix | null | undefined, count: number): TypicalPortions | null {
  const k = requiredPicks(group, group.options.length);
  if (!k) return null;
  const n = group.options.length;
  if (n === 0 || !(count > 0)) return { portions: [], basis: 'even' };
  const units = trustedPickUnits(mix, group, k.kMin);
  const zip = (counts: number[], basis: TypicalPortions['basis']): TypicalPortions => ({
    portions: group.options.map((o, i) => ({ modifierId: o.id, count: counts[i] ?? 0 })),
    basis,
  });
  if (units !== null && mix) {
    const weights = group.options.map((o) => mix.picks.get(o.id) ?? 0);
    const picked = weights.reduce((s, w) => s + w, 0);
    const total = Math.min(mulDivRound(count, picked, units), count * n);
    return zip(apportion(total, weights, count), 'observed');
  }
  const total = Math.min(count * k.kMax, count * n);
  return zip(
    apportion(
      total,
      group.options.map(() => 1),
      count,
    ),
    'even',
  );
}

export interface PortionProblem {
  groupId: string;
  picked: number;
  /** Fewest picks for the count (its minimum each). */
  min: number;
  /** Most picks for the count (its maximum each). */
  max: number;
}

/**
 * A required group whose picks do not fit the count: fewer than its minimum
 * for every unit (a deal with no pizza chosen: the dough would be counted
 * short), or more than its maximum. Null when they fit, or for an optional group.
 */
export function portionProblem(group: PortionGroup, countOf: (modifierId: string) => number, count: number): PortionProblem | null {
  const k = requiredPicks(group, group.options.length);
  if (!k || !(count > 0) || group.options.length === 0) return null;
  const picked = group.options.reduce((s, o) => s + Math.max(0, countOf(o.id)), 0);
  const min = k.kMin * count;
  const max = Math.min(k.kMax, group.options.length) * count;
  return picked < min || picked > max ? { groupId: group.id, picked, min, max } : null;
}

/** "Deal: Large pizza — 7 picked for 12, pick 5 more" / "…, 2 too many". */
export function portionProblemText(groupName: string, p: PortionProblem, count: number): string {
  const head = `${groupName} — ${grouped(p.picked)} picked for ${grouped(count)}`;
  if (p.picked < p.min) {
    const each = count > 0 ? p.min / count : 1;
    return `${head}${each > 1 ? ` (at least ${each} each)` : ''}, pick ${grouped(p.min - p.picked)} more`;
  }
  const each = count > 0 ? p.max / count : 1;
  return `${head}, ${grouped(p.picked - p.max)} too many (at most ${each} each)`;
}

/**
 * A choice counted that has no recipe lines of its own while others in its
 * group do (a deal pizza added but never given its copy of the pizza's
 * lines): its units add nothing, so the dough and boxes would be counted short.
 */
export function choiceWithoutLinesText(optionName: string, count: number): string {
  const counted = count === 1 ? 'the 1 counted adds' : `the ${grouped(count)} counted add`;
  return `"${optionName}" has no recipe lines yet, so ${counted} nothing: add its lines in Inventory → Recipes.`;
}

// -------------------------------------------------------------- batches --

/** A batch recipe as "Make" reads it: its yield and its LIVE inputs, in the recipe's order. */
export interface CalcBatch {
  batchYield: number;
  inputs: ReadonlyArray<{ inputId: string; qty: number }>;
}

/**
 * The batch recipe of an ingredient, or undefined when it is bought in: no
 * yield, or no live input (as effectivePrices and makeBatch treat it).
 */
export type BatchLookup = (ingredientId: string) => CalcBatch | undefined;

/**
 * The batches of a shop: an ingredient with a yield above 0 AND at least
 * one live input is made in-house; one with a yield but no input left is
 * bought in (makeBatch refuses it; effectivePrices keeps its stored price).
 * `liveInputs` must hold live inputs only, in the recipe's order — what
 * makeBatch reads (batch-recipe-repo batchInputs).
 */
export function makeBatchLookup(
  yields: ReadonlyMap<string, number | null>,
  liveInputs: ReadonlyMap<string, ReadonlyArray<{ inputId: string; qty: number }>>,
): BatchLookup {
  const batches = new Map<string, CalcBatch>();
  for (const [id, y] of yields) {
    const inputs = liveInputs.get(id) ?? [];
    if (y !== null && Number.isSafeInteger(y) && y > 0 && inputs.length > 0) batches.set(id, { batchYield: y, inputs });
  }
  return (id) => batches.get(id);
}

/** The key of a batch → input edge (loops are dropped edge by edge). */
export function batchEdgeKey(batchId: string, inputId: string): string {
  return `${batchId}\u0000${inputId}`;
}

export interface ExplodedBatch {
  id: string;
  /** Everything asked needs this much of it, all together. */
  need: number;
  /** Of that, what the lines asked use of it themselves. */
  direct: number;
  /** Of `need`, asked for by name ("2 kg Pizza Sauce"): made in full, whatever is on the shelf. */
  asked: number;
  /** Of `need`, taken from what is already made on the shelf (never more than is there). */
  fromShelf: number;
  /** What to make: asked + what the shelf does not cover. 0 = enough on the shelf. */
  toMake: number;
  /** `toMake` scaled as makeBatch scales it (whole units, half up; 0 = not taken); null when there is nothing to make. */
  scaled: ScaledBatch | null;
}

/** What explodeNeeds uses besides the recipes. */
export interface ExplodeOptions {
  /**
   * What is already made of a batch (this till's count). Used before making
   * more, for everything except what was asked for by name; a count below 0
   * is none. Without it, every batch is made in full.
   */
  stockOf?: (ingredientId: string) => number;
  /**
   * Batches asked for by name, and how much ("2 kg Pizza Sauce": make it,
   * even with some on the shelf). Already counted in `firstLevel`.
   */
  asked?: ReadonlyMap<string, number>;
}

export interface Exploded {
  /**
   * In the order to make them: every batch after the batches it is made
   * from. A batch that is needed but fully on the shelf is listed too
   * (toMake 0); one only a batch on the shelf would have used is not.
   */
  batches: ExplodedBatch[];
  /** Every bought-in ingredient, through every batch still to make, first seen first. */
  raw: QtyLine[];
  /**
   * Edges dropped because they lead back round (batch → input already being
   * made above it). That input is taken from stock as it is, never made.
   */
  loops: Array<{ batchId: string; inputId: string }>;
  /** The same, as batchEdgeKey keys (for batchTree). */
  droppedEdges: ReadonlySet<string>;
}

const asScaleInputs = (b: CalcBatch) => b.inputs.map((i) => ({ inputId: i.inputId, qty: i.qty, pack: null, kind: 'missing' as const }));

/**
 * Open every batch in `firstLevel` up, down to what is bought in:
 *  1. find the batches reachable from it (depth first, inputs in the
 *     recipe's order), dropping an edge that leads back to a batch still
 *     being opened (a loop), and noting it;
 *  2. walk them parents first (reverse post-order), adding each batch's
 *     need from every line and every batch above it BEFORE deciding how
 *     much to make — so each batch is made once, for everything;
 *  3. take what is already made off the need (`stockOf`; never what was
 *     asked for by name): only the rest is made. A sauce with enough on the
 *     shelf is not made at all, and neither is anything only it would use;
 *  4. scale what is made with scaleBatch (whole units, half up — exactly
 *     what "Make" takes; an input that rounds to 0 is not taken), and pass
 *     each input's amount down to its own batch or to the bought-in totals.
 * The per-batch trees (batchTree) are rounded each on their own, so they
 * can differ from these totals by a gram or two.
 */
export function explodeNeeds(firstLevel: readonly QtyLine[], batchOf: BatchLookup, opts: ExplodeOptions = {}): Exploded {
  const direct = new Map<string, number>();
  const raw = new Map<string, number>();
  const addRaw = (id: string, q: number) => raw.set(id, (raw.get(id) ?? 0) + q);
  for (const l of firstLevel) {
    if (!(l.qty > 0)) continue;
    if (batchOf(l.ingredientId)) direct.set(l.ingredientId, (direct.get(l.ingredientId) ?? 0) + l.qty);
    else addRaw(l.ingredientId, l.qty);
  }

  const state = new Map<string, 'open' | 'done'>();
  const post: string[] = [];
  const dropped = new Set<string>();
  const loops: Exploded['loops'] = [];
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const input of batchOf(id)?.inputs ?? []) {
      if (!batchOf(input.inputId)) continue;
      const s = state.get(input.inputId);
      if (s === 'open') {
        const key = batchEdgeKey(id, input.inputId);
        if (!dropped.has(key)) {
          dropped.add(key);
          loops.push({ batchId: id, inputId: input.inputId });
        }
        continue;
      }
      if (s === 'done') continue;
      visit(input.inputId);
    }
    state.set(id, 'done');
    post.push(id);
  };
  for (const id of direct.keys()) if (!state.has(id)) visit(id);

  const need = new Map(direct);
  const worked = new Map<string, Omit<ExplodedBatch, 'id' | 'need' | 'direct'>>();
  for (const id of [...post].reverse()) {
    const n = need.get(id) ?? 0;
    const b = batchOf(id);
    if (!(n > 0) || !b) continue;
    const asked = Math.min(n, Math.max(0, opts.asked?.get(id) ?? 0));
    const uses = n - asked;
    const fromShelf = opts.stockOf ? Math.min(uses, Math.max(0, opts.stockOf(id))) : 0;
    const toMake = asked + uses - fromShelf;
    const scaled = toMake > 0 ? scaleBatch(b.batchYield, asScaleInputs(b), toMake) : null;
    worked.set(id, { asked, fromShelf, toMake, scaled });
    for (const l of scaled?.lines ?? []) {
      if (l.stockQty === 0) continue;
      if (batchOf(l.inputId) && !dropped.has(batchEdgeKey(id, l.inputId))) need.set(l.inputId, (need.get(l.inputId) ?? 0) + l.stockQty);
      else addRaw(l.inputId, l.stockQty);
    }
  }
  return {
    batches: post
      .filter((id) => worked.has(id))
      .map((id) => ({ id, need: need.get(id)!, direct: direct.get(id) ?? 0, ...worked.get(id)! })),
    raw: [...raw].map(([ingredientId, qty]) => ({ ingredientId, qty })),
    loops,
    droppedEdges: dropped,
  };
}

export interface BatchTreeLine {
  inputId: string;
  perBatchQty: number;
  /** Whole units "Make" takes (0 = too little to take). */
  qty: number;
  /** The exact amount, hundredths of a unit. */
  hundredths: number;
  madeOf: BatchTreeNode | null;
  /** A batch that leads back round: taken from stock as it is. */
  loop: boolean;
}

export interface BatchTreeNode {
  id: string;
  amount: number;
  batchYield: number;
  lines: BatchTreeLine[];
}

/**
 * What `amount` of one batch takes, input by input, as "Make" takes it; a
 * batch input opens up the same way for the amount it takes, up to
 * `maxDepth` levels. An input already being opened above it (or an edge
 * explodeNeeds dropped) is a loop: shown, never followed. Null for
 * something that is not a batch.
 */
export function batchTree(
  id: string,
  amount: number,
  batchOf: BatchLookup,
  opts: { maxDepth?: number; droppedEdges?: ReadonlySet<string> } = {},
): BatchTreeNode | null {
  const maxDepth = opts.maxDepth ?? MAX_TREE_DEPTH;
  const walk = (bid: string, amt: number, inside: ReadonlySet<string>, depth: number): BatchTreeNode | null => {
    const b = batchOf(bid);
    if (!b || !(amt > 0)) return null;
    const scaled = scaleBatch(b.batchYield, asScaleInputs(b), amt);
    const here = new Set(inside).add(bid);
    return {
      id: bid,
      amount: amt,
      batchYield: b.batchYield,
      lines: scaled.lines.map((l) => {
        const isBatch = !!batchOf(l.inputId);
        const loop = isBatch && (here.has(l.inputId) || !!opts.droppedEdges?.has(batchEdgeKey(bid, l.inputId)));
        return {
          inputId: l.inputId,
          perBatchQty: l.perBatchQty,
          qty: l.stockQty,
          hundredths: l.scaledHundredths,
          loop,
          madeOf: isBatch && !loop && depth < maxDepth && l.stockQty > 0 ? walk(l.inputId, l.stockQty, here, depth + 1) : null,
        };
      }),
    };
  };
  return walk(id, amount, new Set(), 1);
}

/** How many goes "Make" needs for `need` when one go takes at most `max`. */
export function goesFor(need: number, max: number): number {
  return max > 0 ? Math.max(1, Math.ceil(need / max)) : 1;
}

// ---------------------------------------------------------- kitchen units --

const grouped = (n: number) => new Intl.NumberFormat('en-PK').format(n);

/**
 * An amount the way the kitchen weighs it, exact to the unit: 1250 g →
 * "1.25 kg", 1234 g → "1.234 kg", 750 g → "750 g", 1500 ml → "1.5 L",
 * 12 pcs → "12 pcs".
 */
export function kitchenQty(qty: number, unit: string): string {
  const u = normalizeUnit(unit);
  const abs = Math.abs(qty);
  if ((u === 'g' || u === 'ml') && abs >= 1000 && Number.isSafeInteger(abs)) {
    const whole = Math.floor(abs / 1000);
    const frac = abs % 1000;
    const decimals = frac === 0 ? '' : `.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
    return `${qty < 0 ? '-' : ''}${grouped(whole)}${decimals} ${u === 'g' ? 'kg' : 'L'}`;
  }
  return `${grouped(qty)} ${unit}`;
}

/**
 * A pack worth counting or buying in: more than one unit, and not the
 * 1,000 g / ml a price per kg / litre is kept as (that is a price, not a
 * packet on the shelf).
 */
export function isRealPack(unit: string, packSize: number | null | undefined): boolean {
  if (packSize === null || packSize === undefined || !Number.isSafeInteger(packSize) || packSize <= 1) return false;
  const perThousand = thousandSize(unit);
  return !(perThousand !== null && packSize === perThousand);
}

/** "2 packs of 2 kg + 500 g" (null when not a real pack, or less than one pack). */
export function packsText(qty: number, unit: string, packSize: number | null | undefined): string | null {
  if (!isRealPack(unit, packSize) || !(qty >= packSize!)) return null;
  const packs = Math.floor(qty / packSize!);
  const loose = qty % packSize!;
  return `${grouped(packs)} pack${packs === 1 ? '' : 's'} of ${kitchenQty(packSize!, unit)}${loose > 0 ? ` + ${kitchenQty(loose, unit)}` : ''}`;
}

/** Whole packs to buy to cover `short` (null when not a real pack). */
export function packsToBuy(short: number, unit: string, packSize: number | null | undefined): number | null {
  if (!isRealPack(unit, packSize) || !(short > 0)) return null;
  return Math.ceil(short / packSize!);
}

/** What is missing when `qty` is needed and `inStock` is on the shelf (stock below 0 counts as none). */
export function shortOf(qty: number, inStock: number): number {
  return Math.max(0, qty - Math.max(0, inStock));
}

// ------------------------------------------------------------- the paper --

/** "10 x Fajita Pizza - Large", "2 kg Pizza Sauce (1 batch)". */
export function calcLineTitle(l: Pick<RecipeCalcLineView, 'kind' | 'name' | 'count' | 'unit' | 'batchesText'>): string {
  if (l.kind === 'batch') return `${kitchenQty(l.count, l.unit ?? '')} ${l.name}${l.batchesText ? ` (${l.batchesText})` : ''}`;
  return `${grouped(l.count)} x ${l.name}`;
}

/** "SHORT 400 g (in stock 400 g) - buy 1 pack of 2 kg", or nothing when there is enough. */
export function shortNote(r: Pick<RecipeCalcQtyRow, 'qty' | 'unit' | 'inStock' | 'shortBy' | 'packSize'>): string | null {
  if (!(r.shortBy > 0)) return null;
  const packs = packsToBuy(r.shortBy, r.unit, r.packSize);
  const buy = packs !== null && r.packSize ? ` - buy ${grouped(packs)} pack${packs === 1 ? '' : 's'} of ${kitchenQty(r.packSize, r.unit)}` : '';
  return `SHORT ${kitchenQty(r.shortBy, r.unit)} (in stock ${kitchenQty(Math.max(0, r.inStock), r.unit)})${buy}`;
}

/**
 * What the shelf does for a batch row, in words: "enough in stock here
 * (6 kg): no need to make", "needs 5.9 kg: 3 kg in stock here, make the
 * rest", or null when nothing of it is on the shelf.
 */
export function batchStockNote(b: Pick<RecipeCalcBatchRow, 'qty' | 'unit' | 'inStock' | 'fromShelf' | 'toMake'>): string | null {
  if (b.toMake === 0) return `enough in stock here (${kitchenQty(Math.max(0, b.inStock), b.unit)}): no need to make`;
  if (b.fromShelf > 0) return `needs ${kitchenQty(b.qty, b.unit)}: ${kitchenQty(b.fromShelf, b.unit)} in stock here, make the rest`;
  return null;
}

/** The note the paper and the screen end with. */
export const IN_STOCK_NOTE = "In stock = this till's own count.";
export const LEAVE_OUTS_NOTE = 'Leave-outs ("No onion") are not counted: they only use less.';
export const FROM_SCRATCH_NOTE = 'for what is left to make: batches in stock here used first';

/**
 * The prep list: what was asked (and the picks), the batches to make first
 * — only what the shelf does not already hold, with what that takes — what
 * comes straight from stock (a batch with enough on the shelf included),
 * and everything from scratch for what is left to make — SHORT beside
 * anything this till does not have enough of. No prices, ever: it goes to
 * the kitchen.
 */
export function prepListDocument(calc: RecipeCalc, meta: { when: string; by?: string | null }): PlainDocument {
  const asked: PlainDocumentRow[] = calc.lines.flatMap((l) => [
    { text: calcLineTitle(l), strong: true, notes: l.warnings },
    ...l.picks.map((p) => ({ text: `${grouped(p.count)} x ${p.name}`, indent: 1 })),
  ]);
  const sections: PlainDocument['sections'] = [{ heading: 'FOR', rows: asked }];
  const toMake = calc.batches.filter((b) => b.toMake > 0);
  const onShelf = calc.batches.filter((b) => b.toMake === 0);
  if (toMake.length > 0) {
    sections.push({
      heading: 'MAKE FIRST',
      note: 'in this order',
      rows: toMake.flatMap((b) => [
        {
          text: b.name,
          qty: kitchenQty(b.toMake, b.unit),
          strong: true,
          notes: [
            ...(b.batchesText ? [`${b.batchesText} of ${kitchenQty(b.batchYield, b.unit)}`] : []),
            ...(b.goes > 1 ? [`in ${b.goes} goes of at most ${kitchenQty(b.maxAmount, b.unit)}`] : []),
            ...(batchStockNote(b) ? [batchStockNote(b)!] : []),
          ],
        },
        ...(b.tree?.lines ?? []).map((t) => ({
          text: t.name,
          qty: t.qty === 0 ? `under 1 ${t.unit}` : kitchenQty(t.qty, t.unit),
          indent: 1,
          notes: t.qty === 0 ? ['not taken'] : t.loop ? ['uses itself: taken from stock'] : [],
        })),
      ]),
    });
  }
  if (calc.fromStock.length > 0 || onShelf.length > 0) {
    sections.push({
      heading: 'FROM STOCK',
      rows: [
        ...onShelf.map((b) => ({ text: b.name, qty: kitchenQty(b.qty, b.unit), notes: [batchStockNote(b)!] })),
        ...calc.fromStock.map((r) => ({ text: r.name, qty: kitchenQty(r.qty, r.unit), notes: shortNote(r) ? [shortNote(r)!] : [] })),
      ],
    });
  }
  if (calc.fromScratch.length > 0) {
    const shortFirst = [...calc.fromScratch].sort((a, b) => Number(b.shortBy > 0) - Number(a.shortBy > 0));
    sections.push({
      heading: 'EVERYTHING FROM SCRATCH',
      note: FROM_SCRATCH_NOTE,
      rows: shortFirst.map((r) => ({ text: r.name, qty: kitchenQty(r.qty, r.unit), notes: shortNote(r) ? [shortNote(r)!] : [] })),
    });
  }
  return {
    title: 'PREP LIST',
    subtitle: [meta.by ? `${meta.when} - ${meta.by}` : meta.when],
    sections,
    footer: [IN_STOCK_NOTE, LEAVE_OUTS_NOTE, ...calc.warnings],
  };
}

/** Words broken into rows of at most `width` (a longer word is cut). */
function wrapWords(s: string, width: number): string[] {
  const cols = Math.max(1, Math.floor(width));
  const out: string[] = [];
  let line = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length <= cols) {
      line = `${line} ${w}`;
      continue;
    }
    if (line) out.push(line);
    let rest = w;
    while (rest.length > cols) {
      out.push(rest.slice(0, cols));
      rest = rest.slice(cols);
    }
    line = rest;
  }
  if (line) out.push(line);
  return out;
}

/**
 * The same paper as plain text. With a `width`, laid out like the receipt
 * printer (the amount on the right, wrapped to the width); with null, one
 * row per line ("Pizza Sauce: 800 g"), for pasting into a message.
 */
export function prepListText(doc: PlainDocument, width: number | null): string {
  const out: string[] = [];
  const pad = (indent: number) => '  '.repeat(indent);
  const rule = width ? '-'.repeat(width) : '';
  const fit = (t: string) => (width === null ? [t] : wrapWords(t, width));
  out.push(...fit(doc.title), ...doc.subtitle.flatMap(fit));
  for (const s of doc.sections) {
    out.push(rule);
    out.push(...fit(s.note ? `${s.heading} (${s.note})` : s.heading));
    for (const r of s.rows) {
      const lead = pad(r.indent ?? 0);
      const left = `${lead}${r.text}`;
      if (width === null) {
        out.push(r.qty ? `${left}: ${r.qty}` : left);
      } else if (r.qty && left.length + 1 + r.qty.length <= width) {
        out.push(left + ' '.repeat(width - left.length - r.qty.length) + r.qty);
      } else {
        out.push(...wrapWords(r.text, width - lead.length).map((x) => lead + x));
        if (r.qty) out.push(' '.repeat(Math.max(0, width - r.qty.length)) + r.qty.slice(0, width));
      }
      for (const n of r.notes ?? []) {
        const lead = pad((r.indent ?? 0) + 1);
        if (width === null) out.push(`${lead}${n}`);
        else out.push(...wrapWords(n, width - lead.length).map((x) => lead + x));
      }
    }
  }
  if (doc.footer.length > 0) {
    out.push(rule);
    for (const f of doc.footer) out.push(...fit(f));
  }
  return out.filter((x, i) => !(x === '' && width === null && i > 0 && out[i - 1] === '')).join('\n');
}
