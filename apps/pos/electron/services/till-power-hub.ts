import { app, powerMonitor, powerSaveBlocker } from 'electron';
import log from 'electron-log/main';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LastSleep, TillPowerStatus } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { onAlertWatchChanged } from './alert-watch-events.js';
import { onTillPowerSettingsChanged } from './till-power-events.js';
import { canStartWithWindows, TillPower } from './till-power.js';
import { readTillSetting } from './till-settings.js';
import { getWebBridgeConfig, getWebOrdersShiftPause, takingWebOrders } from './web-bridge-config.js';

/**
 * The real wiring for TillPower (till-power.ts): Windows' "don't sleep"
 * request, the till's start-up entry, sleep and wake, this till's setting.
 *
 * Keep awake follows whether this till takes website orders, so it is
 * checked again whenever that can change: a shift opening or closing that
 * pauses or starts website orders, and the owner saving the website link or
 * "Accept online orders" (both 'alerts:watch-changed', alert-watch-events.ts),
 * the owner saving "This computer", the computer waking up, and each time the
 * card asks.
 *
 * Nothing touches an Electron export until initTillPower runs, so the narrow
 * electron mocks of other tests are safe.
 */

/**
 * The app's id: the installer's Start-menu shortcut (electron-builder's
 * appId), Windows' notices, and the name of the start-up entry. Electron
 * reads the entry by this name, so it is never written under another.
 */
export const APP_USER_MODEL_ID = 'pk.cheeseoclock.pos';

/** The last time this computer slept: the till's own bookkeeping (no audit). */
export const LAST_SLEEP_KEY = 'pc.lastSleep';

/** NSIS's uninstaller (`Uninstall ${PRODUCT_FILENAME}.exe`): only an installed till has one next to it. */
const UNINSTALLER = 'Uninstall CheeseOclock POS.exe';

/** After waking, the network needs a moment before the website bridge tries. */
const WAKE_NUDGE_DELAY_MS = 5_000;

let power: TillPower | null = null;
let listening = false;

/**
 * Called once in bootstrap, after the database is open and the app's id is
 * set (index.ts), before the IPC handlers. Applies the setting at once.
 */
export function initTillPower(db: AppDatabase, opts: { onWoke: () => void }): void {
  const installed = canStartWithWindows({
    isPackaged: app.isPackaged,
    platform: process.platform,
    uninstallerExists: existsSync(path.join(path.dirname(process.execPath), UNINSTALLER)),
  });
  power = new TillPower({
    blocker: {
      // Never 'prevent-app-suspension': on Windows 8 and later it does not keep
      // a Modern Standby laptop from sleeping. A screen kept on also keeps the
      // order banner in sight.
      start: () => powerSaveBlocker.start('prevent-display-sleep'),
      stop: (id) => powerSaveBlocker.stop(id),
      isStarted: (id) => powerSaveBlocker.isStarted(id),
    },
    loginItems: installed
      ? {
          get: () => app.getLoginItemSettings(),
          // No path or args: this copy of the till (process.execPath), as it is.
          set: (s) => app.setLoginItemSettings({ ...s, name: APP_USER_MODEL_ID }),
        }
      : null,
    runValueName: APP_USER_MODEL_ID,
    readSetting: () => readTillSetting(db, 'pc.power'),
    takingOrders: () => takingWebOrders(getWebBridgeConfig(db), getWebOrdersShiftPause(db)),
    readLastSleep: () => parseLastSleep(getSettingRaw(db, LAST_SLEEP_KEY)),
    saveLastSleep: (v) => setSetting(db, LAST_SLEEP_KEY, v),
    onWoke: () => {
      setTimeout(opts.onWoke, WAKE_NUDGE_DELAY_MS);
    },
    now: () => Date.now(),
    info: (m, d) => (d === undefined ? log.info(m) : log.info(m, d)),
    warn: (m, d) => (d === undefined ? log.warn(m) : log.warn(m, d)),
  });
  const s = power.apply();
  log.info('This computer', { keepAwake: s.keepAwake, startWithWindows: s.startWithWindows, exe: process.execPath });
  if (listening) return;
  listening = true;
  onTillPowerSettingsChanged(() => power?.apply());
  onAlertWatchChanged(() => power?.refreshAwake());
  powerMonitor.on('suspend', () => power?.slept());
  powerMonitor.on('resume', () => power?.woke());
}

/** The owner's card; null until the till has started. */
export function tillPowerStatus(): TillPowerStatus | null {
  return power?.status() ?? null;
}

/** "Turn it back on" (the owner); null until the till has started. */
export function turnTillPowerBackOn(): TillPowerStatus | null {
  return power?.apply({ turnBackOn: true }) ?? null;
}

function parseLastSleep(v: unknown): LastSleep | null {
  if (!v || typeof v !== 'object') return null;
  const { sleptAt, wokeAt } = v as Record<string, unknown>;
  if (typeof sleptAt !== 'string') return null;
  return { sleptAt, wokeAt: typeof wokeAt === 'string' ? wokeAt : null };
}
