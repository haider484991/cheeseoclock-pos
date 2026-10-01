import { EventEmitter } from 'node:events';

/**
 * The owner saved "This computer" ('pc.power': keep it awake, start the till
 * with Windows), or put its default back (settings:setTill). The till applies
 * it at once (till-power-hub.ts), not at the next start.
 *
 * In-process and free of Electron, like menu-deploy-events.ts: the settings
 * handlers tell the wiring without importing it (it loads powerSaveBlocker
 * and powerMonitor), and tests can listen.
 */
const bus = new EventEmitter();
const CHANGED = 'till-power:changed';

export function tillPowerSettingsChanged(): void {
  bus.emit(CHANGED);
}

export function onTillPowerSettingsChanged(cb: () => void): () => void {
  bus.on(CHANGED, cb);
  return () => bus.off(CHANGED, cb);
}
