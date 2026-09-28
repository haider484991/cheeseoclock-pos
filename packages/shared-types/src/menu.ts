import type { Cents, Bps } from './money.js';
import type { UUID } from './ids.js';

export type PrepStation = 'kitchen' | 'bar' | 'cold';

export interface Category {
  id: UUID;
  name: string;
  displayOrder: number;
  colorHex: string;
  isActive: boolean;
}

export interface MenuItem {
  id: UUID;
  categoryId: UUID;
  name: string;
  description: string | null;
  basePriceCents: Cents;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  isActive: boolean;
  prepStation: PrepStation;
  taxCategoryId: UUID;
  sortOrder: number;
  currentStock: number | null;
  lowStockThreshold: number | null;
}

export type ModifierSelectionType = 'single' | 'multi';

export interface ModifierGroup {
  id: UUID;
  name: string;
  selectionType: ModifierSelectionType;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
}

export interface Modifier {
  id: UUID;
  modifierGroupId: UUID;
  name: string;
  priceDeltaCents: Cents;
  isDefault: boolean;
  sortOrder: number;
  /**
   * A "leave out" choice ("No onion") names the ingredient it takes off the
   * dish: picked on an order line, that ingredient's base recipe line is not
   * deducted for the line. Null for every ordinary choice.
   */
  removesIngredientId?: UUID | null;
}

/**
 * The heading to show for a choice group. Group names are unique on the till,
 * so a per-item group carries the item after " · " ("Leave out · Fajita
 * Pizza"); customers and cashiers see only the part before it ("Leave out").
 */
export function groupDisplayName(name: string, limits?: { minSelect: number; maxSelect: number }): string {
  const i = name.indexOf(' · ');
  const base = i > 0 ? name.slice(0, i) : name;
  // "Choose 5 veggies" that now takes 1–5 reads "Choose up to 5 veggies" (owner
  // 2026-09-26). The stored name stays: a menu import matches groups by name and
  // never renames one.
  if (!limits || limits.minSelect >= limits.maxSelect) return base;
  return base.replace(/\bChoose (\d+)\b/i, (m, n: string) => (Number(n) === limits.maxSelect ? `Choose up to ${n}` : m));
}

/** A "leave out" choice: printed as "NO ONION" on the kitchen ticket. */
export function isLeaveOutChoice(name: string): boolean {
  return /^no\s/i.test(name.trim());
}

/**
 * What a choice group is for, which sets where it is asked (see
 * `orderChoiceGroups`).
 *  - `required`: the item cannot be sold without it — a deal's pizzas
 *    ("Deal: Large pizza"), "Choose your dip", "Veggie Lovers — Choose 5 veggies".
 *  - `dips`: dips on the side ("Dips on the side", "Side of Ranch" options).
 *  - `extras`: paid additions ("Extra toppings", "Extras · Burgers", "Add cheese").
 *  - `drinks`: an optional drink with the food ("Add a drink"). A drink the
 *    item cannot go without — a soft drink's flavour, a deal's 1 litre drink —
 *    is `required`.
 *  - `leave-out`: "Leave out · Fajita Pizza", or "No onion" choices.
 *  - `other`: anything else a manager made.
 */
export type ChoiceGroupKind = 'required' | 'dips' | 'extras' | 'drinks' | 'leave-out' | 'other';

/** The order the kinds are asked in, on the till and on the website. */
export const CHOICE_GROUP_KIND_ORDER: readonly ChoiceGroupKind[] = ['required', 'dips', 'extras', 'drinks', 'leave-out', 'other'];

/** The fields both the till (ModifierGroup) and the published menu carry. */
export interface ChoiceGroupLike {
  name: string;
  isRequired: boolean;
  minSelect: number;
  modifiers: ReadonlyArray<{ name: string; removesIngredientId?: string | null }>;
}

export function choiceGroupKind(group: ChoiceGroupLike): ChoiceGroupKind {
  if (group.isRequired || group.minSelect > 0) return 'required';
  const head = groupDisplayName(group.name).trim().toLowerCase();
  const options = group.modifiers.map((m) => m.name.trim());
  const every = (test: RegExp) => options.length > 0 && options.every((n) => test.test(n));
  if (/^(?:leave[\s-]*out|without|remove)\b/.test(head)) return 'leave-out';
  // Before extras: "Add a drink" starts like "Add cheese" but is asked after the extras.
  if (/\b(?:drinks?|beverages?)\b/.test(head)) return 'drinks';
  // Before extras: a till may still call the side dips "Extra dips".
  if (/\bdips?\b/.test(head) || every(/^side of\s/i)) return 'dips';
  if (/^add\b/.test(head) || /\bextras?\b/.test(head) || every(/^(?:extra|add)\s/i)) return 'extras';
  if (group.modifiers.length > 0 && group.modifiers.every((m) => m.removesIngredientId != null || isLeaveOutChoice(m.name))) {
    return 'leave-out';
  }
  return 'other';
}

/**
 * An item's choice groups in the order they are asked (owner 2026-09-27:
 * "after selecting pizza it should go to dips, then extras, then leave out"):
 * required choices, dips on the side, extras, "Add a drink", leave-outs, then
 * anything else. Groups of one kind keep the order they came in.
 *
 * Worked out from the groups themselves, never from the item's stored group
 * order: the shop's till imported its groups leave-outs first, and a menu
 * import never reorders what an item already has.
 */
export function orderChoiceGroups<G extends ChoiceGroupLike>(groups: readonly G[]): G[] {
  return groups
    .map((group, index) => ({ group, index, rank: CHOICE_GROUP_KIND_ORDER.indexOf(choiceGroupKind(group)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.group);
}

export interface Combo {
  id: UUID;
  name: string;
  description: string | null;
  priceCents: Cents;
  isActive: boolean;
}

export type ComboSelectionType = 'fixed' | 'choice';

export interface ComboComponent {
  id: UUID;
  comboId: UUID;
  slotName: string;
  selectionType: ComboSelectionType;
  sortOrder: number;
}

export interface ComboComponentChoice {
  id: UUID;
  comboComponentId: UUID;
  menuItemId: UUID;
  priceDeltaCents: Cents;
}

export interface TaxCategory {
  id: UUID;
  name: string;
  rateBps: Bps;
}

/**
 * The rate a till's tax starts at: first-time setup's categories and a new
 * category on Menu → Tax. ONE value for both (they said 17% and 16%).
 * 15%: the rate the shop charges (owner, 24 Sep 2026: "tax is 15%", added
 * on top of the menu prices; the printed menu says "15% tax added on the
 * bill"). Only a starting value on a form: an existing tax category keeps
 * its own rate, and nothing here writes to one.
 */
export const STARTING_TAX_RATE_BPS = 1_500;

/** "15%", "0%", "12.5%": a rate in basis points as the tax forms show it. */
export function taxRatePercentText(rateBps: number): string {
  return `${Number((rateBps / 100).toFixed(2))}%`;
}

/**
 * What first-time setup offers (each row can be edited or taken off there):
 * the shop's rate, and zero-rated. The names are built from the rates.
 */
export const STARTING_TAX_CATEGORIES: ReadonlyArray<Readonly<{ name: string; rateBps: number }>> = Object.freeze([
  Object.freeze({ name: `Sales tax ${taxRatePercentText(STARTING_TAX_RATE_BPS)}`, rateBps: STARTING_TAX_RATE_BPS }),
  Object.freeze({ name: 'Zero-rated', rateBps: 0 }),
]);
