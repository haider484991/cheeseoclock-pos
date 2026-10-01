import log from 'electron-log/main';
import { EMPTY_ALERT_WATCH, type AlertWatch } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import {
  getWebBridgeConfig,
  getWebOrdersShiftPause,
  webOrdersPauseView,
} from './web-bridge-config.js';

/**
 * What every screen may show between logins (alerts:getWatch, no login): the
 * PIN screen polls it, and 'alerts:watch-changed' (alert-watch-events.ts)
 * asks for it again when part of it changes.
 *
 * Only ids, order numbers, statuses, minutes and times leave here — never a
 * customer's name, phone or address, the website address or the connection
 * password. Each part is read on its own: one that fails comes back empty and
 * the others still show. It never throws.
 *
 * Today it carries the website-orders pause; the order, ticket and
 * not-confirmed parts stay empty until they are filled from `_now` (the clock
 * their minutes are counted from).
 */
export function readAlertWatch(db: AppDatabase, _now: number): AlertWatch {
  return {
    ...EMPTY_ALERT_WATCH,
    webOrders: part('website pause', EMPTY_ALERT_WATCH.webOrders, () =>
      webOrdersPauseView(getWebBridgeConfig(db), getWebOrdersShiftPause(db)),
    ),
  };
}

/** One part of the watch, or its empty value when it cannot be read. */
function part<T>(name: string, empty: T, read: () => T): T {
  try {
    return read();
  } catch (e) {
    log.warn(`Alert watch: ${name} not read`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}
