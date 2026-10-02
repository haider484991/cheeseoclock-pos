import type { AppDatabase } from '../connection.js';
import type { OrderMode, OrderSource, OrderStatus, RecentCounterOrder } from '@cheeseoclock/shared-types';
import { COUNTER_ORDER_WINDOW_MS, RECENT_AT_COUNTER_LIMIT, counterOrderNumber } from '@cheeseoclock/pos-domain';
import { getCurrentShift } from './shift-repo.js';
import { REFUSED_ITEM_REFUND_OWED_SQL } from '../order-history-query.js';

/**
 * What the counter (a cashier's login) reads of past orders: this till's
 * orders of the shift open now. Reads only — nothing is written here.
 */

/** At most this many orders share one whole number in that scope (see counterOrderNumber). */
const SAME_NUMBER_LIMIT = 3;

/**
 * Orders taken on this till in the shift open now, newest first. With no
 * shift open: this till's orders taken with no shift. Never older than
 * COUNTER_ORDER_WINDOW_MS (a shift nobody closed does not open up the week),
 * never the draft still being rung up. The same bounds as the counter's rule
 * for opening an order (counterOrderScope in @cheeseoclock/pos-domain).
 *
 * Without `orderNumber`: the newest RECENT_AT_COUNTER_LIMIT. With it: only
 * the order(s) of that same set with that WHOLE number — how a customer back
 * with receipt #1043 after a busy hour is found. A number that is not one
 * (counterOrderNumber) finds nothing. A delivery whose refused item is still
 * to refund (Delivered + Pay with "Customer refused an item") says so.
 */
export function listRecentCounterOrders(
  db: AppDatabase,
  deviceId: string,
  opts: { nowMs?: number; orderNumber?: string } = {},
): RecentCounterOrder[] {
  const since = new Date((opts.nowMs ?? Date.now()) - COUNTER_ORDER_WINDOW_MS).toISOString();
  const shift = getCurrentShift(db, deviceId);
  const scope = shift ? `o.shift_id = ?` : `o.device_id = ? AND o.shift_id IS NULL`;
  const params: unknown[] = [shift ? shift.id : deviceId, since];
  let numberClause = '';
  let limit = RECENT_AT_COUNTER_LIMIT;
  if (opts.orderNumber !== undefined) {
    const n = counterOrderNumber(opts.orderNumber);
    if (!n) return [];
    if ('full' in n) {
      numberClause = ` AND o.order_number = ?`;
      params.push(n.full);
    } else {
      // The part after the day: '…-1043' at the end, so '…-11043' never
      // matches. The suffix is digits only (counterOrderNumber): no wildcards.
      numberClause = ` AND o.order_number LIKE ?`;
      params.push(`%-${n.suffix}`);
    }
    limit = SAME_NUMBER_LIMIT;
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT o.id, o.order_number, o.mode, o.source, o.status, o.created_at, o.paid_at,
              CASE WHEN o.mode = 'delivery' AND o.status = 'paid' AND o.rider_keeps_cents IS NOT NULL
                        AND ${REFUSED_ITEM_REFUND_OWED_SQL} THEN 1 ELSE 0 END AS refund_owed
         FROM orders o
        WHERE ${scope} AND o.deleted_at IS NULL AND o.status <> 'open' AND o.created_at >= ?${numberClause}
        ORDER BY o.created_at DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    order_number: string;
    mode: OrderMode;
    source: OrderSource;
    status: OrderStatus;
    created_at: string;
    paid_at: string | null;
    refund_owed: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    mode: r.mode,
    source: r.source,
    status: r.status,
    createdAt: r.created_at,
    paid: r.paid_at !== null,
    ...(Number(r.refund_owed) === 1 ? { refusedItemRefundOwed: true as const } : {}),
  }));
}
