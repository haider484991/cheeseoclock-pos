/**
 * Settings → Kitchen & stock in plain words: the History lines, the worked
 * examples, the stock-take reminders and the menu import rules. Every
 * number in them comes from the values (the same pure rules the till runs:
 * pos-domain varianceBand, stockFill; suggestReorderQty), never typed into
 * the text.
 */
import { formatCents, formatQty, varianceBand } from '@cheeseoclock/pos-domain';
import type { MenuImportPolicy, StockRules, StockTakeReminders } from '@cheeseoclock/shared-types';
import { formatBps } from '../../costing/costingFormat';
import { VARIANCE_BAND_LABEL } from '../../reports/varianceFormat';
import { suggestReorderQty } from '../../inventory/ingredient-list';

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** One line for History: "“Do this” over 3% (6+ days apart) · good under 2%, OK to 3%, needs work to 5% · no reminders · full bar 3 × low · 7 waste reasons". */
export function stockRulesSummary(r: StockRules): string {
  const hidden = r.wasteReasons.filter((x) => x.hidden).length;
  return [
    `“Do this” over ${formatBps(r.varianceDoThisBps)} (${r.varianceMinWindowDays}+ days apart)`,
    `good under ${formatBps(r.bands.goodUnderBps)}, OK to ${formatBps(r.bands.okUpToBps)}, needs work to ${formatBps(r.bands.needsWorkUpToBps)}`,
    remindersSummary(r.reminders),
    `full bar ${r.reorderMultiple} × low`,
    `${r.wasteReasons.length} waste reasons${hidden > 0 ? ` (${hidden} hidden)` : ''}`,
  ].join(' · ');
}

function remindersSummary(r: StockTakeReminders): string {
  const parts: string[] = [];
  if (r.keyItemsEveryDays !== null) parts.push(`key items every ${days(r.keyItemsEveryDays)}`);
  if (r.fullEveryDays !== null) parts.push(`full every ${days(r.fullEveryDays)}`);
  return parts.length === 0 ? 'no reminders' : `reminders: ${parts.join(', ')}`;
}

/** Food sales between the two stock takes in the example (Rs 100,000). */
export const EXAMPLE_FOOD_SALES_CENTS = 10_000_000;

/**
 * "Used vs should have used" worked through with the owner's numbers:
 * what each rating means in rupees on Rs 100,000 of food sales, and when it
 * goes on the Dashboard's "Do this".
 */
export function varianceExample(r: Pick<StockRules, 'varianceDoThisBps' | 'bands' | 'varianceMinWindowDays'>): string {
  const b = r.bands;
  const points = [Math.max(10, b.goodUnderBps - 50), b.okUpToBps, b.needsWorkUpToBps, b.needsWorkUpToBps + 100];
  const rated = points
    .map((bps) => `${formatCents((EXAMPLE_FOOD_SALES_CENTS * bps) / 10_000)} (${formatBps(bps)}) is ${VARIANCE_BAND_LABEL[varianceBand(bps, b)!]}`)
    .join('; ');
  return (
    `With ${formatCents(EXAMPLE_FOOD_SALES_CENTS)} of food sales between two stock takes, stock gone with nothing to explain it: ${rated}. ` +
    `The Dashboard’s “Do this” lists it when more than ${formatBps(r.varianceDoThisBps)} went (${formatCents((EXAMPLE_FOOD_SALES_CENTS * r.varianceDoThisBps) / 10_000)} here) ` +
    `and the two stock takes are at least ${days(r.varianceMinWindowDays)} apart; closer ones show in Reports only, as they are.`
  );
}

/** What the stock-take reminders do, from the values. */
export function remindersText(r: StockTakeReminders): string {
  if (r.keyItemsEveryDays === null && r.fullEveryDays === null) {
    return 'Off: the Dashboard never asks for a stock take. Turn one on and “Do this” pins it when it is due.';
  }
  const parts: string[] = [];
  if (r.keyItemsEveryDays !== null) {
    parts.push(`“Count the key items” when the last key-items or full stock take was ${days(r.keyItemsEveryDays)} ago or more`);
  }
  if (r.fullEveryDays !== null) parts.push(`“Time for a full stock take” when the last full one was ${days(r.fullEveryDays)} ago or more`);
  return `The Dashboard’s “Do this” pins ${parts.join(', and ')} (or when there has never been one).`;
}

/**
 * The stock bar and "Add low-stock items" worked through: cheese with a
 * 2 kg low level, 1.5 kg left.
 */
export function reorderExample(multiple: number): string {
  const low = 2_000;
  const left = 1_500;
  const full = low * multiple;
  const order = suggestReorderQty({ currentQty: left, lowThreshold: low, packSize: null }, multiple);
  return (
    `Cheese with its low level at ${formatQty(low, 'g')}: its stock bar is full at ${formatQty(full, 'g')}, with the low mark ${multiple === 3 ? 'a third' : `1/${multiple}`} of the way along. ` +
    `With ${formatQty(left, 'g')} left, “Add low-stock items” on a purchase order puts ${formatQty(order, 'g')} on it (whole packs when it comes in packs).`
  );
}

// ---------------------------------------------------------------------------
// What a menu file may change ('menu.importPolicy')
// ---------------------------------------------------------------------------

type PolicyField = Exclude<keyof MenuImportPolicy, 'v'>;

/** Each rule in words: the card's rows. */
export const IMPORT_POLICY_FIELDS: ReadonlyArray<{ field: PolicyField; label: string; file: string; till: string }> = [
  {
    field: 'itemPrices',
    label: 'Menu item prices',
    file: 'The file’s price replaces the till’s.',
    till: 'The till keeps its price; new items still come in at the file’s.',
  },
  {
    field: 'choices',
    label: 'Choices (“Choose your dip”)',
    file: 'The file sets each choice’s extra charge, what it leaves out, which is picked first and how many to pick.',
    till: 'The till keeps them as they are; new options in the file are still added.',
  },
  {
    field: 'recipes',
    label: 'Recipes and batch recipes',
    file: 'The file’s recipe replaces the one on the till.',
    till: 'A recipe the till has stays; an item with none still gets the file’s.',
  },
  {
    field: 'tax',
    label: 'Tax on items',
    file: 'Items move onto the file’s tax rate.',
    till: 'Items keep the tax they have on the till; new items get the file’s.',
  },
];

/** One line for History: "The file wins on everything" / "The till keeps: item prices, recipes". */
export function importPolicySummary(p: MenuImportPolicy): string {
  const kept = IMPORT_POLICY_FIELDS.filter((f) => p[f.field] === 'till').map((f) => f.label.toLowerCase());
  return kept.length === 0 ? 'The file wins on everything (ingredient prices stay the till’s)' : `The till keeps: ${kept.join(', ')}`;
}

/** A menu file's price change worked through with the owner's rule. */
export function importPolicyExample(p: Pick<MenuImportPolicy, 'itemPrices'>): string {
  const till = formatCents(120_000);
  const file = formatCents(130_000);
  return p.itemPrices === 'till'
    ? `A menu file has a pizza at ${file} that the till sells at ${till}: the till keeps ${till}, and the import preview lists it under “Kept on the till” (price ${till}, the file says ${file}).`
    : `A menu file has a pizza at ${file} that the till sells at ${till}: the import changes it to ${file}, and the preview shows “price ${till} → ${file}” before anything is saved.`;
}
