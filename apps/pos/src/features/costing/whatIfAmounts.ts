/**
 * What if on one dish's amounts (0.7.46; the owner, 12 Oct 2026: "the recipe
 * calculator should be really comprehensive — I wanted to know the cost of
 * Regular Fries if I only decrease or increase the fries grams"). The words
 * and steps of RecipeWhatIfDialog, pure so they are tested; the costs
 * themselves come from the main process (costing:recipeWhatIf), the same
 * plate the recipe editor's footer and the cost sheet show.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import { formatNumber } from '@cheeseoclock/pos-domain';

/** How much a − / + tap moves an amount: 10 g / ml on a big amount, 5 on a small one; 1 of anything counted. */
export function amountStep(unit: string, qty: number): number {
  if (unit === 'g' || unit === 'ml') return qty >= 100 ? 10 : 5;
  return 1;
}

/** One − / + tap: never below 0 (0 takes the line off the plate while trying). */
export function stepAmount(qty: number, unit: string, direction: 1 | -1): number {
  const step = amountStep(unit, direction === 1 ? qty : Math.max(0, qty - 1));
  return Math.max(0, qty + direction * step);
}

/** "+Rs 45", "−Rs 20", "no change": the difference between two amounts of money. */
export function moneyDiff(beforeCents: number, afterCents: number): string {
  const d = afterCents - beforeCents;
  if (d === 0) return 'no change';
  return d > 0 ? `+${formatCents(d)}` : `−${formatCents(-d)}`;
}

/** "+5.0 points", "−2.5 points": a food cost % moving, in points; null when either side has none. */
export function bpsDiff(beforeBps: number | null, afterBps: number | null): string | null {
  if (beforeBps === null || afterBps === null) return null;
  const d = afterBps - beforeBps;
  if (d === 0) return 'no change';
  const pts = formatNumber(Math.abs(d) / 100, { minFractionDigits: 1, maxFractionDigits: 1 });
  return `${d > 0 ? '+' : '−'}${pts} points`;
}

/** A price box as paisa: "900" → 90,000; empty, not a number or below 0 → null (the menu's price). */
export function priceCentsOf(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

/** Have the amounts tried moved from the saved ones (line by line, in the same order)? */
export function amountsChanged(saved: ReadonlyArray<{ qtyPerUnit: number }>, tried: ReadonlyArray<{ qtyPerUnit: number }>): boolean {
  return saved.length !== tried.length || saved.some((l, i) => l.qtyPerUnit !== tried[i]?.qtyPerUnit);
}

/** The lines Save writes: the amounts tried, a line tried at 0 left out (taken off the recipe). */
export function linesToSave<L extends { qtyPerUnit: number }>(tried: ReadonlyArray<L>): L[] {
  return tried.filter((l) => l.qtyPerUnit > 0);
}
