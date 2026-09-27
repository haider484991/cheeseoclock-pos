/**
 * Reading the stock ledger for SHOP stock and "used vs should have used"
 * (costing spec 4.6, Phase 8). Read-only, and free of Electron: the stock
 * take's finish (repositories/stock-count-repo.ts, main process) and the
 * Reports worker (services/analytics/stock-control.ts) both load it. The
 * rules are pos-domain's (shop-stock.ts ledgerDate, variance.ts ledgerKind):
 * the bulk of a window — tens of thousands of rows a month — is added up
 * here in SQL that follows them exactly (tested against pos-domain dating
 * every row itself), and the few other rows are handed over one by one.
 *
 * Every till's rows count (a row synced from the other till is shop stock
 * too); 'count' rows are read but never move the shop's stock.
 */
import { shopStockOfSums, type CountAnchor, type LedgerRow, type ShopStock } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from './connection.js';

/** A stock row as the ledger readers hand it out. */
export interface LedgerDbRow extends LedgerRow {
  id: string;
  notes: string | null;
  valueCents: number | null;
  costBasis: string | null;
  deviceId: string;
}

/** The columns a ledger row is read with, for the table aliased `a` ('' for none). */
function ledgerCols(a = ''): string {
  return `${a}id AS id, ${a}ingredient_id AS ingredientId, ${a}delta_qty AS deltaQty, ${a}unit AS unit, ${a}reason AS reason,
    ${a}detail AS detail, ${a}ref_order_id AS refOrderId, ${a}ref_group_id AS refGroupId, ${a}occurred_at AS occurredAt,
    ${a}ref_taken_at AS refTakenAt, ${a}notes AS notes, ${a}value_cents AS valueCents, ${a}cost_basis AS costBasis,
    ${a}device_id AS deviceId`;
}
const LEDGER_COLS = ledgerCols();

function toRow(r: Record<string, unknown>): LedgerDbRow {
  return {
    id: String(r['id']),
    ingredientId: String(r['ingredientId']),
    deltaQty: Number(r['deltaQty']),
    unit: (r['unit'] as string | null) ?? null,
    reason: String(r['reason']),
    detail: (r['detail'] as string | null) ?? null,
    refOrderId: (r['refOrderId'] as string | null) ?? null,
    refGroupId: (r['refGroupId'] as string | null) ?? null,
    occurredAt: String(r['occurredAt']),
    refTakenAt: (r['refTakenAt'] as string | null) ?? null,
    notes: (r['notes'] as string | null) ?? null,
    valueCents: r['valueCents'] === null || r['valueCents'] === undefined ? null : Number(r['valueCents']),
    costBasis: (r['costBasis'] as string | null) ?? null,
    deviceId: String(r['deviceId']),
  };
}

/** One ingredient's stock rows written after `afterIso`, oldest first (idx_movements_ingredient_time). */
export function ledgerRowsOf(db: AppDatabase, ingredientId: string, afterIso: string): LedgerDbRow[] {
  return (
    db
      .prepare(
        `SELECT ${LEDGER_COLS} FROM stock_movements INDEXED BY idx_movements_ingredient_time
          WHERE ingredient_id = ? AND occurred_at > ? AND deleted_at IS NULL
          ORDER BY occurred_at, rowid`,
      )
      .all(ingredientId, afterIso) as Array<Record<string, unknown>>
  ).map(toRow);
}

/**
 * A stock row (alias `m`) that settles an order but kept no ref_taken_at:
 * written before costing (migration 0033). Its date is its order's first
 * take, when earlier, which only the ledger knows.
 */
const SETTLES_WITHOUT_DATE = `m.ref_taken_at IS NULL AND m.ref_order_id IS NOT NULL AND NOT (m.reason = 'sale' AND m.delta_qty < 0)`;

/**
 * d(r) > t0 for a row (alias `m`) written after t0 — pos-domain ledgerDate:
 * its ref_taken_at is after t0; or, settling an order from before costing,
 * its order's first take is (idx_movements_order; the unary + keeps SQLite
 * off the reason index); or it is dated when it was written. Two
 * parameters: t0, t0.
 */
const DATED_AFTER = `CASE
    WHEN m.ref_taken_at IS NOT NULL THEN m.ref_taken_at > ?
    WHEN ${SETTLES_WITHOUT_DATE} THEN
      COALESCE((SELECT MIN(t.occurred_at) FROM stock_movements t
                 WHERE t.ref_order_id = m.ref_order_id AND +t.reason = 'sale' AND t.delta_qty < 0 AND t.deleted_at IS NULL),
               m.occurred_at) > ?
    ELSE 1
  END`;

/** One ingredient's 'sale', 'delivery' and 'waste' rows in the window, added up (in the unit the rows were written in). */
export interface WindowSumsRow {
  ingredientId: string;
  unit: string | null;
  /** Signed, as the rows are written (pos-domain variance addToSums turns them the way the figures read). */
  delivery: number;
  sale: number;
  waste: number;
}

/**
 * The bulk of the window (t0, t1]: every till's 'sale', 'delivery' and
 * 'waste' rows written in it, added up per ingredient in SQL — a month of a
 * busy shop is tens of thousands of rows, too many to hand to JavaScript one
 * by one (costing spec Phase 8 bench: ≤ 200 ms in the worker). A row's date
 * d(r) (pos-domain ledgerDate) is when it was written or, settling an order,
 * when that order first took stock — never later — so a row written in the
 * window counts unless its order took the stock before t0. The rows written
 * AFTER t1 that date back into it (a later cancel) are ledgerRowsToDate's.
 * Walks idx_movements_occurred over the window; tested against pos-domain
 * dating every row itself (stock-control.db.test.ts).
 */
export function ledgerSumsForWindow(db: AppDatabase, sinceIso: string, untilIso: string): WindowSumsRow[] {
  const rows = db
    .prepare(
      `SELECT m.ingredient_id AS ingredientId, m.unit AS unit, m.reason AS reason, SUM(m.delta_qty) AS qty
         FROM stock_movements m INDEXED BY idx_movements_occurred
        WHERE m.occurred_at > ? AND m.occurred_at <= ? AND m.deleted_at IS NULL
          AND m.reason IN ('sale', 'delivery', 'waste')
          AND ${DATED_AFTER}
        GROUP BY m.ingredient_id, m.unit, m.reason`,
    )
    .all(sinceIso, untilIso, sinceIso, sinceIso) as Array<{ ingredientId: string; unit: string | null; reason: string; qty: number }>;
  const out = new Map<string, WindowSumsRow>();
  for (const r of rows) {
    const key = `${r.ingredientId}|${r.unit ?? ''}`;
    let row = out.get(key);
    if (!row) out.set(key, (row = { ingredientId: r.ingredientId, unit: r.unit ?? null, delivery: 0, sale: 0, waste: 0 }));
    if (r.reason === 'sale') row.sale += Number(r.qty);
    else if (r.reason === 'delivery') row.delivery += Number(r.qty);
    else row.waste += Number(r.qty);
  }
  return [...out.values()];
}

/**
 * The window's other rows, one by one, for pos-domain to date (ledgerDate)
 * and classify (ledgerKind) itself — a few a week. Both reads are bounded by
 * the window, however far back it is (the main process runs this itself
 * when the worker is not there):
 *  - every 'adjustment', 'transfer' and 'count' row written in (t0, t1]
 *    (batches, typed fixes, older one-off counts, a stock take's own rows,
 *    "already in the stock take"; idx_movements_reason_time);
 *  - every 'sale', 'waste' or 'count' row settling an order written after t1
 *    whose order first took stock in the window (a later cancel dated back,
 *    with its "already in the stock take" count row; idx_movements_taken,
 *    0038). Nothing else written after t1 dates back: batches and fixes
 *    settle no order, and a settle row with no ref_taken_at could only come
 *    from a till without costing (0033), which the rollout rule rules out
 *    (upgrade both tills together) — and every stock take is after 0038.
 * The caller keeps those whose date falls in the window.
 */
export function ledgerRowsToDate(db: AppDatabase, sinceIso: string, untilIso: string): LedgerDbRow[] {
  const others = db
    .prepare(
      `SELECT ${LEDGER_COLS} FROM stock_movements INDEXED BY idx_movements_reason_time
        WHERE reason IN ('adjustment', 'transfer', 'count') AND occurred_at > ? AND occurred_at <= ? AND deleted_at IS NULL
        ORDER BY occurred_at, rowid`,
    )
    .all(sinceIso, untilIso) as Array<Record<string, unknown>>;
  const settles = db
    .prepare(
      `SELECT ${ledgerCols('m.')}
         FROM stock_movements m INDEXED BY idx_movements_taken
        WHERE m.ref_taken_at > ? AND m.ref_taken_at <= ? AND m.occurred_at > ? AND m.deleted_at IS NULL
          AND m.reason IN ('sale', 'waste', 'count')
        ORDER BY m.occurred_at, m.rowid`,
    )
    .all(sinceIso, untilIso, untilIso) as Array<Record<string, unknown>>;
  return [...others, ...settles].map(toRow);
}

/**
 * When each order FIRST took stock (its earliest negative 'sale' row, any
 * till; idx_movements_order): the date of a settle row written before
 * costing, which kept no ref_taken_at (costing spec 4.6). Asked only for
 * such rows' orders.
 */
export function firstTakesOf(db: AppDatabase, rows: readonly LedgerRow[]): (orderId: string) => string | undefined {
  const ids = [
    ...new Set(
      rows.filter((r) => r.refOrderId !== null && r.refTakenAt === null && !(r.reason === 'sale' && r.deltaQty < 0)).map((r) => r.refOrderId!),
    ),
  ];
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .prepare(
        `SELECT ref_order_id AS orderId, MIN(occurred_at) AS at FROM stock_movements
          WHERE ref_order_id IN (SELECT value FROM json_each(?)) AND reason = 'sale' AND delta_qty < 0 AND deleted_at IS NULL
          GROUP BY ref_order_id`,
      )
      .all(JSON.stringify(chunk)) as Array<{ orderId: string; at: string }>) {
      map.set(r.orderId, r.at);
    }
  }
  return (orderId) => map.get(orderId);
}

/**
 * Each ingredient's last stock take finished at or before `atIso` (any
 * till's): what shop stock starts from. Ingredients never counted by then
 * are absent. A stock take still open, or cancelled, is not one.
 */
export function countAnchors(db: AppDatabase, ingredientIds: readonly string[], atIso: string): Map<string, CountAnchor> {
  const out = new Map<string, CountAnchor>();
  for (let i = 0; i < ingredientIds.length; i += 500) {
    const chunk = ingredientIds.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT l.ingredient_id AS ingredientId, l.counted_qty AS countedQty, l.unit AS unit,
                c.finished_at AS finishedAt, c.id AS countId
           FROM stock_count_lines l JOIN stock_counts c ON c.id = l.stock_count_id
          WHERE l.ingredient_id IN (SELECT value FROM json_each(?)) AND l.deleted_at IS NULL AND l.counted_qty IS NOT NULL
            AND c.status = 'done' AND c.deleted_at IS NULL AND c.finished_at IS NOT NULL AND c.finished_at <= ?
          ORDER BY c.finished_at DESC, c.id DESC`,
      )
      .all(JSON.stringify(chunk), atIso) as Array<{ ingredientId: string; countedQty: number; unit: string | null; finishedAt: string; countId: string }>;
    for (const r of rows) {
      if (out.has(r.ingredientId)) continue;
      out.set(r.ingredientId, { countId: r.countId, countedQty: Number(r.countedQty), unit: r.unit, finishedAt: r.finishedAt });
    }
  }
  return out;
}

/**
 * SHOP stock of each ingredient at `atIso` (costing spec 4.6): its last
 * stock take plus every till's stock rows since, 'count' rows left out;
 * never counted yet: this till's own count (`currentQty`).
 */
export function shopStockAt(
  db: AppDatabase,
  ingredients: ReadonlyArray<{ id: string; unit: string; currentQty: number }>,
  atIso: string,
): Map<string, ShopStock> {
  const anchors = countAnchors(
    db,
    ingredients.map((i) => i.id),
    atIso,
  );
  // Each ingredient's rows since its stock take, added up in SQL per unit
  // they were written in: a full stock take of 90 lines reads a month of the
  // ledger, and the till waits for it. pos-domain shopStockOf is the same
  // figure from the rows one by one (tested against it).
  const moves = db.prepare(SHOP_MOVES_SQL);
  const out = new Map<string, ShopStock>();
  for (const i of ingredients) {
    const anchor = anchors.get(i.id) ?? null;
    const rows = anchor === null ? [] : movesWith(moves, i.id, anchor.finishedAt, atIso);
    out.set(i.id, shopStockOfSums({ unitNow: i.unit, anchor, tillQty: i.currentQty, sums: rows }));
  }
  return out;
}

/** One ingredient's shop rows in (after, at], per unit (shopMovesBetween). Five parameters. */
const SHOP_MOVES_SQL = `SELECT m.unit AS unit, SUM(m.delta_qty) AS qty
     FROM stock_movements m INDEXED BY idx_movements_ingredient_time
    WHERE m.ingredient_id = ? AND m.occurred_at > ? AND m.occurred_at <= ? AND m.deleted_at IS NULL
      AND m.reason <> 'count' AND ${DATED_AFTER}
    GROUP BY m.unit`;

function movesWith(
  stmt: { all(...p: unknown[]): unknown[] },
  ingredientId: string,
  afterIso: string,
  atIso: string,
): Array<{ unit: string | null; qty: number }> {
  return (stmt.all(ingredientId, afterIso, atIso, afterIso, afterIso) as Array<{ unit: string | null; qty: number }>).map((r) => ({
    unit: r.unit ?? null,
    qty: Number(r.qty),
  }));
}

/**
 * Every till's stock rows of one ingredient that count in (afterIso, atIso]
 * (pos-domain ledgerDate), 'count' rows left out, added up per unit they
 * were written in (idx_movements_ingredient_time): what moved the shop's
 * stock between two moments. A settle row written after `afterIso` that
 * dates back before it is left out (DATED_AFTER): its order's take was
 * already behind that moment.
 */
export function shopMovesBetween(db: AppDatabase, ingredientId: string, afterIso: string, atIso: string): Array<{ unit: string | null; qty: number }> {
  return movesWith(db.prepare(SHOP_MOVES_SQL), ingredientId, afterIso, atIso);
}
