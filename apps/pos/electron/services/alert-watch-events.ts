import { EventEmitter } from 'node:events';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';

/**
 * Part of the PIN screen's watch (alerts:getWatch) changed: website orders
 * were paused or started again on this till, or the owner saved the website
 * link or "Accept online orders". No payload: the screens read the watch
 * again, so a missed or late event can never leave stale words on screen.
 * Main process only.
 *
 * The main process hears it too (onAlertWatchChanged): keeping this computer
 * awake follows whether this till takes website orders (till-power-hub.ts).
 */
export const ALERT_WATCH_CHANGED = 'alerts:watch-changed';

const bus = new EventEmitter();

export function broadcastAlertWatchChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(ALERT_WATCH_CHANGED);
    } catch {
      // The window is closing: it has nothing left to show.
    }
  }
  try {
    bus.emit(ALERT_WATCH_CHANGED);
  } catch (e) {
    // A listener's problem must never undo the change that was just saved.
    log.warn('Alert watch: a listener in the main process failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The main process's own listeners (no IPC). Returns the unsubscribe. */
export function onAlertWatchChanged(cb: () => void): () => void {
  bus.on(ALERT_WATCH_CHANGED, cb);
  return () => bus.off(ALERT_WATCH_CHANGED, cb);
}
