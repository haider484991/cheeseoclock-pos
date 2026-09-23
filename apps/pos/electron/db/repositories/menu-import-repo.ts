import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { writeAudit } from './audit-repo.js';
import { listCategories, createCategory } from './category-repo.js';
import { listMenuItems, createMenuItem, updateMenuItem } from './menu-item-repo.js';
import {
  listIngredients,
  createIngredient,
  updateIngredient,
  convertIngredientToBaseUnit,
  setRecipeForItem,
} from './ingredient-repo.js';
import { listTaxCategories } from './tax-category-repo.js';
import { planMenuImport, type MenuImportPlan, type MenuSnapshot } from '../menu-import-plan.js';
import type { MenuImportFile } from '@cheeseoclock/shared-schemas';
import type { MenuImportSummary } from '@cheeseoclock/shared-types';

/** The live menu as the planner needs it. */
export function readMenuSnapshot(db: AppDatabase): MenuSnapshot {
  const recipes = new Map<string, Array<{ ingredientId: string; qtyPerUnit: number }>>();
  const rows = db
    .prepare(
      `SELECT menu_item_id, ingredient_id, qty_per_unit
         FROM recipes WHERE deleted_at IS NULL`,
    )
    .all() as Array<{ menu_item_id: string; ingredient_id: string; qty_per_unit: number }>;
  for (const r of rows) {
    recipes.set(r.menu_item_id, [
      ...(recipes.get(r.menu_item_id) ?? []),
      { ingredientId: r.ingredient_id, qtyPerUnit: r.qty_per_unit },
    ]);
  }
  return {
    categories: listCategories(db),
    items: listMenuItems(db),
    ingredients: listIngredients(db),
    recipes,
    taxCategories: listTaxCategories(db),
  };
}

export function planMenuImportFromDb(db: AppDatabase, file: MenuImportFile): MenuImportPlan {
  return planMenuImport(file, readMenuSnapshot(db));
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
): MenuImportSummary {
  const tx = db.transaction((): MenuImportSummary => {
    const { ops, preview } = planMenuImportFromDb(db, file);

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

    for (const op of ops.items) {
      let itemId = op.existingId;
      if (!itemId && op.create) {
        const categoryId = categoryIds.get(op.create.categoryFileKey);
        if (!categoryId || !ops.taxCategoryId) throw new Error(`No category or tax for ${op.create.name}`);
        itemId = createMenuItem(
          db,
          {
            categoryId,
            name: op.create.name,
            description: op.create.description,
            basePriceCents: op.create.basePriceCents,
            taxCategoryId: ops.taxCategoryId,
            sortOrder: op.create.sortOrder,
          },
          actor,
        ).id;
      } else if (itemId && op.update) {
        updateMenuItem(db, { id: itemId, ...op.update }, actor);
      }
      if (itemId && op.recipe) {
        setRecipeForItem(
          db,
          itemId,
          op.recipe.map((line) => {
            const ingredientId =
              'existingId' in line.ingredient
                ? line.ingredient.existingId
                : ingredientIds.get(line.ingredient.fileKey);
            if (!ingredientId) throw new Error('Recipe line points at an ingredient that was not created');
            return { ingredientId, qtyPerUnit: line.qty };
          }),
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
      after: { fileName, source: file.source, summary: preview.summary },
    });
    return preview.summary;
  });
  return tx();
}
