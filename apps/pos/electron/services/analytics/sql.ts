/**
 * The SQL pieces and small helpers every analytics figure shares (costing
 * spec §9): what counts as a sale, the trading day, the Pakistan hour, the
 * owner's names for order types and payment methods. Reports
 * (business-report.ts) and the Costing page (costing-service.ts) import them
 * from here, and nothing redefines them, so the two never count differently.
 *
 * Every figure is for the orders saved on THIS till (costing spec D14).
 */
import type { ReportChannel, ReportPaymentGroup } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';

/** Pakistan is UTC+5 all year (no daylight saving). */
export const PKT_OFFSET_MS = 5 * 3_600_000;
/** The trading day starts at 05:00 Pakistan time = 00:00 UTC. */
export const TRADING_DAY_OFFSET_MS = 5 * 3_600_000 - PKT_OFFSET_MS;
export const DAY_MS = 86_400_000;

/** Orders started in [since, until) (alias `o`; two params). */
export const IN_RANGE = `o.created_at >= ? AND o.created_at < ?`;

/**
 * The orders every sales figure counts: paid, not cancelled or fully
 * refunded (alias `o`).
 */
export const COUNTED = `o.deleted_at IS NULL AND o.paid_at IS NOT NULL AND o.status NOT IN ('void', 'refunded')`;

/** Money handed back on an order (a positive number): its negative payment rows (alias `o`). */
export const REFUNDED = `COALESCE((SELECT -SUM(rp.amount_cents) FROM payments rp
                    WHERE rp.order_id = o.id AND rp.amount_cents < 0 AND rp.deleted_at IS NULL), 0)`;

export function paymentGroup(method: string): ReportPaymentGroup {
  if (method === 'cash' || method === 'card' || method === 'foodpanda') return method;
  return 'transfer'; // easypaisa, jazzcash, bank_transfer
}

/** Where an order came from, in the owner's words. */
export function channelOf(mode: string, source: string): ReportChannel {
  if (mode === 'foodpanda') return 'foodpanda';
  if (source === 'web') return mode === 'takeaway' ? 'web_pickup' : 'web_delivery';
  if (mode === 'delivery' || mode === 'takeaway' || mode === 'dine_in') return mode;
  return 'online';
}

/** The trading day (YYYY-MM-DD) an instant belongs to. */
export function tradingDayOf(iso: string): string {
  return new Date(Date.parse(iso) - TRADING_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Pakistan clock hour (0–23) of an instant. */
export function pakistanHourOf(iso: string): number {
  return new Date(Date.parse(iso) + PKT_OFFSET_MS).getUTCHours();
}

/**
 * When this till's first COUNTED order was started, or null with none yet:
 * before it, the till has "no data then" (costing spec 4.10). Counted like
 * every figure it guards, so a training order rung and voided, or an empty
 * cart left open, before the shop really started does not mark the till as
 * trading from that day. Walks idx_orders_created from the oldest order and
 * stops at the first counted one.
 */
export function firstOrderMs(db: AppDatabase): number | null {
  const row = db.prepare(`SELECT o.created_at AS at FROM orders o WHERE ${COUNTED} ORDER BY o.created_at LIMIT 1`).get() as
    | { at: string | null }
    | undefined;
  const t = row?.at ? Date.parse(row.at) : NaN;
  return Number.isFinite(t) ? t : null;
}
