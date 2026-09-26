/**
 * What happens to an order's stock when it is cancelled or refunded in full
 * ("Was the food made?"), and what the question looks like before it is asked.
 *
 * Stock leaves when the kitchen gets the order (decrementForOrder: one
 * negative 'sale' row per ingredient, ref_order_id set). When the order then
 * ends without a sale, it is SETTLED from that ledger — never from the recipe,
 * so leave-outs, paid extras, dips, deals and a recipe edited since all come
 * out exactly as they went in:
 *
 *   not made → + qty 'sale'  "Cancelled, not made — put back"          (count goes up)
 *              (a stock take after sending already saw it on the shelf:
 *               + qty 'sale' then − qty 'count' "…already in the stock take", count stays)
 *   made     → + qty 'sale'  "Cancelled after cooking — moved to waste"
 *              − qty 'waste' "Cancelled after cooking — counted as waste" (count stays)
 *              a sealed drink (unless it went to a table or was handed
 *              over) goes back instead: + qty 'sale'
 *
 * Either way the order's net 'sale' comes to 0, so Reports never count a
 * cancelled order's food as sold; made food shows as waste against the
 * order. 'waste' and 'count' are reasons the 0005 CHECK already allows, so
 * this needs no table rebuild. Every row goes through recordStockMovement
 * (row + sync + audit), inside the caller's void / refund transaction, and one
 * order-level audit row says who decided what (stock_put_back / stock_to_waste).
 *
 * Two tills: each keeps its own count (sync-core RECEIVER_KEEPS_ON_UPDATE).
 * Stock the OTHER till took is settled here too, in rows that do not move
 * this till's count ("…put back on the till that sent it", "made" rows): the
 * order's ledger nets to 0 on both tills at once, and when those rows reach
 * the till that took the stock it puts the "not made" share back on its own
 * count (apply-remote.ts applyOtherTillReturn).
 *
 * Rules the till enforces, whoever asks:
 *  - it never guesses: while the food is still in the shop (sent, preparing,
 *    ready) the answer must be given;
 *  - food that left the shop (with a rider, or handed over) can't go back on
 *    the shelf: only "made" is accepted;
 *  - never more back than was taken, and settling twice writes nothing (it
 *    works from what the order still holds).
 */

import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { recordStockMovement } from './stock-movement-repo.js';
import { writeAudit } from './audit-repo.js';
import {
  answerWentAgainstHint,
  drinksGoBackByDefault,
  foodLeftShop,
  foodMadeQuestion,
  handedOver,
  ingredientCostCents,
  isSealedDrink,
  noteKindAnswer,
  orderStockNote,
  orderStockNoteKind,
  returnsToOtherTill,
  unitFactor,
} from '@cheeseoclock/pos-domain';
import type {
  FoodMade,
  OrderMode,
  OrderStatus,
  OrderStockHow,
  OrderStockLine,
  OrderStockLineNote,
  OrderStockStatus,
  StockSettlement,
} from '@cheeseoclock/shared-types';

// ---------------------------------------------------------------------------
// Reading what an order took and what settled it
// ---------------------------------------------------------------------------

interface LedgerRow {
  ingredient_id: string;
  reason: string;
  delta_qty: number;
  unit: string | null;
  notes: string | null;
  device_id: string;
  occurred_at: string;
  actor_user_id: string | null;
}

interface IngredientRow {
  id: string;
  name: string;
  unit: string;
  category: string | null;
  cost_per_unit_cents: number;
  pack_size: number | null;
  pack_price_cents: number | null;
  deleted_at: string | null;
}

/** One ingredient of one order, in the unit the ingredient has now. */
interface Holding {
  ingredientId: string;
  ing: IngredientRow | null;
  /** Net 'sale' on this till's count (negative = still taken). */
  own: number;
  /** Net 'sale' on the other till's count. */
  other: number;
  /** Some row's unit can't be converted into the ingredient's unit now. */
  unconvertible: boolean;
  /** This till's first take for the order (a later stock take already counted the shelf). */
  ownTakenAt: string | null;
  /** Settle rows already written (any till). */
  plusSale: number;
  wasted: number;
  counted: number;
  /** Of `plusSale`: put back from here onto the other till's count. */
  thereBack: number;
}

interface OrderLedger {
  holdings: Holding[];
  /** When the order first took stock (this till's take when there is one). */
  takenAt: string | null;
  otherTill: boolean;
  /** Settle rows: + sale, waste, count (a settle, or an older till's "put back"). */
  settleRows: LedgerRow[];
}

function readOrderLedger(db: AppDatabase, orderId: string, deviceId: string): OrderLedger {
  const rows = db
    .prepare(
      `SELECT ingredient_id, reason, delta_qty, unit, notes, device_id, occurred_at, actor_user_id
         FROM stock_movements
        WHERE ref_order_id = ? AND deleted_at IS NULL
        ORDER BY occurred_at, id`,
    )
    .all(orderId) as LedgerRow[];
  const ids = [...new Set(rows.map((r) => r.ingredient_id))];
  const ings = new Map<string, IngredientRow>();
  if (ids.length > 0) {
    const found = db
      .prepare(
        `SELECT id, name, unit, category, cost_per_unit_cents, pack_size, pack_price_cents, deleted_at
           FROM ingredients WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as IngredientRow[];
    for (const i of found) ings.set(i.id, i);
  }

  const byId = new Map<string, Holding>();
  let takenAt: string | null = null;
  let ownTakenAt: string | null = null;
  let otherTill = false;
  const settleRows: LedgerRow[] = [];
  for (const r of rows) {
    const ing = ings.get(r.ingredient_id) ?? null;
    let h = byId.get(r.ingredient_id);
    if (!h) {
      h = {
        ingredientId: r.ingredient_id,
        ing,
        own: 0,
        other: 0,
        unconvertible: false,
        ownTakenAt: null,
        plusSale: 0,
        wasted: 0,
        counted: 0,
        thereBack: 0,
      };
      byId.set(r.ingredient_id, h);
    }
    const mine = r.device_id === deviceId;
    if (!mine) otherTill = true;
    const factor = ing ? unitFactor(r.unit, ing.unit) : 1;
    if (factor === null) {
      h.unconvertible = true;
      continue;
    }
    const qty = Number(r.delta_qty) * factor;
    if (r.reason === 'sale') {
      if (qty > 0 && returnsToOtherTill(orderStockNoteKind(r.notes))) {
        // Booked for the count of the till that took the stock: written here,
        // it evens out the other till's take; written there, ours.
        if (mine) {
          h.other += qty;
          h.thereBack += qty;
        } else {
          h.own += qty;
        }
      } else if (mine) {
        h.own += qty;
      } else {
        h.other += qty;
      }
      if (qty < 0) {
        if (takenAt === null || r.occurred_at < takenAt) takenAt = r.occurred_at;
        if (mine) {
          if (ownTakenAt === null || r.occurred_at < ownTakenAt) ownTakenAt = r.occurred_at;
          if (h.ownTakenAt === null || r.occurred_at < h.ownTakenAt) h.ownTakenAt = r.occurred_at;
        }
      } else if (qty > 0) {
        h.plusSale += qty;
        settleRows.push(r);
      }
    } else if (r.reason === 'waste') {
      h.wasted += -qty;
      settleRows.push(r);
    } else if (r.reason === 'count') {
      h.counted += -qty;
      settleRows.push(r);
    }
  }
  return { holdings: [...byId.values()], takenAt: ownTakenAt ?? takenAt, otherTill, settleRows };
}

/** What an order still holds of one ingredient: in all, and of that on this till. */
function held(h: Holding): { need: number; mine: number; theirs: number } {
  const need = Math.max(0, -(h.own + h.other));
  const mine = Math.min(need, Math.max(0, -h.own));
  return { need, mine, theirs: need - mine };
}

function isDrink(ing: IngredientRow | null): boolean {
  return ing !== null && isSealedDrink(ing);
}

function cost(ing: IngredientRow | null, qty: number): number {
  if (!ing || qty === 0) return 0;
  return ingredientCostCents(qty, {
    costPerUnitCents: ing.cost_per_unit_cents,
    packSize: ing.pack_size,
    packPriceCents: ing.pack_price_cents,
  });
}

/** Ingredients this till counted in a stock take (not an order's own row) after `sinceIso`. */
function countedSince(db: AppDatabase, deviceId: string, holdings: Holding[]): Set<string> {
  const wanted = holdings.filter((h) => h.ownTakenAt !== null);
  if (wanted.length === 0) return new Set();
  const earliest = wanted.reduce((m, h) => (h.ownTakenAt! < m ? h.ownTakenAt! : m), wanted[0]!.ownTakenAt!);
  // Stock takes since the order was sent: a short range of idx_movements_reason_time.
  const rows = db
    .prepare(
      `SELECT ingredient_id AS id, MAX(occurred_at) AS last
         FROM stock_movements
        WHERE reason = 'count' AND occurred_at > ? AND ref_order_id IS NULL AND deleted_at IS NULL
          AND device_id = ? AND ingredient_id IN (SELECT value FROM json_each(?))
        GROUP BY ingredient_id`,
    )
    .all(earliest, deviceId, JSON.stringify(wanted.map((h) => h.ingredientId))) as Array<{ id: string; last: string }>;
  const last = new Map(rows.map((r) => [r.id, r.last]));
  const out = new Set<string>();
  for (const h of wanted) {
    const at = last.get(h.ingredientId);
    if (at !== undefined && h.ownTakenAt !== null && at > h.ownTakenAt) out.add(h.ingredientId);
  }
  return out;
}

function lineNote(h: Holding, counted: Set<string>): OrderStockLineNote | null {
  if (!h.ing || h.ing.deleted_at !== null) return 'deleted';
  if (h.unconvertible) return 'unit_changed';
  const { mine, theirs } = held(h);
  if (mine > 0 && counted.has(h.ingredientId)) return 'counted_since';
  if (theirs > 0) return 'other_till';
  return null;
}

function baseLine(h: Holding, qty: number, note: OrderStockLineNote | null): OrderStockLine {
  return {
    ingredientId: h.ingredientId,
    name: h.ing?.name ?? 'Deleted ingredient',
    unit: h.ing?.unit ?? '',
    qty,
    estCostCents: cost(h.ing, qty),
    drink: isDrink(h.ing),
    note,
  };
}

const byName = (a: OrderStockLine, b: OrderStockLine) => a.name.localeCompare(b.name);

/**
 * The answer given, once settled: this till's own order-level audit row when
 * it settled the order, else what the settle rows' notes stand for (the other
 * till's audit trail stays on that till; its rows travel).
 */
function settledAnswer(audited: { action: string; after_json: string | null } | undefined, rows: LedgerRow[]): FoodMade | null {
  if (audited) {
    try {
      const after = JSON.parse(audited.after_json ?? '{}') as { outcome?: unknown };
      if (after.outcome === 'made' || after.outcome === 'not_made') return after.outcome;
    } catch {
      // fall through to the action
    }
    return audited.action === 'stock_to_waste' ? 'made' : 'not_made';
  }
  const answers = rows.map((r) => noteKindAnswer(orderStockNoteKind(r.notes)));
  if (answers.includes('made')) return 'made';
  if (answers.includes('not_made')) return 'not_made';
  return null;
}

// ---------------------------------------------------------------------------
// The status the dialogs and Order History read
// ---------------------------------------------------------------------------

/**
 * What cancelling this order would do to stock (state 'out', with the
 * question), or what it did. Null when there is no such order. Read-only.
 * Everything in it, lines and costs included: the IPC handler trims it for a
 * counter login (pos-domain stockStatusForCounter).
 */
export function getOrderStockStatus(
  db: AppDatabase,
  orderId: string,
  deviceId: string,
  nowMs: number,
): OrderStockStatus | null {
  const order = db
    .prepare(
      `SELECT o.status AS status, ua.full_name AS approvedBy
         FROM orders o LEFT JOIN users ua ON ua.id = o.voided_by
        WHERE o.id = ? AND o.deleted_at IS NULL`,
    )
    .get(orderId) as { status: OrderStatus; approvedBy: string | null } | undefined;
  if (!order) return null;

  const ledger = readOrderLedger(db, orderId, deviceId);
  const counted = countedSince(db, deviceId, ledger.holdings);
  // Settled when a settle row exists (written here, or arrived from the other
  // till) — or, when every line was skipped (all deleted from Inventory),
  // when this till's order-level audit row says so.
  const audited = db
    .prepare(
      `SELECT action, after_json FROM audit_log
        WHERE entity_type = 'orders' AND entity_id = ? AND action IN ('stock_put_back', 'stock_to_waste')
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId) as { action: string; after_json: string | null } | undefined;
  const settled = ledger.settleRows.length > 0 || audited !== undefined;
  const lines: OrderStockLine[] = [];
  let wasteCents = 0;
  for (const h of ledger.holdings) {
    const { need } = held(h);
    if (settled) {
      const wasted = Math.max(0, h.wasted);
      const alreadyCounted = Math.max(0, h.counted);
      const putBackThere = Math.max(0, h.thereBack);
      const putBack = Math.max(0, h.plusSale - wasted - alreadyCounted - putBackThere);
      const qty = putBack + alreadyCounted + putBackThere + wasted + need;
      if (qty === 0 && !h.unconvertible) continue;
      const line = baseLine(h, qty, need > 0 || h.unconvertible ? lineNote(h, counted) : null);
      line.putBack = putBack;
      line.alreadyCounted = alreadyCounted;
      line.putBackThere = putBackThere;
      line.wasted = wasted;
      line.wasteCents = cost(h.ing, wasted);
      wasteCents += line.wasteCents;
      lines.push(line);
    } else if (need > 0 || h.unconvertible) {
      lines.push(baseLine(h, need, lineNote(h, counted)));
    }
  }
  lines.sort(byName);

  const answer = settled ? settledAnswer(audited, ledger.settleRows) : null;
  const holds = lines.some(
    (l) => l.qty > 0 && (l.putBack ?? 0) + (l.alreadyCounted ?? 0) + (l.putBackThere ?? 0) + (l.wasted ?? 0) < l.qty,
  );
  // What happened to the stock: booked as waste, or back on a shelf. A "made"
  // answer where only sealed drinks moved put stock back (answer says why);
  // one where nothing could be booked (every ingredient deleted) still reads
  // as the food being gone.
  const state: OrderStockStatus['state'] = settled
    ? ledger.settleRows.some((r) => r.reason === 'waste') || (ledger.settleRows.length === 0 && answer === 'made')
      ? 'wasted'
      : 'returned'
    : holds
      ? order.status === 'void' || order.status === 'refunded'
        ? 'kept'
        : 'out'
      : 'none';

  const last = ledger.settleRows.reduce<LedgerRow | null>((m, r) => (!m || r.occurred_at >= m.occurred_at ? r : m), null);
  const settledBy = last?.actor_user_id
    ? ((db.prepare(`SELECT full_name AS n FROM users WHERE id = ?`).get(last.actor_user_id) as { n: string } | undefined)?.n ??
      null)
    : null;

  return {
    orderId,
    status: order.status,
    state,
    takenAt: ledger.takenAt,
    lines,
    estCostCents: lines.reduce((s, l) => s + l.estCostCents, 0),
    hasCosts: lines.some((l) => l.estCostCents !== 0),
    question: state === 'out' ? foodMadeQuestion({ status: order.status, takenAt: ledger.takenAt, now: nowMs }) : null,
    kitchenTicket: kitchenTicketState(db, orderId),
    otherTill: ledger.otherTill,
    settledAt: last?.occurred_at ?? null,
    settledByName: settledBy,
    approvedByName: order.approvedBy,
    answer,
    wasteCents,
    hiddenLines: 0,
  };
}

/**
 * Whether the kitchen got its ticket from this till. 'not_printed' (queued,
 * not done) is the useful one: a real sign the food may not have been made.
 * Finished jobs are cleared after a fortnight, so an old order reads 'none'.
 */
function kitchenTicketState(db: AppDatabase, orderId: string): OrderStockStatus['kitchenTicket'] {
  const rows = db
    .prepare(
      `SELECT status FROM print_queue
        WHERE order_id = ? AND job_kind = 'kitchen'
          AND COALESCE(json_extract(payload_json, '$.cancelled'), 0) = 0`,
    )
    .all(orderId) as Array<{ status: string }>;
  if (rows.length === 0) return 'none';
  return rows.some((r) => r.status === 'done') ? 'printed' : 'not_printed';
}

// ---------------------------------------------------------------------------
// Settling: the answer, written into the ledger
// ---------------------------------------------------------------------------

export interface SettleOrderStockInput {
  orderId: string;
  how: OrderStockHow;
  /** The order's status just before this cancel / refund. */
  statusBefore: OrderStatus;
  /** "Was the food made?" — required while the food is still in the shop. */
  foodMade?: FoodMade;
  /**
   * Sealed drinks to put back although the food was made. Omitted: the
   * till's default (pos-domain drinksGoBackByDefault — every sealed drink of
   * a takeaway or delivery not yet handed over; none of a dine-in order).
   */
  putBack?: string[];
  /** The manager who approved the cancel / refund. */
  approverUserId: string | null;
}

/** The till's refusals, as the cashier reads them. */
export const SAY_IF_MADE = 'Say whether the food was made';
export const FOOD_LEFT_THE_SHOP = "The food left the shop — it can't go back on the shelf";

/**
 * Settle what the order still holds, per the answer. Null (nothing written)
 * when it holds nothing: a draft, an order with no recipes, or one already
 * settled — so calling it twice is safe. Runs in a transaction; inside a void
 * or refund it is a savepoint of that one, and any refusal rolls the whole
 * cancel back.
 */
export function settleOrderStock(
  db: AppDatabase,
  input: SettleOrderStockInput,
  actor: Actor,
): StockSettlement | null {
  let result: StockSettlement | null = null;
  db.transaction(() => {
    const ledger = readOrderLedger(db, input.orderId, actor.deviceId);
    const holding = ledger.holdings.filter((h) => held(h).need > 0 || h.unconvertible);
    if (!holding.some((h) => held(h).need > 0)) return;

    const question = foodMadeQuestion({ status: input.statusBefore, takenAt: ledger.takenAt, now: Date.now() });
    let outcome: FoodMade;
    let answered: StockSettlement['answered'];
    if (foodLeftShop(input.statusBefore)) {
      if (input.foodMade === 'not_made') throw new Error(FOOD_LEFT_THE_SHOP);
      outcome = 'made';
      answered = 'forced';
    } else {
      if (input.foodMade !== 'made' && input.foodMade !== 'not_made') throw new Error(SAY_IF_MADE);
      outcome = input.foodMade;
      answered = 'staff';
    }

    // Sealed drinks go back to the fridge even when the food was made — by
    // default only when they can still be sealed (not at a table, not handed
    // over); staff change it drink by drink.
    const mode = (db.prepare(`SELECT mode FROM orders WHERE id = ?`).get(input.orderId) as { mode: OrderMode } | undefined)
      ?.mode;
    const drinkIds = new Set(holding.filter((h) => isDrink(h.ing) && held(h).need > 0).map((h) => h.ingredientId));
    let drinksBack: Set<string>;
    if (outcome !== 'made') drinksBack = new Set();
    else if (input.putBack === undefined) {
      drinksBack = mode !== undefined && drinksGoBackByDefault(mode, input.statusBefore) ? drinkIds : new Set();
    } else {
      if (input.putBack.length > 0 && handedOver(input.statusBefore)) {
        throw new Error("Drinks that were handed over can't go back on the shelf");
      }
      for (const id of input.putBack) {
        if (!drinkIds.has(id)) throw new Error('Only sealed drinks on this order can go back when the food was made');
      }
      drinksBack = new Set(input.putBack);
    }

    const counted = outcome === 'not_made' ? countedSince(db, actor.deviceId, holding) : new Set<string>();
    const note = (kind: Parameters<typeof orderStockNote>[0]) => orderStockNote(kind, input.how);
    /** A row on this till's count, or (`here` false) booked for the other till's. */
    const move = (ingredientId: string, deltaQty: number, reason: 'sale' | 'waste' | 'count', notes: string, here = true) =>
      recordStockMovement(
        db,
        { ingredientId, deltaQty, reason, refOrderId: input.orderId, notes, ...(here ? {} : { countHere: false }) },
        actor,
      );

    const lines: OrderStockLine[] = [];
    let wasteCents = 0;
    let skipped = 0;
    for (const h of holding) {
      const { need, mine, theirs } = held(h);
      const ln = lineNote(h, counted);
      const line = baseLine(h, need, ln);
      line.putBack = 0;
      line.alreadyCounted = 0;
      line.putBackThere = 0;
      line.wasted = 0;
      line.wasteCents = 0;
      lines.push(line);
      if (ln === 'deleted' || ln === 'unit_changed' || need === 0) {
        skipped += 1;
        continue;
      }
      if (outcome === 'not_made') {
        if (mine > 0) {
          move(h.ingredientId, mine, 'sale', note(counted.has(h.ingredientId) ? 'already_counted' : 'put_back'));
          if (counted.has(h.ingredientId)) {
            // The stock take after sending saw it on the shelf: the count stays.
            move(h.ingredientId, -mine, 'count', note('already_counted'));
            line.alreadyCounted = mine;
          } else {
            line.putBack = mine;
          }
        }
        // The other till's share: booked here without moving this count; the
        // till that took it puts it back on its own when the row arrives.
        if (theirs > 0) {
          move(h.ingredientId, theirs, 'sale', note('put_back_other_till'), false);
          line.putBackThere = theirs;
        }
      } else if (drinksBack.has(h.ingredientId)) {
        if (mine > 0) {
          move(h.ingredientId, mine, 'sale', note('drink_back'));
          line.putBack = mine;
        }
        if (theirs > 0) {
          move(h.ingredientId, theirs, 'sale', note('drink_back_other_till'), false);
          line.putBackThere = theirs;
        }
      } else {
        // Made: the sale undone and booked as waste — on this count for this
        // till's share (up, then down), and without moving it for the other's.
        if (mine > 0) {
          move(h.ingredientId, mine, 'sale', note('moved_to_waste'));
          move(h.ingredientId, -mine, 'waste', note('waste'));
        }
        if (theirs > 0) {
          move(h.ingredientId, theirs, 'sale', note('moved_to_waste'), false);
          move(h.ingredientId, -theirs, 'waste', note('waste'), false);
        }
        line.wasted = need;
        line.wasteCents = cost(h.ing, need);
        wasteCents += line.wasteCents;
      }
    }
    lines.sort(byName);

    const returned = (l: OrderStockLine) => (l.putBack ?? 0) + (l.alreadyCounted ?? 0) + (l.putBackThere ?? 0) > 0;
    const settlement: StockSettlement = {
      outcome,
      answered,
      how: input.how,
      statusBefore: input.statusBefore,
      lines,
      wasteCents,
      drinksBack: outcome === 'made' ? lines.filter((l) => l.drink && returned(l)).length : 0,
      returnedLines: lines.filter(returned).length,
      wastedLines: lines.filter((l) => (l.wasted ?? 0) > 0).length,
      skipped,
      hasCosts: lines.some((l) => l.estCostCents !== 0),
      hiddenLines: 0,
    };

    // Who decided what — the order's own trail (each row above also has its own).
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: outcome === 'made' ? 'stock_to_waste' : 'stock_put_back',
      actorUserId: actor.userId,
      before: { status: input.statusBefore, takenAt: ledger.takenAt },
      after: {
        outcome,
        answered,
        how: input.how,
        approverUserId: input.approverUserId,
        hint: question.hint,
        preselect: question.preselect,
        lean: question.lean,
        againstHint: answered === 'staff' && answerWentAgainstHint(question, outcome),
        wasteCents,
        skipped,
        lines: lines.map((l) => ({
          ingredientId: l.ingredientId,
          name: l.name,
          unit: l.unit,
          qty: l.qty,
          putBack: l.putBack,
          alreadyCounted: l.alreadyCounted,
          putBackThere: l.putBackThere,
          wasted: l.wasted,
          note: l.note,
        })),
      },
    });
    result = settlement;
  })();
  return result;
}
