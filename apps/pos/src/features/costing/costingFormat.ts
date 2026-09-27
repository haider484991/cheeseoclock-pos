/**
 * How the Costing page says things (costing spec D15: plain words, a few
 * numbers). Pure, so the wording is tested.
 */
import { formatCents, mcToCents, suggestedTargetBps } from '@cheeseoclock/pos-domain';
import type { BatchCalc, CategoryTargetView, CostLineKind, FoodCostFlag, LeaveOutView, MenuCostRow } from '@cheeseoclock/shared-types';

/** 1470 → "14.7%"; 3000 → "30%". */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  const pct = bps / 100;
  return `${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(pct)}%`;
}

/** Millicents as rupees, rounded once to paisa. */
export function formatMc(mc: number): string {
  return formatCents(mcToCents(mc));
}

/** Weighed units: the price is per kilogram / litre; anything else per piece (or slice…). */
function perThousand(unit: string): string | null {
  if (unit === 'g') return 'kg';
  if (unit === 'ml') return 'litre';
  return null;
}

/**
 * A unit price for people: "Rs 1,200 / kg" for grams (a gram's price in
 * millicents is the kilogram's in paisa), "Rs 40 / pcs" for pieces.
 */
export function formatUnitPrice(unitCostMc: number | null, unit: string): string {
  if (unitCostMc === null) return 'no price';
  const big = perThousand(unit);
  if (big) return `${formatCents(unitCostMc)} / ${big}`;
  return `${formatMc(unitCostMc)} / ${unit || 'unit'}`;
}

/** An exact amount in hundredths of a base unit: 1250 → "12.5 g". */
export function formatHundredths(hundredths: number, unit: string): string {
  const n = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(hundredths / 100);
  return `${n} ${unit}`;
}

export function formatQtyUnit(qty: number, unit: string): string {
  return `${new Intl.NumberFormat('en-PK').format(qty)} ${unit}`;
}

export const FLAG_LABEL: Record<FoodCostFlag, string> = {
  green: 'On target',
  amber: 'Close',
  red: 'Over target',
  grey: "Can't cost yet",
  neutral: 'Target not confirmed',
  nonfood: 'Not food',
};

/** Worst first: over, close, can't cost, unconfirmed, on target, not food. */
const SEVERITY: Record<FoodCostFlag, number> = { red: 0, amber: 1, grey: 2, neutral: 3, green: 4, nonfood: 5 };

export function compareWorstFirst(a: Pick<MenuCostRow, 'flag' | 'foodCostBps' | 'name'>, b: Pick<MenuCostRow, 'flag' | 'foodCostBps' | 'name'>): number {
  return (
    SEVERITY[a.flag] - SEVERITY[b.flag] ||
    (b.foodCostBps ?? -1) - (a.foodCostBps ?? -1) ||
    a.name.localeCompare(b.name)
  );
}

/** "Fajita Pizza — Medium" → base "Fajita Pizza", size "Medium"; the dash the menu uses for sizes. */
export function splitSize(name: string): { base: string; size: string | null } {
  const m = name.match(/^(.*\S)\s+[—–]\s+(\S.*)$/);
  return m ? { base: m[1]!, size: m[2]! } : { base: name, size: null };
}

export interface SizeGroup {
  key: string;
  base: string;
  rows: MenuCostRow[];
}

/**
 * Rows grouped by base name within a category ("Fajita Pizza": Medium,
 * Large), each group placed at its worst size, groups worst first.
 */
export function groupSizes(rows: readonly MenuCostRow[]): SizeGroup[] {
  const groups = new Map<string, SizeGroup>();
  for (const r of [...rows].sort(compareWorstFirst)) {
    const { base } = splitSize(r.name);
    const key = `${r.categoryId}|${base.toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { key, base, rows: [r] });
  }
  return [...groups.values()];
}

/**
 * "31 items: 18 on target, 9 close, 4 over, 3 can't be costed yet". Items
 * whose category target is still only a suggestion have not been checked
 * against anything, and it says so — never a count that reads as good news.
 */
export function summarySentence(s: { items: number; onTarget: number; close: number; over: number; cantCost: number; notConfirmed: number }): string {
  const parts: string[] = [];
  if (s.onTarget) parts.push(`${s.onTarget} on target`);
  if (s.close) parts.push(`${s.close} close`);
  if (s.over) parts.push(`${s.over} over`);
  if (s.notConfirmed) parts.push(`${s.notConfirmed} not checked yet (the targets are only suggestions)`);
  if (s.cantCost) parts.push(`${s.cantCost} can't be costed yet`);
  const head = `${s.items} ${s.items === 1 ? 'item' : 'items'}`;
  return parts.length ? `${head}: ${parts.join(', ')}` : head;
}

/** A line whose price is not a real one says so. */
export function priceKindNote(kind: CostLineKind): string | null {
  switch (kind) {
    case 'unset':
    case 'missing':
      return 'no price yet';
    case 'estimate':
      return 'a guess';
    case 'free':
      return 'free';
    default:
      return null;
  }
}

/** A typed percentage ("32.5") as basis points, or null when it is not one. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const bps = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return bps <= 10_000 ? bps : null;
}

/** A typed rupee amount ("10", "12.5") as paisa, or null. */
export function parseRupees(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** The bigger unit a base unit can be typed in (g → kg, ml → litre), or null. */
export function thousandUnit(unit: string): 'kg' | 'litre' | null {
  if (unit === 'g') return 'kg';
  if (unit === 'ml') return 'litre';
  return null;
}

/** Words people type after an amount, per base unit: × 1 (the base unit) or × 1,000 (kg, litre). */
const UNIT_WORDS: Record<string, { base: readonly string[]; thousand: readonly string[] }> = {
  g: { base: ['g', 'gm', 'gms', 'gram', 'grams', 'gr'], thousand: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'] },
  ml: { base: ['ml', 'mls'], thousand: ['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'] },
};

export type AmountReading =
  | { ok: true; amount: number }
  | {
      ok: false;
      reason:
        /** Nothing typed yet. */
        | 'empty'
        /** Not an amount ("abc", "1.2.3", a unit that is not this item's). */
        | 'unreadable'
        /** A part of a base unit (12.5 g): stock is counted in whole ones. */
        | 'part-unit'
        /** More than three decimals in kg / litre (a part of a gram). */
        | 'too-precise'
        | 'zero';
    };

/**
 * An amount typed in the batch calculator, as whole base units of the batch
 * item: "200", "200 g", "1,500g", "1.5 kg" (or "1.5" with the kg switch on).
 * A unit typed after the number wins over the switch. Stock is counted in
 * whole base units, so "12.5 g" is refused — with the reason, so the screen
 * can say "switch to kg" rather than something that makes no sense.
 */
export function readAmount(text: string, inThousands: boolean, baseUnit: string): AmountReading {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (t === '') return { ok: false, reason: 'empty' };
  const m = t.match(/^(\d{1,9})(?:\.(\d+))?\s*([a-z]*)\.?$/);
  if (!m) return { ok: false, reason: 'unreadable' };
  const [, whole = '0', frac = '', word = ''] = m;
  let thousands = inThousands;
  if (word) {
    const words = UNIT_WORDS[baseUnit];
    if (words?.base.includes(word)) thousands = false;
    else if (words?.thousand.includes(word)) thousands = true;
    else if (word === baseUnit.toLowerCase() || (baseUnit === 'pcs' && ['pc', 'pcs', 'piece', 'pieces'].includes(word))) thousands = false;
    else return { ok: false, reason: 'unreadable' };
  }
  if (thousands && thousandUnit(baseUnit) === null) thousands = false;
  const digits = frac.replace(/0+$/, '');
  let n: number;
  if (thousands) {
    if (digits.length > 3) return { ok: false, reason: 'too-precise' };
    n = Number(whole) * 1000 + Number((digits + '000').slice(0, 3));
  } else {
    if (digits !== '') return { ok: false, reason: 'part-unit' };
    n = Number(whole);
  }
  return n > 0 ? { ok: true, amount: n } : { ok: false, reason: 'zero' };
}

/** The amount, or null when it is not a usable one (see readAmount). */
export function parseAmount(text: string, inThousands: boolean, baseUnit = 'g'): number | null {
  const r = readAmount(text, inThousands, baseUnit);
  return r.ok ? r.amount : null;
}

/** What to say under the amount box when it cannot be used, in plain words. */
export function amountProblem(r: AmountReading, baseUnit: string, inThousands: boolean): string | null {
  if (r.ok) return null;
  const big = thousandUnit(baseUnit);
  switch (r.reason) {
    case 'empty':
      return `Type an amount in ${inThousands && big ? big : baseUnit}.`;
    case 'part-unit':
      return big
        ? `Stock is counted in whole ${baseUnit}: type ${baseUnit} without a decimal, or switch to ${big} to type 1.5 ${big}.`
        : `Stock is counted in whole ${baseUnit}: type a whole number.`;
    case 'too-precise':
      return `At most 3 decimal places in ${big ?? baseUnit} (1 ${baseUnit} is 0.001 ${big ?? baseUnit}).`;
    case 'zero':
      return 'Type an amount above 0.';
    default:
      return big ? `Type an amount like 200 or 200 ${baseUnit}, or 1.5 ${big}.` : `Type an amount like 12 or 12 ${baseUnit}.`;
  }
}

/**
 * "Make this amount" may be pressed only when what is on screen is what it
 * will do: a usable amount, a recipe with lines, nothing already recording —
 * and, for a login that sees the costed breakdown, that breakdown already
 * worked out for THIS amount (it is fetched a moment after typing, and the
 * previous figures stay up, dimmed, until then).
 */
export function batchMakeReady(s: {
  amount: number | null;
  usable: boolean;
  hasLines: boolean;
  pending: boolean;
  seesCosts: boolean;
  /** The amount the breakdown on screen was worked out for, or null. */
  shownAmount: number | null;
}): boolean {
  if (!s.usable || s.amount === null || !s.hasLines || s.pending) return false;
  return !s.seesCosts || s.shownAmount === s.amount;
}

/** "Garlic has no price yet", "Garlic and Onion have…", or "5 ingredients have…" — each ingredient once. */
export function noPriceText(names: readonly string[]): string {
  if (names.length === 0) return 'Nothing is missing a price';
  if (names.length === 1) return `${names[0]} has no price yet`;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} have no price yet`;
  return `${names.length} ingredients have no price yet`;
}

/** Why a dish can't be costed yet (its chip is grey), in a few words. */
export function cantCostReason(r: Pick<MenuCostRow, 'hasRecipe' | 'missingIngredients' | 'priceCents'>): string {
  if (!r.hasRecipe) return 'No recipe yet';
  if (r.missingIngredients.length > 0) return noPriceText(r.missingIngredients);
  if (r.priceCents <= 0) return 'Its menu price is Rs 0';
  return 'A price is missing';
}

/** Rupees, or "at least" them when some of what they add up had no price (counted as Rs 0). */
export function atLeast(cents: number, partial: boolean): string {
  return partial ? `at least ${formatCents(cents)}` : formatCents(cents);
}

/** Lines costed with no price (they count as Rs 0). */
export function hasMissing(lines: ReadonlyArray<{ priceKind: CostLineKind }>): boolean {
  return lines.some((l) => l.priceKind === 'missing' || l.priceKind === 'unset');
}

/** What a leave-out saves, honestly: an unpriced ingredient's saving is not known. */
export function leaveOutText(l: Pick<LeaveOutView, 'savingCents' | 'missingLines' | 'ingredientName'>): string {
  if (l.missingLines === 0) return `saves ${formatCents(l.savingCents)}`;
  if (l.savingCents > 0) return `saves at least ${formatCents(l.savingCents)}`;
  return `saving not known yet: ${l.ingredientName} has no price`;
}

/**
 * The line above a sauce's "made of" breakdown when not every input has a
 * price: the line is costed at the sauce's saved price (or can't be costed),
 * while the breakdown adds up only the inputs that have one — so say which
 * figure is used and why they differ.
 */
export function madeOfNote(line: { costCents: number; priceKind: CostLineKind }, calc: Pick<BatchCalc, 'complete' | 'unpricedInputs' | 'totalCostCents'>): string | null {
  if (calc.complete) return null;
  const which = calc.unpricedInputs.length > 0 ? noPriceText(calc.unpricedInputs) : 'Its inputs lead back to itself';
  const known = `the inputs with a price come to ${formatCents(calc.totalCostCents)}`;
  if (line.priceKind === 'missing' || line.priceKind === 'unset') return `${which}, so this can't be costed yet; ${known}.`;
  return `${which}, so this is costed at its saved price (${formatCents(line.costCents)}) until every input has one; ${known}.`;
}

/**
 * What the default food-cost target does, from its value: the target of a
 * category with none of its own yet whose NAME the till has no suggestion
 * for (pos-domain suggestedTargetBps: a later "Cold Drinks" takes the
 * drinks' suggestion, not this) — shown as a suggestion until the targets
 * are saved. The ones still "suggested" on the screen follow the box
 * (withDefaultFollowed), so a Save keeps what the words say.
 */
export function defaultTargetText(defaultBps: number): string {
  return `A category the till has no suggestion for (one without Pizza, Burger, Fries, Side, Deal, Combo, Dip, Sauce, Drink or Beverage in its name) starts at ${formatBps(defaultBps)} — shown as “suggested”, without colours, until you save the targets. That is any such category added later, and any above that is still “suggested”: its box follows this one. For example, a new “Wraps” category: a Rs 1,000 wrap is on target up to ${formatCents(Math.round((100_000 * defaultBps) / 10_000))} of ingredients.`;
}

/**
 * A category whose target is the default one: still the till's suggestion
 * (not confirmed), food, and no suggestion of its own by its name.
 */
export function followsDefaultTarget(c: Pick<CategoryTargetView, 'name' | 'confirmed'>, nonFood: boolean): boolean {
  return !c.confirmed && !nonFood && suggestedTargetBps(c.name, -1) === -1;
}

/**
 * The Targets form's boxes after the default box changes to `defaultText`:
 * every category that follows the default (followsDefaultTarget) and whose
 * box the owner has not typed in (`edited`) takes the new default, so Save
 * confirms what the default's words promise; the rest stay as typed.
 */
export function withDefaultFollowed(
  categories: ReadonlyArray<Pick<CategoryTargetView, 'categoryId' | 'name' | 'confirmed'>>,
  pct: Readonly<Record<string, string>>,
  nonFood: Readonly<Record<string, boolean>>,
  edited: ReadonlySet<string>,
  defaultText: string,
): Record<string, string> {
  const out = { ...pct };
  for (const c of categories) {
    if (!edited.has(c.categoryId) && followsDefaultTarget(c, !!nonFood[c.categoryId])) out[c.categoryId] = defaultText;
  }
  return out;
}
