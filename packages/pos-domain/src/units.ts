/**
 * Ingredient units. Stock and recipes count whole base units (g, ml, pcs…),
 * so a kilogram or litre unit cannot hold "300 g of dough" — those are
 * converted to grams / millilitres. Costs come from how the item is bought:
 * a pack of N base units for a price, giving a cost per base unit.
 */

import { formatCents } from './money.js';

const UNIT_ALIASES: Record<string, string> = {
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', each: 'pcs', ea: 'pcs', nos: 'pcs', no: 'pcs', unit: 'pcs', units: 'pcs',
  slice: 'slice', slices: 'slice',
  portion: 'portion', portions: 'portion',
  pkt: 'pkt', pkts: 'pkt', packet: 'pkt', packets: 'pkt', pack: 'pkt', packs: 'pkt',
};

/** Canonical spelling of a unit: "Grams" → "g", "Packet" → "pkt". Unknown units are lower-cased. */
export function normalizeUnit(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[key] ?? key;
}

/** Units the ingredient screen offers. */
export const INGREDIENT_UNITS = ['g', 'ml', 'pcs', 'slice', 'portion', 'pkt'] as const;

/** kg → g and l → ml, ×1000. Null when the unit is already a base unit. */
export function baseUnitConversion(unit: string): { unit: 'g' | 'ml'; factor: 1000 } | null {
  const u = normalizeUnit(unit);
  if (u === 'kg') return { unit: 'g', factor: 1000 };
  if (u === 'l') return { unit: 'ml', factor: 1000 };
  return null;
}

/**
 * What a stock row written in `from` is worth in `to`, the ingredient's unit
 * now: 1 when nothing changed (or the row carries no unit — rows written
 * before 0029 read as "the unit now"), 1000 after a Convert (kg → g,
 * l → ml). Null when the two can't be converted (not a change the till makes).
 */
export function unitFactor(from: string | null | undefined, to: string): number | null {
  if (from === null || from === undefined || from === '') return 1;
  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (a === b) return 1;
  const conv = baseUnitConversion(a);
  if (conv && conv.unit === b) return conv.factor;
  return null;
}

/**
 * What a quantity of an ingredient cost, in paisa, at its stored price. Exact
 * from the pack ("6,000 g for Rs 2,250") when there is one, else the stored
 * per-unit cost. Rounded once, on the total.
 */
export function ingredientCostCents(
  qty: number,
  i: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null },
): number {
  if (qty === 0) return 0;
  if (i.packSize && i.packSize > 0 && i.packPriceCents !== null) {
    return Math.round((qty * i.packPriceCents) / i.packSize);
  }
  return Math.round(qty * i.costPerUnitCents);
}

/** Cost of one base unit, in whole paisa, from a pack price. */
export function costPerUnitFromPack(packPriceCents: number, packSize: number): number {
  if (!(packSize > 0)) throw new Error('Pack size must be more than zero');
  return Math.round(packPriceCents / packSize);
}

/**
 * Cost per base unit for display: exact from the pack when there is one
 * ("Rs 0.375 / g"), up to three decimals, else the stored per-unit cost.
 */
export function formatUnitCost(i: {
  unit: string;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
}): string {
  const fromPack = !!i.packSize && i.packSize > 0 && i.packPriceCents !== null;
  const rupees = fromPack ? i.packPriceCents! / i.packSize! / 100 : i.costPerUnitCents / 100;
  const text = new Intl.NumberFormat('en-PK', {
    minimumFractionDigits: rupees < 1 ? 2 : 0,
    maximumFractionDigits: rupees < 1 ? 3 : 2,
  }).format(rupees);
  return `Rs ${text} / ${i.unit}`;
}

// -----------------------------------------------------------------------------
// Exact costing (costing spec D1, D10). An ingredient's price is kept as the
// pack it was bought in ("6,000 g for Rs 2,250"), never as a per-gram price
// rounded to whole paisa. Every figure is worked out from the pack in integer
// arithmetic and rounded ONCE, half away from zero, so a take and its
// put-back are the same size and net to exactly 0.
// -----------------------------------------------------------------------------

/** A price as a pack: `size` base units for `priceCents` paisa. */
export interface Pack {
  size: number;
  priceCents: number;
}

/**
 * The pack an ingredient is costed from: its own pack when it has one, else
 * a pack of 1 at the stored per-unit cost (the old way of entering a price).
 */
export function effectivePack(i: { costPerUnitCents: number; packSize: number | null; packPriceCents: number | null }): Pack {
  if (i.packSize && i.packSize > 0 && i.packPriceCents !== null) return { size: i.packSize, priceCents: i.packPriceCents };
  return { size: 1, priceCents: i.costPerUnitCents };
}

function assertWhole(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a whole number`);
}

/** n / d rounded half away from zero, exactly (d > 0). */
function roundRatio(n: bigint, d: bigint): number {
  const neg = n < 0n;
  const mag = neg ? -n : n;
  const q = (2n * mag + d) / (2n * d);
  return Number(neg ? -q : q);
}

/**
 * round(a × b ÷ den), half away from zero, exact even when a × b is past
 * 2^53 (worked in BigInt). The one rounding every costing figure goes through.
 */
export function mulDivRound(a: number, b: number, den: number): number {
  return ratioRound([a, b], [den]);
}

/**
 * (n1 × n2 × …) ÷ (d1 × d2 × …), rounded half away from zero, exactly: the
 * products are worked in BigInt, so no step ever passes through a float.
 */
export function ratioRound(nums: readonly number[], dens: readonly number[]): number {
  let n = 1n;
  let d = 1n;
  for (const x of nums) {
    assertWhole(x, 'Amount');
    n *= BigInt(x);
  }
  for (const x of dens) {
    assertWhole(x, 'Divisor');
    if (x <= 0) throw new Error('Divisor must be more than zero');
    d *= BigInt(x);
  }
  return roundRatio(n, d);
}

/**
 * What `q` base units are worth, in paisa, SIGNED like q:
 * sign(q) × round_half_up(|q| × P ÷ S). value(−q) = −value(q), so a take and
 * the same put-back net to exactly 0.
 */
export function valueCents(q: number, pack: Pack): number {
  return mulDivRound(q, pack.priceCents, pack.size);
}

/** Price of one base unit in millicents (1/1000 paisa): round(P × 1000 ÷ S). Per gram, it reads as paisa per kg. */
export function unitCostMc(pack: Pack): number {
  return mulDivRound(pack.priceCents, 1000, pack.size);
}

/** Cost of `qty` base units in millicents: round(qty × P × 1000 ÷ S). */
export function lineCostMc(qty: number, pack: Pack): number {
  return ratioRound([qty, pack.priceCents, 1000], [pack.size]);
}

/** Millicents to paisa, rounded once. */
export function mcToCents(mc: number): number {
  return mulDivRound(mc, 1, 1000);
}

/**
 * A part of a whole in basis points (share of a plate, food cost %):
 * round(part × 10,000 ÷ whole); null when the whole is not above zero.
 */
export function shareBps(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return mulDivRound(part, 10_000, whole);
}

// -----------------------------------------------------------------------------
// Prices as they are typed, and prices across a Convert (costing spec 4.1,
// Phase 4). Every one of these keeps the price EXACT: a pack, never a price
// per gram rounded to whole paisa.
// -----------------------------------------------------------------------------

/** A weighed or measured unit (grams, kg, ml, litres): priced per kg / litre, never per piece. */
export function isWeighedUnit(unit: string): boolean {
  const u = normalizeUnit(unit);
  return u === 'g' || u === 'kg' || u === 'ml' || u === 'l';
}

/** What "per kg" (or "per litre") is in this unit: 1,000 g, 1,000 ml, 1 kg, 1 litre; null when not weighed. */
export function thousandSize(unit: string): number | null {
  const u = normalizeUnit(unit);
  if (u === 'g' || u === 'ml') return 1000;
  if (u === 'kg' || u === 'l') return 1;
  return null;
}

/** "kg" or "litre" for a weighed / measured unit, else null. */
export function thousandWord(unit: string): 'kg' | 'litre' | null {
  const u = normalizeUnit(unit);
  if (u === 'g' || u === 'kg') return 'kg';
  if (u === 'ml' || u === 'l') return 'litre';
  return null;
}

/** How a price may be typed for this unit: per kg / litre or per pack when weighed; per piece or per pack otherwise. */
export function priceEntryChoices(unit: string): Array<'thousand' | 'pack' | 'piece'> {
  return isWeighedUnit(unit) ? ['thousand', 'pack'] : ['piece', 'pack'];
}

/** A price as typed on the "Set price" dialog. */
export interface TypedPrice {
  per: 'thousand' | 'pack' | 'piece';
  /** Rs X, in paisa. */
  priceCents: number;
  /** N, for a pack: base units in one pack. */
  packSize?: number | null;
}

/**
 * The exact pack a typed price is (costing spec 4.1), for an ingredient
 * counted in `unit`:
 *   "Rs X per kg / litre" → (1,000, 100X) in g / ml, (1, 100X) in kg / l;
 *   "Rs X per pack of N"  → (N, 100X);
 *   "Rs X per piece"      → (1, 100X).
 * Throws, in plain words, when the way it is typed does not fit the unit
 * ("per piece" of something weighed would be a per-gram price again).
 */
export function typedPricePack(t: TypedPrice, unit: string): Pack {
  assertWhole(t.priceCents, 'The price');
  if (t.priceCents < 0) throw new Error('A price cannot be below Rs 0');
  switch (t.per) {
    case 'thousand': {
      const size = thousandSize(unit);
      if (size === null) throw new Error(`Per kg or per litre only fits something weighed or measured, not ${unit}: use per piece or per pack`);
      return { size, priceCents: t.priceCents };
    }
    case 'pack': {
      const size = t.packSize ?? 0;
      if (!Number.isSafeInteger(size) || size < 1) throw new Error(`Say how much one pack holds, in whole ${unit}`);
      return { size, priceCents: t.priceCents };
    }
    case 'piece':
      if (isWeighedUnit(unit)) throw new Error(`Per piece does not fit something counted in ${unit}: use per ${thousandWord(unit) ?? 'kg'} or per pack`);
      return { size: 1, priceCents: t.priceCents };
    default:
      throw new Error('Say how the price is bought: per kg, per pack or per piece');
  }
}

/**
 * The same price after a Convert that counts `factor`× as many units (kg → g,
 * l → ml): the pack holds factor× as many units for the same money, so
 * every value stays exactly as it was. Replaces rounding the per-unit cost.
 */
export function convertPack(pack: Pack, factor: number): Pack {
  assertWhole(factor, 'The factor');
  if (factor < 1) throw new Error('The factor must be at least 1');
  return { size: pack.size * factor, priceCents: pack.priceCents };
}

/**
 * A pack kept in one unit, as a pack in another it converts to (a price
 * kept in kg for a row counted in g, or the other way round), exactly; null
 * when the two units do not convert. Same unit: the pack as it is.
 */
export function packInUnit(pack: Pack, from: string, to: string): Pack | null {
  const down = unitFactor(from, to);
  if (down !== null) return down === 1 ? pack : convertPack(pack, down);
  const up = unitFactor(to, from);
  // S base units of `from` for P = S units of `to` for P × up (1 kg = 1,000 g).
  if (up !== null) return { size: pack.size, priceCents: pack.priceCents * up };
  return null;
}

/** "6,000 g for Rs 2,250" */
export function formatPack(i: { unit: string; packSize: number | null; packPriceCents: number | null }): string | null {
  if (!i.packSize || i.packPriceCents === null) return null;
  return `${new Intl.NumberFormat('en-PK').format(i.packSize)} ${i.unit} for ${formatCents(i.packPriceCents)}`;
}
