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
    notes: string | null;
  }>;
  /** Live recipe lines per menu item id. */
  recipes: Map<string, Array<{ ingredientId: string; qtyPerUnit: number }>>;
  taxCategories: Array<{ id: string; name: string }>;
}

/** A reference to an ingredient that exists now, or one the import creates first. */
export type IngredientRef = { existingId: string } | { fileKey: string };

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
    update: { basePriceCents?: number; description?: string } | null;
    /** Replace the item's recipe with these lines; null = leave the recipe alone. */
    recipe: Array<{ ingredient: IngredientRef; qty: number }> | null;
  }>;
  taxCategoryId: string | null;
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
    recipesSet: 0,
    newIngredients: 0,
    updatedIngredients: 0,
    newCategories: 0,
    skipped: 0,
  };

  // ---- Categories ----------------------------------------------------------
  const categoryPlans: MenuImportCategoryPlan[] = [];
  const categoryOps: MenuImportOps['categories'] = [];
  /** file category key → the name it will carry on this POS */
  const categoryNameByKey = new Map<string, string>();
  let nextOrder = Math.max(0, ...live.categories.map((c) => c.displayOrder + 1));
  const categoryMatches = matchAll(file.categories, live.categories);
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
        create: { name: cat.name, displayOrder: nextOrder++, colorHex: cat.colorHex },
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
  file.ingredients.forEach((ing, i) => {
    const key = ing.name.toLowerCase();
    const m = ingredientMatches[i]!;
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

  // ---- Items ---------------------------------------------------------------
  const counts = new Map<string, number>();
  for (const it of live.items) counts.set(it.taxCategoryId, (counts.get(it.taxCategoryId) ?? 0) + 1);
  const busiestTax = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const taxCategory =
    live.taxCategories.find((t) => t.id === busiestTax) ??
    [...live.taxCategories].sort((a, b) => a.name.localeCompare(b.name))[0] ??
    null;

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
    const recipeRefs = item.recipe.map((line) => ({
      ingredient: ingredientRef.get(line.ingredient.toLowerCase()),
      name: line.ingredient,
      qty: line.qty,
    }));
    const missing = recipeRefs.filter((l) => !l.ingredient).map((l) => l.name);
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
        recipe = recipeRefs.map((l) => ({ ingredient: l.ingredient!, qty: l.qty }));
      }
    }

    if (!m.row) {
      if (!taxCategory) {
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
        changes: [],
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

    let recipeChange: MenuImportItemPlan['recipeChange'] = item.recipe.length > 0 ? 'skip' : 'none';
    if (recipe) {
      const current = live.recipes.get(row.id) ?? [];
      const same =
        current.length === recipe.length &&
        recipe.every((l) => {
          if (!('existingId' in l.ingredient)) return false;
          const id = l.ingredient.existingId;
          const factor = conversions.get(id) ?? 1;
          return current.some((c) => c.ingredientId === id && c.qtyPerUnit * factor === l.qty);
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
    const action = hasUpdate || recipe ? 'update' : 'same';
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
      itemOps.push({ existingId: row.id, create: null, update: hasUpdate ? update : null, recipe });
    }
  });

  const untouchedItems = live.items
    .filter((it) => !matchedItemIds.has(it.id))
    .map((it) => (it.isActive ? it.name : `${it.name} (hidden)`))
    .sort((a, b) => a.localeCompare(b));

  if (!taxCategory && file.items.length > 0) {
    warnings.push('This POS has no tax category, so new items cannot be added yet (Menu → Tax).');
  }

  // A category is only created when a new item needs a home in it.
  const needed = new Set(itemOps.flatMap((o) => (o.create ? [o.create.categoryFileKey] : [])));
  const keepCategory = (i: number) => categoryOps[i]!.existingId !== null || needed.has(categoryOps[i]!.fileKey);
  const categoriesKept = categoryOps.filter((_, i) => keepCategory(i));

  return {
    preview: {
      source: file.source,
      taxCategoryName: taxCategory?.name ?? null,
      categories: categoryPlans.filter((_, i) => keepCategory(i)),
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
      taxCategoryId: taxCategory?.id ?? null,
    },
  };
}
