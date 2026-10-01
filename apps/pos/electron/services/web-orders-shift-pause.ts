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
  type StoredShiftPause,
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
 *
 * The rule holds from the start too (v0.7.33): a till that takes website
 * orders while no shift is open on it — never opened yet, a fresh setup —
 * is paused at start and when the owner saves the link
 * (pauseWhileNoShiftOpen), so the first shift's open is what starts them.
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
  announcePauseChange(change);
}

/**
 * The pause was just set or lifted: the screens hear first (the PIN screen's
 * notice, the shift controls, and keeping this computer awake, which listens
 * in the main process), then the website. Each in its own try: never throws.
 */
function announcePauseChange(change: 'opened' | 'closed' | 'start'): void {
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
  const paused = setWebOrdersShiftPause(db, shiftClosedPause(), actorUserId);
  if (paused) log.info('Website orders paused: the last open shift on this till closed');
  return paused;
}

/** The pause as a close sets it — the one reason the website knows ('shift_closed'), from now. */
function shiftClosedPause(): StoredShiftPause {
  return { reason: 'shift_closed', since: nowIso() };
}

/**
 * Website orders follow the shift from the start, not only from the first
 * close (v0.7.33, found by the hands-on test of the packaged till): a till
 * with the website link set and "Accept online orders" on, but no shift open
 * on it — never opened yet, a fresh setup, a restored copy — sets the pause
 * exactly as closing the last shift does (the same key and reason, audited
 * the same way, the owner's switch never written). Before, the pause was set
 * only by a close, so such a till sent "accepting" heartbeats, the PIN screen
 * said nothing, and this computer was kept awake, with nobody on shift to
 * cook. The first shift's open lifts it, as it lifts a close's pause.
 *
 * Called at start (settleShiftPauseAtStart: no person, the till did it) and
 * by webBridge:setConfig when the owner saves (the owner is the actor). Never
 * with a shift open on THIS till (another till's open shift does not count,
 * the same rule as a close), never with the switch off or the link not
 * ready: then the website is not taking orders through this till anyway.
 *
 * Only records: returns true when the pause was set now (one audit row), and
 * the caller tells the screens and the website. Never throws.
 */
export function pauseWhileNoShiftOpen(db: AppDatabase, deviceId: string, actorUserId: string | null): boolean {
  try {
    const cfg = getWebBridgeConfig(db);
    if (!cfg.enabled || !isWebBridgeReady(cfg).ok) return false;
    if (getCurrentShift(db, deviceId)) return false;
    const paused = setWebOrdersShiftPause(db, shiftClosedPause(), actorUserId);
    if (paused) log.info('Website orders paused: no shift is open on this till');
    return paused;
  } catch (e) {
    log.warn('Could not pause website orders while no shift is open', {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
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
 * the till did it. This step only ever lifts, and it never throws. (The plan
 * said "the till never sets a pause at boot"; since v0.7.33 it does, in the
 * step right after this one — settleShiftPauseAtStart, pauseWhileNoShiftOpen
 * — because a till that had never closed a shift kept taking website orders.)
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

/**
 * Start-up, before the website bridge starts (index.ts): first the heal
 * (healShiftPause: a pause left behind while a shift is open is lifted),
 * then the rule from the start (pauseWhileNoShiftOpen: no shift open on this
 * till, with the switch on and the link ready, pauses website orders —
 * audited with no person, the till did it). Run before the bridge starts, so
 * the bridge's very first heartbeat already says "not accepting"; the
 * screens and keeping this computer awake read the pause when they start,
 * and are told as well. Never throws.
 */
export function settleShiftPauseAtStart(db: AppDatabase, deviceId: string): void {
  healShiftPause(db, deviceId);
  if (pauseWhileNoShiftOpen(db, deviceId, null)) announcePauseChange('start');
}
