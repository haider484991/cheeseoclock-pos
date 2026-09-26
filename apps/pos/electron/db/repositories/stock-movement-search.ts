/**
 * Read side of the stock movement history, for the Inventory → Movements
 * screen. Kept apart from stock-movement-repo.ts (the write side the till
 * uses on every sale) so the screen can grow without touching the sale path.
 *
 * Movements grow without end (every sale writes one per ingredient), so this
 * pages in SQL rather than handing the screen everything.
 */

import type { AppDatabase } from '../connection.js';
import type {
  StockMovementEntry,
  StockMovementPage,
  StockMovementReason,
  StockMovementSearch,
} from '@cheeseoclock/shared-types';

const MAX_PAGE = 200;

interface EntryRow {
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
  ingredient_name: string | null;
  unit: string | null;
  actor_name: string | null;
  order_number: string | null;
  po_ref: string | null;
}

// LEFT JOINs: a deleted ingredient's history must still show its name, and a
// movement is never hidden because its order or user row is gone.
const FROM = `
  FROM stock_movements sm
  LEFT JOIN ingredients i ON i.id = sm.ingredient_id
  LEFT JOIN users u ON u.id = sm.actor_user_id
  LEFT JOIN orders o ON o.id = sm.ref_order_id
  LEFT JOIN purchase_orders po ON po.id = sm.ref_purchase_order_id
`;

/** "moz  sauce" → ['moz', 'sauce'], each safe inside LIKE '%…%' ESCAPE '\'. */
export function searchTokens(search: string | undefined): string[] {
  return (search ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => t.replace(/[\\%_]/g, (c) => `\\${c}`));
}

function whereClause(
  opts: StockMovementSearch,
  includeReason: boolean,
): { sql: string; params: unknown[] } {
  const where: string[] = ['sm.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (includeReason && opts.reason) {
    where.push('sm.reason = ?');
    params.push(opts.reason);
  }
  if (opts.ingredientId) {
    where.push('sm.ingredient_id = ?');
    params.push(opts.ingredientId);
  }
  if (opts.sinceIso) {
    where.push('sm.occurred_at >= ?');
    params.push(opts.sinceIso);
  }
  if (opts.untilIso) {
    where.push('sm.occurred_at < ?');
    params.push(opts.untilIso);
  }
  // Every word has to match somewhere: the ingredient, the note, the order
  // number or the purchase order reference.
  for (const token of searchTokens(opts.search)) {
    where.push(
      `(i.name LIKE ? ESCAPE '\\' OR sm.notes LIKE ? ESCAPE '\\'
        OR o.order_number LIKE ? ESCAPE '\\' OR po.reference_no LIKE ? ESCAPE '\\')`,
    );
    const like = `%${token}%`;
    params.push(like, like, like, like);
  }
  return { sql: where.join(' AND '), params };
}

export function searchMovements(db: AppDatabase, input?: StockMovementSearch): StockMovementPage {
  const opts = input ?? {};
  const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const filtered = whereClause(opts, true);
  const rows = db
    .prepare(
      `SELECT sm.id, sm.ingredient_id, sm.delta_qty, sm.reason, sm.ref_order_id, sm.ref_purchase_order_id,
              sm.notes, sm.actor_user_id, sm.occurred_at, sm.resulting_qty,
              i.name AS ingredient_name, i.unit AS unit, u.full_name AS actor_name,
              o.order_number AS order_number, po.reference_no AS po_ref
         ${FROM}
        WHERE ${filtered.sql}
        ORDER BY sm.occurred_at DESC, sm.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...filtered.params, limit, offset) as EntryRow[];

  // The chip counts ignore the reason filter, so every chip says what it would show.
  const unreasoned = whereClause(opts, false);
  const counts = db
    .prepare(`SELECT sm.reason AS reason, COUNT(*) AS n ${FROM} WHERE ${unreasoned.sql} GROUP BY sm.reason`)
    .all(...unreasoned.params) as Array<{ reason: StockMovementReason; n: number }>;
  const reasonCounts: StockMovementPage['reasonCounts'] = {};
  for (const c of counts) reasonCounts[c.reason] = c.n;
  const total = opts.reason
    ? reasonCounts[opts.reason] ?? 0
    : counts.reduce((sum, c) => sum + c.n, 0);

  return { rows: rows.map(rowToEntry), total, reasonCounts };
}

function rowToEntry(r: EntryRow): StockMovementEntry {
  return {
    id: r.id as StockMovementEntry['id'],
    ingredientId: r.ingredient_id as StockMovementEntry['ingredientId'],
    deltaQty: r.delta_qty,
    reason: r.reason,
    refOrderId: r.ref_order_id as StockMovementEntry['refOrderId'],
    refPurchaseOrderId: r.ref_purchase_order_id as StockMovementEntry['refPurchaseOrderId'],
    notes: r.notes,
    actorUserId: r.actor_user_id as StockMovementEntry['actorUserId'],
    occurredAt: r.occurred_at,
    resultingQty: r.resulting_qty,
    ingredientName: r.ingredient_name ?? 'Unknown ingredient',
    unit: r.unit ?? '',
    actorName: r.actor_name,
    orderNumber: r.order_number,
    purchaseOrderRef: r.po_ref,
  };
}
