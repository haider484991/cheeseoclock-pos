/**
 * Menu import planner — pure. Given a validated menu file and a snapshot of
 * the live menu, decide what the import would create, update or leave alone.
 * The same plan drives the preview the manager reads and the writes that
 * follow (menu-import-repo.ts re-plans inside its transaction, so what is
 * written always matches the menu as it is at that moment).
 *
 * Rules the shop can rely on:
 *   - Nothing is deleted, renamed, re-categorised or hidden/unhidden.
 *   - An item or ingredient the shop already has is found by name or by one
 *     of the file's aliases, ignoring case, spaces and punctuation
 *     ("Fajita — Medium" = "fajita medium"). Two possible matches → skipped,
 *     never guessed.
 *   - Stock is never added to or taken from. An ingredient the shop counts
 *     in kg (or litres) where the file counts grams (ml) is converted — stock,
 *     low level and recipe lines ×1000, the same physical amounts. Any other
 *     unit mismatch is skipped, and so are the recipes that use it.
 *   - Prices (costing spec Phase 6, section 8): the TILL owns ingredient
 *     prices. The file's price is used only for a NEW ingredient or one
 *     with no price yet ('unset'); every other keeps the till's price (from
 *     a delivery, typed, from an earlier file, or 'free'). The file's price
 *     is always kept beside it as the sheet's reference (ingredients.sheet_*),
 *     shown in Inventory with "Use the sheet's price". A batch made here is
 *     costed from its batch recipe; the sheet's figure for it is only a
 *     reference (menu-import-repo). The preview says it in ONE line: "Prices:
 *     12 kept from deliveries, 3 new from the sheet, 0 unpriced."
 *   - A pack price ("6,000 g for Rs 2,250") is kept exactly as the pack.
 *   - Rs 0 in the file means "not priced yet" ('unset', listed under
 *     Costing → Missing costs). `priceIsEstimate` marks a guess ('estimate').
 *   - A description is only filled in where the item has none.
 *   - Choice groups ("Choose your dip") are matched by name; missing options
 *     are added, none removed. Items gain the file's groups; groups they
 *     already had stay attached.
 *   - A recipe line with `when` is only used when that choice is picked.
 *   - Batch recipes (what the kitchen makes) replace the old batch recipe;
 *     a method is only filled in where there is none.
 *   - The owner's import rules (Settings → Kitchen & stock,
 *     'menu.importPolicy'): on things the till ALREADY has, the file wins
 *     by default (today's behaviour) or the till keeps its own — a menu
 *     item's price, a choice's charge and rules, a recipe (dish or batch),
 *     an item's tax. What the till keeps is listed in the preview ("kept on
 *     the till") and counted in `keptLine`. New things always come in.
 */

import {
  baseUnitConversion,
  convertedStoredPrice,
  costPerUnitFromPack,
  effectivePack,
  effectivePrices,
  formatCents,
  hasPrice,
  mcToCents,
  mulDivRound,
  normalizeUnit,
  thousandSize,
  thousandWord,
  unitCostMc,
} from '@cheeseoclock/pos-domain';
import type { MenuImportFile } from '@cheeseoclock/shared-schemas';
import { DEFAULT_MENU_IMPORT_POLICY } from '@cheeseoclock/shared-types';
import type {
  MenuImportPolicy,
  MenuImportKept,
  MenuImportCategoryPlan,
  MenuImportChoiceGroupPlan,
  MenuImportIngredientPlan,
  MenuImportItemPlan,
  MenuImportPreview,
  MenuImportPriceOutcome,
  MenuImportPriceSummary,
  MenuImportSummary,
  PriceKind,
  PriceSource,
} from '@cheeseoclock/shared-types';

export interface MenuSnapshot {
  categories: Array<{ id: string; name: string; displayOrder: number }>;
  items: Array<{
    id: string;
    name: string;
    categoryId: string;
    basePriceCents: number;
    description: string | null;
    isActive: boolean;
    taxCategoryId: string;
  }>;
  ingredients: Array<{
    id: string;
    name: string;
    unit: string;
    costPerUnitCents: number;
    packSize: number | null;
    packPriceCents: number | null;
    /** Omitted = 'set' (a snapshot from before migration 0032). */
    priceKind?: PriceKind;
    /** Where its price came from (its newest price history line); null / omitted = not known. */
    priceSource?: PriceSource | null;
    /** The sheet's price kept for it now (ingredients.sheet_*); null / omitted = none yet. */
    sheet?: SheetPrice | null;
    batchYield: number | null;
    batchMethod: string | null;
    notes: string | null;
  }>;
  /** Live recipe lines per menu item id. */
  recipes: Map<string, Array<{ ingredientId: string; qtyPerUnit: number; modifierId: string | null }>>;
  taxCategories: Array<{ id: string; name: string; rateBps: number }>;
  modifierGroups: Array<{
    id: string;
    name: string;
    selectionType: 'single' | 'multi';
    minSelect: number;
    maxSelect: number;
    isRequired: boolean;
    modifiers: Array<{
      id: string;
      name: string;
      priceDeltaCents: number;
      isDefault: boolean;
      sortOrder: number;
      removesIngredientId?: string | null;
    }>;
  }>;
  /** Groups attached to each menu item id. */
  itemGroups: Map<string, Array<{ groupId: string; sortOrder: number }>>;
  /** Batch recipe inputs per made-in-house ingredient id. */
  batchLines: Map<string, Array<{ inputId: string; qty: number }>>;
  /**
   * How many items use each tax category, when that is not `items` — a fresh
   * start plans against an empty menu but keeps the tax the shop was using.
   */
  taxUse?: Map<string, number>;
}

/** The costing sheet's price for an ingredient, as the file gives it (ingredients.sheet_*). */
export interface SheetPrice {
  packSize: number;
  packPriceCents: number;
  priceKind: PriceKind;
}

/** A reference to an ingredient that exists now, or one the import creates first. */
export type IngredientRef = { existingId: string } | { fileKey: string };
/** A choice group that exists now, or one the import creates. */
export type GroupRef = { existingId: string } | { groupKey: string };
/** An option of a choice group that exists now, or one the import creates. */
export type ModifierRef = { existingId: string } | { groupKey: string; optionKey: string };

export interface MenuImportOps {
  categories: Array<{
    fileKey: string;
    existingId: string | null;
    create: { name: string; displayOrder: number; colorHex: string } | null;
  }>;
  ingredients: Array<{
    fileKey: string;
    existingId: string | null;
    create: {
      name: string;
      unit: string;
      costPerUnitCents: number;
      packSize: number | null;
      packPriceCents: number | null;
      priceKind: PriceKind;
      notes: string | null;
    } | null;
    update: {
      costPerUnitCents?: number;
      packSize?: number | null;
      packPriceCents?: number | null;
      priceKind?: PriceKind;
      notes?: string;
    } | null;
    /** Convert kg → g / l → ml (stock and recipe lines ×1000) before the update. */
    convert: boolean;
    /** The sheet's price, always kept as the reference (after any convert). */
    sheet: SheetPrice;
  }>;
  items: Array<{
    existingId: string | null;
    create: {
      name: string;
      categoryFileKey: string;
      basePriceCents: number;
      description: string | null;
      sortOrder: number;
    } | null;
    /** useImportTax: move the item onto the import's tax category (see taxCategoryId / createTaxCategory). */
    update: { basePriceCents?: number; description?: string; useImportTax?: true } | null;
    /** Choice groups to attach (in addition to those already attached). */
    attach: GroupRef[];
    /** Replace the item's recipe with these lines; null = leave the recipe alone. */
    recipe: Array<{ ingredient: IngredientRef; qty: number; modifier: ModifierRef | null }> | null;
  }>;
  modifierGroups: Array<{
    groupKey: string;
    existingId: string | null;
    create: { name: string; selectionType: 'single' | 'multi'; minSelect: number; maxSelect: number; isRequired: boolean } | null;
    update: { selectionType?: 'single' | 'multi'; minSelect?: number; maxSelect?: number; isRequired?: boolean } | null;
    options: Array<{
      optionKey: string;
      existingId: string | null;
      create: {
        name: string;
        priceDeltaCents: number;
        isDefault: boolean;
        sortOrder: number;
        /** A "leave out" choice: the ingredient it takes off the dish. */
        removes: IngredientRef | null;
      } | null;
      update: { priceDeltaCents?: number; isDefault?: boolean; removes?: IngredientRef | null } | null;
    }>;
  }>;
  batches: Array<{
    ingredient: IngredientRef;
    batchYield: number;
    batchMethod: string | null;
    lines: Array<{ ingredient: IngredientRef; qty: number }>;
  }>;
  /** Tax category for new items and useImportTax updates… */
  taxCategoryId: string | null;
  /** …or, when the POS has none at the file's rate, the one to create first. */
  createTaxCategory: { name: string; rateBps: number } | null;
}

export interface MenuImportPlan {
  preview: Omit<MenuImportPreview, 'fileName'>;
  ops: MenuImportOps;
}

/** Case-, accent-, space- and punctuation-blind key: "Jalapeño — Large" → "jalapenolarge". */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

interface Named {
  name: string;
  aliases: string[];
}

/**
 * Pair file entries with existing rows. A row found by the entry's own name
 * wins over rows found only by an alias; more than one candidate, or a row
 * two entries both reach, is ambiguous and neither side is matched.
 */
function matchAll<E extends Named, R extends { id: string; name: string }>(
  entries: E[],
  rows: R[],
): Array<{ row: R | null; ambiguous: R[] }> {
  const byKey = new Map<string, R[]>();
  for (const row of rows) {
    const key = normalizeName(row.name);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const found = entries.map((entry) => {
    const exact = byKey.get(normalizeName(entry.name)) ?? [];
    if (exact.length > 0) return exact;
    const viaAlias = new Map<string, R>();
    for (const alias of entry.aliases) {
      for (const row of byKey.get(normalizeName(alias)) ?? []) viaAlias.set(row.id, row);
    }
    return [...viaAlias.values()];
  });
  const claims = new Map<string, number>();
  for (const candidates of found) {
    if (candidates.length === 1) claims.set(candidates[0]!.id, (claims.get(candidates[0]!.id) ?? 0) + 1);
  }
  return found.map((candidates) => {
    if (candidates.length === 1 && claims.get(candidates[0]!.id) === 1) {
      return { row: candidates[0]!, ambiguous: [] };
    }
    return { row: null, ambiguous: candidates };
  });
}

/** "Fajita — Medium" → { base: "Fajita", size: "Medium" }; the dash forms the checkout groups on. */
function splitSize(name: string): { base: string; size: string } | null {
  const m = name.match(/^(.*\S)\s+[—–-]\s*(\S.*)$/);
  return m ? { base: m[1]!, size: m[2]! } : null;
}

type Costing = { unit: string; costPerUnitCents: number; packSize: number | null; packPriceCents: number | null };

/**
 * The file's price for an ingredient as the sheet's reference: its pack
 * exactly, or (1, its cost per unit) when it gives none; Rs 0 is 'unset',
 * a guess 'estimate'.
 */
export function sheetPriceOf(ing: {
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  priceIsEstimate: boolean;
}): SheetPrice {
  const pack =
    ing.packSize !== null && ing.packSize > 0 && ing.packPriceCents !== null
      ? { packSize: ing.packSize, packPriceCents: ing.packPriceCents }
      : { packSize: 1, packPriceCents: ing.costPerUnitCents };
  return { ...pack, priceKind: importedPriceKind(hasPrice(ing), ing.priceIsEstimate, null) };
}

/** A price for people: "Rs 1,500 / kg" for something weighed, "Rs 40 / pcs" otherwise. */
function unitPriceText(unitCostMcValue: number, unit: string): string {
  const size = thousandSize(unit);
  const word = thousandWord(unit);
  if (size !== null && word !== null) return `${formatCents(mulDivRound(unitCostMcValue, size, 1000))} / ${word}`;
  return `${formatCents(mcToCents(unitCostMcValue))} / ${unit}`;
}

/** A price the till keeps, by where it came from (its newest price history line). */
function keptOutcome(source: PriceSource | null): MenuImportPriceOutcome {
  if (source === 'delivery' || source === 'purchase') return 'kept_delivery';
  if (source === 'manual') return 'kept_typed';
  return 'kept';
}

/** The outcomes where the till keeps the price it has (the sheet's may differ: Inventory offers it). */
const KEEPS_TILL_PRICE: ReadonlySet<MenuImportPriceOutcome> = new Set(['kept_delivery', 'kept_typed', 'kept', 'batch_kept']);

/** An ingredient's price outcome, before the file's batch recipes are known. */
interface PriceFact {
  plan: MenuImportIngredientPlan;
  fileKey: string;
  existingId: string | null;
  /** Its price kind once the file is in (the sheet's where it takes the sheet's, else the till's). */
  kindAfter: PriceKind;
  /** Its outcome when no batch recipe prices it. */
  own: MenuImportPriceOutcome;
  /** The till's price differs from the sheet's (counts where the till keeps its price). */
  sheetDiffersIfKept: boolean;
  /** Where "no price yet: the sheet's …" sits in its changes, to be said right once the batches are known. */
  sheetChange: { index: number; sheetText: string } | null;
}

/** What an ingredient with no price takes from the file: the sheet's price, or (a batch its recipe prices) its recipe's. */
function sheetTakenText(sheetText: string, fromRecipe: boolean): string {
  return fromRecipe
    ? `no price yet: worked out from its batch recipe (the sheet's ${sheetText} is only a reference)`
    : `no price yet: the sheet's ${sheetText}`;
}

/**
 * Each ingredient's price outcome as the repository will decide it
 * (menu-import-repo applyMenuImport): a batch made here — its recipe after
 * the file, the file's own recipes and prices in — whose every input will
 * have a price is 'made_here' (its price rolled up from them). One whose
 * recipe can't price it (something in it has no price) keeps the price it
 * has, 'batch_kept', and Costing → Alerts says so; with no price of its own
 * it takes the sheet's or stays unpriced, like any other ingredient. The
 * same roll-up rule the till prices with (pos-domain effectivePrices), on
 * the price KINDS only: whether a price is there, not what it is.
 */
function settleBatchPrices(facts: readonly PriceFact[], batchOps: MenuImportOps['batches'], live: MenuSnapshot): void {
  const simId = (f: Pick<PriceFact, 'fileKey' | 'existingId'>) => f.existingId ?? `file:${f.fileKey}`;
  const refId = (ref: IngredientRef) => ('existingId' in ref ? ref.existingId : `file:${ref.fileKey}`);
  const kindAfter = new Map<string, PriceKind>(live.ingredients.map((r) => [r.id, r.priceKind ?? 'set']));
  const yieldAfter = new Map<string, number | null>(live.ingredients.map((r) => [r.id, r.batchYield]));
  const linesAfter = new Map<string, Array<{ inputId: string; qty: number }>>(live.batchLines);
  for (const f of facts) kindAfter.set(simId(f), f.kindAfter);
  for (const b of batchOps) {
    const id = refId(b.ingredient);
    yieldAfter.set(id, b.batchYield);
    linesAfter.set(
      id,
      b.lines.map((l) => ({ inputId: refId(l.ingredient), qty: l.qty })),
    );
  }
  const after = effectivePrices(
    [...kindAfter].map(([id, priceKind]) => ({
      id,
      name: id,
      unit: '',
      priceKind,
      costPerUnitCents: 0,
      packSize: null,
      packPriceCents: null,
      batchYield: yieldAfter.get(id) ?? null,
    })),
    linesAfter,
  );
  for (const f of facts) {
    const batch = after.get(simId(f))?.batch ?? null;
    const outcome: MenuImportPriceOutcome = !batch
      ? f.own
      : batch.complete
        ? 'made_here'
        : f.own === 'new_from_sheet' || f.own === 'unpriced'
          ? f.own
          : 'batch_kept';
    f.plan.price = outcome;
    f.plan.sheetDiffers = f.sheetDiffersIfKept && KEEPS_TILL_PRICE.has(outcome);
    if (f.sheetChange) f.plan.changes[f.sheetChange.index] = sheetTakenText(f.sheetChange.sheetText, outcome === 'made_here');
  }
}

/** The ingredients' price outcomes, counted (skipped ones left out). */
export function countPrices(plans: ReadonlyArray<Pick<MenuImportIngredientPlan, 'price' | 'sheetDiffers'>>): MenuImportPriceSummary {
  const out: MenuImportPriceSummary = {
    keptFromDeliveries: 0,
    keptTyped: 0,
    keptOther: 0,
    madeHere: 0,
    batchKept: 0,
    newFromSheet: 0,
    unpriced: 0,
    sheetDiffers: 0,
  };
  for (const p of plans) {
    switch (p.price) {
      case 'kept_delivery':
        out.keptFromDeliveries++;
        break;
      case 'kept_typed':
        out.keptTyped++;
        break;
      case 'kept':
      case 'kept_free':
        out.keptOther++;
        break;
      case 'made_here':
        out.madeHere++;
        break;
      case 'batch_kept':
        out.batchKept++;
        break;
      case 'new_from_sheet':
        out.newFromSheet++;
        break;
      case 'unpriced':
        out.unpriced++;
        break;
      default:
        break;
    }
    if (p.sheetDiffers) out.sheetDiffers++;
  }
  return out;
}

/**
 * The preview's ONE line about prices (costing spec §5, Phase 6): what the
 * till keeps, where from, what the sheet fills in and what is still
 * unpriced. "Prices: 12 kept from deliveries, 3 new from the sheet, 0 unpriced."
 */
export function priceSummaryLine(p: MenuImportPriceSummary): string {
  const parts: string[] = [];
  if (p.keptFromDeliveries > 0) parts.push(`${p.keptFromDeliveries} kept from deliveries`);
  if (p.keptTyped > 0) parts.push(`${p.keptTyped} kept as typed`);
  if (p.keptOther > 0) parts.push(`${p.keptOther} kept as they are`);
  if (p.madeHere > 0) parts.push(`${p.madeHere} worked out from their batch recipe`);
  if (p.batchKept > 0) {
    parts.push(
      p.batchKept === 1
        ? '1 batch keeps its price (something in it has no price)'
        : `${p.batchKept} batches keep their price (something in them has no price)`,
    );
  }
  parts.push(`${p.newFromSheet} new from the sheet`);
  parts.push(`${p.unpriced} unpriced`);
  return `Prices: ${parts.join(', ')}.`;
}

/** What a costing works out to per base unit, in paisa (a pack wins over a typed cost). */
function unitCost(c: Costing): number {
  return c.packSize && c.packPriceCents !== null ? costPerUnitFromPack(c.packPriceCents, c.packSize) : c.costPerUnitCents;
}

/**
 * The price kind the file gives an ingredient (costing spec D4 / section 8):
 * Rs 0 in the file is 'unset' — never overwriting a 'free' the shop chose —
 * and a price is 'estimate' when the file says it is a guess, else 'set'.
 * From Phase 6 it only decides a price the sheet gives (a new or unpriced
 * ingredient) and the sheet's reference.
 */
export function importedPriceKind(filePriced: boolean, isEstimate: boolean, previous: PriceKind | null): PriceKind {
  if (!filePriced) return previous === 'free' ? 'free' : 'unset';
  return isEstimate ? 'estimate' : 'set';
}

/**
 * The preview's line about what the till kept against the file (the
 * owner's import rules): "Kept on the till: 3 prices, 1 recipe (Settings →
 * Kitchen & stock)." Null when nothing was.
 */
export function keptOnTillLine(k: MenuImportKept): string | null {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (k.prices > 0) parts.push(n(k.prices, 'price'));
  if (k.choices > 0) parts.push(n(k.choices, 'choice group'));
  if (k.recipes > 0) parts.push(n(k.recipes, 'recipe'));
  if (k.taxes > 0) parts.push(`the tax of ${n(k.taxes, 'item')}`);
  return parts.length === 0 ? null : `Kept on the till: ${parts.join(', ')} (Settings → Kitchen & stock).`;
}

export function planMenuImport(
  file: MenuImportFile,
  live: MenuSnapshot,
  policy: Omit<MenuImportPolicy, 'v'> = DEFAULT_MENU_IMPORT_POLICY,
): MenuImportPlan {
  const warnings: string[] = [];
  const summary: MenuImportSummary = {
    newItems: 0,
    updatedItems: 0,
    priceChanges: 0,
    taxChanges: 0,
    recipesSet: 0,
    newIngredients: 0,
    updatedIngredients: 0,
    newCategories: 0,
    choiceGroupsChanged: 0,
    batchRecipesSet: 0,
    skipped: 0,
    removedItems: 0,
    prices: countPrices([]),
    priceLine: '',
    keptOnTill: { prices: 0, choices: 0, recipes: 0, taxes: 0 },
    keptLine: null,
  };

  // ---- Categories ----------------------------------------------------------
  const categoryPlans: MenuImportCategoryPlan[] = [];
  const categoryOps: MenuImportOps['categories'] = [];
  /** file category key → the name it will carry on this POS */
  const categoryNameByKey = new Map<string, string>();
  let nextOrder = Math.max(0, ...live.categories.map((c) => c.displayOrder + 1));
  const categoryMatches = matchAll(file.categories, live.categories);
  /** The shop's order of each file category that already exists, else null. */
  const liveOrder = categoryMatches.map((m) => (m.row ?? m.ambiguous[0] ?? null)?.displayOrder ?? null);
  /**
   * Where a NEW category goes: where the file puts it, among the ones the shop
   * has (owner 2026-09-26: a new "Dips" landed after "Delivery Charges", off
   * the edge of the till's category bar). Between its neighbours when there is
   * room; otherwise level with the next one (the till sorts a tie by name);
   * after everything only when nothing follows it. Existing categories never move.
   */
  const orderForNew = (i: number): number => {
    let prev: number | null = null;
    for (let j = i - 1; j >= 0 && prev === null; j--) prev = liveOrder[j] ?? null;
    let next: number | null = null;
    for (let k = i + 1; k < liveOrder.length && next === null; k++) next = liveOrder[k] ?? null;
    if (next === null) return nextOrder++;
    if (prev !== null && next - prev > 1) {
      liveOrder[i] = prev + 1; // a second new one right after takes the next gap
      return prev + 1;
    }
    liveOrder[i] = next;
    return next;
  };
  file.categories.forEach((cat, i) => {
    const key = cat.name.toLowerCase();
    const m = categoryMatches[i]!;
    // Two existing categories both called e.g. "Pizza": use the first, it is only a home for new items.
    const existing = m.row ?? m.ambiguous[0] ?? null;
    if (existing) {
      categoryPlans.push({ name: cat.name, action: 'same', existingName: existing.name });
      categoryOps.push({ fileKey: key, existingId: existing.id, create: null });
      categoryNameByKey.set(key, existing.name);
    } else {
      categoryPlans.push({ name: cat.name, action: 'create', existingName: null });
      categoryOps.push({
        fileKey: key,
        existingId: null,
        create: { name: cat.name, displayOrder: orderForNew(i), colorHex: cat.colorHex },
      });
      categoryNameByKey.set(key, cat.name);
    }
  });

  // ---- Ingredients ---------------------------------------------------------
  // Prices (costing spec Phase 6, section 8): once costing has started the
  // TILL owns ingredient prices. The sheet prices a NEW ingredient, or one
  // with no price yet ('unset'); every other keeps the till's price (from a
  // delivery, typed, from an earlier sheet, or 'free'). A batch made here is
  // costed from its recipe (menu-import-repo decides, once the file's
  // recipes are in). The sheet's price is ALWAYS kept as the reference.
  const ingredientPlans: MenuImportIngredientPlan[] = [];
  const ingredientOps: MenuImportOps['ingredients'] = [];
  /** file ingredient key → how a recipe line refers to it; absent = skipped */
  const ingredientRef = new Map<string, IngredientRef>();
  /** existing ingredient id → factor its stock and recipe lines are scaled by */
  const conversions = new Map<string, number>();
  const ingredientMatches = matchAll(file.ingredients, live.ingredients);
  /** file ingredient key → the existing row it matched (for batch comparison) */
  const matchedIngredient = new Map<string, MenuSnapshot['ingredients'][number]>();
  /** What settles each ingredient's price outcome once the file's batch recipes are known (see "Prices" below). */
  const priceFacts: PriceFact[] = [];
  file.ingredients.forEach((ing, i) => {
    const key = ing.name.toLowerCase();
    const m = ingredientMatches[i]!;
    if (m.row) matchedIngredient.set(key, m.row);
    const filePriced = hasPrice(ing);
    const sheet = sheetPriceOf(ing);
    const sheetUnitCostMc = unitCostMc({ size: sheet.packSize, priceCents: sheet.packPriceCents });
    const base = {
      name: ing.name,
      unit: ing.unit,
      costPerUnitCents: unitCost(ing),
      packSize: ing.packSize,
      packPriceCents: ing.packPriceCents,
    };
    if (!m.row && m.ambiguous.length > 0) {
      ingredientPlans.push({
        ...base,
        priceKind: sheet.priceKind,
        action: 'skip',
        existingName: null,
        changes: [],
        reason: `More than one ingredient here could be this one: ${m.ambiguous.map((r) => r.name).join(', ')}`,
        price: null,
        tillPrice: null,
        sheetUnitCostMc,
        sheetDiffers: false,
      });
      summary.skipped++;
      return;
    }
    if (!m.row) {
      // Settled below, once the file's batch recipes are known: a batch whose recipe prices it is 'made_here'.
      const outcome: MenuImportPriceOutcome = filePriced ? 'new_from_sheet' : 'unpriced';
      const plan: MenuImportIngredientPlan = {
        ...base,
        priceKind: sheet.priceKind,
        action: 'create',
        existingName: null,
        changes: [],
        reason: null,
        price: outcome,
        tillPrice: null,
        sheetUnitCostMc,
        sheetDiffers: false,
      };
      ingredientPlans.push(plan);
      priceFacts.push({ plan, fileKey: key, existingId: null, kindAfter: sheet.priceKind, own: outcome, sheetDiffersIfKept: false, sheetChange: null });
      ingredientOps.push({
        fileKey: key,
        existingId: null,
        create: {
          name: ing.name,
          unit: ing.unit,
          costPerUnitCents: unitCost(ing),
          packSize: ing.packSize,
          packPriceCents: ing.packPriceCents,
          priceKind: sheet.priceKind,
          notes: ing.notes,
        },
        update: null,
        convert: false,
        sheet,
      });
      ingredientRef.set(key, { fileKey: key });
      summary.newIngredients++;
      return;
    }
    const row = m.row;
    const changes: string[] = [];
    // The shop's costing, as it will stand after any kg → g conversion.
    let current: Costing = row;
    let convert = false;
    if (normalizeUnit(row.unit) !== normalizeUnit(ing.unit)) {
      const conv = baseUnitConversion(row.unit);
      if (!conv || conv.unit !== normalizeUnit(ing.unit)) {
        ingredientPlans.push({
          ...base,
          priceKind: row.priceKind ?? 'set',
          action: 'skip',
          existingName: row.name,
          changes: [],
          reason: `Counted in "${row.unit}" here but "${ing.unit}" in the file — change one to match, then import again`,
          price: null,
          tillPrice: null,
          sheetUnitCostMc,
          sheetDiffers: false,
        });
        summary.skipped++;
        return;
      }
      convert = true;
      conversions.set(row.id, conv.factor);
      // As Convert keeps it (exactly: "Rs 375 per kg" becomes 1,000 g for Rs 375).
      current = {
        unit: conv.unit,
        ...convertedStoredPrice(
          {
            costPerUnitCents: row.costPerUnitCents,
            packSize: row.packSize,
            packPriceCents: row.packPriceCents,
            priceKind: row.priceKind ?? 'set',
          },
          conv.factor,
        ),
      };
      changes.push(`counted in ${row.unit} → ${conv.unit} (stock and recipes ×${conv.factor})`);
    }
    const update: NonNullable<MenuImportOps['ingredients'][number]['update']> = {};
    const kindNow = row.priceKind ?? 'set';
    const tillUnitCostMc = kindNow === 'unset' ? null : unitCostMc(effectivePack(current));
    // The sheet's price, written only where the till has none (a batch made
    // here takes it only if its recipe can't price it: menu-import-repo).
    const takeSheet = kindNow === 'unset' && filePriced;
    if (takeSheet) {
      const packGiven = ing.packSize !== null && ing.packPriceCents !== null;
      if (packGiven) {
        update.packSize = ing.packSize;
        update.packPriceCents = ing.packPriceCents;
      } else {
        update.costPerUnitCents = ing.costPerUnitCents;
        // A typed cost only counts once the pack that decides the cost is cleared.
        if (current.packSize !== null) {
          update.packSize = null;
          update.packPriceCents = null;
        }
      }
      update.priceKind = sheet.priceKind;
    }
    // Its outcome as a bought-in ingredient; a batch whose recipe prices it
    // becomes 'made_here' below, once the file's batch recipes are known.
    const outcome: MenuImportPriceOutcome =
      kindNow === 'unset'
        ? filePriced
          ? 'new_from_sheet'
          : 'unpriced'
        : kindNow === 'free'
          ? 'kept_free'
          : keptOutcome(row.priceSource ?? null);
    const sheetText = unitPriceText(sheetUnitCostMc, current.unit);
    let sheetChange: PriceFact['sheetChange'] = null;
    if (takeSheet) {
      sheetChange = { index: changes.length, sheetText };
      changes.push(sheetTakenText(sheetText, false));
    }
    // The sheet's figure is kept as the reference either way (Inventory shows it beside the till's).
    const sheetBefore = row.sheet ?? null;
    const sheetNew =
      !sheetBefore ||
      sheetBefore.packSize !== sheet.packSize ||
      sheetBefore.packPriceCents !== sheet.packPriceCents ||
      sheetBefore.priceKind !== sheet.priceKind;
    // A converted ingredient's reference was in the old unit: always noted again.
    const noteSheet = (sheetNew || convert) && !takeSheet;
    if (noteSheet) changes.push(filePriced ? `the sheet says ${sheetText} (kept for reference)` : "the sheet has no price for it (kept for reference)");
    if (!row.notes?.trim() && ing.notes?.trim()) {
      changes.push('notes added');
      update.notes = ing.notes;
    }
    const sheetDiffersIfKept = filePriced && tillUnitCostMc !== null && tillUnitCostMc !== sheetUnitCostMc;
    const changed = convert || Object.keys(update).length > 0 || noteSheet;
    const plan: MenuImportIngredientPlan = {
      ...base,
      priceKind: takeSheet ? sheet.priceKind : kindNow,
      action: changed ? 'update' : 'same',
      existingName: row.name,
      changes,
      reason: null,
      price: outcome,
      tillPrice: tillUnitCostMc === null ? null : { unitCostMc: tillUnitCostMc, priceKind: kindNow, source: row.priceSource ?? null },
      sheetUnitCostMc,
      sheetDiffers: sheetDiffersIfKept && KEEPS_TILL_PRICE.has(outcome),
    };
    ingredientPlans.push(plan);
    priceFacts.push({
      plan,
      fileKey: key,
      existingId: row.id,
      kindAfter: takeSheet ? sheet.priceKind : kindNow,
      own: outcome,
      sheetDiffersIfKept,
      sheetChange,
    });
    ingredientOps.push({
      fileKey: key,
      existingId: row.id,
      create: null,
      update: Object.keys(update).length > 0 ? update : null,
      convert,
      sheet,
    });
    ingredientRef.set(key, { existingId: row.id });
    if (changed) summary.updatedIngredients++;
  });

  // ---- Batch recipes ---------------------------------------------------------
  const batchOps: MenuImportOps['batches'] = [];
  const planOf = new Map(ingredientPlans.map((p) => [p.name.toLowerCase(), p]));
  file.ingredients.forEach((ing) => {
    const key = ing.name.toLowerCase();
    const self = ingredientRef.get(key);
    const plan = planOf.get(key);
    if (!ing.batch || !self || !plan) return;
    const lines = ing.batch.lines.map((l) => ({ ref: ingredientRef.get(l.ingredient.toLowerCase()), name: l.ingredient, qty: l.qty }));
    const unresolved = lines.filter((l) => !l.ref).map((l) => l.name);
    if (unresolved.length > 0) {
      plan.reason = `Batch recipe left as it is: ${unresolved.join(', ')} could not be imported`;
      return;
    }
    const row = matchedIngredient.get(key);
    const factor = row ? conversions.get(row.id) ?? 1 : 1;
    const current = row ? live.batchLines.get(row.id) ?? [] : [];
    const same =
      !!row &&
      (row.batchYield ?? 0) * factor === ing.batch.yield &&
      current.length === lines.length &&
      lines.every((l) => {
        if (!('existingId' in l.ref!)) return false;
        const id = l.ref.existingId;
        const f = conversions.get(id) ?? 1;
        return current.some((c) => c.inputId === id && c.qty * f === l.qty);
      });
    const method = row?.batchMethod?.trim() ? row.batchMethod : ing.batch.method;
    if (same && method === (row?.batchMethod ?? null)) return;
    // The owner's rule: a batch recipe the till already has stays as it is (method and all).
    if (!same && row && current.length > 0 && policy.recipes === 'till') {
      plan.keptOnTill = [
        ...(plan.keptOnTill ?? []),
        `batch recipe: ${current.length} inputs, makes ${(row.batchYield ?? 0) * factor} ${ing.unit} (the file has ${lines.length} inputs, makes ${ing.batch.yield} ${ing.unit})`,
      ];
      summary.keptOnTill.recipes++;
      return;
    }
    batchOps.push({
      ingredient: self,
      batchYield: ing.batch.yield,
      batchMethod: method,
      lines: lines.map((l) => ({ ingredient: l.ref!, qty: l.qty })),
    });
    if (!same) {
      plan.changes.push(`batch recipe: ${lines.length} inputs, makes ${ing.batch.yield} ${ing.unit}`);
      summary.batchRecipesSet++;
    } else {
      plan.changes.push('batch method added');
    }
    if (plan.action === 'same') {
      plan.action = 'update';
      summary.updatedIngredients++;
    }
  });

  // ---- Prices: the batches made here ----------------------------------------
  settleBatchPrices(priceFacts, batchOps, live);
  summary.prices = countPrices(ingredientPlans);
  summary.priceLine = priceSummaryLine(summary.prices);

  // ---- Choice groups -------------------------------------------------------
  const choicePlans: MenuImportChoiceGroupPlan[] = [];
  const groupOps: MenuImportOps['modifierGroups'] = [];
  /** file group key → how items refer to it; absent = skipped */
  const groupRef = new Map<string, GroupRef>();
  /** "groupKey|optionKey" → how recipe lines refer to the option; absent = skipped */
  const optionRef = new Map<string, ModifierRef>();
  /** A leave-out choice's ingredient, by its name in the file (the schema checked it exists). */
  const removesRef = (name: string | null | undefined): IngredientRef | null =>
    name ? ingredientRef.get(name.toLowerCase()) ?? null : null;
  const groupMatches = matchAll(file.modifierGroups, live.modifierGroups);
  file.modifierGroups.forEach((g, i) => {
    const groupKey = g.name.toLowerCase();
    const m = groupMatches[i]!;
    const optionNames = g.options.map((o) => o.name);
    if (!m.row && m.ambiguous.length > 0) {
      choicePlans.push({
        name: g.name,
        action: 'skip',
        existingName: null,
        options: optionNames,
        changes: [`More than one choice group here could be this one: ${m.ambiguous.map((r) => r.name).join(', ')}`],
      });
      summary.skipped++;
      return;
    }
    const shape = { selectionType: g.selectionType, minSelect: g.minSelect, maxSelect: g.maxSelect, isRequired: g.required };
    if (!m.row) {
      groupRef.set(groupKey, { groupKey });
      groupOps.push({
        groupKey,
        existingId: null,
        create: { name: g.name, ...shape },
        update: null,
        options: g.options.map((o, j) => {
          const optionKey = o.name.toLowerCase();
          optionRef.set(`${groupKey}|${optionKey}`, { groupKey, optionKey });
          return {
            optionKey,
            existingId: null,
            create: {
              name: o.name,
              priceDeltaCents: o.priceDeltaCents,
              isDefault: o.isDefault,
              sortOrder: j,
              removes: removesRef(o.removes),
            },
            update: null,
          };
        }),
      });
      choicePlans.push({ name: g.name, action: 'create', existingName: null, options: optionNames, changes: [] });
      summary.choiceGroupsChanged++;
      return;
    }
    const row = m.row;
    groupRef.set(groupKey, { existingId: row.id });
    const changes: string[] = [];
    // The owner's rule: a choice group the till already has keeps its charges and rules (new options still come in).
    const keepChoices = policy.choices === 'till';
    const kept: string[] = [];
    const update: NonNullable<MenuImportOps['modifierGroups'][number]['update']> = {};
    if (row.selectionType !== shape.selectionType) update.selectionType = shape.selectionType;
    if (row.minSelect !== shape.minSelect) update.minSelect = shape.minSelect;
    if (row.maxSelect !== shape.maxSelect) update.maxSelect = shape.maxSelect;
    if (row.isRequired !== shape.isRequired) update.isRequired = shape.isRequired;
    const chooseText = (min: number, max: number, required: boolean) =>
      `choose ${min === max ? min : `${min}–${max}`}${required ? ', required' : ''}`;
    if (Object.keys(update).length > 0) {
      if (keepChoices) {
        kept.push(`${chooseText(row.minSelect, row.maxSelect, row.isRequired)} (the file says ${chooseText(shape.minSelect, shape.maxSelect, shape.isRequired)})`);
        for (const k of Object.keys(update) as Array<keyof typeof update>) delete update[k];
      } else {
        changes.push(chooseText(shape.minSelect, shape.maxSelect, shape.isRequired));
      }
    }
    let nextSort = Math.max(0, ...row.modifiers.map((x) => x.sortOrder + 1));
    const optionMatches = matchAll(g.options, row.modifiers);
    const options: MenuImportOps['modifierGroups'][number]['options'] = [];
    g.options.forEach((o, j) => {
      const optionKey = o.name.toLowerCase();
      const om = optionMatches[j]!;
      if (!om.row && om.ambiguous.length > 0) {
        changes.push(`"${o.name}" skipped: more than one option could be it`);
        return;
      }
      if (!om.row) {
        optionRef.set(`${groupKey}|${optionKey}`, { groupKey, optionKey });
        options.push({
          optionKey,
          existingId: null,
          create: {
            name: o.name,
            priceDeltaCents: o.priceDeltaCents,
            isDefault: o.isDefault,
            sortOrder: nextSort++,
            removes: removesRef(o.removes),
          },
          update: null,
        });
        changes.push(`"${o.name}" added`);
        return;
      }
      optionRef.set(`${groupKey}|${optionKey}`, { existingId: om.row.id });
      const oUpdate: { priceDeltaCents?: number; isDefault?: boolean; removes?: IngredientRef | null } = {};
      const wantRemoves = removesRef(o.removes);
      const haveRemoves = om.row.removesIngredientId ?? null;
      const sameRemoves =
        wantRemoves === null
          ? haveRemoves === null
          : 'existingId' in wantRemoves && wantRemoves.existingId === haveRemoves;
      if (!sameRemoves) {
        if (keepChoices) kept.push(`what "${om.row.name}" leaves out (the file: ${wantRemoves ? o.removes : 'nothing'})`);
        else {
          oUpdate.removes = wantRemoves;
          changes.push(`"${om.row.name}" ${wantRemoves ? `leaves out ${o.removes}` : 'no longer leaves anything out'}`);
        }
      }
      if (om.row.priceDeltaCents !== o.priceDeltaCents) {
        if (keepChoices) kept.push(`"${om.row.name}" ${formatCents(om.row.priceDeltaCents)} (the file says ${formatCents(o.priceDeltaCents)})`);
        else {
          oUpdate.priceDeltaCents = o.priceDeltaCents;
          changes.push(`"${om.row.name}" ${formatCents(om.row.priceDeltaCents)} → ${formatCents(o.priceDeltaCents)}`);
        }
      }
      if (om.row.isDefault !== o.isDefault) {
        if (keepChoices) kept.push(`"${om.row.name}" ${om.row.isDefault ? 'picked' : 'not picked'} to start with`);
        else oUpdate.isDefault = o.isDefault;
      }
      options.push({ optionKey, existingId: om.row.id, create: null, update: Object.keys(oUpdate).length ? oUpdate : null });
    });
    const changed = Object.keys(update).length > 0 || options.some((o) => o.create || o.update);
    groupOps.push({ groupKey, existingId: row.id, create: null, update: Object.keys(update).length ? update : null, options });
    choicePlans.push({
      name: g.name,
      action: changed ? 'update' : 'same',
      existingName: row.name,
      options: optionNames,
      changes,
      ...(kept.length > 0 ? { keptOnTill: kept } : {}),
    });
    if (changed) summary.choiceGroupsChanged++;
    if (kept.length > 0) summary.keptOnTill.choices++;
  });
  const fileGroups = new Map(file.modifierGroups.map((g) => [g.name.toLowerCase(), g]));
  /** An item's choices: option name → the option, through the item's groups. */
  const optionsOf = (item: MenuImportFile['items'][number]) => {
    const out = new Map<string, ModifierRef | undefined>();
    for (const gName of item.modifierGroups) {
      const g = fileGroups.get(gName.toLowerCase());
      for (const o of g?.options ?? []) out.set(o.name.toLowerCase(), optionRef.get(`${gName.toLowerCase()}|${o.name.toLowerCase()}`));
    }
    return out;
  };

  // ---- Items ---------------------------------------------------------------
  const counts = new Map<string, number>(live.taxUse ?? []);
  if (!live.taxUse) for (const it of live.items) counts.set(it.taxCategoryId, (counts.get(it.taxCategoryId) ?? 0) + 1);
  const byUse = (a: { id: string; name: string }, b: { id: string; name: string }) =>
    (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name);
  const pct = (bps: number) => `${bps / 100}%`;
  // With a tax in the file: a category at exactly that rate (same name first,
  // then the most used), else one is created. Without: the most used one.
  let taxCategory: { id: string; name: string; rateBps: number } | null;
  let createTaxCategory: MenuImportOps['createTaxCategory'] = null;
  if (file.tax) {
    const atRate = live.taxCategories.filter((t) => t.rateBps === file.tax!.rateBps).sort(byUse);
    taxCategory = atRate.find((t) => normalizeName(t.name) === normalizeName(file.tax!.name)) ?? atRate[0] ?? null;
    if (!taxCategory) createTaxCategory = { name: file.tax.name, rateBps: file.tax.rateBps };
  } else {
    taxCategory = [...live.taxCategories].sort(byUse)[0] ?? null;
  }
  const taxRateById = new Map(live.taxCategories.map((t) => [t.id, t.rateBps]));
  const importTaxName = taxCategory?.name ?? createTaxCategory?.name ?? null;
  const importTaxRate = taxCategory?.rateBps ?? createTaxCategory?.rateBps ?? null;
  const canCreateItems = importTaxName !== null;

  const categoryNameById = new Map(live.categories.map((c) => [c.id, c.name]));
  const itemPlans: MenuImportItemPlan[] = [];
  const itemOps: MenuImportOps['items'] = [];
  const matchedItemIds = new Set<string>();
  const itemMatches = matchAll(file.items, live.items);

  // Sizes are separate items the checkout groups by name ("Fajita — Medium" +
  // "Fajita — Large"). When the shop already has one size under its own name,
  // a size the import adds takes that name too, or the two would not group.
  const shopBaseByFileBase = new Map<string, string>();
  file.items.forEach((item, i) => {
    const row = itemMatches[i]!.row;
    const fileSized = splitSize(item.name);
    const shopSized = row ? splitSize(row.name) : null;
    if (fileSized && shopSized) shopBaseByFileBase.set(normalizeName(fileSized.base), shopSized.base);
  });
  const liveNames = new Set(live.items.map((it) => normalizeName(it.name)));
  const nameForNew = (fileName: string): string => {
    const sized = splitSize(fileName);
    const shopBase = sized && shopBaseByFileBase.get(normalizeName(sized.base));
    if (!sized || !shopBase) return fileName;
    const name = `${shopBase} — ${sized.size}`;
    return liveNames.has(normalizeName(name)) ? fileName : name;
  };

  file.items.forEach((item, i) => {
    const m = itemMatches[i]!;
    const catKey = item.category.toLowerCase();
    const itemOptions = optionsOf(item);
    const recipeRefs = item.recipe.map((line) => ({
      ingredient: ingredientRef.get(line.ingredient.toLowerCase()),
      modifier: line.when ? itemOptions.get(line.when.toLowerCase()) : null,
      name: line.when ? `${line.ingredient} (if ${line.when})` : line.ingredient,
      qty: line.qty,
    }));
    const missing = recipeRefs.filter((l) => !l.ingredient || l.modifier === undefined).map((l) => l.name);
    const attachWanted = item.modifierGroups
      .map((gName) => ({ name: gName, ref: groupRef.get(gName.toLowerCase()) }))
      .filter((x): x is { name: string; ref: GroupRef } => !!x.ref);
    const base = { name: item.name, priceCents: item.priceCents, recipeLines: item.recipe.length };

    if (!m.row && m.ambiguous.length > 0) {
      itemPlans.push({
        ...base,
        categoryName: categoryNameByKey.get(catKey) ?? item.category,
        action: 'skip',
        existingName: null,
        changes: [],
        recipeChange: 'skip',
        reason: `More than one item here could be this one: ${m.ambiguous.map((r) => r.name).join(', ')} — rename one so they differ`,
      });
      summary.skipped++;
      return;
    }

    // Recipe: resolved lines, or why it is left alone.
    let recipe: MenuImportOps['items'][number]['recipe'] = null;
    let recipeReason: string | null = null;
    if (item.recipe.length > 0) {
      if (missing.length > 0) {
        recipeReason = `Recipe left as it is: ${missing.join(', ')} could not be imported`;
      } else {
        recipe = recipeRefs.map((l) => ({ ingredient: l.ingredient!, qty: l.qty, modifier: l.modifier ?? null }));
      }
    }

    if (!m.row) {
      if (!canCreateItems) {
        itemPlans.push({
          ...base,
          categoryName: categoryNameByKey.get(catKey) ?? item.category,
          action: 'skip',
          existingName: null,
          changes: [],
          recipeChange: 'skip',
          reason: 'No tax category exists yet — add one under Menu → Tax, then import again',
        });
        summary.skipped++;
        return;
      }
      itemPlans.push({
        ...base,
        name: nameForNew(item.name),
        categoryName: categoryNameByKey.get(catKey) ?? item.category,
        action: 'create',
        existingName: null,
        changes: attachWanted.length ? [`asks: ${attachWanted.map((x) => x.name).join(', ')}`] : [],
        recipeChange: recipe ? 'set' : item.recipe.length > 0 ? 'skip' : 'none',
        reason: recipeReason,
      });
      itemOps.push({
        existingId: null,
        create: {
          name: nameForNew(item.name),
          categoryFileKey: catKey,
          basePriceCents: item.priceCents,
          description: item.description,
          sortOrder: item.sortOrder,
        },
        update: null,
        attach: attachWanted.map((x) => x.ref),
        recipe,
      });
      summary.newItems++;
      if (recipe) summary.recipesSet++;
      return;
    }

    const row = m.row;
    matchedItemIds.add(row.id);
    const changes: string[] = [];
    /** What the till keeps against the file (the owner's import rules). */
    const kept: string[] = [];
    const update: NonNullable<MenuImportOps['items'][number]['update']> = {};
    if (row.basePriceCents !== item.priceCents) {
      if (policy.itemPrices === 'till') {
        kept.push(`price ${formatCents(row.basePriceCents)} (the file says ${formatCents(item.priceCents)})`);
        summary.keptOnTill.prices++;
      } else {
        changes.push(`price ${formatCents(row.basePriceCents)} → ${formatCents(item.priceCents)}`);
        update.basePriceCents = item.priceCents;
        summary.priceChanges++;
      }
    }
    if (!row.description?.trim() && item.description?.trim()) {
      changes.push('description added');
      update.description = item.description;
    }
    if (file.tax && row.taxCategoryId !== taxCategory?.id) {
      const was = taxRateById.get(row.taxCategoryId);
      if (policy.tax === 'till') {
        kept.push(`tax ${was !== undefined ? pct(was) : '?'} (the file says ${pct(file.tax.rateBps)})`);
        summary.keptOnTill.taxes++;
      } else {
        changes.push(`tax ${was !== undefined ? pct(was) : '?'} → ${pct(file.tax.rateBps)}`);
        update.useImportTax = true;
        summary.taxChanges++;
      }
    }

    const attachedNow = new Set((live.itemGroups.get(row.id) ?? []).map((a) => a.groupId));
    const attach = attachWanted.filter((x) => !('existingId' in x.ref) || !attachedNow.has(x.ref.existingId));
    if (attach.length > 0) changes.push(`asks: ${attach.map((x) => x.name).join(', ')}`);

    let recipeChange: MenuImportItemPlan['recipeChange'] = item.recipe.length > 0 ? 'skip' : 'none';
    if (recipe) {
      const current = live.recipes.get(row.id) ?? [];
      const same =
        current.length === recipe.length &&
        recipe.every((l) => {
          if (!('existingId' in l.ingredient)) return false;
          if (l.modifier && !('existingId' in l.modifier)) return false;
          const id = l.ingredient.existingId;
          const modifierId = l.modifier && 'existingId' in l.modifier ? l.modifier.existingId : null;
          const factor = conversions.get(id) ?? 1;
          return current.some((c) => c.ingredientId === id && c.modifierId === modifierId && c.qtyPerUnit * factor === l.qty);
        });
      if (same) {
        recipe = null;
        recipeChange = 'same';
      } else if (current.length > 0 && policy.recipes === 'till') {
        // The owner's rule: a recipe the till already has stays; an item with none still gets the file's.
        recipe = null;
        recipeChange = 'kept';
        kept.push(`recipe (${current.length} ${current.length === 1 ? 'line' : 'lines'}; the file has ${item.recipe.length})`);
        summary.keptOnTill.recipes++;
      } else {
        recipeChange = current.length === 0 ? 'set' : 'replace';
        changes.push(current.length === 0 ? `recipe added (${item.recipe.length} lines)` : `recipe replaced (${current.length} → ${item.recipe.length} lines)`);
        summary.recipesSet++;
      }
    }

    const hasUpdate = Object.keys(update).length > 0;
    const action = hasUpdate || recipe || attach.length > 0 ? 'update' : 'same';
    if (action === 'update') summary.updatedItems++;
    itemPlans.push({
      ...base,
      categoryName: categoryNameById.get(row.categoryId) ?? '?',
      action,
      existingName: row.isActive ? row.name : `${row.name} (hidden)`,
      changes,
      recipeChange,
      reason: recipeReason,
      ...(kept.length > 0 ? { keptOnTill: kept } : {}),
    });
    if (action === 'update') {
      itemOps.push({ existingId: row.id, create: null, update: hasUpdate ? update : null, attach: attach.map((x) => x.ref), recipe });
    }
  });

  const untouchedItems = live.items
    .filter((it) => !matchedItemIds.has(it.id))
    .map((it) => (it.isActive ? it.name : `${it.name} (hidden)`))
    .sort((a, b) => a.localeCompare(b));

  if (!canCreateItems && file.items.length > 0) {
    warnings.push('This POS has no tax category, so new items cannot be added yet (Menu → Tax).');
  }

  // A category is only created when a new item needs a home in it.
  const needed = new Set(itemOps.flatMap((o) => (o.create ? [o.create.categoryFileKey] : [])));
  const keepCategory = (i: number) => categoryOps[i]!.existingId !== null || needed.has(categoryOps[i]!.fileKey);
  const categoriesKept = categoryOps.filter((_, i) => keepCategory(i));

  return {
    preview: {
      fresh: null,
      source: file.source,
      taxCategoryName: importTaxName && importTaxRate !== null ? `${importTaxName} (${pct(importTaxRate)})` : null,
      taxCategoryIsNew: createTaxCategory !== null,
      taxFromFile: file.tax !== null,
      categories: categoryPlans.filter((_, i) => keepCategory(i)),
      choiceGroups: choicePlans,
      ingredients: ingredientPlans,
      items: itemPlans,
      untouchedItems,
      warnings,
      summary: { ...summary, newCategories: categoriesKept.filter((c) => c.create).length, keptLine: keptOnTillLine(summary.keptOnTill) },
    },
    ops: {
      categories: categoriesKept,
      ingredients: ingredientOps,
      items: itemOps,
      modifierGroups: groupOps,
      batches: batchOps,
      taxCategoryId: taxCategory?.id ?? null,
      createTaxCategory,
    },
  };
}
