import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { writeAudit } from './audit-repo.js';
import { listCategories, createCategory, deleteCategory } from './category-repo.js';
import { listMenuItems, createMenuItem, updateMenuItem, deleteMenuItem } from './menu-item-repo.js';
import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  convertIngredientToBaseUnit,
  setRecipeForItem,
} from './ingredient-repo.js';
import { setBatchRecipe, clearBatchRecipeLines } from './batch-recipe-repo.js';
import { listCombos, deleteCombo } from './combo-repo.js';
import {
  listModifierGroups,
  listModifiersByGroup,
  createModifierGroup,
  updateModifierGroup,
  deleteModifierGroup,
  createModifier,
  updateModifier,
  deleteModifier,
  listModifierGroupsForItem,
  setItemModifierGroups,
} from './modifier-repo.js';
import { listTaxCategories, createTaxCategory } from './tax-category-repo.js';
import {
  planMenuImport,
  type GroupRef,
  type IngredientRef,
  type MenuImportPlan,
  type MenuSnapshot,
  type ModifierRef,
} from '../menu-import-plan.js';
import type { MenuImportFile } from '@cheeseoclock/shared-schemas';
import type { MenuImportFreshStart, MenuImportSummary } from '@cheeseoclock/shared-types';

/** The import cannot run as asked (open orders during a fresh start…). */
export class MenuImportRefusedError extends Error {}

function groupBy<T, K, V>(rows: T[], key: (r: T) => K, value: (r: T) => V): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), value(r)]);
  return out;
}

/** The live menu as the planner needs it. */
export function readMenuSnapshot(db: AppDatabase): MenuSnapshot {
  const recipes = db
    .prepare(`SELECT menu_item_id, ingredient_id, qty_per_unit, modifier_id FROM recipes WHERE deleted_at IS NULL`)
    .all() as Array<{ menu_item_id: string; ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>;
  const attachments = db
    .prepare(
      `SELECT menu_item_id, modifier_group_id, sort_order FROM menu_item_modifier_groups WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ menu_item_id: string; modifier_group_id: string; sort_order: number }>;
  const batchLines = db
    .prepare(`SELECT ingredient_id, input_ingredient_id, qty FROM batch_recipe_lines WHERE deleted_at IS NULL`)
    .all() as Array<{ ingredient_id: string; input_ingredient_id: string; qty: number }>;
  return {
    categories: listCategories(db),
    items: listMenuItems(db),
    ingredients: listIngredients(db),
    recipes: groupBy(recipes, (r) => r.menu_item_id, (r) => ({
      ingredientId: r.ingredient_id,
      qtyPerUnit: r.qty_per_unit,
      modifierId: r.modifier_id,
    })),
    taxCategories: listTaxCategories(db),
    modifierGroups: listModifierGroups(db).map((g) => ({ ...g, modifiers: listModifiersByGroup(db, g.id) })),
    itemGroups: groupBy(attachments, (a) => a.menu_item_id, (a) => ({ groupId: a.modifier_group_id, sortOrder: a.sort_order })),
    batchLines: groupBy(batchLines, (b) => b.ingredient_id, (b) => ({ inputId: b.input_ingredient_id, qty: b.qty })),
  };
}

/**
 * Unpaid orders still in progress — a fresh start waits until there are none,
 * or their stock would come off recipes that no longer exist. Paid orders
 * waiting on the board are fine: their stock came off when they were paid.
 */
function countOpenOrders(db: AppDatabase): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
          WHERE deleted_at IS NULL AND paid_at IS NULL
            AND status IN ('open', 'sent_to_kitchen', 'preparing', 'ready', 'out_for_delivery')`,
      )
      .get() as { n: number }
  ).n;
}

/** Throws while unpaid orders are open (checked again inside the import's transaction). */
export function refuseFreshStartWhileBusy(db: AppDatabase): void {
  const open = countOpenOrders(db);
  if (open > 0) {
    throw new MenuImportRefusedError(
      `${open} unpaid order${open === 1 ? ' is' : 's are'} still open. Take payment or discard ${open === 1 ? 'it' : 'them'} first — a fresh start replaces every menu item.`,
    );
  }
}

function taxUseOf(live: MenuSnapshot): Map<string, number> {
  const use = new Map<string, number>();
  for (const it of live.items) use.set(it.taxCategoryId, (use.get(it.taxCategoryId) ?? 0) + 1);
  return use;
}

/** The same POS with no menu: what a fresh start plans against (tax categories stay). */
function emptyMenu(live: MenuSnapshot): MenuSnapshot {
  return {
    categories: [],
    items: [],
    ingredients: [],
    recipes: new Map(),
    taxCategories: live.taxCategories,
    modifierGroups: [],
    itemGroups: new Map(),
    batchLines: new Map(),
    taxUse: taxUseOf(live),
  };
}

function freshStartOf(db: AppDatabase, live: MenuSnapshot): MenuImportFreshStart {
  return {
    items: live.items.map((i) => i.name).sort((a, b) => a.localeCompare(b)),
    categories: live.categories.length,
    combos: listCombos(db).length,
    choiceGroups: live.modifierGroups.length,
    ingredients: live.ingredients.length,
    openOrders: countOpenOrders(db),
  };
}

/**
 * What loading the file would do. fresh: as a fresh start — the whole current
 * menu removed first, so every row in the file is new.
 */
export function planMenuImportFromDb(
  db: AppDatabase,
  file: MenuImportFile,
  opts: { fresh?: boolean } = {},
): MenuImportPlan {
  const live = readMenuSnapshot(db);
  if (!opts.fresh) return planMenuImport(file, live);
  const plan = planMenuImport(file, emptyMenu(live));
  return { ...plan, preview: { ...plan.preview, fresh: freshStartOf(db, live), untouchedItems: [] } };
}

/**
 * Remove the whole menu — every menu item (with its recipe and choice
 * attachments), combo, choice group, ingredient (with its batch recipe) and
 * category — through the ordinary repositories, so each row syncs and audits.
 * Rows left behind by items deleted earlier are cleared too. Orders keep their
 * own snapshots, so history is unaffected. Returns the number of items removed.
 */
function clearMenu(db: AppDatabase, actor: Actor): number {
  const ids = (sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
  for (const id of ids(`SELECT DISTINCT menu_item_id AS id FROM recipes WHERE deleted_at IS NULL`)) {
    setRecipeForItem(db, id, [], actor);
  }
  for (const id of ids(`SELECT DISTINCT menu_item_id AS id FROM menu_item_modifier_groups WHERE deleted_at IS NULL`)) {
    setItemModifierGroups(db, id, [], actor);
  }
  const items = ids(`SELECT id FROM menu_items WHERE deleted_at IS NULL`);
  for (const id of items) deleteMenuItem(db, id, actor);
  for (const c of listCombos(db)) deleteCombo(db, c.id, actor);
  for (const g of listModifierGroups(db)) {
    for (const m of listModifiersByGroup(db, g.id)) deleteModifier(db, m.id, actor);
    deleteModifierGroup(db, g.id, actor);
  }
  for (const id of ids(`SELECT DISTINCT ingredient_id AS id FROM batch_recipe_lines WHERE deleted_at IS NULL`)) {
    clearBatchRecipeLines(db, id, actor);
  }
  for (const i of listIngredients(db)) deleteIngredient(db, i.id, actor);
  for (const c of listCategories(db)) deleteCategory(db, c.id, actor);
  return items.length;
}

/**
 * Write a menu file. Re-plans against the live menu inside one transaction,
 * then goes through the ordinary repositories — every row gets its own sync
 * entry and audit row — plus one audit row recording the import itself.
 * Any failure rolls the whole import back.
 */
export function applyMenuImport(
  db: AppDatabase,
  file: MenuImportFile,
  fileName: string,
  actor: Actor,
  opts: { fresh?: boolean } = {},
): MenuImportSummary {
  const tx = db.transaction((): MenuImportSummary => {
    let removedItems = 0;
    let taxUse: Map<string, number> | undefined;
    if (opts.fresh) {
      refuseFreshStartWhileBusy(db);
      taxUse = taxUseOf(readMenuSnapshot(db));
      removedItems = clearMenu(db, actor);
    }
    const snapshot = readMenuSnapshot(db);
    const { ops, preview } = planMenuImport(file, taxUse ? { ...snapshot, taxUse } : snapshot);

    const taxCategoryId = ops.createTaxCategory
      ? createTaxCategory(db, ops.createTaxCategory, actor).id
      : ops.taxCategoryId;

    const categoryIds = new Map<string, string>();
    for (const c of ops.categories) {
      categoryIds.set(c.fileKey, c.existingId ?? createCategory(db, c.create!, actor).id);
    }

    const ingredientIds = new Map<string, string>();
    for (const ing of ops.ingredients) {
      if (ing.existingId) {
        if (ing.convert) convertIngredientToBaseUnit(db, ing.existingId, actor);
        if (ing.update) updateIngredient(db, { id: ing.existingId, ...ing.update }, actor);
        ingredientIds.set(ing.fileKey, ing.existingId);
      } else if (ing.create) {
        ingredientIds.set(ing.fileKey, createIngredient(db, ing.create, actor).id);
      }
    }
    const ingredientId = (ref: IngredientRef): string => {
      const id = 'existingId' in ref ? ref.existingId : ingredientIds.get(ref.fileKey);
      if (!id) throw new Error('A recipe points at an ingredient that was not created');
      return id;
    };

    for (const b of ops.batches) {
      setBatchRecipe(
        db,
        {
          ingredientId: ingredientId(b.ingredient),
          batchYield: b.batchYield,
          batchMethod: b.batchMethod,
          lines: b.lines.map((l) => ({ inputIngredientId: ingredientId(l.ingredient), qty: l.qty })),
        },
        actor,
      );
    }

    const groupIds = new Map<string, string>();
    const optionIds = new Map<string, string>();
    for (const g of ops.modifierGroups) {
      let gid = g.existingId;
      if (!gid) gid = createModifierGroup(db, g.create!, actor).id;
      else if (g.update) updateModifierGroup(db, { id: gid, ...g.update }, actor);
      groupIds.set(g.groupKey, gid);
      for (const o of g.options) {
        let oid = o.existingId;
        if (!oid) oid = createModifier(db, { modifierGroupId: gid, ...o.create! }, actor).id;
        else if (o.update) updateModifier(db, { id: oid, ...o.update }, actor);
        optionIds.set(`${g.groupKey}|${o.optionKey}`, oid);
      }
    }
    const groupId = (ref: GroupRef): string => {
      const id = 'existingId' in ref ? ref.existingId : groupIds.get(ref.groupKey);
      if (!id) throw new Error('An item points at a choice group that was not created');
      return id;
    };
    const modifierId = (ref: ModifierRef): string => {
      const id = 'existingId' in ref ? ref.existingId : optionIds.get(`${ref.groupKey}|${ref.optionKey}`);
      if (!id) throw new Error('A recipe line points at a choice that was not created');
      return id;
    };

    for (const op of ops.items) {
      let itemId = op.existingId;
      if (!itemId && op.create) {
        const categoryId = categoryIds.get(op.create.categoryFileKey);
        if (!categoryId || !taxCategoryId) throw new Error(`No category or tax for ${op.create.name}`);
        itemId = createMenuItem(
          db,
          {
            categoryId,
            name: op.create.name,
            description: op.create.description,
            basePriceCents: op.create.basePriceCents,
            taxCategoryId,
            sortOrder: op.create.sortOrder,
          },
          actor,
        ).id;
      } else if (itemId && op.update) {
        const { useImportTax, ...fields } = op.update;
        if (useImportTax && !taxCategoryId) throw new Error('No tax category to move items onto');
        updateMenuItem(db, { id: itemId, ...fields, ...(useImportTax ? { taxCategoryId: taxCategoryId! } : {}) }, actor);
      }
      if (!itemId) continue;
      if (op.attach.length > 0) {
        // Keep what is attached, add the file's groups after it.
        const current = listModifierGroupsForItem(db, itemId);
        let next = Math.max(-1, ...current.map((g) => g.sortOrder)) + 1;
        setItemModifierGroups(
          db,
          itemId,
          [
            ...current.map((g) => ({ modifierGroupId: g.id, sortOrder: g.sortOrder })),
            ...op.attach.map((ref) => ({ modifierGroupId: groupId(ref), sortOrder: next++ })),
          ],
          actor,
        );
      }
      if (op.recipe) {
        setRecipeForItem(
          db,
          itemId,
          op.recipe.map((line) => ({
            ingredientId: ingredientId(line.ingredient),
            qtyPerUnit: line.qty,
            modifierId: line.modifier ? modifierId(line.modifier) : null,
          })),
          actor,
        );
      }
    }

    writeAudit(db, {
      entityType: 'menu_import',
      entityId: uuidv7(),
      action: 'import',
      actorUserId: actor.userId,
      before: null,
      after: { fileName, source: file.source, fresh: !!opts.fresh, removedItems, summary: preview.summary },
    });
    return { ...preview.summary, removedItems };
  });
  return tx();
}
