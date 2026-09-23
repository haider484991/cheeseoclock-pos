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

/** "6,000 g for Rs 2,250" */
export function formatPack(i: { unit: string; packSize: number | null; packPriceCents: number | null }): string | null {
  if (!i.packSize || i.packPriceCents === null) return null;
  return `${new Intl.NumberFormat('en-PK').format(i.packSize)} ${i.unit} for ${formatCents(i.packPriceCents)}`;
}
