import { v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import type { StockMovement, StockMovementReason } from '@cheeseoclock/shared-types';

interface MovementRow {
  id: string;
  ingredient_id: string;
  delta_qty: number;
  reason: StockMovementReason;
  ref_order_id: string | null;
  ref_purchase_order_id: string | null;
  notes: string | null;
  actor_user_id: string | null;
  occurred_at: string;
  resulting_qty: number;
}

const MV_SELECT = `
  id, ingredient_id, delta_qty, reason, ref_order_id, ref_purchase_order_id,
  notes, actor_user_id, occurred_at, resulting_qty
`;

function rowToMovement(r: MovementRow): StockMovement {
  return {
    id: r.id as StockMovement['id'],
    ingredientId: r.ingredient_id as StockMovement['ingredientId'],
    deltaQty: r.delta_qty,
    reason: r.reason,
    refOrderId: r.ref_order_id as StockMovement['refOrderId'],
    refPurchaseOrderId: r.ref_purchase_order_id as StockMovement['refPurchaseOrderId'],
    notes: r.notes,
    actorUserId: r.actor_user_id as StockMovement['actorUserId'],
    occurredAt: r.occurred_at,
    resultingQty: r.resulting_qty,
  };
}

export function listMovements(
  db: AppDatabase,
  opts?: {
    ingredientId?: string;
    reason?: StockMovementReason;
    sinceIso?: string;
    limit?: number;
  },
): StockMovement[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.ingredientId) {
    where.push('ingredient_id = ?');
    params.push(opts.ingredientId);
  }
  if (opts?.reason) {
    where.push('reason = ?');
    params.push(opts.reason);
  }
  if (opts?.sinceIso) {
    where.push('occurred_at >= ?');
    params.push(opts.sinceIso);
  }
  const limit = opts?.limit ?? 200;
  const rows = db
    .prepare(
      `SELECT ${MV_SELECT} FROM stock_movements WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(...params, limit) as MovementRow[];
  return rows.map(rowToMovement);
}

export interface RecordMovementInput {
  ingredientId: string;
  deltaQty: number; // signed
  reason: StockMovementReason;
  refOrderId?: string | null;
  refPurchaseOrderId?: string | null;
  notes?: string | null;
  occurredAtIso?: string;
}

/**
 * Records one stock movement and updates ingredients.current_qty atomically.
 * Returns the resulting (post-movement) quantity.
 */
export function recordStockMovement(
  db: AppDatabase,
  input: RecordMovementInput,
  actor: Actor,
): { movementId: string; resultingQty: number } {
  const id = uuidv7();
  const now = nowIso();
  const occurredAt = input.occurredAtIso ?? now;
  let resultingQty = 0;

  const tx = db.transaction(() => {
    const ing = db
      .prepare(`SELECT current_qty FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
      .get(input.ingredientId) as { current_qty: number } | undefined;
    if (!ing) throw new Error('Ingredient not found');
    resultingQty = ing.current_qty + input.deltaQty;

    // Update the ingredient
    db.prepare(
      `UPDATE ingredients SET current_qty = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(resultingQty, now, input.ingredientId);

    enqueueSync(db, {
      entityType: 'ingredients',
      entityId: input.ingredientId,
      op: 'upsert',
      payload: { id: input.ingredientId, currentQty: resultingQty },
    });

    // Insert the movement row
    db.prepare(
      `INSERT INTO stock_movements
         (id, ingredient_id, delta_qty, reason, ref_order_id, ref_purchase_order_id,
          notes, actor_user_id, occurred_at, resulting_qty,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      input.ingredientId,
      input.deltaQty,
      input.reason,
      input.refOrderId ?? null,
      input.refPurchaseOrderId ?? null,
      input.notes ?? null,
      actor.userId,
      occurredAt,
      resultingQty,
      now,
      now,
      actor.deviceId,
    );

    enqueueSync(db, {
      entityType: 'stock_movements',
      entityId: id,
      op: 'upsert',
      payload: {
        id,
        ingredientId: input.ingredientId,
        deltaQty: input.deltaQty,
        reason: input.reason,
        resultingQty,
      },
    });
    writeAudit(db, {
      entityType: 'stock_movements',
      entityId: id,
      action: input.reason,
      actorUserId: actor.userId,
      before: { qty: ing.current_qty },
      after: { qty: resultingQty, delta: input.deltaQty, reason: input.reason },
    });
  });
  tx();
  return { movementId: id, resultingQty };
}

/**
 * Decrement ingredients consumed by an order. Walks each order item's recipe
 * and deducts qty_per_unit × quantity. Idempotent guard: if any movement rows
 * already exist for this order, skip (don't double-decrement).
 *
 * Returns the list of ingredients that crossed below their threshold.
 */
export function decrementForOrder(
  db: AppDatabase,
  orderId: string,
  actor: Actor,
): Array<{ ingredientId: string; name: string; resultingQty: number; threshold: number }> {
  const alreadyDone = db
    .prepare(`SELECT 1 FROM stock_movements WHERE ref_order_id = ? LIMIT 1`)
    .get(orderId);
  if (alreadyDone) return [];

  const usages = db
    .prepare(
      `SELECT oi.id AS order_item_id, oi.menu_item_id, oi.quantity,
              r.ingredient_id, r.qty_per_unit, i.name, i.current_qty, i.low_threshold
         FROM order_items oi
         JOIN recipes r ON r.menu_item_id = oi.menu_item_id AND r.deleted_at IS NULL
         JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
        WHERE oi.order_id = ? AND oi.deleted_at IS NULL`,
    )
    .all(orderId) as Array<{
    menu_item_id: string;
    quantity: number;
    ingredient_id: string;
    qty_per_unit: number;
    name: string;
    current_qty: number;
    low_threshold: number;
  }>;

  if (usages.length === 0) return [];

  // Aggregate per-ingredient delta across all order items.
  const byIngredient = new Map<string, { name: string; delta: number; low: number }>();
  for (const u of usages) {
    const prev = byIngredient.get(u.ingredient_id);
    const delta = (prev?.delta ?? 0) + u.qty_per_unit * u.quantity;
    byIngredient.set(u.ingredient_id, { name: u.name, delta, low: u.low_threshold });
  }

  const crossed: Array<{ ingredientId: string; name: string; resultingQty: number; threshold: number }> = [];
  const tx = db.transaction(() => {
    for (const [ingredientId, info] of byIngredient) {
      const result = recordStockMovement(
        db,
        {
          ingredientId,
          deltaQty: -info.delta,
          reason: 'sale',
          refOrderId: orderId,
        },
        actor,
      );
      if (result.resultingQty <= info.low) {
        crossed.push({
          ingredientId,
          name: info.name,
          resultingQty: result.resultingQty,
          threshold: info.low,
        });
      }
    }
  });
  tx();

  if (crossed.length > 0) {
    log.info('Stock crossed low threshold', { count: crossed.length });
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('inventory:low-stock', crossed);
    }
  }

  return crossed;
}
