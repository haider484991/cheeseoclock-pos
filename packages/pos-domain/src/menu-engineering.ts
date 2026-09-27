/**
 * The menu map (costing spec 4.8, Phase 9): menu engineering in the
 * AHLEI / Kasavana–Smith way, per category, at menu price, in the owner's
 * words. Pure, so it is tested against the textbook example.
 *
 *  - The dishes (the spec's "items"): every food dish on the menu now plus
 *    any sold — placed, "can't place yet" and not sold alike.
 *  - n_i = units sold; MM_i = n_i ÷ Σn (the dish's share of the category),
 *    Σn over EVERY dish: a dish whose cost is not known yet still sold what
 *    it sold, so it stays in the mix.
 *  - CM_i = (Σ menu price − Σ cost) ÷ units, over the sales whose cost is
 *    fully known (what one sale earns).
 *  - Popular: MM_i ≥ 70% × (1 ÷ N), N every dish of the category, sold or
 *    not (the 70% rule: a dish on the menu that nobody ordered still has an
 *    equal share to live up to).
 *  - Profitable: CM_i ≥ Σ(n_i × CM_i) ÷ Σn_i over the PLACED dishes — the
 *    weighted average (AHLEI: 3,444.80 ÷ 1,000 = 3.44), not a plain average
 *    of the dishes; only placed dishes have a known CM.
 *  - A category needs 200 units and 3 dishes (costing spec 4.8); otherwise
 *    "not enough sales yet". A dish with under 90% of its units fully costed
 *    can't be placed yet, and the map also waits for 3 PLACED dishes: an
 *    average profit worked out from one or two dishes would call one of them
 *    "profitable" by definition (a stricter rule than the spec's, on purpose).
 *
 * Exact integer comparisons (CM kept in millicents, one rounding each);
 * nothing is compared on a rounded percentage.
 */
import type { MenuMapClass } from '@cheeseoclock/shared-types';
import { shareBps } from './units.js';

/** A category needs this many units sold (costing spec 4.8). */
export const MENU_MAP_MIN_UNITS = 200;
/** …and this many dishes with known costs. */
export const MENU_MAP_MIN_DISHES = 3;
/** A dish needs this share of its units fully costed to be placed: 90%. */
export const MENU_MAP_COSTED_BPS = 9_000;
/** The popularity line: 70% of an equal share. */
export const MENU_MAP_POPULAR_PCT = 70;

export interface MenuMapDishInput {
  id: string;
  name: string;
  /** Units sold in the days looked at (every sale). */
  units: number;
  /** Of them, units whose cost is fully known… */
  knownUnits: number;
  /** …their menu price (line totals)… */
  knownMenuSalesCents: number;
  /** …and what they cost. */
  knownCostCents: number;
}

export interface MenuMapDish {
  id: string;
  name: string;
  units: number;
  mixBps: number;
  /** What one sale earns at menu price, millicents (one rounding). */
  profitMc: number;
  profitPerSaleCents: number;
  priceCents: number;
  costCents: number;
  popular: boolean;
  profitable: boolean;
  class: MenuMapClass;
  belowAverageCents: number | null;
  raiseToAverageCents: number | null;
}

export interface MenuMapResult {
  state: 'ok' | 'few_sales' | 'few_dishes';
  units: number;
  dishes: MenuMapDish[];
  cantPlace: Array<{ id: string; name: string; units: number; costedShareBps: number }>;
  notSold: Array<{ id: string; name: string }>;
  /** 70% of an equal share, basis points; null unless 'ok'. */
  popularLineBps: number | null;
  /** The weighted average profit per sale, millicents and paisa; null unless 'ok'. */
  averageProfitMc: number | null;
  averageProfitCents: number | null;
}

function divRound(n: bigint, d: bigint): number {
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const q = (2n * mag + d) / (2n * d);
  return Number(neg ? -q : q);
}

/** The class from the two tests. */
export function menuMapClass(popular: boolean, profitable: boolean): MenuMapClass {
  if (popular) return profitable ? 'star' : 'plowhorse';
  return profitable ? 'puzzle' : 'dog';
}

/**
 * How much more on the price (or less on the cost) brings a dish to the
 * category's average profit per sale: the gap, rounded UP to the owner's
 * price step (Rs 10 by default). 0 when it is already there.
 */
export function raiseToAverageCents(averageProfitMc: number, profitMc: number, stepCents: number): number {
  const gapMc = averageProfitMc - profitMc;
  if (gapMc <= 0) return 0;
  const step = Math.max(1, Math.round(stepCents)) * 1000;
  return Math.ceil(gapMc / step) * (step / 1000);
}

/** One category's menu map. `stepCents`: the owner's price step, for "Rs 60 more on the price". */
export function menuMap(dishes: readonly MenuMapDishInput[], stepCents: number): MenuMapResult {
  // Σn: the units of every dish of the category (placed or not).
  const units = dishes.reduce((s, d) => s + Math.max(0, d.units), 0);
  const notSold: MenuMapResult['notSold'] = [];
  const cantPlace: MenuMapResult['cantPlace'] = [];
  const placed: MenuMapDishInput[] = [];
  for (const d of dishes) {
    if (d.units <= 0) notSold.push({ id: d.id, name: d.name });
    else if (d.knownUnits <= 0 || d.knownUnits * 10_000 < MENU_MAP_COSTED_BPS * d.units) {
      cantPlace.push({ id: d.id, name: d.name, units: d.units, costedShareBps: shareBps(Math.max(0, d.knownUnits), d.units) ?? 0 });
    } else placed.push(d);
  }
  const empty = { dishes: [], popularLineBps: null, averageProfitMc: null, averageProfitCents: null };
  // N: every dish of the category (spec 4.8's items), whether it could be placed, sold or not.
  const n = dishes.length;
  if (units < MENU_MAP_MIN_UNITS) return { state: 'few_sales', units, cantPlace, notSold, ...empty };
  if (n < MENU_MAP_MIN_DISHES || placed.length < MENU_MAP_MIN_DISHES) return { state: 'few_dishes', units, cantPlace, notSold, ...empty };

  const placedUnits = placed.reduce((s, d) => s + d.units, 0);
  const withCm = placed.map((d) => ({
    d,
    profitMc: divRound(BigInt(d.knownMenuSalesCents - d.knownCostCents) * 1000n, BigInt(d.knownUnits)),
  }));
  // Σ n_i × CM_i over the placed dishes (millicents × units), and the line Σ ÷ Σn (compared exactly, not rounded).
  const weighted = withCm.reduce((s, x) => s + BigInt(x.d.units) * BigInt(x.profitMc), 0n);
  const averageProfitMc = divRound(weighted, BigInt(placedUnits));
  const out: MenuMapDish[] = withCm.map(({ d, profitMc }) => {
    // MM ≥ 0.70 ÷ N  ⟺  n × N × 100 ≥ 70 × Σn — N and Σn over every dish.
    const popular = d.units * n * 100 >= MENU_MAP_POPULAR_PCT * units;
    // CM ≥ Σ(n × CM) ÷ Σn  ⟺  CM × Σn ≥ Σ(n × CM) — over the placed dishes.
    const profitable = BigInt(profitMc) * BigInt(placedUnits) >= weighted;
    const cls = menuMapClass(popular, profitable);
    const below = profitable ? null : Math.max(0, averageProfitMc - profitMc);
    return {
      id: d.id,
      name: d.name,
      units: d.units,
      mixBps: shareBps(d.units, units) ?? 0,
      profitMc,
      profitPerSaleCents: divRound(BigInt(profitMc), 1000n),
      priceCents: divRound(BigInt(d.knownMenuSalesCents), BigInt(d.knownUnits)),
      costCents: divRound(BigInt(d.knownCostCents), BigInt(d.knownUnits)),
      popular,
      profitable,
      class: cls,
      belowAverageCents: below === null ? null : divRound(BigInt(below), 1000n),
      raiseToAverageCents: cls === 'plowhorse' ? raiseToAverageCents(averageProfitMc, profitMc, stepCents) : null,
    };
  });
  out.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  return {
    state: 'ok',
    units,
    dishes: out,
    cantPlace,
    notSold,
    // 70% of an equal share, basis points: 7,000 ÷ N.
    popularLineBps: divRound(BigInt(MENU_MAP_POPULAR_PCT * 100), BigInt(n)),
    averageProfitMc,
    averageProfitCents: divRound(BigInt(averageProfitMc), 1000n),
  };
}

// ----------------------------------------------------------- break-even --

/**
 * Break-even volume for a price change (costing spec 4.8): how much the
 * units sold can change before the change earns less (a rise) or before it
 * earns as much (a cut): ΔV = −ΔP ÷ (CM + ΔP), in basis points of the units
 * sold now. CM is what one sale earns now (price − cost), in the same unit
 * as ΔP. +20% at a 60% margin: −25%; −20%: +50%. Null when the new price
 * earns nothing per sale (no volume makes up for it) or nothing changes.
 */
export function breakEvenVolumeBps(priceChange: number, profitPerSaleNow: number): number | null {
  if (priceChange === 0) return 0;
  const after = profitPerSaleNow + priceChange;
  if (after <= 0) return null;
  return divRound(BigInt(-priceChange) * 10_000n, BigInt(after));
}

/** The same from percentages (basis points of the price): ΔV% = −ΔP% ÷ (CM% + ΔP%). */
export function breakEvenVolumeFromShares(priceChangeBps: number, marginBps: number): number | null {
  return breakEvenVolumeBps(priceChangeBps, marginBps);
}
