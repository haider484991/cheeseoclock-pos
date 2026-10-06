/**
 * Where a tax rate starts on the forms (first-time setup, Menu → Tax → Add
 * tax): ONE starting set, shared-types STARTING_TAX_RATE_BPS /
 * STARTING_TAX_CATEGORIES (setup offered 17% / 13% / 0% and a new category
 * started at 16% up to v0.7.26). Only where a form starts: editing an
 * existing tax category shows its own rate, and nothing here saves one.
 */
import { STARTING_TAX_CATEGORIES, STARTING_TAX_RATE_BPS } from '@cheeseoclock/shared-types';

/** The Rate (%) box: the category's own rate when editing one, the starting rate for a new one. */
export function taxRateFieldStart(existing: { rateBps: number } | null): string {
  return ((existing?.rateBps ?? STARTING_TAX_RATE_BPS) / 100).toString();
}

/**
 * The "when paid by card / wallet" box (0052): the category's own card rate
 * when it has one, else empty — empty means no card rate (the same rate
 * however the bill is paid), for a new category too.
 */
export function cardRateFieldStart(existing: { rateBps?: number; digitalRateBps?: number | null } | null): string {
  const bps = existing?.digitalRateBps;
  return typeof bps === 'number' ? (bps / 100).toString() : '';
}

/**
 * A rate box as basis points: "8" → 800, "12.5" → 1250; empty or not a
 * number → null (the card box: no card rate). Never below 0 or over 100%.
 */
export function rateBpsOf(text: string): number | null {
  const n = parseFloat(text.trim());
  if (text.trim() === '' || !Number.isFinite(n)) return null;
  return Math.min(10_000, Math.max(0, Math.round(n * 100)));
}

/** "15%", "15% · card 8%": a category's rates as the Tax list shows them. */
export function taxRatesText(t: { rateBps: number; digitalRateBps?: number | null }): string {
  const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
  return typeof t.digitalRateBps === 'number' && t.digitalRateBps !== t.rateBps ? `${pct(t.rateBps)} · card ${pct(t.digitalRateBps)}` : pct(t.rateBps);
}

/** First-time setup's tax rows (fresh copies, each editable there). */
export function startingTaxRows(): Array<{ name: string; rateBps: number }> {
  return STARTING_TAX_CATEGORIES.map((r) => ({ name: r.name, rateBps: r.rateBps }));
}
