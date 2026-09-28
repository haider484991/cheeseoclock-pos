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

/** First-time setup's tax rows (fresh copies, each editable there). */
export function startingTaxRows(): Array<{ name: string; rateBps: number }> {
  return STARTING_TAX_CATEGORIES.map((r) => ({ name: r.name, rateBps: r.rateBps }));
}
