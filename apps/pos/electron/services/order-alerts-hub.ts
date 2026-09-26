import { BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../db/connection.js';
import { OrderAlertsHub, type AttentionNotice } from './order-alerts.js';

/**
 * The real wiring for OrderAlertsHub: the database (to see which orders have
 * moved along), the taskbar flash and the Windows notice.
 *
 * The notice is shown by the main process itself, so it still works when the
 * screen is reloading or not answering. It is silent: the till's own chime
 * plays from the screen, and Windows' sound on top would ring twice.
 */

let db: AppDatabase | null = null;
/** Kept on purpose: a notice that is garbage-collected never reports its click. */
let current: Notification | null = null;

/** Called once the database is open (IPC registration). */
export function attachOrderAlertsDb(database: AppDatabase): void {
  db = database;
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
});
