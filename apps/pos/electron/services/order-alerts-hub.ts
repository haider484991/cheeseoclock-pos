import { BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import {
  markAlertsSeen,
  markCancelNoted,
  openSiteCancels,
  unseenWebOrders,
} from '../db/repositories/web-order-imports-repo.js';
import {
  FAILURE_TTL_MS,
  OrderAlertsHub,
  RESTORE_MAX_AGE_MS,
  type AttentionNotice,
  type FailedWebOrder,
  type ReceivedWebOrder,
} from './order-alerts.js';

/**
 * The real wiring for OrderAlertsHub: the database (to see which orders have
 * moved along, to keep Seen and closed across a restart, and to bring back
 * what nobody has looked at when the till starts), the taskbar flash and the
 * Windows notice.
 *
 * The notice is shown by the main process itself, so it still works when the
 * screen is reloading or not answering. It is silent: the till's own chime
 * plays from the screen, and Windows' sound on top would ring twice.
 */

let db: AppDatabase | null = null;
/** Kept on purpose: a notice that is garbage-collected never reports its click. */
let current: Notification | null = null;

/**
 * Called once the database is open (IPC registration, before the screen
 * loads): the alerts nobody looked at before the till closed come back, so
 * the screen's first alerts:getPending already has them.
 */
export function attachOrderAlertsDb(database: AppDatabase): void {
  db = database;
  restoreOrderAlerts();
}

function tillWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

/** The cashier is looking at the till: the banner and the chime are enough. */
function tillInFront(w: BrowserWindow): boolean {
  return w.isVisible() && !w.isMinimized() && w.isFocused();
}

function closeCurrent(): void {
  const n = current;
  current = null;
  try {
    n?.close();
  } catch {
    // already gone
  }
}

function bringTillToFront(kind: AttentionNotice['kind'] | 'test'): void {
  const w = tillWindow();
  if (!w) return;
  try {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    w.webContents.send('alerts:open', { kind });
  } catch (e) {
    log.warn('Could not bring the till to the front', e);
  }
}

/**
 * Flash the taskbar button and show a Windows notice — unless the till is
 * already in front (then `force`, for the Settings test, still shows it).
 * Returns whether anything was shown. Never throws.
 */
export function showAttention(
  notice: { kind: AttentionNotice['kind'] | 'test'; title: string; body: string },
  opts: { force?: boolean } = {},
): boolean {
  try {
    const w = tillWindow();
    if (w && !opts.force && tillInFront(w)) return false;
    // Windows flashes it until the till is brought to the front.
    if (w && !tillInFront(w)) w.flashFrame(true);
    if (!Notification.isSupported()) return !!w;
    closeCurrent();
    const n = new Notification({
      title: notice.title.slice(0, 80),
      body: notice.body.slice(0, 200),
      silent: true,
      // An order stays in view until someone deals with it; the test goes by itself.
      timeoutType: notice.kind === 'test' ? 'default' : 'never',
    });
    n.on('click', () => bringTillToFront(notice.kind));
    n.on('close', () => {
      if (current === n) current = null;
    });
    // Notifications switched off for the app, Focus assist, …: say so in the log.
    n.on('failed', (_e, error) => log.warn('Windows notice was not shown', { error }));
    current = n;
    n.show();
    return true;
  } catch (e) {
    log.warn('Could not show the Windows notice', e);
    return false;
  }
}

/** Nothing is waiting any more: stop the flash and take the notice away. */
export function clearAttention(): void {
  try {
    const w = tillWindow();
    if (w) w.flashFrame(false);
  } catch {
    // window closing
  }
  closeCurrent();
}

function stillWaiting(orderIds: readonly string[]): ReadonlySet<string> | null {
  if (!db) return null;
  const ids = orderIds.slice(0, 200);
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare(
      `SELECT id FROM orders
        WHERE status = 'sent_to_kitchen' AND deleted_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export const orderAlerts = new OrderAlertsHub({
  now: () => Date.now(),
  stillWaiting,
  requestAttention: (n) => void showAttention(n),
  clearAttention,
  formatMoney: (cents) => formatCents(cents),
  warn: (message, detail) => log.warn(message, detail),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  persistSeen: (ids) => {
    if (db) markAlertsSeen(db, ids, new Date().toISOString());
  },
  persistClosed: (ids) => {
    if (db) markCancelNoted(db, ids, new Date().toISOString());
  },
});

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** Website orders still New that nobody has seen, imported in the last RESTORE_MAX_AGE_MS. */
function unseenOrders(database: AppDatabase): ReceivedWebOrder[] {
  return unseenWebOrders(database, isoAgo(RESTORE_MAX_AGE_MS)).map((o) => ({
    orderId: o.orderId,
    orderNumber: o.orderNumber,
    customerName: o.customerName ?? '',
    webOrderId: o.webOrderId,
    fulfilment: o.fulfilment,
    totalCents: o.totalCents,
    // Rows from before 0046 have no website total: no "total changed" for them.
    ...(o.webTotalCents !== null && o.webTotalCents !== o.totalCents
      ? { totalMismatch: { webTotalCents: o.webTotalCents, tillTotalCents: o.totalCents } }
      : {}),
    receivedAt: o.importedAt,
  }));
}

/** "Website cancelled" cards nobody signed in has closed, from the last FAILURE_TTL_MS. */
function openCancelCards(database: AppDatabase): FailedWebOrder[] {
  return openSiteCancels(database, isoAgo(FAILURE_TTL_MS)).map((c) => ({
    webOrderId: c.webOrderId,
    customerName: c.customerName ?? '',
    // For the signed-in card only: alerts:getPending drops it while nobody is
    // signed in, and the Windows notice never shows it.
    customerPhone: c.customerPhone,
    orderNumber: c.orderNumber,
    message: 'cancelled on the website while the kitchen had it',
    final: true,
    reason: 'cancelled_on_site',
    at: c.siteCancelledAt,
  }));
}

/**
 * Bring back, after a restart, the website orders nobody has seen and the
 * "website cancelled" cards nobody has closed. Each read stands alone: one
 * that fails is logged and the other still comes back. Never throws.
 */
export function restoreOrderAlerts(): void {
  const database = db;
  if (!database) return;
  let orders: ReceivedWebOrder[] = [];
  let failures: FailedWebOrder[] = [];
  try {
    orders = unseenOrders(database);
  } catch (e) {
    log.warn('Order alerts not restored', { part: 'unseen orders', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    failures = openCancelCards(database);
  } catch (e) {
    log.warn('Order alerts not restored', { part: 'website cancels', error: e instanceof Error ? e.message : String(e) });
  }
  if (orders.length === 0 && failures.length === 0) return;
  try {
    orderAlerts.restore(orders, failures);
    log.info('Order alerts restored', { orders: orders.length, websiteCancels: failures.length });
  } catch (e) {
    log.warn('Order alerts not restored', { error: e instanceof Error ? e.message : String(e) });
  }
}
