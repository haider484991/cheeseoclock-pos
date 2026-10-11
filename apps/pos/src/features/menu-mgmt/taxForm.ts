/**
 * Where a tax rate starts on the forms (first-time setup, Menu → Tax → Add
 * tax): ONE starting set, shared-types STARTING_TAX_RATE_BPS /
 * STARTING_TAX_CATEGORIES (setup offered 17% / 13% / 0% and a new category
 * started at 16% up to v0.7.26). Only where a form starts: editing an
 * existing tax category shows its own rate, and nothing here saves one.
 */
import {
  RATED_METHOD_LABEL,
  RATED_PAYMENT_METHODS,
  rateByMethod,
  STARTING_TAX_CATEGORIES,
  STARTING_TAX_RATE_BPS,
  type MethodRatesBps,
  type RatedPaymentMethod,
} from '@cheeseoclock/shared-types';

/** The Rate (%) box: the category's own rate when editing one, the starting rate for a new one. */
export function taxRateFieldStart(existing: { rateBps: number } | null): string {
  return ((existing?.rateBps ?? STARTING_TAX_RATE_BPS) / 100).toString();
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

/** "15%", "12.5%". */
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** "card", "EasyPaisa", "bank": a way of paying in the tax list's words. */
function wayWord(m: RatedPaymentMethod): string {
  return m === 'card' ? 'card' : m === 'bank_transfer' ? 'bank' : RATED_METHOD_LABEL[m];
}

/**
 * "15%", "15% · card 8%": a category's rates as the Tax list shows them.
 * Every way but cash at one rate reads "card 8%", as since 0052; ways at
 * rates of their own (0.7.45) are listed by rate — "15% · card, EasyPaisa
 * 8% · bank 10%" — and a way at the cash rate is not listed.
 */
export function taxRatesText(t: { rateBps: number; digitalRateBps?: number | null; methodRatesBps?: MethodRatesBps | null }): string {
  const groups: Array<{ rate: number; ways: RatedPaymentMethod[] }> = [];
  for (const m of RATED_PAYMENT_METHODS) {
    const rate = rateByMethod(t, m);
    if (rate === t.rateBps) continue;
    const g = groups.find((x) => x.rate === rate);
    if (g) g.ways.push(m);
    else groups.push({ rate, ways: [m] });
  }
  if (groups.length === 0) return pct(t.rateBps);
  if (groups.length === 1 && groups[0]!.ways.length === RATED_PAYMENT_METHODS.length) return `${pct(t.rateBps)} · card ${pct(groups[0]!.rate)}`;
  return [pct(t.rateBps), ...groups.map((g) => `${g.ways.map(wayWord).join(', ')} ${pct(g.rate)}`)].join(' · ');
}

/** The boxes "Rate by how the customer pays" (0.7.45): one per way of paying but cash, as typed. */
export type WayRateFields = Record<RatedPaymentMethod, string>;

/**
 * Where those boxes start: each way's rate as the category charges it now,
 * written out — empty when it is the cash rate (an empty box means the cash
 * rate). A new category starts with every box empty.
 */
export function wayRateFieldsStart(existing: { rateBps: number; digitalRateBps?: number | null; methodRatesBps?: MethodRatesBps | null } | null): WayRateFields {
  const out = {} as WayRateFields;
  for (const m of RATED_PAYMENT_METHODS) {
    const rate = existing ? rateByMethod(existing, m) : null;
    out[m] = rate === null || rate === existing?.rateBps ? '' : (rate / 100).toString();
  }
  return out;
}

/**
 * The boxes as the tax category stores them: the card's box is the card rate
 * (empty: none, the cash rate), each other way's box its own rate (empty:
 * the cash rate). The main process keeps only the ways that differ from the
 * card rate, so a category whose ways all pay the card rate is stored
 * exactly as before 0.7.45.
 */
export function wayRatesOf(rateBps: number, fields: WayRateFields): { digitalRateBps: number | null; methodRatesBps: MethodRatesBps } {
  const card = rateBpsOf(fields.card);
  const methodRatesBps: MethodRatesBps = {};
  for (const m of RATED_PAYMENT_METHODS) {
    if (m === 'card') continue;
    methodRatesBps[m] = rateBpsOf(fields[m]) ?? rateBps;
  }
  return { digitalRateBps: card === rateBps ? null : card, methodRatesBps };
}

/** First-time setup's tax rows (fresh copies, each editable there). */
export function startingTaxRows(): Array<{ name: string; rateBps: number }> {
  return STARTING_TAX_CATEGORIES.map((r) => ({ name: r.name, rateBps: r.rateBps }));
}
