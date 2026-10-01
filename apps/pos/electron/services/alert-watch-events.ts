import { BrowserWindow } from 'electron';

/**
 * Part of the PIN screen's watch (alerts:getWatch) changed: website orders
 * were paused or started again on this till, or the owner saved the website
 * link or "Accept online orders". No payload: the screens read the watch
 * again, so a missed or late event can never leave stale words on screen.
 * Main process only.
 */
export const ALERT_WATCH_CHANGED = 'alerts:watch-changed';

export function broadcastAlertWatchChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(ALERT_WATCH_CHANGED);
    } catch {
      // The window is closing: it has nothing left to show.
    }
  }
}
