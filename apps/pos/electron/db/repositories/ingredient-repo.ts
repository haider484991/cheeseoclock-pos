import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { clearBatchRecipeLines } from './batch-recipe-repo.js';
import type { Ingredient, IngredientCategory, Recipe } from '@cheeseoclock/shared-types';
import {
  baseUnitConversion,
  costPerUnitFromPack,
  guessIngredientCategory,
  isIngredientCategory,
} from '@cheeseoclock/pos-domain';

// -----------------------------------------------------------------------------
// Ingredients
// -----------------------------------------------------------------------------

interface IngRow {
  id: string;
  name: string;
  /** NULL = not chosen yet; guessed from the name on every read (migration 0024). */
  category: string | null;
  unit: string;
  current_qty: number;
  low_threshold: number;
  cost_per_unit_cents: number;
  pack_size: number | null;
  pack_price_cents: number | null;
  batch_yield: number | null;
  batch_method: string | null;
  default_supplier_id: string | null;
  sku: string | null;
  notes: string | null;
  is_active: number;
}

const ING_SELECT = `
  id, name, category, unit, current_qty, low_threshold, cost_per_unit_cents,
  pack_size, pack_price_cents, batch_yield, batch_method, default_supplier_id, sku, notes, is_active
`;

/** The stored choice when there is a valid one, else the guess from the name. */
function resolveCategory(stored: string | null, name: string): { category: IngredientCategory; categoryAuto: boolean } {
  return isIngredientCategory(stored)
    ? { category: stored, categoryAuto: false }
    : { category: guessIngredientCategory(name), categoryAuto: true };
}

function rowToIngredient(r: IngRow): Ingredient {
  return {
    id: r.id as Ingredient['id'],
    name: r.name,
    ...resolveCategory(r.category, r.name),
    unit: r.unit,
    currentQty: r.current_qty,
    lowThreshold: r.low_threshold,
    costPerUnitCents: r.cost_per_unit_cents,
    packSize: r.pack_size,
    packPriceCents: r.pack_price_cents,
    batchYield: r.batch_yield,
    batchMethod: r.batch_method,
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
  /** Omitted or null = guessed from the name (the menu import leaves it out). */
  category?: IngredientCategory | null;
  unit: string;
  currentQty?: number;
  lowThreshold?: number;
  costPerUnitCents?: number;
  packSize?: number | null;
  packPriceCents?: number | null;
  defaultSupplierId?: string | null;
  sku?: string | null;
  notes?: string | null;
}

/**
 * A pack price, when there is one, decides the per-unit cost — the two can
 * never disagree. Half a pack (size without price) is treated as no pack.
 */
function withPackCost<T extends { packSize: number | null; packPriceCents: number | null; costPerUnitCents: number }>(
  ing: T,
): T {
  if (ing.packSize && ing.packSize > 0 && ing.packPriceCents !== null) {
    return { ...ing, costPerUnitCents: costPerUnitFromPack(ing.packPriceCents, ing.packSize) };
  }
  return { ...ing, packSize: null, packPriceCents: null };
}

export function createIngredient(
  db: AppDatabase,
  input: CreateIngredientInput,
  actor: Actor,
): Ingredient {
  const id = uuidv7();
  const now = nowIso();
  const storedCategory = input.category ?? null;
  const ing: Ingredient = withPackCost({
    id: id as Ingredient['id'],
    name: input.name,
    ...resolveCategory(storedCategory, input.name),
    unit: input.unit,
    currentQty: input.currentQty ?? 0,
    lowThreshold: input.lowThreshold ?? 0,
    costPerUnitCents: input.costPerUnitCents ?? 0,
    packSize: input.packSize ?? null,
    packPriceCents: input.packPriceCents ?? null,
    batchYield: null,
    batchMethod: null,
    defaultSupplierId: (input.defaultSupplierId ?? null) as Ingredient['defaultSupplierId'],
    sku: input.sku ?? null,
    notes: input.notes ?? null,
    isActive: true,
  });
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
           (id, name, category, unit, current_qty, low_threshold, cost_per_unit_cents,
            pack_size, pack_price_cents, default_supplier_id, sku, notes, is_active,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      ).run(
        id,
        ing.name,
        storedCategory,
        ing.unit,
        ing.currentQty,
        ing.lowThreshold,
        ing.costPerUnitCents,
        ing.packSize,
        ing.packPriceCents,
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
  /** null = back to "guess from the name"; omitted = unchanged. */
  category?: IngredientCategory | null;
  unit?: string;
  lowThreshold?: number;
  costPerUnitCents?: number;
  packSize?: number | null;
  packPriceCents?: number | null;
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
  // A unit is not a label: stock, recipes, batches and costs are all counted
  // in it. Re-labelling kg as g here turned 5 kg of stock into 5 g and left
  // every recipe and cost 1000x off (audit 2026-09-25) — the Convert button
  // scales everything instead.
  if (input.unit !== undefined && input.unit !== before.unit) {
    throw new Error(`Use Convert to change ${before.name} from ${before.unit} — it rescales stock, recipes and costs`);
  }
  const name = input.name ?? before.name;
  const storedCategory = input.category !== undefined ? input.category : isIngredientCategory(row.category) ? row.category : null;
  const after: Ingredient = withPackCost({
    ...before,
    name,
    // A guessed category follows a rename; a chosen one stays.
    ...resolveCategory(storedCategory, name),
    unit: input.unit ?? before.unit,
    lowThreshold: input.lowThreshold ?? before.lowThreshold,
    costPerUnitCents: input.costPerUnitCents ?? before.costPerUnitCents,
    packSize: input.packSize !== undefined ? input.packSize : before.packSize,
    packPriceCents: input.packPriceCents !== undefined ? input.packPriceCents : before.packPriceCents,
    defaultSupplierId:
      input.defaultSupplierId !== undefined
        ? (input.defaultSupplierId as Ingredient['defaultSupplierId'])
        : before.defaultSupplierId,
    sku: input.sku !== undefined ? input.sku : before.sku,
    notes: input.notes !== undefined ? input.notes : before.notes,
    isActive: input.isActive ?? before.isActive,
  });
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
           name = ?, category = ?, unit = ?, low_threshold = ?, cost_per_unit_cents = ?,
           pack_size = ?, pack_price_cents = ?,
           default_supplier_id = ?, sku = ?, notes = ?, is_active = ?,
           updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(
        after.name,
        storedCategory,
        after.unit,
        after.lowThreshold,
        after.costPerUnitCents,
        after.packSize,
        after.packPriceCents,
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
  const batchUsage = db
    .prepare(`SELECT COUNT(*) AS n FROM batch_recipe_lines WHERE input_ingredient_id = ? AND deleted_at IS NULL`)
    .get(id) as { n: number };
  if (batchUsage.n > 0) {
    throw new Error(`Ingredient is used in ${batchUsage.n} batch recipes — remove it from them first`);
  }
  const now = nowIso();
  // Its own batch recipe goes with it, in one transaction with the delete.
  db.transaction(() => {
    clearBatchRecipeLines(db, id, actor);
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
  })();
}

/**
 * Switch an ingredient counted in kg (or litres) to grams (or ml): stock,
 * low-stock level and pack size x1000, cost per unit /1000, and every recipe
 * line that uses it x1000 — the same physical amounts, now in units a recipe
 * can express ("300 g", which a whole-number kg column cannot hold).
 * One transaction; the ingredient and each recipe row sync and audit.
 */
export function convertIngredientToBaseUnit(db: AppDatabase, id: string, actor: Actor): Ingredient {
  const row = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as IngRow | undefined;
  if (!row) throw new Error('Ingredient not found');
  const before = rowToIngredient(row);
  const conv = baseUnitConversion(before.unit);
  if (!conv) throw new Error(`"${before.name}" is already counted in ${before.unit}`);
  const f = conv.factor;
  const after: Ingredient = withPackCost({
    ...before,
    unit: conv.unit,
    currentQty: before.currentQty * f,
    lowThreshold: before.lowThreshold * f,
    costPerUnitCents: Math.round(before.costPerUnitCents / f),
    packSize: before.packSize !== null ? before.packSize * f : null,
    batchYield: before.batchYield !== null ? before.batchYield * f : null,
  });
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ingredients SET unit = ?, current_qty = ?, low_threshold = ?, cost_per_unit_cents = ?,
              pack_size = ?, pack_price_cents = ?, batch_yield = ?, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(
      after.unit,
      after.currentQty,
      after.lowThreshold,
      after.costPerUnitCents,
      after.packSize,
      after.packPriceCents,
      after.batchYield,
      now,
      id,
    );
    enqueueSync(db, { entityType: 'ingredients', entityId: id, op: 'upsert', payload: after });
    writeAudit(db, {
      entityType: 'ingredients',
      entityId: id,
      action: 'convert_unit',
      actorUserId: actor.userId,
      before,
      after,
    });

    const lines = db
      .prepare(
        `SELECT id, menu_item_id, qty_per_unit FROM recipes WHERE ingredient_id = ? AND deleted_at IS NULL`,
      )
      .all(id) as Array<{ id: string; menu_item_id: string; qty_per_unit: number }>;
    for (const line of lines) {
      const qty = line.qty_per_unit * f;
      db.prepare(
        `UPDATE recipes SET qty_per_unit = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(qty, now, line.id);
      enqueueSync(db, {
        entityType: 'recipes',
        entityId: line.id,
        op: 'upsert',
        payload: { id: line.id, menuItemId: line.menu_item_id, ingredientId: id, qtyPerUnit: qty },
      });
      writeAudit(db, {
        entityType: 'recipes',
        entityId: line.id,
        action: 'convert_unit',
        actorUserId: actor.userId,
        before: { qtyPerUnit: line.qty_per_unit, unit: before.unit },
        after: { qtyPerUnit: qty, unit: after.unit },
      });
    }

    // …every purchase order still to be received: 5 "kg" on order would
    // otherwise arrive as 5 g.
    const poLines = db
      .prepare(
        `SELECT poi.id, poi.purchase_order_id, poi.qty_ordered, poi.qty_received, poi.unit_cost_cents
           FROM purchase_order_items poi
           JOIN purchase_orders po ON po.id = poi.purchase_order_id
          WHERE poi.ingredient_id = ? AND poi.deleted_at IS NULL AND po.deleted_at IS NULL
            AND po.status IN ('draft', 'ordered', 'partial')`,
      )
      .all(id) as Array<{
      id: string;
      purchase_order_id: string;
      qty_ordered: number;
      qty_received: number;
      unit_cost_cents: number;
    }>;
    for (const line of poLines) {
      const next = {
        qtyOrdered: line.qty_ordered * f,
        qtyReceived: line.qty_received * f,
        // The line total (what is owed) stays as it is; only the per-unit price moves.
        unitCostCents: Math.round(line.unit_cost_cents / f),
      };
      db.prepare(
        `UPDATE purchase_order_items SET qty_ordered = ?, qty_received = ?, unit_cost_cents = ?,
                updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(next.qtyOrdered, next.qtyReceived, next.unitCostCents, now, line.id);
      enqueueSync(db, {
        entityType: 'purchase_order_items',
        entityId: line.id,
        op: 'upsert',
        payload: { id: line.id, purchaseOrderId: line.purchase_order_id, ingredientId: id, ...next },
      });
      writeAudit(db, {
        entityType: 'purchase_order_items',
        entityId: line.id,
        action: 'convert_unit',
        actorUserId: actor.userId,
        before: {
          qtyOrdered: line.qty_ordered,
          qtyReceived: line.qty_received,
          unitCostCents: line.unit_cost_cents,
          unit: before.unit,
        },
        after: { ...next, unit: after.unit },
      });
    }

    // …and every batch recipe that uses it as an input.
    const inputs = db
      .prepare(
        `SELECT id, ingredient_id, qty FROM batch_recipe_lines WHERE input_ingredient_id = ? AND deleted_at IS NULL`,
      )
      .all(id) as Array<{ id: string; ingredient_id: string; qty: number }>;
    for (const line of inputs) {
      const qty = line.qty * f;
      db.prepare(`UPDATE batch_recipe_lines SET qty = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
        qty,
        now,
        line.id,
      );
      enqueueSync(db, {
        entityType: 'batch_recipe_lines',
        entityId: line.id,
        op: 'upsert',
        payload: { id: line.id, ingredientId: line.ingredient_id, inputIngredientId: id, qty },
      });
      writeAudit(db, {
        entityType: 'batch_recipe_lines',
        entityId: line.id,
        action: 'convert_unit',
        actorUserId: actor.userId,
        before: { qty: line.qty, unit: before.unit },
        after: { qty, unit: after.unit },
      });
    }
  });
  tx();
  return after;
}

// -----------------------------------------------------------------------------
// Recipes — per menu item, the list of (ingredient, qty) needed to make one.
// -----------------------------------------------------------------------------

interface RecipeRow {
  id: string;
  menu_item_id: string;
  ingredient_id: string;
  qty_per_unit: number;
  modifier_id: string | null;
}

export interface RecipeWithIngredient extends Recipe {
  ingredientName: string;
  unit: string;
  /** The choice this line depends on, or null for lines used on every sale. */
  modifierName: string | null;
}

export function listRecipeForItem(
  db: AppDatabase,
  menuItemId: string,
): RecipeWithIngredient[] {
  // A line tied to a choice that has since been deleted can never apply; leave it out.
  const rows = db
    .prepare(
      `SELECT r.id, r.menu_item_id, r.ingredient_id, r.qty_per_unit, r.modifier_id,
              i.name AS ingredient_name, i.unit, m.name AS modifier_name
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id
         LEFT JOIN modifiers m ON m.id = r.modifier_id AND m.deleted_at IS NULL
        WHERE r.menu_item_id = ? AND r.deleted_at IS NULL AND i.deleted_at IS NULL
          AND (r.modifier_id IS NULL OR m.id IS NOT NULL)
        ORDER BY r.modifier_id IS NOT NULL, m.sort_order, m.name, i.name`,
    )
    .all(menuItemId) as Array<
    RecipeRow & { ingredient_name: string; unit: string; modifier_name: string | null }
  >;
  return rows.map((r) => ({
    id: r.id as Recipe['id'],
    menuItemId: r.menu_item_id as Recipe['menuItemId'],
    ingredientId: r.ingredient_id as Recipe['ingredientId'],
    qtyPerUnit: r.qty_per_unit,
    modifierId: r.modifier_id as Recipe['modifierId'],
    ingredientName: r.ingredient_name,
    unit: r.unit,
    modifierName: r.modifier_name,
  }));
}

/**
 * Recipe lines per menu item, counted the way `listRecipeForItem` lists them
 * (live ingredient, live choice), so the Recipes screen can say "no recipe"
 * without asking for every item's recipe one by one.
 */
export function listRecipeLineCounts(db: AppDatabase): Array<{ menuItemId: string; lineCount: number }> {
  const rows = db
    .prepare(
      `SELECT r.menu_item_id, COUNT(*) AS n
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
         LEFT JOIN modifiers m ON m.id = r.modifier_id AND m.deleted_at IS NULL
        WHERE r.deleted_at IS NULL AND (r.modifier_id IS NULL OR m.id IS NOT NULL)
        GROUP BY r.menu_item_id`,
    )
    .all() as Array<{ menu_item_id: string; n: number }>;
  return rows.map((r) => ({ menuItemId: r.menu_item_id, lineCount: r.n }));
}

/** Replace the entire recipe for an item. One transaction. */
export function setRecipeForItem(
  db: AppDatabase,
  menuItemId: string,
  desired: Array<{ ingredientId: string; qtyPerUnit: number; modifierId?: string | null }>,
  actor: Actor,
): void {
  const now = nowIso();
  const lineKey = (ingredientId: string, modifierId: string | null | undefined) => `${ingredientId}|${modifierId ?? ''}`;
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id, ingredient_id, modifier_id FROM recipes WHERE menu_item_id = ? AND deleted_at IS NULL`,
      )
      .all(menuItemId) as Array<{ id: string; ingredient_id: string; modifier_id: string | null }>;
    const existingByIng = new Map(existing.map((r) => [lineKey(r.ingredient_id, r.modifier_id), r]));
    const desiredByIng = new Map(desired.map((d) => [lineKey(d.ingredientId, d.modifierId), d]));
    if (desiredByIng.size !== desired.length) throw new Error('The same ingredient is listed twice for the same choice');
    for (const d of desired) {
      if (!d.modifierId) continue;
      const mod = db.prepare(`SELECT 1 FROM modifiers WHERE id = ? AND deleted_at IS NULL`).get(d.modifierId);
      if (!mod) throw new Error('A recipe line points at a choice that does not exist');
    }

    // Soft-delete recipes whose ingredient is no longer desired
    for (const row of existing) {
      if (!desiredByIng.has(lineKey(row.ingredient_id, row.modifier_id))) {
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
      const modifierId = want.modifierId ?? null;
      const ex = existingByIng.get(lineKey(want.ingredientId, modifierId));
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
            modifierId,
          },
        });
      } else {
        const id = uuidv7();
        db.prepare(
          `INSERT INTO recipes
             (id, menu_item_id, ingredient_id, qty_per_unit, modifier_id, created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, menuItemId, want.ingredientId, want.qtyPerUnit, modifierId, now, now, actor.deviceId);
        enqueueSync(db, {
          entityType: 'recipes',
          entityId: id,
          op: 'upsert',
          payload: {
            id,
            menuItemId,
            ingredientId: want.ingredientId,
            qtyPerUnit: want.qtyPerUnit,
            modifierId,
          },
        });
      }
    }

    writeAudit(db, {
      entityType: 'recipes',
      entityId: menuItemId,
      action: 'set_recipe',
      actorUserId: actor.userId,
      before: existing.map((r) => ({ id: r.id, ingredientId: r.ingredient_id, modifierId: r.modifier_id })),
      after: desired,
    });
  });
  tx();
}
