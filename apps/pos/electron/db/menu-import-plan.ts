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
 *   - A pack price ("6,000 g for Rs 2,250") decides the per-gram cost.
 *   - A description is only filled in where the item has none.
 *   - Choice groups ("Choose your dip") are matched by name; missing options
 *     are added, none removed. Items gain the file's groups; groups they
 *     already had stay attached.
 *   - A recipe line with `when` is only used when that choice is picked.
 *   - Batch recipes (what the kitchen makes) replace the old batch recipe;
 *     a method is only filled in where there is none.
 */

import {
  baseUnitConversion,
  costPerUnitFromPack,
  formatCents,
  formatPack,
  formatUnitCost,
  normalizeUnit,
} from '@cheeseoclock/pos-domain';
import type { MenuImportFile } from '@cheeseoclock/shared-schemas';
import type {
  MenuImportCategoryPlan,
  MenuImportChoiceGroupPlan,
  MenuImportIngredientPlan,
  MenuImportItemPlan,
  MenuImportPreview,
  MenuImportSummary,
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
      notes: string | null;
    } | null;
    update: {
      costPerUnitCents?: number;
      packSize?: number | null;
      packPriceCents?: number | null;
      notes?: string;
    } | null;
    /** Convert kg → g / l → ml (stock and recipe lines ×1000) before the update. */
    convert: boolean;
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

/** What a costing works out to per base unit, in paisa (a pack wins over a typed cost). */
function unitCost(c: Costing): number {
  return c.packSize && c.packPriceCents !== null ? costPerUnitFromPack(c.packPriceCents, c.packSize) : c.costPerUnitCents;
}

export function planMenuImport(file: MenuImportFile, live: MenuSnapshot): MenuImportPlan {
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
  const ingredientPlans: MenuImportIngredientPlan[] = [];
  const ingredientOps: MenuImportOps['ingredients'] = [];
  /** file ingredient key → how a recipe line refers to it; absent = skipped */
  const ingredientRef = new Map<string, IngredientRef>();
  /** existing ingredient id → factor its stock and recipe lines are scaled by */
  const conversions = new Map<string, number>();
  const ingredientMatches = matchAll(file.ingredients, live.ingredients);
  /** file ingredient key → the existing row it matched (for batch comparison) */
  const matchedIngredient = new Map<string, MenuSnapshot['ingredients'][number]>();
  file.ingredients.forEach((ing, i) => {
    const key = ing.name.toLowerCase();
    const m = ingredientMatches[i]!;
    if (m.row) matchedIngredient.set(key, m.row);
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
        action: 'skip',
        existingName: null,
        changes: [],
        reason: `More than one ingredient here could be this one: ${m.ambiguous.map((r) => r.name).join(', ')}`,
      });
      summary.skipped++;
      return;
    }
    if (!m.row) {
      ingredientPlans.push({ ...base, action: 'create', existingName: null, changes: [], reason: null });
      ingredientOps.push({
        fileKey: key,
        existingId: null,
        create: {
          name: ing.name,
          unit: ing.unit,
          costPerUnitCents: unitCost(ing),
          packSize: ing.packSize,
          packPriceCents: ing.packPriceCents,
          notes: ing.notes,
        },
        update: null,
        convert: false,
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
          action: 'skip',
          existingName: row.name,
          changes: [],
          reason: `Counted in "${row.unit}" here but "${ing.unit}" in the file — change one to match, then import again`,
        });
        summary.skipped++;
        return;
      }
      convert = true;
      conversions.set(row.id, conv.factor);
      current = {
        unit: conv.unit,
        costPerUnitCents: Math.round(row.costPerUnitCents / conv.factor),
        packSize: row.packSize !== null ? row.packSize * conv.factor : null,
        packPriceCents: row.packPriceCents,
      };
      changes.push(`counted in ${row.unit} → ${conv.unit} (stock and recipes ×${conv.factor})`);
    }
    const update: NonNullable<MenuImportOps['ingredients'][number]['update']> = {};
    const packGiven = ing.packSize !== null && ing.packPriceCents !== null;
    if (packGiven && (current.packSize !== ing.packSize || current.packPriceCents !== ing.packPriceCents)) {
      update.packSize = ing.packSize;
      update.packPriceCents = ing.packPriceCents;
      changes.push(`bought as ${formatPack({ unit: current.unit, packSize: ing.packSize, packPriceCents: ing.packPriceCents })}`);
    }
    if (!packGiven && current.costPerUnitCents !== ing.costPerUnitCents) {
      update.costPerUnitCents = ing.costPerUnitCents;
      if (current.packSize !== null) {
        // A typed cost only counts once the pack that decides the cost is cleared.
        update.packSize = null;
        update.packPriceCents = null;
      }
    }
    if (unitCost(current) !== unitCost(ing)) {
      changes.push(
        `cost ${formatUnitCost(current)} → ${formatUnitCost({ ...ing, unit: current.unit, costPerUnitCents: unitCost(ing) })}`,
      );
    }
    if (!row.notes?.trim() && ing.notes?.trim()) {
      changes.push('notes added');
      update.notes = ing.notes;
    }
    const changed = convert || Object.keys(update).length > 0;
    ingredientPlans.push({ ...base, action: changed ? 'update' : 'same', existingName: row.name, changes, reason: null });
    ingredientOps.push({
      fileKey: key,
      existingId: row.id,
      create: null,
      update: Object.keys(update).length > 0 ? update : null,
      convert,
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
    const update: NonNullable<MenuImportOps['modifierGroups'][number]['update']> = {};
    if (row.selectionType !== shape.selectionType) update.selectionType = shape.selectionType;
    if (row.minSelect !== shape.minSelect) update.minSelect = shape.minSelect;
    if (row.maxSelect !== shape.maxSelect) update.maxSelect = shape.maxSelect;
    if (row.isRequired !== shape.isRequired) update.isRequired = shape.isRequired;
    if (Object.keys(update).length > 0) {
      changes.push(`choose ${shape.minSelect === shape.maxSelect ? shape.minSelect : `${shape.minSelect}–${shape.maxSelect}`}${shape.isRequired ? ', required' : ''}`);
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
        oUpdate.removes = wantRemoves;
        changes.push(`"${om.row.name}" ${wantRemoves ? `leaves out ${o.removes}` : 'no longer leaves anything out'}`);
      }
      if (om.row.priceDeltaCents !== o.priceDeltaCents) {
        oUpdate.priceDeltaCents = o.priceDeltaCents;
        changes.push(`"${om.row.name}" ${formatCents(om.row.priceDeltaCents)} → ${formatCents(o.priceDeltaCents)}`);
      }
      if (om.row.isDefault !== o.isDefault) oUpdate.isDefault = o.isDefault;
      options.push({ optionKey, existingId: om.row.id, create: null, update: Object.keys(oUpdate).length ? oUpdate : null });
    });
    const changed = Object.keys(update).length > 0 || options.some((o) => o.create || o.update);
    groupOps.push({ groupKey, existingId: row.id, create: null, update: Object.keys(update).length ? update : null, options });
    choicePlans.push({ name: g.name, action: changed ? 'update' : 'same', existingName: row.name, options: optionNames, changes });
    if (changed) summary.choiceGroupsChanged++;
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
    const update: NonNullable<MenuImportOps['items'][number]['update']> = {};
    if (row.basePriceCents !== item.priceCents) {
      changes.push(`price ${formatCents(row.basePriceCents)} → ${formatCents(item.priceCents)}`);
      update.basePriceCents = item.priceCents;
      summary.priceChanges++;
    }
    if (!row.description?.trim() && item.description?.trim()) {
      changes.push('description added');
      update.description = item.description;
    }
    if (file.tax && row.taxCategoryId !== taxCategory?.id) {
      const was = taxRateById.get(row.taxCategoryId);
      changes.push(`tax ${was !== undefined ? pct(was) : '?'} → ${pct(file.tax.rateBps)}`);
      update.useImportTax = true;
      summary.taxChanges++;
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
      summary: { ...summary, newCategories: categoriesKept.filter((c) => c.create).length },
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
