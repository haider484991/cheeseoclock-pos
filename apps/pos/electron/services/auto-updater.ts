import { app, BrowserWindow, ipcMain } from 'electron/main';
import log from 'electron-log/main';

/**
 * Optional auto-update — activates only when:
 *   - the `electron-updater` package is installed (try-imported)
 *   - the build has a `publish` configuration (set in electron-builder.yml)
 *
 * Otherwise no-ops. Lets us ship the app without forcing a release pipeline,
 * and later turn updates on by setting publish + bundling electron-updater.
 *
 * UX:
 *   - Check on launch + every 4 hours.
 *   - Download silently in the background.
 *   - When ready, broadcast `updater:ready` to renderer. Renderer shows a
 *     toast with "Restart now" → `updater:install`.
 *   - In dev mode we skip the whole check (updater would no-op anyway with
 *     no publish url).
 */
export async function initAutoUpdater(): Promise<void> {
  // One-way IPC: renderer clicks "Restart now" on the UpdateBanner → quit + apply.
  ipcMain.removeAllListeners('updater:install-now');
  ipcMain.on('updater:install-now', () => {
    void quitAndInstallUpdate();
  });

  if (!app.isPackaged) {
    log.info('Auto-updater: dev mode — skipping');
    return;
  }
  try {
    const mod = (await import(/* webpackIgnore: true */ 'electron-updater' as string).catch(
      () => null,
    )) as null | {
      autoUpdater: AutoUpdaterLike;
    };
    if (!mod) {
      log.warn('Auto-updater: electron-updater not installed; skipping');
      return;
    }
    const updater = mod.autoUpdater;

    updater.logger = log;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    updater.on('update-available', (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string };
      log.info('Auto-updater: update available', { version: info.version });
      broadcast('updater:available', { version: info.version ?? null });
    });
    updater.on('update-downloaded', (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string };
      log.info('Auto-updater: update downloaded', { version: info.version });
      broadcast('updater:ready', { version: info.version ?? null });
    });
    updater.on('error', (...args: unknown[]) => {
      const err = args[0] as Error | undefined;
      log.warn('Auto-updater: error', err);
    });

    void updater.checkForUpdates().catch((e: unknown) => log.warn('updater: check failed', e));

    setInterval(
      () => {
        void updater.checkForUpdates().catch((e: unknown) => log.warn('updater: check failed', e));
      },
      4 * 60 * 60 * 1000,
    );
  } catch (e) {
    log.warn('Auto-updater: init failed', e);
  }
}

/**
 * Apply the downloaded update and restart. Renderer invokes this via IPC
 * when the user clicks "Restart now" on the toast.
 */
export async function quitAndInstallUpdate(): Promise<void> {
  try {
    const mod = (await import(/* webpackIgnore: true */ 'electron-updater' as string).catch(
      () => null,
    )) as null | { autoUpdater: AutoUpdaterLike };
    if (!mod) return;
    mod.autoUpdater.quitAndInstall();
  } catch (e) {
    log.warn('Auto-updater: install failed', e);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload);
  }
}

/** Minimal shape we use from electron-updater so the no-dep dynamic import compiles. */
interface AutoUpdaterLike {
  logger: unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // Loose listener type — electron-updater emits a few different payload shapes
  // per event; the runtime handlers cast as appropriate.
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: () => void;
}
