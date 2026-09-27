/**
 * "Prices for the costing file" (costing spec Phase 6, section 8): the
 * till's ingredient prices as a CSV, a HANDOFF to whoever keeps the costing
 * workbook (the owner is not expected to run anything). Once costing has
 * started the till owns prices — deliveries and bills set them — so the
 * workbook goes stale unless someone copies these into it. Each line says
 * the till's price, where it came from and since when, beside what the
 * sheet says now. Pure, so what goes in the file is tested (with made-up
 * prices only: the repo is public).
 */
import { effectivePack, thousandSize, unitCostMc } from '@cheeseoclock/pos-domain';
import type { Ingredient } from '@cheeseoclock/shared-types';
import { toCsv, type CsvCell } from '../reports/exporters';
import { SOURCE_CHIP } from './price-view';

const KIND_WORD: Record<Ingredient['priceKind'], string> = {
  set: 'known',
  estimate: 'a guess',
  free: 'free',
  unset: 'no price yet',
};

/** Rupees for a spreadsheet (plain, two decimals). */
const rs = (cents: number): { cents: number } => ({ cents });

/** One base unit (mc) as the price per kg / litre / piece, in paisa (rounded once). */
function perText(unit: string): string {
  if (unit === 'g') return 'kg';
  if (unit === 'ml') return 'litre';
  return unit;
}

function perPriceCents(mc: number, unit: string): number {
  const size = thousandSize(unit) ?? 1;
  // mc × size ÷ 1,000, rounded half away from zero.
  const num = mc * size;
  return Math.sign(num) * Math.floor((2 * Math.abs(num) + 1000) / 2000);
}

/** The till's price per base unit (mc), or null when it has none (no price yet, or free). */
function tillUnitMc(i: Ingredient): number | null {
  if (i.priceKind === 'unset') return null;
  if (i.priceKind === 'free') return 0;
  return unitCostMc(effectivePack(i));
}

/** Till against sheet: "12.5% dearer", "4% cheaper", "same"; blank when either has no price. */
function differenceText(till: number | null, sheet: number | null): string {
  if (till === null || sheet === null || sheet <= 0) return '';
  if (till === sheet) return 'same';
  const bps = Math.round(((till - sheet) * 10_000) / sheet);
  const pct = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(Math.abs(bps) / 100);
  return `${pct}% ${bps > 0 ? 'dearer' : 'cheaper'}`;
}

export const COSTING_FILE_HEADER = [
  'Ingredient',
  'Till price (Rs)',
  'Per',
  'Bought as (units)',
  'Pack price (Rs)',
  'Price is',
  'Where it came from',
  'Since',
  "Sheet's price (Rs)",
  'Till against the sheet',
] as const;

/** The CSV's rows, header first, by ingredient name. */
export function costingFileRows(ingredients: readonly Ingredient[]): CsvCell[][] {
  const rows: CsvCell[][] = [[...COSTING_FILE_HEADER]];
  const sorted = [...ingredients].filter((i) => i.isActive).sort((a, b) => a.name.localeCompare(b.name));
  for (const i of sorted) {
    const till = tillUnitMc(i);
    const sheet = i.sheetPrice && i.sheetPrice.priceKind !== 'unset' ? i.sheetPrice.unitCostMc : null;
    const pack = i.priceKind === 'unset' || i.priceKind === 'free' ? null : effectivePack(i);
    const tag = i.latestPrice ?? null;
    rows.push([
      i.name,
      till === null ? null : rs(perPriceCents(till, i.unit)),
      perText(i.unit),
      pack && pack.size > 1 ? pack.size : null,
      pack && pack.size > 1 ? rs(pack.priceCents) : null,
      i.priceFromRecipe ? 'from its batch recipe' : KIND_WORD[i.priceKind],
      tag ? SOURCE_CHIP[tag.source].label : '',
      tag && tag.source !== 'seed' ? tag.effectiveAt.slice(0, 10) : '',
      sheet === null ? null : rs(perPriceCents(sheet, i.unit)),
      differenceText(till, sheet),
    ]);
  }
  return rows;
}

/** The file itself: UTF-8 with a byte-order mark, so Excel reads it right. */
export function costingFileCsv(ingredients: readonly Ingredient[]): string {
  return toCsv(costingFileRows(ingredients));
}

/**
 * Said in words under the "Prices for the costing file" button (costing spec
 * section 8: the handoff "is stated on the button"), never in a tooltip — a
 * touch-screen till shows none.
 */
export const COSTING_FILE_NOTE = 'For whoever keeps the costing workbook: nothing to run, just copy the prices in.';

/** Said in words above the ingredients: what the "Sheet says" column is (a reference, never used on its own). */
export const SHEET_SAYS_NOTE =
  "Sheet says: the costing sheet's price, from the menu file. Only a reference: the till's own price is what costs your dishes, unless you tap \"Use the sheet's price\".";

/** "prices-for-the-costing-file-2026-09-27.csv" */
export function costingFileName(now: Date): string {
  return `prices-for-the-costing-file-${now.toISOString().slice(0, 10)}.csv`;
}
