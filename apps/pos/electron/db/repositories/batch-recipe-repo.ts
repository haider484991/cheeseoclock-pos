import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordStockMovement } from './stock-movement-repo.js';
import type { BatchRecipe, BatchRecipeLine } from '@cheeseoclock/shared-types';

/**
 * Batch recipes: what the kitchen makes itself (sauces, dough, cheese mix).
 * One batch of an ingredient uses the listed inputs and yields
 * `ingredients.batch_yield` units of it. Inputs may be made in-house too.
 */

export function getBatchRecipe(db: AppDatabase, ingredientId: string): BatchRecipe {
  const ing = db
    .prepare(`SELECT id, batch_yield, batch_method FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(ingredientId) as { id: string; batch_yield: number | null; batch_method: string | null } | undefined;
  if (!ing) throw new Error('Ingredient not found');
  const rows = db
    .prepare(
      `SELECT l.input_ingredient_id, l.qty, i.name, i.unit, i.cost_per_unit_cents,
              i.pack_size, i.pack_price_cents
         FROM batch_recipe_lines l
         JOIN ingredients i ON i.id = l.input_ingredient_id AND i.deleted_at IS NULL
        WHERE l.ingredient_id = ? AND l.deleted_at IS NULL
        ORDER BY l.sort_order, i.name`,
    )
    .all(ingredientId) as Array<{
    input_ingredient_id: string;
    qty: number;
    name: string;
    unit: string;
    cost_per_unit_cents: number;
    pack_size: number | null;
    pack_price_cents: number | null;
  }>;
  const lines: BatchRecipeLine[] = rows.map((r) => ({
    inputIngredientId: r.input_ingredient_id as BatchRecipeLine['inputIngredientId'],
    name: r.name,
    unit: r.unit,
    qty: r.qty,
    costPerUnitCents: r.cost_per_unit_cents,
  }));
  // Cost from the pack price where there is one: the per-unit cost is rounded to
  // whole paisa (Rs 1.005/ml shows as 1.01), which over a 2 kg batch adds up to rupees.
  const exact = rows.reduce(
    (n, r) =>
      n + r.qty * (r.pack_size && r.pack_price_cents !== null ? r.pack_price_cents / r.pack_size : r.cost_per_unit_cents),
    0,
  );
  return {
    ingredientId: ing.id as BatchRecipe['ingredientId'],
    batchYield: ing.batch_yield,
    batchMethod: ing.batch_method,
    lines,
    batchCostCents: Math.round(exact),
  };
}

/** Would making `inputId` part of `ingredientId`'s batch create a loop (A needs B needs A)? */
function wouldLoop(db: AppDatabase, ingredientId: string, inputId: string): boolean {
  const seen = new Set<string>();
  const stack = [inputId];
  const inputsOf = db.prepare(
    `SELECT input_ingredient_id FROM batch_recipe_lines WHERE ingredient_id = ? AND deleted_at IS NULL`,
  );
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ingredientId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of inputsOf.all(cur) as Array<{ input_ingredient_id: string }>) stack.push(r.input_ingredient_id);
  }
  return false;
}

/**
 * Replace an ingredient's batch recipe (inputs, yield, method). An empty
 * recipe with no yield marks it as bought in again. One transaction; every
 * line and the ingredient sync and audit.
 */
export function setBatchRecipe(
  db: AppDatabase,
  input: {
    ingredientId: string;
    batchYield: number | null;
    batchMethod?: string | null;
    lines: Array<{ inputIngredientId: string; qty: number }>;
  },
  actor: Actor,
): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const ing = db
      .prepare(`SELECT batch_yield, batch_method FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
      .get(input.ingredientId) as { batch_yield: number | null; batch_method: string | null } | undefined;
    if (!ing) throw new Error('Ingredient not found');
    if (input.lines.length > 0 && !input.batchYield) throw new Error('Say how much one batch makes');
    if (input.batchYield && input.lines.length === 0) {
      throw new Error('Add at least one ingredient the batch uses');
    }
    const seenInputs = new Set<string>();
    for (const l of input.lines) {
      if (seenInputs.has(l.inputIngredientId)) throw new Error('The same input is listed twice');
      seenInputs.add(l.inputIngredientId);
      const exists = db.prepare(`SELECT 1 FROM ingredients WHERE id = ? AND deleted_at IS NULL`).get(l.inputIngredientId);
      if (!exists) throw new Error('A batch input does not exist');
      if (l.inputIngredientId === input.ingredientId || wouldLoop(db, input.ingredientId, l.inputIngredientId)) {
        throw new Error('A batch cannot use itself, directly or through another batch');
      }
    }

    const method = input.batchMethod !== undefined ? input.batchMethod : ing.batch_method;
    db.prepare(
      `UPDATE ingredients SET batch_yield = ?, batch_method = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(input.batchYield, method, now, input.ingredientId);
    enqueueSync(db, {
      entityType: 'ingredients',
      entityId: input.ingredientId,
      op: 'upsert',
      payload: { id: input.ingredientId, batchYield: input.batchYield, batchMethod: method },
    });

    const existing = db
      .prepare(
        `SELECT id, input_ingredient_id, qty FROM batch_recipe_lines WHERE ingredient_id = ? AND deleted_at IS NULL`,
      )
      .all(input.ingredientId) as Array<{ id: string; input_ingredient_id: string; qty: number }>;
    const existingByInput = new Map(existing.map((r) => [r.input_ingredient_id, r]));
    const wanted = new Set(input.lines.map((l) => l.inputIngredientId));
    for (const row of existing) {
      if (wanted.has(row.input_ingredient_id)) continue;
      db.prepare(`UPDATE batch_recipe_lines SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
        now,
        now,
        row.id,
      );
      enqueueSync(db, { entityType: 'batch_recipe_lines', entityId: row.id, op: 'delete', payload: { id: row.id, deletedAt: now } });
    }
    input.lines.forEach((l, sortOrder) => {
      const ex = existingByInput.get(l.inputIngredientId);
      const id = ex?.id ?? uuidv7();
      if (ex) {
        db.prepare(
          `UPDATE batch_recipe_lines SET qty = ?, sort_order = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(l.qty, sortOrder, now, id);
      } else {
        db.prepare(
          `INSERT INTO batch_recipe_lines
             (id, ingredient_id, input_ingredient_id, qty, sort_order, created_at, updated_at, device_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(id, input.ingredientId, l.inputIngredientId, l.qty, sortOrder, now, now, actor.deviceId);
      }
      enqueueSync(db, {
        entityType: 'batch_recipe_lines',
        entityId: id,
        op: 'upsert',
        payload: { id, ingredientId: input.ingredientId, inputIngredientId: l.inputIngredientId, qty: l.qty, sortOrder },
      });
    });

    writeAudit(db, {
      entityType: 'batch_recipe_lines',
      entityId: input.ingredientId,
      action: 'set_batch_recipe',
      actorUserId: actor.userId,
      before: {
        batchYield: ing.batch_yield,
        lines: existing.map((r) => ({ inputIngredientId: r.input_ingredient_id, qty: r.qty })),
      },
      after: { batchYield: input.batchYield, lines: input.lines },
    });
  });
  tx();
}

/**
 * Remove an ingredient's batch recipe lines — used when the ingredient itself
 * is deleted (its recipe would otherwise keep its inputs "in use" for ever).
 * Runs inside the caller's transaction when there is one.
 */
export function clearBatchRecipeLines(db: AppDatabase, ingredientId: string, actor: Actor): number {
  const rows = db
    .prepare(`SELECT id, input_ingredient_id, qty FROM batch_recipe_lines WHERE ingredient_id = ? AND deleted_at IS NULL`)
    .all(ingredientId) as Array<{ id: string; input_ingredient_id: string; qty: number }>;
  if (rows.length === 0) return 0;
  const now = nowIso();
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`UPDATE batch_recipe_lines SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
        now,
        now,
        r.id,
      );
      enqueueSync(db, { entityType: 'batch_recipe_lines', entityId: r.id, op: 'delete', payload: { id: r.id, deletedAt: now } });
    }
    writeAudit(db, {
      entityType: 'batch_recipe_lines',
      entityId: ingredientId,
      action: 'clear_batch_recipe',
      actorUserId: actor.userId,
      before: { lines: rows.map((r) => ({ inputIngredientId: r.input_ingredient_id, qty: r.qty })) },
      after: { lines: [] },
    });
  })();
  return rows.length;
}

/**
 * Record `batches` batches made: each input comes out of stock, the yield
 * goes in — ordinary stock movements (reason 'adjustment', noted), in one
 * transaction.
 */
export function makeBatch(
  db: AppDatabase,
  input: { ingredientId: string; batches: number },
  actor: Actor,
): { made: number; resultingQty: number } {
  const recipe = getBatchRecipe(db, input.ingredientId);
  if (!recipe.batchYield || recipe.lines.length === 0) throw new Error('This ingredient has no batch recipe');
  const name = (db.prepare(`SELECT name FROM ingredients WHERE id = ?`).get(input.ingredientId) as { name: string }).name;
  const n = input.batches;
  let resultingQty = 0;
  const tx = db.transaction(() => {
    for (const l of recipe.lines) {
      recordStockMovement(
        db,
        {
          ingredientId: l.inputIngredientId,
          deltaQty: -l.qty * n,
          reason: 'adjustment',
          notes: `Used in ${n} batch${n === 1 ? '' : 'es'} of ${name}`,
        },
        actor,
      );
    }
    resultingQty = recordStockMovement(
      db,
      {
        ingredientId: input.ingredientId,
        deltaQty: recipe.batchYield! * n,
        reason: 'adjustment',
        notes: `Made ${n} batch${n === 1 ? '' : 'es'}`,
      },
      actor,
    ).resultingQty;
  });
  tx();
  return { made: recipe.batchYield * n, resultingQty };
}
