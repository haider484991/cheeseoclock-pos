/**
 * What one menu item costs to make (costing spec 4.3), at today's prices:
 * the lines used on every sale, plus the choices the customer must make
 * (a deal's pizzas, "Choose your dip", "Choose 5 veggies") weighted by what
 * customers actually picked over the last 28 days — or, with fewer than 10
 * sold, the conservative "most picks × the average option", as the costing
 * sheet does. Paid extras and leave-outs are costed on their own. Every
 * figure goes through expandRecipe, the same rule the stock takes by.
 *
 * Integer arithmetic throughout: line costs in millicents (mc), each rounded
 * once; paisa only for display.
 */

import type { FoodCostFlag, PriceKind } from '@cheeseoclock/shared-types';
import { BASE_PART, expandRecipe, type PickedChoice, type RecipeLine } from './recipe-expand.js';
import { lineCostMc, mcToCents, mulDivRound, shareBps, type Pack } from './units.js';

/** The price of an ingredient as costing uses it (see effectivePrices), or undefined when it is gone. */
export type PriceOf = (ingredientId: string) => { pack: Pack; kind: PriceKind } | undefined;

export interface CostedLine {
  ingredientId: string;
  qty: number;
  costMc: number;
  /** 'missing': no price, or the ingredient no longer exists (adds nothing). */
  kind: PriceKind | 'missing';
}

export interface PartCost {
  lines: CostedLine[];
  costMc: number;
  costCents: number;
  /** Lines with no price: they add Rs 0 and make the item "can't cost yet". */
  missingLines: number;
  /** Lines priced with a guess. */
  estimateLines: number;
}

/** Cost a set of lines: each round(qty × P × 1000 ÷ S) mc; an unpriced line adds 0 and is counted. */
export function costLines(lines: ReadonlyArray<{ ingredientId: string; qty: number }>, priceOf: PriceOf): PartCost {
  const out: CostedLine[] = [];
  let costMc = 0;
  let missingLines = 0;
  let estimateLines = 0;
  for (const l of lines) {
    const p = priceOf(l.ingredientId);
    if (!p || p.kind === 'unset') {
      missingLines += 1;
      out.push({ ingredientId: l.ingredientId, qty: l.qty, costMc: 0, kind: 'missing' });
      continue;
    }
    if (p.kind === 'estimate') estimateLines += 1;
    const mc = lineCostMc(l.qty, p.pack);
    costMc += mc;
    out.push({ ingredientId: l.ingredientId, qty: l.qty, costMc: mc, kind: p.kind });
  }
  return { lines: out, costMc, costCents: mcToCents(costMc), missingLines, estimateLines };
}

export interface PlateOption {
  id: string;
  name: string;
  priceDeltaCents: number;
  removesIngredientId: string | null;
}

export interface PlateGroup {
  id: string;
  name: string;
  selectionType: 'single' | 'multi';
  minSelect: number;
  /** 0 = no upper limit. */
  maxSelect: number;
  isRequired: boolean;
  options: PlateOption[];
}

/** What customers picked over the window: units of the item sold, and per choice the units that had it. */
export interface PickMix {
  units: number;
  picks: ReadonlyMap<string, number>;
  /**
   * Per choice group, the units whose line had at least one of its choices
   * (U_g). A group is weighted over these, not over every unit sold, so a
   * group attached last week (or orders that came without their picks) does
   * not read as "customers pick nothing here". When absent, every unit sold
   * counts (U).
   */
  groupUnits?: ReadonlyMap<string, number>;
}

export interface PlateItemInput {
  basePriceCents: number;
  recipe: readonly RecipeLine[];
  groups: readonly PlateGroup[];
  mix?: PickMix | null;
}

/** Below this many units sold in the window, the observed mix is not trusted. */
export const MIX_MIN_UNITS = 10;

/**
 * The mix from order lines: U = Σ qty; N_o = Σ qty over the lines that
 * picked o (once per line however often it was picked). A quantity-2 line
 * with five veggies counts two of each. With `groupOf` (choice → its group)
 * it also counts U_g, the units whose line picked anything in group g.
 */
export function pickMix(
  lines: ReadonlyArray<{ quantity: number; modifierIds: readonly string[] }>,
  groupOf?: (modifierId: string) => string | undefined,
): PickMix {
  let units = 0;
  const picks = new Map<string, number>();
  const groupUnits = new Map<string, number>();
  for (const l of lines) {
    units += l.quantity;
    const ids = new Set(l.modifierIds);
    for (const id of ids) picks.set(id, (picks.get(id) ?? 0) + l.quantity);
    if (groupOf) {
      const groups = new Set([...ids].map(groupOf).filter((g): g is string => !!g));
      for (const g of groups) groupUnits.set(g, (groupUnits.get(g) ?? 0) + l.quantity);
    }
  }
  return groupOf ? { units, picks, groupUnits } : { units, picks };
}

/** A required group's pick counts (k_min ≥ 1 … k_max), or null for an optional group. */
export function requiredPicks(g: Pick<PlateGroup, 'selectionType' | 'minSelect' | 'maxSelect' | 'isRequired'>, optionCount: number): { kMin: number; kMax: number } | null {
  if (!g.isRequired && g.minSelect <= 0) return null;
  const kMin = Math.max(1, g.minSelect);
  const upper = g.selectionType === 'single' ? 1 : g.maxSelect > 0 ? g.maxSelect : Math.max(optionCount, 1);
  return { kMin, kMax: Math.max(kMin, upper) };
}

export interface OptionCost {
  option: PlateOption;
  cost: PartCost;
  /** Of the units that made a pick in this group, how many had it (bps); null while the group has too few picks. */
  pickedShareBps: number | null;
}

export interface GroupCost {
  group: PlateGroup;
  kMin: number;
  kMax: number;
  basis: 'observed' | 'usual';
  options: OptionCost[];
  typicalCostMc: number;
  typicalPriceMc: number;
  cheapestMc: number;
  dearestMc: number;
}

export interface PaidExtraCost {
  option: PlateOption;
  groupName: string;
  cost: PartCost;
  marginCents: number;
  foodCostBps: number | null;
}

export interface LeaveOutCost {
  option: PlateOption;
  ingredientId: string;
  savingMc: number;
  savingCents: number;
  /**
   * Unpriced lines leaving it out takes off the plate: they count as Rs 0,
   * so when this is above 0 the saving is only "at least" (or not known).
   */
  missingLines: number;
}

export interface PlateCost {
  hasRecipe: boolean;
  /** "Always in it": the lines with no choice. */
  base: PartCost;
  groups: GroupCost[];
  typicalCostMc: number;
  typicalCostCents: number;
  minCostCents: number;
  maxCostCents: number;
  /** base price + the usual paid picks of the required groups (ex-tax, as on the menu). */
  typicalPriceMc: number;
  typicalPriceCents: number;
  /** Σ over the required groups of their usual price (what the base price does not include). */
  groupsPriceMc: number;
  profitCents: number;
  foodCostBps: number | null;
  /** Unpriced lines on the plate or in any option of a required group. */
  missingLines: number;
  /**
   * The ingredients behind those lines, each once (first seen first): one
   * unpriced sauce used by eight deal pizzas is ONE thing to price, not eight.
   */
  missingIngredientIds: string[];
  estimateLines: number;
  paidExtras: PaidExtraCost[];
  leaveOuts: LeaveOutCost[];
}

/** The lines one choice brings, costed (with any leave-outs picked beside it). */
function optionPart(recipe: readonly RecipeLine[], option: PlateOption, removing: readonly PlateOption[], priceOf: PriceOf): PartCost {
  const picks: PickedChoice[] = [option, ...removing].map((o) => ({
    modifierId: o.id,
    priceDeltaCents: o.priceDeltaCents,
    removesIngredientId: o.removesIngredientId,
  }));
  return costLines(
    expandRecipe(recipe, picks, 1).filter((l) => l.part === option.id),
    priceOf,
  );
}

function basePart(recipe: readonly RecipeLine[], removing: readonly PlateOption[], priceOf: PriceOf): PartCost {
  const picks: PickedChoice[] = removing.map((o) => ({
    modifierId: o.id,
    priceDeltaCents: o.priceDeltaCents,
    removesIngredientId: o.removesIngredientId,
  }));
  return costLines(
    expandRecipe(recipe, picks, 1).filter((l) => l.part === BASE_PART),
    priceOf,
  );
}

interface Typical {
  base: PartCost;
  groups: GroupCost[];
  costMc: number;
  priceMc: number;
  groupsPriceMc: number;
  minMc: number;
  maxMc: number;
}

/**
 * The units a group is weighted over (U_g), or null when its picks are not
 * to be trusted yet: fewer than MIX_MIN_UNITS units picked in it, or fewer
 * picks than its minimum asks for (orders from before the group was
 * required, or before its minimum was raised) — then the usual fallback.
 */
function observedUnits(mix: PickMix | null | undefined, g: PlateGroup, kMin: number): number | null {
  if (!mix) return null;
  const units = mix.groupUnits ? (mix.groupUnits.get(g.id) ?? 0) : mix.units;
  if (units < MIX_MIN_UNITS) return null;
  const picked = g.options.reduce((s, o) => s + (mix.picks.get(o.id) ?? 0), 0);
  if (picked < kMin * units) return null;
  return units;
}

/** The typical plate, optionally with leave-out picks applied (for the saving). */
function typicalPlate(item: PlateItemInput, priceOf: PriceOf, removing: readonly PlateOption[]): Typical {
  const base = basePart(item.recipe, removing, priceOf);
  const groups: GroupCost[] = [];
  let costMc = base.costMc;
  let minMc = base.costMc;
  let maxMc = base.costMc;
  let groupsPriceMc = 0;
  for (const g of item.groups) {
    const k = requiredPicks(g, g.options.length);
    if (!k) continue;
    const units = observedUnits(item.mix, g, k.kMin);
    const mix = units === null ? null : (item.mix ?? null);
    const options: OptionCost[] = g.options.map((o) => ({
      option: o,
      cost: optionPart(item.recipe, o, removing, priceOf),
      pickedShareBps: mix && units !== null ? shareBps(mix.picks.get(o.id) ?? 0, units) : null,
    }));
    const n = options.length;
    let typicalCostMc = 0;
    let typicalPriceMc = 0;
    if (n > 0 && mix && units !== null) {
      // Σ_o (N_o ÷ U_g) × cost(o): weights × line quantities, one rounding.
      let costNum = 0n;
      let priceNum = 0n;
      for (const oc of options) {
        const picks = BigInt(mix.picks.get(oc.option.id) ?? 0);
        costNum += picks * BigInt(oc.cost.costMc);
        priceNum += picks * BigInt(oc.option.priceDeltaCents) * 1000n;
      }
      typicalCostMc = divRound(costNum, BigInt(units));
      typicalPriceMc = divRound(priceNum, BigInt(units));
    } else if (n > 0) {
      // Too few sold: the most picks × the average option (conservative, as the costing sheet does).
      const sumCost = options.reduce((s, oc) => s + oc.cost.costMc, 0);
      const sumPrice = options.reduce((s, oc) => s + oc.option.priceDeltaCents, 0);
      typicalCostMc = mulDivRound(k.kMax, sumCost, n);
      typicalPriceMc = mulDivRound(k.kMax * 1000, sumPrice, n);
    }
    const sorted = options.map((oc) => oc.cost.costMc).sort((a, b) => a - b);
    const cheapestMc = sorted.slice(0, Math.min(k.kMin, n)).reduce((s, v) => s + v, 0);
    const dearestMc = sorted.slice(Math.max(0, n - k.kMax)).reduce((s, v) => s + v, 0);
    groups.push({
      group: g,
      kMin: k.kMin,
      kMax: k.kMax,
      basis: mix ? 'observed' : 'usual',
      options,
      typicalCostMc,
      typicalPriceMc,
      cheapestMc,
      dearestMc,
    });
    costMc += typicalCostMc;
    minMc += cheapestMc;
    maxMc += dearestMc;
    groupsPriceMc += typicalPriceMc;
  }
  return { base, groups, costMc, priceMc: item.basePriceCents * 1000 + groupsPriceMc, groupsPriceMc, minMc, maxMc };
}

function divRound(n: bigint, d: bigint): number {
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const q = (2n * mag + d) / (2n * d);
  return Number(neg ? -q : q);
}

/** Every part of a typical plate: the lines always in it, then each option of each required group. */
function partsOf(t: Typical): PartCost[] {
  return [t.base, ...t.groups.flatMap((g) => g.options.map((oc) => oc.cost))];
}

/** A dish's plate cost at today's prices (see the file comment). */
export function plateCost(item: PlateItemInput, priceOf: PriceOf): PlateCost {
  const t = typicalPlate(item, priceOf, []);
  let missingLines = 0;
  let estimateLines = 0;
  const missingIngredientIds = new Set<string>();
  for (const part of partsOf(t)) {
    missingLines += part.missingLines;
    estimateLines += part.estimateLines;
    for (const l of part.lines) if (l.kind === 'missing') missingIngredientIds.add(l.ingredientId);
  }
  const missingOf = (x: Typical) => partsOf(x).reduce((s, part) => s + part.missingLines, 0);

  const paidExtras: PaidExtraCost[] = [];
  const leaveOuts: LeaveOutCost[] = [];
  for (const g of item.groups) {
    const required = requiredPicks(g, g.options.length) !== null;
    for (const o of g.options) {
      if (o.removesIngredientId) {
        const without = typicalPlate(item, priceOf, [o]);
        const savingMc = t.costMc - without.costMc;
        leaveOuts.push({
          option: o,
          ingredientId: o.removesIngredientId,
          savingMc,
          savingCents: mcToCents(savingMc),
          missingLines: Math.max(0, missingLines - missingOf(without)),
        });
        continue;
      }
      if (required || o.priceDeltaCents <= 0) continue;
      const cost = optionPart(item.recipe, o, [], priceOf);
      paidExtras.push({
        option: o,
        groupName: g.name,
        cost,
        marginCents: o.priceDeltaCents - cost.costCents,
        foodCostBps: shareBps(cost.costMc, o.priceDeltaCents * 1000),
      });
    }
  }

  return {
    hasRecipe: item.recipe.length > 0,
    base: t.base,
    groups: t.groups,
    typicalCostMc: t.costMc,
    typicalCostCents: mcToCents(t.costMc),
    minCostCents: mcToCents(t.minMc),
    maxCostCents: mcToCents(t.maxMc),
    typicalPriceMc: t.priceMc,
    typicalPriceCents: mcToCents(t.priceMc),
    groupsPriceMc: t.groupsPriceMc,
    profitCents: mcToCents(t.priceMc - t.costMc),
    foodCostBps: shareBps(t.costMc, t.priceMc),
    missingLines,
    missingIngredientIds: [...missingIngredientIds],
    estimateLines,
    paidExtras,
    leaveOuts,
  };
}

export interface TargetForFlag {
  /** The category's food-cost target. */
  bps: number;
  /** "Close" is up to this far over it. */
  amberBps: number;
  confirmed: boolean;
  nonFood: boolean;
}

/**
 * The chip colour: GREEN at or under the target T, AMBER up to T + A, RED
 * beyond; GREY when it can't be costed (an unpriced line, no recipe, no
 * price); NEUTRAL while the target is only a suggestion. Compared exactly
 * (cost × 10,000 against target × price), never on a rounded %.
 */
export function foodCostFlag(
  pc: { hasRecipe: boolean; missingLines: number; costMc: number; priceMc: number },
  t: TargetForFlag,
): FoodCostFlag {
  if (t.nonFood) return 'nonfood';
  if (!pc.hasRecipe || pc.missingLines > 0 || pc.priceMc <= 0) return 'grey';
  if (!t.confirmed) return 'neutral';
  const cost = BigInt(pc.costMc) * 10_000n;
  if (cost <= BigInt(t.bps) * BigInt(pc.priceMc)) return 'green';
  if (cost <= BigInt(t.bps + t.amberBps) * BigInt(pc.priceMc)) return 'amber';
  return 'red';
}

/**
 * The menu price that brings a dish to its target (spec 4.3, shown with
 * profit.view later): P* = ceil_to_step(TPC ÷ T − Σ_g P_g). Null for a zero
 * target. Rs 609.42 at 30% → Rs 2,031.40 → Rs 2,040 with Rs 10 steps.
 */
export function priceToHitTarget(typicalCostMc: number, targetBps: number, groupsPriceMc: number, stepCents: number): number | null {
  if (!(targetBps > 0) || !(stepCents > 0)) return null;
  // needed (mc) = TPC × 10,000 ÷ T − Σ P_g, then up to the next whole step.
  const neededNum = BigInt(typicalCostMc) * 10_000n - BigInt(groupsPriceMc) * BigInt(targetBps);
  const neededDen = BigInt(targetBps);
  const stepMc = BigInt(stepCents) * 1000n;
  if (neededNum <= 0n) return 0;
  const den = neededDen * stepMc;
  const steps = (neededNum + den - 1n) / den;
  return Number(steps * BigInt(stepCents));
}
