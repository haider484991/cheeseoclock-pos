import log from 'electron-log/main';
import {
  ALERT_WATCH_MAX_AGE_MIN,
  EMPTY_ALERT_WATCH,
  type AlertWatch,
  type OrderSource,
  type WatchOrder,
} from '@cheeseoclock/shared-types';
import { readShopSetting } from '../db/business-settings-read.js';
import type { AppDatabase } from '../db/connection.js';
import { kitchenTicketsNotPrinted } from '../db/repositories/print-queue-repo.js';
import { getCurrentShift } from '../db/repositories/shift-repo.js';
import { unconfirmedWebOrders } from '../db/repositories/web-order-imports-repo.js';
import {
  getWebBridgeConfig,
  getWebOrdersShiftPause,
  webOrdersPauseView,
} from './web-bridge-config.js';
import { ACK_RETRY_WINDOW_MS, WEBSITE_UNCONFIRMED_TTL_MS } from './web-order-age.js';

/** A website order the website has not confirmed for this long gets a note on every screen. */
export const ACK_WARN_AFTER_MS = 5 * 60_000;
/**
 * Not-confirmed orders are looked for this far back: as far as the bridge
 * keeps asking the website again (ACK_RETRY_WINDOW_MS), so the note's "the
 * till keeps trying" stays true.
 */
export const ACK_WATCH_MAX_AGE_MS = ACK_RETRY_WINDOW_MS;
/** At most this many kitchen orders are listed (the oldest first). */
export const WATCH_ORDERS_MAX = 200;

/**
 * What every screen may show between logins (alerts:getWatch, no login): the
 * PIN screen polls it, and 'alerts:watch-changed' (alert-watch-events.ts)
 * asks for it again when part of it changes.
 *
 * Only ids, order numbers, statuses, minutes, times and one yes/no leave
 * here — never a customer's name, phone or address, the website address or
 * the connection password. Each part is read on its own: one that fails comes
 * back empty and the others still show. It never throws.
 *
 * The parts:
 *   - webOrders: website orders paused on this till because no shift is open;
 *   - orders: what the kitchen still has (New, Preparing, Ready) from the
 *     last ALERT_WATCH_MAX_AGE_MIN minutes, with whole minutes since each
 *     came in, counted from `now`;
 *   - timing: the owner's "waiting too long" minutes ('kitchen.timing'), as
 *     the PIN screen cannot read the shop rules;
 *   - ticketsNotPrinted: kitchen tickets this till gave up printing, for
 *     those same orders: the PIN screen beeps for orders up to 3 hours old,
 *     so one forgotten in New since yesterday does not beep all night (Live
 *     Orders keeps its "Ticket not printed" strip whatever the order's age);
 *   - unconfirmed: website orders the website has not confirmed for 5
 *     minutes or more, with when the website cancels each one;
 *   - shiftOpen: a shift is open on this till (`deviceId`). Only the yes or
 *     no leaves: not who opened it, when, or any cash. With none open the
 *     shop is closed and the PIN screen's "waiting too long" note does not
 *     beep (false, too, when it cannot be read).
 */
export function readAlertWatch(db: AppDatabase, now: number, deviceId: string): AlertWatch {
  const orders = part('orders', [] as WatchOrder[], () => kitchenOrders(db, now));
  return {
    webOrders: part('website pause', EMPTY_ALERT_WATCH.webOrders, () =>
      webOrdersPauseView(getWebBridgeConfig(db), getWebOrdersShiftPause(db)),
    ),
    orders,
    timing: part('kitchen timing', { ...EMPTY_ALERT_WATCH.timing }, () => {
      const t = readShopSetting(db, 'kitchen.timing').value;
      return { notStartedMin: t.notStartedMin, notDoneMin: t.notDoneMin };
    }),
    // Only the orders above (none, should they not read).
    ticketsNotPrinted: part('tickets not printed', [] as AlertWatch['ticketsNotPrinted'], () =>
      kitchenTicketsNotPrinted(db, { orderIds: orders.map((o) => o.orderId) }).map((t) => ({
        orderId: t.orderId,
        orderNumber: t.orderNumber,
        failedAt: t.failedAt,
      })),
    ),
    unconfirmed: part('not confirmed', [] as AlertWatch['unconfirmed'], () =>
      unconfirmedWebOrders(db, {
        olderThanIso: new Date(now - ACK_WARN_AFTER_MS).toISOString(),
        sinceIso: new Date(now - ACK_WATCH_MAX_AGE_MS).toISOString(),
      }).map((u) => ({
        orderId: u.orderId,
        orderNumber: u.orderNumber,
        minutes: wholeMinutes(u.importedAt, now),
        cancelsAt: cancelsAt(u.webCreatedAt),
      })),
    ),
    shiftOpen: part(
      'shift',
      EMPTY_ALERT_WATCH.shiftOpen,
      () => getCurrentShift(db, deviceId) !== null,
    ),
  };
}

interface KitchenOrderRow {
  id: string;
  order_number: string;
  status: WatchOrder['status'];
  source: OrderSource;
  created_at: string;
}

/**
 * Orders the kitchen still has, oldest first (idx_orders_status_created).
 * created_at stays here: only the minutes go out.
 */
function kitchenOrders(db: AppDatabase, now: number): WatchOrder[] {
  const cutoff = new Date(now - ALERT_WATCH_MAX_AGE_MIN * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, order_number, status, source, created_at
         FROM orders
        WHERE deleted_at IS NULL
          AND status IN ('sent_to_kitchen', 'preparing', 'ready')
          AND created_at >= ?
        ORDER BY created_at
        LIMIT ?`,
    )
    .all(cutoff, WATCH_ORDERS_MAX) as KitchenOrderRow[];
  return rows.map((r) => ({
    orderId: r.id,
    orderNumber: r.order_number,
    status: r.status,
    source: r.source,
    minutes: wholeMinutes(r.created_at, now),
  }));
}

/** Whole minutes from `iso` to `now` (0 for a time that does not read, or one ahead of the clock). */
function wholeMinutes(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0;
}

/** When the website cancels an order it has not seen confirmed; null when the order's website time is not known (imported before 0046). */
function cancelsAt(webCreatedAt: string | null): string | null {
  if (!webCreatedAt) return null;
  const t = Date.parse(webCreatedAt);
  return Number.isFinite(t) ? new Date(t + WEBSITE_UNCONFIRMED_TTL_MS).toISOString() : null;
}

/** One part of the watch, or its empty value when it cannot be read. */
function part<T>(name: string, empty: T, read: () => T): T {
  try {
    return read();
  } catch (e) {
    log.warn(`Alert watch: ${name} not read`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}
