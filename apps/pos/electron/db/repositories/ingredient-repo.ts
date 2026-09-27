import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { clearBatchRecipeLines } from './batch-recipe-repo.js';
import { priceRowId, setIngredientPrice } from './ingredient-cost-repo.js';
import type { Ingredient, IngredientCategory, PriceKind, PriceSource, Recipe } from '@cheeseoclock/shared-types';
import {
  baseUnitConversion,
  convertPack,
  convertedStoredPrice,
  costPerUnitFromPack,
  guessIngredientCategory,
  isIngredientCategory,
  orderedPack,
  toPriceKind,
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
  /** Migration 0032: set / estimate / free / unset. */
  price_kind: string;
  batch_yield: number | null;
  batch_method: string | null;
  default_supplier_id: string | null;
  sku: string | null;
  notes: string | null;
  is_active: number;
}

const ING_SELECT = `
  id, name, category, unit, current_qty, low_threshold, cost_per_unit_cents,
  pack_size, pack_price_cents, price_kind, batch_yield, batch_method, default_supplier_id, sku, notes, is_active
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
    priceKind: toPriceKind(r.price_kind),
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
  /** Omitted = from the price: Rs 0 is 'unset' (not priced yet). */
  priceKind?: PriceKind;
  defaultSupplierId?: string | null;
  sku?: string | null;
  notes?: string | null;
}

/**
 * How a price written by create / update / Convert goes into the price
 * history (costing spec Phase 4): where it came from, and — for a row two
 * tills could each write for the same fact (the menu file) — the key its
 * name-based id is made from (ingredient-cost-repo priceRowId).
 */
export interface PriceMeta {
  /** Default 'manual' (typed on the ingredient form). */
  source?: PriceSource;
  /** Name-based history row id from this key; omitted = a new uuid v7. */
  rowKey?: string;
  /** Roll the new price up into the batches made from it (default yes). */
  cascade?: boolean;
}

function priceRowIdFor(ingredientId: string, meta: PriceMeta | undefined): string | undefined {
  return meta?.rowKey ? priceRowId(ingredientId, meta.rowKey) : undefined;
}

/**
 * Add an ingredient. Its row goes in without a price, then its price is
 * written through the one price path (setIngredientPrice: exact pack, price
 * kind, the first line of its price history), and then the whole new row is
 * synced and audited as the create — one transaction.
 */
export function createIngredient(
  db: AppDatabase,
  input: CreateIngredientInput,
  actor: Actor,
  price?: PriceMeta,
): Ingredient {
  const id = uuidv7();
  const now = nowIso();
  const storedCategory = input.category ?? null;
  return db.transaction((): Ingredient => {
    // No price columns here: an ingredient's price is written ONLY by
    // ingredient-cost-repo (the row starts at the columns' defaults).
    db.prepare(
      `INSERT INTO ingredients
         (id, name, category, unit, current_qty, low_threshold, default_supplier_id, sku, notes, is_active,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
    ).run(
      id,
      input.name,
      storedCategory,
      input.unit,
      input.currentQty ?? 0,
      input.lowThreshold ?? 0,
      input.defaultSupplierId ?? null,
      input.sku ?? null,
      input.notes ?? null,
      now,
      now,
      actor.deviceId,
    );
    setIngredientPrice(
      db,
      {
        ingredientId: id,
        price: {
          costPerUnitCents: input.costPerUnitCents ?? 0,
          packSize: input.packSize ?? null,
          packPriceCents: input.packPriceCents ?? null,
        },
        priceKind: input.priceKind,
        source: price?.source ?? 'manual',
      },
      actor,
      { first: true, id: priceRowIdFor(id, price) },
    );
    const ing = findIngredient(db, id)!;
    enqueueSync(db, { entityType: 'ingredients', entityId: id, op: 'upsert', payload: ing });
    writeAudit(db, { entityType: 'ingredients', entityId: id, action: 'create', actorUserId: actor.userId, before: null, after: ing });
    return ing;
  })();
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
  /** Omitted = kept, or worked out when the price changes (see withPriceKind). */
  priceKind?: PriceKind;
  defaultSupplierId?: string | null;
  sku?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

/**
 * Change an ingredient. Its name, shelf, low level, supplier and notes are
 * written here; a price that changes goes through the one price path
 * (setIngredientPrice: exact pack, price kind, a line in its price history,
 * batches made from it rolled up) — all in one transaction. Saving the form
 * with the price as it was writes no price at all.
 */
export function updateIngredient(
  db: AppDatabase,
  input: UpdateIngredientInput,
  actor: Actor,
  price?: PriceMeta,
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
  const after: Ingredient = {
    ...before,
    name,
    // A guessed category follows a rename; a chosen one stays.
    ...resolveCategory(storedCategory, name),
    lowThreshold: input.lowThreshold ?? before.lowThreshold,
    defaultSupplierId:
      input.defaultSupplierId !== undefined
        ? (input.defaultSupplierId as Ingredient['defaultSupplierId'])
        : before.defaultSupplierId,
    sku: input.sku !== undefined ? input.sku : before.sku,
    notes: input.notes !== undefined ? input.notes : before.notes,
    isActive: input.isActive ?? before.isActive,
  };
  const detailsChanged =
    after.name !== before.name ||
    storedCategory !== (isIngredientCategory(row.category) ? row.category : null) ||
    after.lowThreshold !== before.lowThreshold ||
    after.defaultSupplierId !== before.defaultSupplierId ||
    after.sku !== before.sku ||
    after.notes !== before.notes ||
    after.isActive !== before.isActive;
  const priceTouched =
    input.priceKind !== undefined ||
    input.costPerUnitCents !== undefined ||
    input.packSize !== undefined ||
    input.packPriceCents !== undefined;
  const now = nowIso();
  db.transaction(() => {
    if (detailsChanged) {
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
               name = ?, category = ?, low_threshold = ?,
               default_supplier_id = ?, sku = ?, notes = ?, is_active = ?,
               updated_at = ?, version = version + 1 WHERE id = ?`,
          ).run(
            after.name,
            storedCategory,
            after.lowThreshold,
            after.defaultSupplierId,
            after.sku,
            after.notes,
            fromBool(after.isActive),
            now,
            input.id,
          );
        },
      });
    }
    if (priceTouched) {
      // What is not sent stays as it was: a typed cost with the pack left in
      // place is still decided by the pack (the menu import clears the pack
      // when a per-unit cost is meant to count).
      setIngredientPrice(
        db,
        {
          ingredientId: input.id,
          price: {
            costPerUnitCents: input.costPerUnitCents ?? before.costPerUnitCents,
            packSize: input.packSize !== undefined ? input.packSize : before.packSize,
            packPriceCents: input.packPriceCents !== undefined ? input.packPriceCents : before.packPriceCents,
          },
          priceKind: input.priceKind,
          source: price?.source ?? 'manual',
        },
        actor,
        { id: priceRowIdFor(input.id, price), cascade: price?.cascade },
      );
    }
  })();
  return findIngredient(db, input.id)!;
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
 * low-stock level and batch yield x1000, and every recipe line, open
 * purchase order line and batch recipe line that uses it x1000 — the same
 * physical amounts, now in units a recipe can express ("300 g", which a
 * whole-number kg column cannot hold). The price is kept EXACTLY (costing
 * spec 4.1): the pack holds 1,000x as many units for the same money
 * ("Rs 375 per kg" becomes "1,000 g for Rs 375", never 38 paisa a gram), so
 * every value stays as it was, with a line in the price history saying so.
 * An open purchase order line keeps the price it was ordered at as an exact
 * pack (costing spec Phase 5, 0035): the pack holds 1,000x as many units for
 * the same money, so what the order owes stays exactly what it was (Rs 375.50
 * a kg is 1,000 g for Rs 375.50, never 38 paisa a gram); a line from before
 * that is priced (1, its price per unit) and becomes a pack the same way.
 * One transaction; the ingredient and each row it touches sync and audit.
 */
export function convertIngredientToBaseUnit(
  db: AppDatabase,
  id: string,
  actor: Actor,
  opts: { priceRowKey?: string } = {},
): Ingredient {
  const row = db
    .prepare(`SELECT ${ING_SELECT} FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as IngRow | undefined;
  if (!row) throw new Error('Ingredient not found');
  const before = rowToIngredient(row);
  const conv = baseUnitConversion(before.unit);
  if (!conv) throw new Error(`"${before.name}" is already counted in ${before.unit}`);
  const f = conv.factor;
  const price = convertedStoredPrice(before, f);
  const after: Ingredient = {
    ...before,
    ...price,
    unit: conv.unit,
    currentQty: before.currentQty * f,
    lowThreshold: before.lowThreshold * f,
    batchYield: before.batchYield !== null ? before.batchYield * f : null,
  };
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ingredients SET unit = ?, current_qty = ?, low_threshold = ?, batch_yield = ?,
              updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(after.unit, after.currentQty, after.lowThreshold, after.batchYield, now, id);
    // The same price in the new unit: the one price path, with its history
    // line ('convert'). Nothing to roll up: no value changes.
    setIngredientPrice(
      db,
      { ingredientId: id, price, priceKind: price.priceKind, source: 'convert', notes: `Counted in ${after.unit} instead of ${before.unit}` },
      actor,
      { force: true, cascade: false, previousUnit: before.unit, id: opts.priceRowKey ? priceRowId(id, opts.priceRowKey) : undefined },
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
        `SELECT poi.id, poi.purchase_order_id, poi.qty_ordered, poi.qty_received, poi.unit_cost_cents,
                poi.ordered_pack_size, poi.ordered_pack_price_cents
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
      ordered_pack_size: number | null;
      ordered_pack_price_cents: number | null;
    }>;
    for (const line of poLines) {
      // The ordered pack holds f× as many units for the same money, so the
      // line total (what is owed) stays exactly as it is. The price per unit
      // in whole paisa is only for older screens.
      const pack = convertPack(
        orderedPack({
          orderedPackSize: line.ordered_pack_size === null ? null : Number(line.ordered_pack_size),
          orderedPackPriceCents: line.ordered_pack_price_cents === null ? null : Number(line.ordered_pack_price_cents),
          unitCostCents: Number(line.unit_cost_cents),
        }),
        f,
      );
      const next = {
        qtyOrdered: line.qty_ordered * f,
        qtyReceived: line.qty_received * f,
        unitCostCents: costPerUnitFromPack(pack.priceCents, pack.size),
        orderedPackSize: pack.size,
        orderedPackPriceCents: pack.priceCents,
      };
      db.prepare(
        `UPDATE purchase_order_items SET qty_ordered = ?, qty_received = ?, unit_cost_cents = ?,
                ordered_pack_size = ?, ordered_pack_price_cents = ?,
                updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(next.qtyOrdered, next.qtyReceived, next.unitCostCents, next.orderedPackSize, next.orderedPackPriceCents, now, line.id);
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
          orderedPackSize: line.ordered_pack_size,
          orderedPackPriceCents: line.ordered_pack_price_cents,
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
