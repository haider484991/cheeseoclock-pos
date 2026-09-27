import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { nowIso } from '../db/repositories/base.js';
import { getCurrentShift } from '../db/repositories/shift-repo.js';
import { setWebOrdersShiftPause } from './web-bridge-config.js';
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
