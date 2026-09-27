import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';
import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { loadPriceBook, type PriceBook } from '../price-book.js';
import {
  BASE_PART,
  costSaleLine,
  expandRecipe,
  stockValueAt,
  totalsByIngredient,
  type PickedChoice,
  type PriceOf,
  type RecipeLine,
  type SaleCostPart,
  type StockValue,
} from '@cheeseoclock/pos-domain';
import {
  COC_ID_NAMESPACE,
  COST_BASES,
  MOVEMENT_DETAILS,
  type CostBasis,
  type MovementDetail,
  type StockMovement,
  type StockMovementReason,
  type WasteReason,
} from '@cheeseoclock/shared-types';

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
  detail: string | null;
  value_cents: number | null;
  unit_cost_mc: number | null;
  cost_basis: string | null;
}

const MV_SELECT = `
  id, ingredient_id, delta_qty, reason, ref_order_id, ref_purchase_order_id,
  notes, actor_user_id, occurred_at, resulting_qty,
  detail, value_cents, unit_cost_mc, cost_basis
`;

/** A stored detail as the type; anything this till does not know (a newer till's) reads as null. */
export function toMovementDetail(v: string | null | undefined): MovementDetail | null {
  return (MOVEMENT_DETAILS as readonly string[]).includes(v ?? '') ? (v as MovementDetail) : null;
}

/** A stored cost basis as the type; anything this till does not know reads as null. */
export function toCostBasis(v: string | null | undefined): CostBasis | null {
  return (COST_BASES as readonly string[]).includes(v ?? '') ? (v as CostBasis) : null;
}

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
    detail: toMovementDetail(r.detail),
    // Costs: the IPC handler leaves these out for a login without COST_CAPABILITY.
    valueCents: r.value_cents,
    unitCostMc: r.unit_cost_mc,
    costBasis: toCostBasis(r.cost_basis),
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

/** A stock row that could not be valued (bad data): no value, like a row from before costing. */
export const NOT_VALUED = { valueCents: null, unitCostMc: null, basis: null } as const;
export type RowValue = StockValue | typeof NOT_VALUED;

/**
 * What `q` units are worth at a price, for a stock row — never throwing: a
 * quantity the exact arithmetic refuses (not a whole number, from old or
 * hand-edited data) is left unvalued rather than blocking the stock.
 */
export function safeStockValue(q: number, price: Parameters<typeof stockValueAt>[1]): RowValue {
  try {
    return stockValueAt(q, price);
  } catch {
    return NOT_VALUED;
  }
}

/** Every live ingredient's effective price now (a batch at its rolled-up price). */
export function priceOfBook(book: PriceBook): PriceOf {
  return (id) => {
    const p = book.prices.get(id);
    return p ? { pack: p.pack, kind: p.kind } : undefined;
  };
}

export interface RecordMovementInput {
  ingredientId: string;
  deltaQty: number; // signed
  reason: StockMovementReason;
  refOrderId?: string | null;
  refPurchaseOrderId?: string | null;
  notes?: string | null;
  occurredAtIso?: string;
  /**
   * False: the row is booked for the OTHER till's count (stock it took, put
   * back or wasted from here when an order is settled on this till), so this
   * till's count does not move. Default true.
   */
  countHere?: boolean;
  /**
   * What the row stands for beyond its reason (costing spec 0033). When left
   * out, a row booked by hand gets its own: waste → 'waste:<wasteReason>'
   * ('other' when none was given), a stock take → 'stock_take', a fix →
   * 'correction'.
   */
  detail?: MovementDetail | null;
  /** Waste booked by hand: why it was thrown away. */
  wasteReason?: WasteReason;
  /** The rows of one batch run share this. */
  refGroupId?: string | null;
  /** On a row that settles an order: when that order first took stock. */
  refTakenAt?: string | null;
  /**
   * What the row is worth, when the caller knows it: a delivery at its bill,
   * a put-back at what the order's take cost, a batch at its inputs. Left
   * out: valued at the ingredient's effective price now (a stock take marked
   * 'count').
   */
  value?: RowValue;
}

/** The detail a row booked by hand gets when none is given. */
function defaultDetail(input: RecordMovementInput): MovementDetail | null {
  if (input.detail !== undefined) return input.detail;
  if (input.refOrderId) return null;
  if (input.reason === 'waste') return `waste:${input.wasteReason ?? 'other'}`;
  if (input.reason === 'count') return 'stock_take';
  if (input.reason === 'adjustment') return 'correction';
  return null;
}

/**
 * Records one stock movement and updates ingredients.current_qty atomically.
 * Returns the resulting (post-movement) quantity.
 *
 * Every row carries what it was worth when written (costing spec D2/D10):
 * value_cents SIGNED like the quantity, so a take and its put-back net to
 * exactly 0, with the unit price and how it was valued. Reports never
 * revalue it.
 */
export function recordStockMovement(
  db: AppDatabase,
  input: RecordMovementInput,
  actor: Actor,
): { movementId: string; resultingQty: number } {
  const id = uuidv7();
  const now = nowIso();
  const occurredAt = input.occurredAtIso ?? now;
  const countHere = input.countHere !== false;
  const detail = defaultDetail(input);
  let resultingQty = 0;

  const tx = db.transaction(() => {
    const ing = db
      .prepare(`SELECT current_qty, unit FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
      .get(input.ingredientId) as { current_qty: number; unit: string } | undefined;
    if (!ing) throw new Error('Ingredient not found');
    resultingQty = countHere ? ing.current_qty + input.deltaQty : ing.current_qty;

    let value: RowValue;
    if (input.value !== undefined) value = input.value;
    else {
      value = safeStockValue(input.deltaQty, priceOfBook(loadPriceBook(db))(input.ingredientId));
      if (input.reason === 'count' && !input.refOrderId && value.basis === 'price') value = { ...value, basis: 'count' };
    }

    // Update the ingredient's running count. Not version or updated_at: those
    // are the second-till link's "who edited last" clock, and the count is
    // each till's own (a till takes the other's count only for an ingredient
    // new to it; the movement row below is what travels). Bumping them here
    // made every sale out-rank a manager's edit made on the other till, so
    // the edit was dropped on both tills.
    if (countHere) {
      db.prepare(`UPDATE ingredients SET current_qty = ? WHERE id = ?`).run(
        resultingQty,
        input.ingredientId,
      );

      enqueueSync(db, {
        entityType: 'ingredients',
        entityId: input.ingredientId,
        op: 'upsert',
        payload: { id: input.ingredientId, currentQty: resultingQty },
      });
    }

    // Insert the movement row, stamped with the unit it is counted in (0029):
    // a later Convert (kg → g) must not turn "2 kg" into "2 g" when this row
    // is read back — cancelling the order, or valuing it in Reports.
    db.prepare(
      `INSERT INTO stock_movements
         (id, ingredient_id, delta_qty, reason, ref_order_id, ref_purchase_order_id,
          notes, actor_user_id, occurred_at, resulting_qty, unit,
          unit_cost_mc, value_cents, cost_basis, detail, ref_group_id, ref_taken_at,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
      ing.unit,
      value.unitCostMc,
      value.valueCents,
      value.basis,
      detail,
      input.refGroupId ?? null,
      input.refTakenAt ?? null,
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
        unit: ing.unit,
        refOrderId: input.refOrderId ?? null,
      },
    });
    writeAudit(db, {
      entityType: 'stock_movements',
      entityId: id,
      action: input.reason,
      actorUserId: actor.userId,
      before: { qty: ing.current_qty },
      after: {
        qty: resultingQty,
        delta: input.deltaQty,
        reason: input.reason,
        ...(detail ? { detail } : {}),
        ...(value.valueCents !== null ? { valueCents: value.valueCents } : {}),
        ...(countHere ? {} : { countHere: false }),
      },
    });
  });
  tx();
  return { movementId: id, resultingQty };
}

// ---------------------------------------------------------------------------
// The kitchen gets the order: stock leaves, and the sale keeps its cost
// ---------------------------------------------------------------------------

/** The id of a sale's cost row: the same on every till, for every call (costing spec D13). */
export function saleCostId(orderItemId: string, part: string): string {
  return uuidv5(`${orderItemId}|${part}`, COC_ID_NAMESPACE);
}

interface OrderLine {
  id: string;
  menuItemId: string | null;
  quantity: number;
  picks: PickedChoice[];
}

/** The order's lines and the choices picked on each. */
function readOrderLines(db: AppDatabase, orderId: string): OrderLine[] {
  const lines = (
    db
      .prepare(
        `SELECT id, menu_item_id, quantity FROM order_items
          WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
      )
      .all(orderId) as Array<{ id: string; menu_item_id: string | null; quantity: number }>
  ).map((l): OrderLine => ({ id: l.id, menuItemId: l.menu_item_id, quantity: Number(l.quantity), picks: [] }));
  if (lines.length === 0) return lines;
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const p of db
    .prepare(
      `SELECT oim.order_item_id, oim.modifier_id, oim.price_delta_cents, m.removes_ingredient_id
         FROM order_item_modifiers oim
         LEFT JOIN modifiers m ON m.id = oim.modifier_id
        WHERE oim.order_item_id IN (SELECT value FROM json_each(?)) AND oim.deleted_at IS NULL
          AND oim.modifier_id IS NOT NULL`,
    )
    .all(JSON.stringify(lines.map((l) => l.id))) as Array<{
    order_item_id: string;
    modifier_id: string;
    price_delta_cents: number;
    removes_ingredient_id: string | null;
  }>) {
    byId.get(p.order_item_id)?.picks.push({
      modifierId: p.modifier_id,
      priceDeltaCents: Number(p.price_delta_cents),
      removesIngredientId: p.removes_ingredient_id,
    });
  }
  return lines;
}

/** The recipes of the items sold, live ingredients only (as the stock SQL always joined them). */
function readRecipes(db: AppDatabase, itemIds: string[]): Map<string, RecipeLine[]> {
  const out = new Map<string, RecipeLine[]>();
  if (itemIds.length === 0) return out;
  for (const r of db
    .prepare(
      `SELECT r.menu_item_id, r.ingredient_id, r.qty_per_unit, r.modifier_id
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id AND i.deleted_at IS NULL
        WHERE r.menu_item_id IN (SELECT value FROM json_each(?)) AND r.deleted_at IS NULL`,
    )
    .all(JSON.stringify(itemIds)) as Array<{ menu_item_id: string; ingredient_id: string; qty_per_unit: number; modifier_id: string | null }>) {
    let list = out.get(r.menu_item_id);
    if (!list) out.set(r.menu_item_id, (list = []));
    list.push({ ingredientId: r.ingredient_id, qtyPerUnit: r.qty_per_unit, modifierId: r.modifier_id });
  }
  return out;
}

/*
 * The guards below run on every send, tender, serve and hand-over, inside the
 * write transaction: each must find the order's own rows through
 * idx_movements_order, never walk the ledger. (The app never runs ANALYZE, so
 * with `reason = 'sale'` beside it SQLite picks idx_movements_reason_time and
 * reads EVERY sale row; the unary + keeps it off that index.) Their plans are
 * tested (sale-costs.db.test.ts).
 */

/** The order has stock rows already (idx_movements_order, covering). */
export const HAS_STOCK_ROWS = `SELECT 1 FROM stock_movements WHERE ref_order_id = ? LIMIT 1`;

/**
 * The order took its stock before this till kept costs (a take with no
 * value): it was sent before the upgrade, so it does not start keeping a
 * cost now, at today's prices — Reports estimates it from what it took
 * (costing spec §7).
 */
export const TAKEN_BEFORE_COSTING = `
  SELECT 1 FROM stock_movements
   WHERE ref_order_id = ? AND +reason = 'sale' AND delta_qty < 0 AND value_cents IS NULL
     AND cost_basis IS NULL AND deleted_at IS NULL
   LIMIT 1`;

/** A line with no 'base' cost row yet (idx_order_items_order, then idx_order_item_costs_line_part). */
export const LINE_WITHOUT_COST = `
  SELECT 1 FROM order_items oi
   WHERE oi.order_id = ? AND oi.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM order_item_costs c
                      WHERE c.order_item_id = oi.id AND c.part = '${BASE_PART}' AND c.deleted_at IS NULL)
   LIMIT 1`;

interface LineCost {
  line: OrderLine;
  parts: SaleCostPart[];
  /** Working the cost out went wrong: one 'failed' base row, Rs 0. */
  error: string | null;
}

/**
 * Write the cost rows not there yet: each (line, part) once, by its
 * name-based id — so calling this again, or the other till having costed
 * the same order, never makes a second row. One order-level audit row says
 * what was kept. Returns how many rows were written.
 */
function writeSaleCosts(db: AppDatabase, orderId: string, costs: LineCost[], actor: Actor): number {
  const now = nowIso();
  const exists = db.prepare(
    `SELECT 1 FROM order_item_costs
      WHERE id = ? OR (order_item_id = ? AND part = ? AND deleted_at IS NULL) LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO order_item_costs
       (id, order_id, order_item_id, part, modifier_id, line_qty, cost_cents, status,
        missing_lines, estimate_lines, costed_at, created_at, updated_at, device_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  let written = 0;
  let costCents = 0;
  const statuses: Record<string, number> = {};
  const failed: Array<{ orderItemId: string; error: string }> = [];
  for (const c of costs) {
    let wroteLine = false;
    for (const p of c.parts) {
      const id = saleCostId(c.line.id, p.part);
      if (exists.get(id, c.line.id, p.part)) continue;
      insert.run(
        id,
        orderId,
        c.line.id,
        p.part,
        p.modifierId,
        c.line.quantity,
        p.costCents,
        p.status,
        p.missingLines,
        p.estimateLines,
        now,
        now,
        now,
        actor.deviceId,
      );
      enqueueSync(db, { entityType: 'order_item_costs', entityId: id, op: 'upsert', payload: { id } });
      written += 1;
      wroteLine = true;
      costCents += p.costCents;
      statuses[p.status] = (statuses[p.status] ?? 0) + 1;
    }
    if (wroteLine && c.error !== null) failed.push({ orderItemId: c.line.id, error: c.error });
  }
  if (written > 0) {
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: 'cost_snapshot',
      actorUserId: actor.userId,
      before: null,
      after: { rows: written, costCents, statuses, ...(failed.length > 0 ? { failed } : {}) },
    });
  }
  return written;
}

/** A 'failed' base row per line: costing went wrong, the sale and its stock go on. */
function failedCosts(lines: OrderLine[], error: string): LineCost[] {
  return lines.map((line) => ({
    line,
    error,
    parts: [{ part: BASE_PART, modifierId: null, costCents: 0, status: 'failed', missingLines: 0, estimateLines: 0 }],
  }));
}

/**
 * The kitchen is about to use the ingredients: take them off stock, and keep
 * with the sale what its food cost today (costing spec Phase 2).
 *
 * Every order line goes through ONE rule, pos-domain expandRecipe: every
 * recipe line with no choice, plus the lines of the choices picked on that
 * line (the five veggies, the dip, a deal's pizzas), a "leave out" keeping its
 * ingredient off (a paid extra still taken) — exactly what the stock SQL used
 * to take, tested order for order (costing.db.test.ts).
 *
 * Inside ONE transaction, two independent guards:
 *  - the cost rows (order_item_costs) not written yet are written, even for
 *    a line with nothing to take (status 'none'); a costing error writes
 *    'failed' rows and never blocks the stock or the order. An order that
 *    took its stock before costing started keeps none (it is estimated);
 *  - the stock rows (one per ingredient, each valued at its effective price
 *    now) are written only when the order has none yet — checked inside the
 *    transaction, so two sends at once can't both take it.
 * Idempotent: called on send, on payment and on hand-over, it writes each
 * thing once.
 *
 * Returns the ingredients that crossed below their threshold.
 */
export function decrementForOrder(
  db: AppDatabase,
  orderId: string,
  actor: Actor,
): Array<{ ingredientId: string; name: string; unit: string; resultingQty: number; threshold: number }> {
  // The cheap early exit: the stock is out, and every line keeps its cost
  // (or the order was sent before costing started and never will).
  const nothingToCost = () => !db.prepare(LINE_WITHOUT_COST).get(orderId) || !!db.prepare(TAKEN_BEFORE_COSTING).get(orderId);
  if (db.prepare(HAS_STOCK_ROWS).get(orderId) && nothingToCost()) return [];

  const lines = readOrderLines(db, orderId);
  if (lines.length === 0) return [];
  const recipes = readRecipes(db, [...new Set(lines.map((l) => l.menuItemId).filter((id): id is string => id !== null))]);
  const recipeOf = (l: OrderLine) => (l.menuItemId ? (recipes.get(l.menuItemId) ?? []) : []);
  // An order with no recipes at all (Baked Wings, a delivery charge) takes
  // nothing and keeps one 'none' row per line: once those are there, a
  // repeat call (tender, serve, hand-over) has nothing to write — skip the
  // price book and the write transaction.
  if (lines.every((l) => recipeOf(l).length === 0) && !db.prepare(LINE_WITHOUT_COST).get(orderId)) return [];

  // What leaves stock, per ingredient: the same expansion the costs use.
  const takes = totalsByIngredient(lines.flatMap((l) => expandRecipe(recipeOf(l), l.picks, l.quantity)));

  let book: PriceBook | null = null;
  let costs: LineCost[];
  try {
    book = loadPriceBook(db);
    const priceOf = priceOfBook(book);
    costs = lines.map((line): LineCost => {
      try {
        return { line, parts: costSaleLine(recipeOf(line), line.picks, line.quantity, priceOf).parts, error: null };
      } catch (e) {
        return failedCosts([line], String(e))[0]!;
      }
    });
  } catch (e) {
    costs = failedCosts(lines, String(e));
  }

  const crossed: Array<{ ingredientId: string; name: string; unit: string; resultingQty: number; threshold: number }> = [];
  const tx = db.transaction(() => {
    // 1. The cost kept with the sale. A savepoint of its own: whatever goes
    //    wrong here, the stock below is still taken.
    if (!db.prepare(TAKEN_BEFORE_COSTING).get(orderId)) {
      try {
        db.transaction(() => writeSaleCosts(db, orderId, costs, actor))();
      } catch (e) {
        log.warn('Keeping the sale cost failed (stock still taken)', { orderId, error: String(e) });
        try {
          db.transaction(() => writeSaleCosts(db, orderId, failedCosts(lines, String(e)), actor))();
        } catch (e2) {
          log.warn('Could not mark the sale cost as failed', { orderId, error: String(e2) });
        }
      }
    }

    // 2. The stock. Checked inside the transaction: two sends at once must
    //    not both take it off (the check above is only the early exit).
    if (takes.size === 0 || db.prepare(HAS_STOCK_ROWS).get(orderId)) return;
    const meta = new Map(
      (
        db
          .prepare(
            `SELECT id, name, unit, low_threshold FROM ingredients
              WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
          )
          .all(JSON.stringify([...takes.keys()])) as Array<{ id: string; name: string; unit: string; low_threshold: number }>
      ).map((m) => [m.id, m]),
    );
    const priceOf: PriceOf = book ? priceOfBook(book) : () => undefined;
    for (const [ingredientId, qty] of takes) {
      const m = meta.get(ingredientId);
      if (!m) continue;
      const result = recordStockMovement(
        db,
        {
          ingredientId,
          deltaQty: -qty,
          reason: 'sale',
          refOrderId: orderId,
          value: book ? safeStockValue(-qty, priceOf(ingredientId)) : NOT_VALUED,
        },
        actor,
      );
      // Warn on the way down through the line only — every sale of an item
      // already under it used to raise the same alert again.
      const before = result.resultingQty + qty;
      if (result.resultingQty <= m.low_threshold && before > m.low_threshold) {
        crossed.push({
          ingredientId,
          name: m.name,
          unit: m.unit,
          resultingQty: result.resultingQty,
          threshold: m.low_threshold,
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

// Putting an order's stock back (or booking it as waste) when it is cancelled
// or refunded lives in order-stock-repo.ts: settleOrderStock.
