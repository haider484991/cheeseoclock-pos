import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { nowIso } from '../db/repositories/base.js';
import { getCurrentShift } from '../db/repositories/shift-repo.js';
import { broadcastAlertWatchChanged } from './alert-watch-events.js';
import {
  getWebBridgeConfig,
  getWebOrdersShiftPause,
  isWebBridgeReady,
  setWebOrdersShiftPause,
} from './web-bridge-config.js';
import { webOrdersBridge } from './web-orders-bridge.js';

/**
 * Website orders follow the shifts on this till (owner, 2026-09-27).
 *
 *  - The LAST open shift on this till closes → the till pauses website orders
 *    by itself ('shift closed'): the heartbeat says "not accepting" at once,
 *    so the website stops taking orders nobody is on shift to cook. Orders
 *    already placed are still pulled in and put on the board.
 *  - A shift opens → the pause is lifted and the heartbeat says "accepting"
 *    again — unless the owner switched website ordering off by hand, which
 *    stays off: the pause is kept apart from that switch and never writes it
 *    (web-bridge-config.ts, storeAcceptingOrders).
 *
 * Called by the shifts:open / shifts:close handlers after the shift is saved.
 * It never throws: a website problem must never stop a shift opening or
 * closing. With no website connection set up it only records the pause.
 * When the pause changes, the screens hear first ('alerts:watch-changed'),
 * so the PIN screen says so even if the website cannot be reached.
 */
export function followShiftForWebOrders(
  db: AppDatabase,
  deviceId: string,
  change: 'opened' | 'closed',
  actorUserId: string | null,
): void {
  try {
    if (!recordShiftPause(db, deviceId, change, actorUserId)) return;
  } catch (e) {
    log.warn('Could not record the website-orders shift pause', {
      change,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  try {
    broadcastAlertWatchChanged();
  } catch (e) {
    log.warn('Could not tell the screens about the website-orders pause', {
      change,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    webOrdersBridge.refreshStoreStatus();
  } catch (e) {
    log.warn('Could not tell the website about the shift change', {
      change,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Set or lift the pause for this change; true when it changed. */
function recordShiftPause(
  db: AppDatabase,
  deviceId: string,
  change: 'opened' | 'closed',
  actorUserId: string | null,
): boolean {
  if (change === 'opened') {
    const lifted = setWebOrdersShiftPause(db, null, actorUserId);
    if (lifted) log.info('Website-orders shift pause lifted: a shift was opened');
    return lifted;
  }
  // Another shift still open on this till keeps website orders going.
  if (getCurrentShift(db, deviceId)) return false;
  const paused = setWebOrdersShiftPause(
    db,
    { reason: 'shift_closed', since: nowIso() },
    actorUserId,
  );
  if (paused) log.info('Website orders paused: the last open shift on this till closed');
  return paused;
}

/**
 * Would closing `shiftId` pause website orders on this till? True when the
 * owner's switch is on, the website link is set, and no OTHER shift stays
 * open here (one open shift per till: idx_shifts_one_open_per_device) — the
 * same "last open shift on this till" rule as recordShiftPause. Read by
 * shifts:closeCheck so the close box can say so first. Never throws.
 */
export function closeWouldPauseWebOrders(db: AppDatabase, deviceId: string, shiftId: string): boolean {
  try {
    const cfg = getWebBridgeConfig(db);
    if (!cfg.enabled || !isWebBridgeReady(cfg).ok) return false;
    const open = getCurrentShift(db, deviceId);
    return !open || open.id === shiftId;
  } catch {
    return false;
  }
}

/**
 * At start: a pause stored while a shift is open on this till is lifted. It
 * happens when the till stopped between opening a shift and lifting the
 * pause, or when that write failed; left alone, the website would stay shut
 * all shift with nothing on screen to say so. Audited with no person:
 * the till did it. It only ever lifts — a pause is set by a close, never at
 * start — and it never throws.
 */
export function healShiftPause(db: AppDatabase, deviceId: string): void {
  try {
    if (!getWebOrdersShiftPause(db) || !getCurrentShift(db, deviceId)) return;
    if (setWebOrdersShiftPause(db, null, null)) {
      log.info('Website-orders shift pause lifted at start: a shift is open');
    }
  } catch (e) {
    log.warn('Could not check the website-orders shift pause at start', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
