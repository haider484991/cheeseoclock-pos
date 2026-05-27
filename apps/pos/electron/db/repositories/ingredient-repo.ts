import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type { Ingredient, Recipe } from '@cheeseoclock/shared-types';

// -----------------------------------------------------------------------------
// Ingredients
// -----------------------------------------------------------------------------

interface IngRow {
  id: string;
  name: string;
  unit: string;
  current_qty: number;
  low_threshold: number;
  cost_per_unit_cents: number;
  default_supplier_id: string | null;
  sku: string | null;
  notes: string | null;
  is_active: number;
}

const ING_SELECT = `
  id, name, unit, current_qty, low_threshold, cost_per_unit_cents,
  default_supplier_id, sku, notes, is_active
`;

function rowToIngredient(r: IngRow): Ingredient {
  return {
    id: r.id as Ingredient['id'],
    name: r.name,
    unit: r.unit,
    currentQty: r.current_qty,
    lowThreshold: r.low_threshold,
    costPerUnitCents: r.cost_per_unit_cents,
    defaultSupplierId: r.default_supplier_id as Ingredient['defaultSupplierId'],
    sku: r.sku,
    notes: r.notes,
    isActive: toBool(r.is_active),
  };
}

export function listIngredients(
  db: AppDatabase,
  opts?: { activeOnly?: boolean; lowStockOnly?: boolean },
): Ingredient[] {
  const where: string[] = ['deleted_at IS NULL'];
  if (opts?.activeOnly) where.push('is_active = 1');
  if (opts?.lowStockOnly) where.push('current_qty <= low_threshold');
  const rows = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE ${where.join(' AND ')} ORDER BY name`)
    .all() as IngRow[];
  return rows.map(rowToIngredient);
}

export function findIngredient(db: AppDatabase, id: string): Ingredient | null {
  const row = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as IngRow | undefined;
  return row ? rowToIngredient(row) : null;
}

export interface CreateIngredientInput {
  name: string;
  unit: string;
  currentQty?: number;
  lowThreshold?: number;
  costPerUnitCents?: number;
  defaultSupplierId?: string | null;
  sku?: string | null;
  notes?: string | null;
}

export function createIngredient(
  db: AppDatabase,
  input: CreateIngredientInput,
  actor: Actor,
): Ingredient {
  const id = uuidv7();
  const now = nowIso();
  const ing: Ingredient = {
    id: id as Ingredient['id'],
    name: input.name,
    unit: input.unit,
    currentQty: input.currentQty ?? 0,
    lowThreshold: input.lowThreshold ?? 0,
    costPerUnitCents: input.costPerUnitCents ?? 0,
    defaultSupplierId: (input.defaultSupplierId ?? null) as Ingredient['defaultSupplierId'],
    sku: input.sku ?? null,
    notes: input.notes ?? null,
    isActive: true,
  };
  writeWithSync({
    db,
    entityType: 'ingredients',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: ing,
    writeRow: () => {
      db.prepare(
        `INSERT INTO ingredients
           (id, name, unit, current_qty, low_threshold, cost_per_unit_cents,
            default_supplier_id, sku, notes, is_active,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      ).run(
        id,
        ing.name,
        ing.unit,
        ing.currentQty,
        ing.lowThreshold,
        ing.costPerUnitCents,
        ing.defaultSupplierId,
        ing.sku,
        ing.notes,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return ing;
}

export interface UpdateIngredientInput {
  id: string;
  name?: string;
  unit?: string;
  lowThreshold?: number;
  costPerUnitCents?: number;
  defaultSupplierId?: string | null;
  sku?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export function updateIngredient(
  db: AppDatabase,
  input: UpdateIngredientInput,
  actor: Actor,
): Ingredient {
  const row = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as IngRow | undefined;
  if (!row) throw new Error('Ingredient not found');
  const before = rowToIngredient(row);
  const after: Ingredient = {
    ...before,
    name: input.name ?? before.name,
    unit: input.unit ?? before.unit,
    lowThreshold: input.lowThreshold ?? before.lowThreshold,
    costPerUnitCents: input.costPerUnitCents ?? before.costPerUnitCents,
    defaultSupplierId:
      input.defaultSupplierId !== undefined
        ? (input.defaultSupplierId as Ingredient['defaultSupplierId'])
        : before.defaultSupplierId,
    sku: input.sku !== undefined ? input.sku : before.sku,
    notes: input.notes !== undefined ? input.notes : before.notes,
    isActive: input.isActive ?? before.isActive,
  };
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'ingredients',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE ingredients SET
           name = ?, unit = ?, low_threshold = ?, cost_per_unit_cents = ?,
           default_supplier_id = ?, sku = ?, notes = ?, is_active = ?,
           updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(
        after.name,
        after.unit,
        after.lowThreshold,
        after.costPerUnitCents,
        after.defaultSupplierId,
        after.sku,
        after.notes,
        fromBool(after.isActive),
        now,
        input.id,
      );
    },
  });
  return after;
}

export function deleteIngredient(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as IngRow | undefined;
  if (!row) throw new Error('Ingredient not found');
  const usage = db
    .prepare(`SELECT COUNT(*) AS n FROM recipes WHERE ingredient_id = ? AND deleted_at IS NULL`)
    .get(id) as { n: number };
  if (usage.n > 0) {
    throw new Error(`Ingredient is used in ${usage.n} recipes — remove from recipes first`);
  }
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'ingredients',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToIngredient(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE ingredients SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}

// -----------------------------------------------------------------------------
// Recipes — per menu item, the list of (ingredient, qty) needed to make one.
// -----------------------------------------------------------------------------

interface RecipeRow {
  id: string;
  menu_item_id: string;
  ingredient_id: string;
  qty_per_unit: number;
}

export interface RecipeWithIngredient extends Recipe {
  ingredientName: string;
  unit: string;
}

export function listRecipeForItem(
  db: AppDatabase,
  menuItemId: string,
): RecipeWithIngredient[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.menu_item_id, r.ingredient_id, r.qty_per_unit, i.name AS ingredient_name, i.unit
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id
        WHERE r.menu_item_id = ? AND r.deleted_at IS NULL AND i.deleted_at IS NULL
        ORDER BY i.name`,
    )
    .all(menuItemId) as Array<
    RecipeRow & { ingredient_name: string; unit: string }
  >;
  return rows.map((r) => ({
    id: r.id as Recipe['id'],
    menuItemId: r.menu_item_id as Recipe['menuItemId'],
    ingredientId: r.ingredient_id as Recipe['ingredientId'],
    qtyPerUnit: r.qty_per_unit,
    ingredientName: r.ingredient_name,
    unit: r.unit,
  }));
}

/** Replace the entire recipe for an item. One transaction. */
export function setRecipeForItem(
  db: AppDatabase,
  menuItemId: string,
  desired: Array<{ ingredientId: string; qtyPerUnit: number }>,
  actor: Actor,
): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id, ingredient_id FROM recipes WHERE menu_item_id = ? AND deleted_at IS NULL`,
      )
      .all(menuItemId) as Array<{ id: string; ingredient_id: string }>;
    const existingByIng = new Map(existing.map((r) => [r.ingredient_id, r]));
    const desiredByIng = new Map(desired.map((d) => [d.ingredientId, d]));

    // Soft-delete recipes whose ingredient is no longer desired
    for (const row of existing) {
      if (!desiredByIng.has(row.ingredient_id)) {
        db.prepare(
          `UPDATE recipes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(now, now, row.id);
        enqueueSync(db, {
          entityType: 'recipes',
          entityId: row.id,
          op: 'delete',
          payload: { id: row.id, deletedAt: now },
        });
      }
    }
    // Insert / update desired
    for (const want of desired) {
      const ex = existingByIng.get(want.ingredientId);
      if (ex) {
        db.prepare(
          `UPDATE recipes SET qty_per_unit = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(want.qtyPerUnit, now, ex.id);
        enqueueSync(db, {
          entityType: 'recipes',
          entityId: ex.id,
          op: 'upsert',
          payload: {
            id: ex.id,
            menuItemId,
            ingredientId: want.ingredientId,
            qtyPerUnit: want.qtyPerUnit,
          },
        });
      } else {
        const id = uuidv7();
        db.prepare(
          `INSERT INTO recipes
             (id, menu_item_id, ingredient_id, qty_per_unit, created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, menuItemId, want.ingredientId, want.qtyPerUnit, now, now, actor.deviceId);
        enqueueSync(db, {
          entityType: 'recipes',
          entityId: id,
          op: 'upsert',
          payload: {
            id,
            menuItemId,
            ingredientId: want.ingredientId,
            qtyPerUnit: want.qtyPerUnit,
          },
        });
      }
    }

    writeAudit(db, {
      entityType: 'recipes',
      entityId: menuItemId,
      action: 'set_recipe',
      actorUserId: actor.userId,
      before: existing.map((r) => ({ id: r.id, ingredientId: r.ingredient_id })),
      after: desired,
    });
  });
  tx();
}
