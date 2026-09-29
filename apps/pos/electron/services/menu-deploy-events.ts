import { EventEmitter } from 'node:events';

/**
 * Something the menu files from the costing PC depend on changed on this
 * till (v0.7.32, services/menu-package-service.ts): a setting arrived from
 * the other till (sync-worker, after applyRemoteBatch — the marker of a file
 * the other till put in, 'menu.lastPackage', comes this way), or the owner
 * saved "put in by themselves / wait for my OK" here. The till looks at the
 * website again a moment later instead of at its next regular check.
 *
 * In-process and free of Electron, like website-settings-events.ts: the sync
 * worker and the settings handlers tell the service without importing it.
 */
const bus = new EventEmitter();
const NUDGE = 'menu-deploy:nudge';

export function nudgeMenuDeploy(): void {
  bus.emit(NUDGE);
}

export function onMenuDeployNudge(cb: () => void): () => void {
  bus.on(NUDGE, cb);
  return () => bus.off(NUDGE, cb);
}
