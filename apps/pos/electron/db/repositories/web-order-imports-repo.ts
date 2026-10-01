import type { AppDatabase } from '../connection.js';
import type { OrderStatus, WebFulfilment } from '@cheeseoclock/shared-types';

/**
 * What the till knows about each website order it took in, past the import
 * itself: whether the website confirmed it, whether someone saw its alert,
 * and whether the website cancelled it while the kitchen had it. The columns
 * are migration 0046's (web_order_imports itself is 0012's).
 *
 * Pure-local (not synced), like print_queue: web_order_imports is per till
 * and only the till running the website link writes it (sync-core's
 * sync-contract.ts lists it). So this repo doesn't go through writeWithSync:
 * no sync_queue row and no audit row, just the bookkeeping columns. The
 * orders themselves are business rows and are only read here.
 *
 * Any of these may throw on a database error. Callers (the web bridge, the
 * alert hub) wrap every call, so a failed mark never stops an import or an
 * alert.
 */

/** The most ids one mark takes. The alert list never holds this many; a longer list is cut, not refused. */
export const MAX_MARK_IDS = 200;

/** Distinct non-empty ids, at most MAX_MARK_IDS of them, in the order given. */
function markIds(ids: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (out.size >= MAX_MARK_IDS) break;
    if (typeof id === 'string' && id.length > 0) out.add(id);
  }
  return [...out];
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * The website confirmed this order (its ack, or an answer to a status push).
 * The first time is kept: a later confirmation never moves it.
 */
export function markWebOrderAcked(db: AppDatabase, webOrderId: string, at: string): void {
  db.prepare(
    `UPDATE web_order_imports
        SET acked_at = COALESCE(acked_at, ?), updated_at = ?
      WHERE web_order_id = ?`,
  ).run(at, at, webOrderId);
}

/** An imported order the website has not confirmed yet, with what the ack and its check need. */
export interface UnackedImport {
  webOrderId: string;
  posOrderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  /** Deleted on this till (a test order, say): the website is told 'cancelled'. */
  orderDeleted: boolean;
  importedAt: string;
}

interface UnackedRaw {
  web_order_id: string;
  pos_order_id: string;
  order_number: string;
  status: OrderStatus;
  deleted_at: string | null;
  imported_at: string;
}

/**
 * Imported orders still waiting for the website's confirmation, oldest
 * first: imported since `sinceIso`, not confirmed, not cancelled on the
 * website. The ack retry goes through them on every poll (it stops at the
 * first failure). Rides on idx_web_imports_unacked.
 */
export function listUnackedImports(db: AppDatabase, sinceIso: string, limit = 25): UnackedImport[] {
  const rows = db
    .prepare(
      `SELECT wi.web_order_id, wi.pos_order_id, wi.imported_at,
              o.order_number, o.status, o.deleted_at
         FROM web_order_imports wi
         JOIN orders o ON o.id = wi.pos_order_id
        WHERE wi.status = 'imported'
          AND wi.acked_at IS NULL
          AND wi.site_cancelled_at IS NULL
          AND wi.pos_order_id IS NOT NULL
          AND wi.imported_at >= ?
        ORDER BY wi.imported_at
        LIMIT ?`,
    )
    .all(sinceIso, limit) as UnackedRaw[];
  return rows.map((r) => ({
    webOrderId: r.web_order_id,
    posOrderId: r.pos_order_id,
    orderNumber: r.order_number,
    orderStatus: r.status,
    orderDeleted: r.deleted_at !== null,
    importedAt: r.imported_at,
  }));
}

/**
 * The website cancelled an order the kitchen has. Recorded once: true the
 * first time (the till raises the loud card then), false after that. It
 * also counts as the website's answer, and as its last status 'cancelled'.
 */
export function markCancelledOnSite(db: AppDatabase, webOrderId: string, at: string): boolean {
  const result = db
    .prepare(
      `UPDATE web_order_imports
          SET site_cancelled_at = ?,
              acked_at = COALESCE(acked_at, ?),
              last_pushed_status = 'cancelled',
              updated_at = ?
        WHERE web_order_id = ? AND site_cancelled_at IS NULL`,
    )
    .run(at, at, at, webOrderId);
  return Number(result.changes) > 0;
}

/**
 * Someone saw these orders' new-order alert (Seen, View, or Live Orders
 * opened), by POS order id: after a restart they do not ring again. The
 * first time is kept. Returns how many rows were marked.
 */
export function markAlertsSeen(db: AppDatabase, posOrderIds: readonly string[], at: string): number {
  const ids = markIds(posOrderIds);
  if (ids.length === 0) return 0;
  const result = db
    .prepare(
      `UPDATE web_order_imports
          SET alert_seen_at = ?
        WHERE pos_order_id IN (${placeholders(ids.length)}) AND alert_seen_at IS NULL`,
    )
    .run(at, ...ids);
  return Number(result.changes);
}

/**
 * Someone signed in closed the "website cancelled order" card for these
 * website orders: it does not come back after a restart. Only rows the
 * website did cancel; the first time is kept. Returns how many were marked.
 */
export function markCancelNoted(db: AppDatabase, webOrderIds: readonly string[], at: string): number {
  const ids = markIds(webOrderIds);
  if (ids.length === 0) return 0;
  const result = db
    .prepare(
      `UPDATE web_order_imports
          SET cancel_noted_at = ?
        WHERE web_order_id IN (${placeholders(ids.length)})
          AND site_cancelled_at IS NOT NULL
          AND cancel_noted_at IS NULL`,
    )
    .run(at, ...ids);
  return Number(result.changes);
}

/** A website order nobody has seen yet, as the new-order alert needs it after a restart. */
export interface UnseenWebOrder {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  webOrderId: string;
  fulfilment: WebFulfilment;
  /** The till's own total. */
  totalCents: number;
  /** What the website showed the customer (NULL on a row imported before 0046). */
  webTotalCents: number | null;
  importedAt: string;
}

interface UnseenRaw {
  pos_order_id: string;
  order_number: string;
  customer_name_snapshot: string | null;
  web_order_id: string;
  mode: string;
  total_cents: number;
  web_total_cents: number | null;
  imported_at: string;
}

/**
 * Website orders imported since `sinceIso` whose alert nobody has seen and
 * that are still New on the board (sent to the kitchen, not started, not
 * deleted), oldest first. A pick-up is imported as a takeaway order, so a
 * takeaway here is a pick-up and anything else a delivery.
 */
export function unseenWebOrders(db: AppDatabase, sinceIso: string): UnseenWebOrder[] {
  const rows = db
    .prepare(
      `SELECT wi.pos_order_id, wi.web_order_id, wi.web_total_cents, wi.imported_at,
              o.order_number, o.customer_name_snapshot, o.mode, o.total_cents
         FROM web_order_imports wi
         JOIN orders o ON o.id = wi.pos_order_id
        WHERE wi.status = 'imported'
          AND wi.alert_seen_at IS NULL
          AND wi.imported_at >= ?
          AND o.status = 'sent_to_kitchen'
          AND o.deleted_at IS NULL
        ORDER BY wi.imported_at`,
    )
    .all(sinceIso) as UnseenRaw[];
  return rows.map((r) => ({
    orderId: r.pos_order_id,
    orderNumber: r.order_number,
    customerName: r.customer_name_snapshot,
    webOrderId: r.web_order_id,
    fulfilment: r.mode === 'takeaway' ? 'pickup' : 'delivery',
    totalCents: Number(r.total_cents),
    webTotalCents: r.web_total_cents === null ? null : Number(r.web_total_cents),
    importedAt: r.imported_at,
  }));
}

/** A website cancel of an order the kitchen had, whose card nobody signed in has closed yet. */
export interface OpenSiteCancel {
  webOrderId: string;
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  siteCancelledAt: string;
}

interface SiteCancelRaw {
  web_order_id: string;
  pos_order_id: string;
  site_cancelled_at: string;
  order_number: string;
  customer_name_snapshot: string | null;
  customer_phone_snapshot: string | null;
}

/**
 * Website cancels since `sinceIso` whose card is still open, oldest first.
 * An order since deleted, voided or refunded here was dealt with: it is
 * left out. The name and phone are for the signed-in card only.
 */
export function openSiteCancels(db: AppDatabase, sinceIso: string): OpenSiteCancel[] {
  const rows = db
    .prepare(
      `SELECT wi.web_order_id, wi.pos_order_id, wi.site_cancelled_at,
              o.order_number, o.customer_name_snapshot, o.customer_phone_snapshot
         FROM web_order_imports wi
         JOIN orders o ON o.id = wi.pos_order_id
        WHERE wi.site_cancelled_at >= ?
          AND wi.cancel_noted_at IS NULL
          AND o.deleted_at IS NULL
          AND o.status NOT IN ('void', 'refunded')
        ORDER BY wi.site_cancelled_at`,
    )
    .all(sinceIso) as SiteCancelRaw[];
  return rows.map((r) => ({
    webOrderId: r.web_order_id,
    orderId: r.pos_order_id,
    orderNumber: r.order_number,
    customerName: r.customer_name_snapshot,
    customerPhone: r.customer_phone_snapshot,
    siteCancelledAt: r.site_cancelled_at,
  }));
}

/** A website order the website has not confirmed for a while. Numbers and times only: the PIN screen shows it. */
export interface UnconfirmedWebOrder {
  orderId: string;
  orderNumber: string;
  importedAt: string;
  /** When the customer placed it (NULL on a row imported before 0046). */
  webCreatedAt: string | null;
}

interface UnconfirmedRaw {
  pos_order_id: string;
  order_number: string;
  imported_at: string;
  web_created_at: string | null;
}

/**
 * Imported orders the website has still not confirmed, imported between
 * `sinceIso` and `olderThanIso` (so not one that came in a moment ago),
 * oldest first. One cancelled on the website, or deleted, voided or
 * refunded here, is not waiting for anything and is left out.
 */
export function unconfirmedWebOrders(
  db: AppDatabase,
  range: { olderThanIso: string; sinceIso: string },
): UnconfirmedWebOrder[] {
  const rows = db
    .prepare(
      `SELECT wi.pos_order_id, wi.imported_at, wi.web_created_at, o.order_number
         FROM web_order_imports wi
         JOIN orders o ON o.id = wi.pos_order_id
        WHERE wi.status = 'imported'
          AND wi.acked_at IS NULL
          AND wi.site_cancelled_at IS NULL
          AND wi.imported_at <= ?
          AND wi.imported_at >= ?
          AND o.deleted_at IS NULL
          AND o.status NOT IN ('void', 'refunded')
        ORDER BY wi.imported_at`,
    )
    .all(range.olderThanIso, range.sinceIso) as UnconfirmedRaw[];
  return rows.map((r) => ({
    orderId: r.pos_order_id,
    orderNumber: r.order_number,
    importedAt: r.imported_at,
    webCreatedAt: r.web_created_at,
  }));
}
