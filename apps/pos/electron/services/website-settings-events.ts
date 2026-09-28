import { EventEmitter } from 'node:events';

/**
 * A setting the website needs changed on this till — the delivery areas and
 * fees, or the pick-up offer (the settings block of the menu publish) —
 * saved here (settings handlers) or arrived from the other till (sync-worker,
 * after applyRemoteBatch). The web bridge listens and publishes the menu
 * with the newer block (web-orders-bridge maybePublishSettings): ANY till
 * with the website link, not only the one where the owner pressed Save.
 *
 * In-process and free of Electron, so the handlers and the sync worker tell
 * the bridge without importing it (it loads better-sqlite3 and the backup
 * code), and tests can listen.
 */
const bus = new EventEmitter();
const CHANGED = 'website-settings:changed';

export function websiteSettingsChanged(): void {
  bus.emit(CHANGED);
}

export function onWebsiteSettingsChanged(cb: () => void): () => void {
  bus.on(CHANGED, cb);
  return () => bus.off(CHANGED, cb);
}
