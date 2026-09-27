import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordStockMovement } from './stock-movement-repo.js';
import { loadPriceBook } from '../price-book.js';
import type { BatchRecipe, BatchRecipeLine } from '@cheeseoclock/shared-types';
import {
  MAX_BATCHES_AT_ONCE,
  batchesText,
  effectivePack,
  hasPrice,
  maxBatchAmount,
  scaleBatch,
  toPriceKind,
  valueCents,
} from '@cheeseoclock/pos-domain';

/**
 * Batch recipes: what the kitchen makes itself (sauces, dough, cheese mix).
 * One batch of an ingredient uses the listed inputs and yields
 * `ingredients.batch_yield` units of it. Inputs may be made in-house too.
 */

export function getBatchRecipe(db: AppDatabase, ingredientId: string): BatchRecipe {
  const ing = db
    .prepare(
      `SELECT id, batch_yield, batch_method, cost_per_unit_cents, pack_size, pack_price_cents, price_kind
         FROM ingredients WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(ingredientId) as
    | {
        id: string;
        batch_yield: number | null;
        batch_method: string | null;
        cost_per_unit_cents: number;
        pack_size: number | null;
        pack_price_cents: number | null;
        price_kind: string;
      }
    | undefined;
  if (!ing) throw new Error('Ingredient not found');
  const rows = batchInputs(db, ingredientId);
  // Prices as costing uses them: rolled up through inputs made in-house too,
  // from the exact pack ("6,000 g for Rs 2,250"), never a per-gram price
  // rounded to whole paisa (costing spec 4.1).
  const book = loadPriceBook(db);
  const lines: BatchRecipeLine[] = rows.map((r) => {
    const p = book.prices.get(r.input_ingredient_id);
    return {
      inputIngredientId: r.input_ingredient_id as BatchRecipeLine['inputIngredientId'],
      name: r.name,
      unit: r.unit,
      qty: r.qty,
      costPerUnitCents: r.cost_per_unit_cents,
      priceKind: p?.kind ?? 'unset',
      madeInHouse: !!p?.batch,
    };
  });
  const rolled = book.prices.get(ingredientId)?.batch ?? null;
  const nameOf = (id: string) => book.ingredients.get(id)?.name ?? 'an ingredient that was deleted';
  const stored = { costPerUnitCents: ing.cost_per_unit_cents, packSize: ing.pack_size, packPriceCents: ing.pack_price_cents };
  return {
    ingredientId: ing.id as BatchRecipe['ingredientId'],
    batchYield: ing.batch_yield,
    batchMethod: ing.batch_method,
    lines,
    batchCostCents: rolled ? rolled.rolledCostCents : 0,
    complete: rolled ? rolled.complete : false,
    unpricedInputs: rolled ? rolled.unpricedInputIds.map(nameOf) : [],
    storedBatchCostCents:
      ing.batch_yield && toPriceKind(ing.price_kind) !== 'unset' && hasPrice(stored)
        ? valueCents(ing.batch_yield, effectivePack(stored))
        : null,
  };
}

/** A batch recipe's inputs (live ones), in the recipe's order. */
function batchInputs(db: AppDatabase, ingredientId: string) {
  return db
    .prepare(
      `SELECT l.input_ingredient_id, l.qty, i.name, i.unit, i.cost_per_unit_cents
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
  }>;
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

const qtyText = (n: number) => new Intl.NumberFormat('en-PK').format(n);

/**
 * Record a batch made: each input comes out of stock and what was made goes
 * in — ordinary stock movements (reason 'adjustment', noted), in one
 * transaction, with one audit row saying what was made from what.
 *
 *  - `batches`: whole batches, as before ("Make a batch" × n).
 *  - `amount`: ANY amount of the batch item in its base unit (200 g of a
 *    2,000 g sauce). Every input is scaled by amount ÷ yield and rounded to
 *    the whole grams / ml / pieces stock is counted in (pos-domain
 *    scaleBatch — the same figures the batch calculator showed); an input
 *    that rounds to nothing is not taken.
 *
 * The answer carries no costs: any login may record a batch.
 */
export function makeBatch(
  db: AppDatabase,
  input: { ingredientId: string; batches?: number; amount?: number },
  actor: Actor,
): { made: number; resultingQty: number } {
  const ing = db
    .prepare(`SELECT name, unit, batch_yield, current_qty FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(input.ingredientId) as { name: string; unit: string; batch_yield: number | null; current_qty: number } | undefined;
  if (!ing) throw new Error('Ingredient not found');
  const inputs = batchInputs(db, input.ingredientId);
  if (!ing.batch_yield || inputs.length === 0) throw new Error('This ingredient has no batch recipe');
  const batchYield = ing.batch_yield;
  if ((input.batches === undefined) === (input.amount === undefined)) {
    throw new Error('Say how many batches, or how much to make');
  }
  const whole = input.batches !== undefined;
  const n = input.batches ?? 0;
  const amount = whole ? batchYield * n : input.amount!;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Make at least 1');
  if (amount > maxBatchAmount(batchYield)) {
    throw new Error(`That is more than ${MAX_BATCHES_AT_ONCE} batches: at most ${qtyText(maxBatchAmount(batchYield))} ${ing.unit} at once`);
  }
  const scaled = scaleBatch(
    batchYield,
    inputs.map((l) => ({ inputId: l.input_ingredient_id, qty: l.qty, pack: null, kind: 'missing' as const })),
    amount,
  );
  const madeText = `${qtyText(amount)} ${ing.unit}`;
  const usedNote = whole
    ? `Used in ${n} batch${n === 1 ? '' : 'es'} of ${ing.name}`
    : `Used to make ${madeText} of ${ing.name} (${batchesText(amount, batchYield)})`;
  const madeNote = whole
    ? `Made ${n} batch${n === 1 ? '' : 'es'}`
    : `Made ${madeText} (${batchesText(amount, batchYield)}; one batch makes ${qtyText(batchYield)} ${ing.unit})`;

  let resultingQty = 0;
  const tx = db.transaction(() => {
    const taken: Array<{ ingredientId: string; qty: number }> = [];
    for (const l of scaled.lines) {
      if (l.stockQty === 0) continue;
      recordStockMovement(
        db,
        { ingredientId: l.inputId, deltaQty: -l.stockQty, reason: 'adjustment', notes: usedNote },
        actor,
      );
      taken.push({ ingredientId: l.inputId, qty: l.stockQty });
    }
    resultingQty = recordStockMovement(
      db,
      { ingredientId: input.ingredientId, deltaQty: amount, reason: 'adjustment', notes: madeNote },
      actor,
    ).resultingQty;
    writeAudit(db, {
      entityType: 'ingredients',
      entityId: input.ingredientId,
      action: 'make_batch',
      actorUserId: actor.userId,
      before: { qty: ing.current_qty },
      after: {
        qty: resultingQty,
        made: amount,
        batchYield,
        batches: whole ? n : null,
        inputs: taken,
        notTaken: scaled.roundedAwayIds,
      },
    });
  });
  tx();
  return { made: amount, resultingQty };
}
