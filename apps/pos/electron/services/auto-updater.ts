import { app, BrowserWindow, ipcMain } from 'electron/main';
import log from 'electron-log/main';
import fs from 'node:fs';
import path from 'node:path';

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

type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string | null }
  | { kind: 'ready'; version: string | null };

interface Diagnostics {
  initStarted: boolean;
  isPackaged: boolean;
  modLoaded: boolean | null;
  feedURL: string | null;
  checksAttempted: number;
  lastCheckAt: string | null;
  lastCheckResult: unknown | null;
  lastError: { message: string; stack?: string } | null;
  lastEvent: { name: string; payload: unknown; at: string } | null;
  state: UpdaterState;
  diagLogPath: string;
}

let currentState: UpdaterState = { kind: 'idle' };
let updaterRef: AutoUpdaterLike | null = null;

const diag: Diagnostics = {
  initStarted: false,
  isPackaged: false,
  modLoaded: null,
  feedURL: null,
  checksAttempted: 0,
  lastCheckAt: null,
  lastCheckResult: null,
  lastError: null,
  lastEvent: null,
  state: currentState,
  diagLogPath: '',
};

/**
 * Raw file logger that writes to userData/updater-diag.log via fs.appendFileSync,
 * bypassing electron-log entirely. Used to diagnose why the updater isn't firing
 * — if electron-log itself is broken in production, regular log.info() is
 * invisible. This file is a last-resort tap.
 */
function diagLog(...parts: unknown[]): void {
  try {
    const line =
      `[${new Date().toISOString()}] ` +
      parts
        .map((p) => {
          if (p instanceof Error) return `${p.message}\n${p.stack ?? ''}`;
          if (typeof p === 'string') return p;
          try {
            return JSON.stringify(p);
          } catch {
            return String(p);
          }
        })
        .join(' ') +
      '\n';
    fs.appendFileSync(diag.diagLogPath, line);
  } catch {
    // never throw from the logger
  }
}

export async function initAutoUpdater(): Promise<void> {
  diag.diagLogPath = path.join(app.getPath('userData'), 'updater-diag.log');
  diag.initStarted = true;
  diag.isPackaged = app.isPackaged;
  diagLog('initAutoUpdater() called', { isPackaged: app.isPackaged, version: app.getVersion() });

  // One-way IPC: renderer clicks "Restart now" on the UpdateBanner → quit + apply.
  ipcMain.removeAllListeners('updater:install-now');
  ipcMain.on('updater:install-now', () => {
    void quitAndInstallUpdate();
  });

  // Pull-based query so the renderer can fetch state on mount.
  ipcMain.removeHandler('updater:getState');
  ipcMain.handle('updater:getState', () => currentState);

  // Diagnostics — renderer can call from DevTools to see why the updater is
  // idle. Returns a snapshot of init/check state + the path to the raw log.
  ipcMain.removeHandler('updater:getDiagnostics');
  ipcMain.handle('updater:getDiagnostics', () => ({ ...diag, state: currentState }));

  // Manual check trigger — DevTools can call this to force an immediate
  // checkForUpdates() and get the result/error back, instead of waiting for
  // the 4-hour interval.
  ipcMain.removeHandler('updater:checkNow');
  ipcMain.handle('updater:checkNow', async () => {
    if (!updaterRef) {
      return { ok: false, reason: 'updater-not-initialized', diag: { ...diag } };
    }
    diagLog('checkNow() invoked from renderer');
    return runCheck('manual');
  });

  if (!app.isPackaged) {
    log.info('Auto-updater: dev mode — skipping');
    diagLog('skipping in dev mode');
    return;
  }
  try {
    diagLog('attempting dynamic import of electron-updater');
    const mod = (await import(/* webpackIgnore: true */ 'electron-updater' as string).catch(
      (err: unknown) => {
        diag.lastError = toErrorRecord(err);
        diagLog('electron-updater import failed', err);
        return null;
      },
    )) as null | Record<string, unknown>;
    diag.modLoaded = mod !== null;
    if (!mod) {
      log.warn('Auto-updater: electron-updater not installed; skipping');
      diagLog('mod was null — bailing');
      return;
    }
    diagLog('electron-updater loaded ok', { keys: Object.keys(mod) });
    // electron-updater is CJS. When imported via Node ESM dynamic import, the
    // real exports land under `.default`. Try both so the code works regardless
    // of how the bundler/runtime resolves the interop.
    const candidate =
      (mod['autoUpdater'] as AutoUpdaterLike | undefined) ??
      ((mod['default'] as Record<string, unknown> | undefined)?.['autoUpdater'] as
        | AutoUpdaterLike
        | undefined);
    if (!candidate) {
      const err = new Error(
        `electron-updater exported no autoUpdater (keys: ${Object.keys(mod).join(',')})`,
      );
      diag.lastError = toErrorRecord(err);
      diagLog('autoUpdater missing on export', err);
      log.warn('Auto-updater: autoUpdater export not found');
      return;
    }
    const updater = candidate;
    updaterRef = updater;

    updater.logger = log;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    // Until we have a real code-signing cert, the .exe is unsigned. Override
    // electron-updater's publisher/Authenticode verification so it accepts
    // unsigned builds instead of erroring out and stalling the banner at
    // "Downloading…". When we ship signed builds (Sectigo/DigiCert EV), drop
    // this override and electron-updater will enforce the signature check
    // normally.
    try {
      const updaterAny = updater as unknown as {
        verifyUpdateCodeSignature?: (publisherNames: string[], path: string) => Promise<string | null>;
      };
      updaterAny.verifyUpdateCodeSignature = async () => null;
      diagLog('signature verification override installed (unsigned-build mode)');
    } catch (err) {
      diagLog('failed to install signature verification override', err);
    }
    try {
      diag.feedURL = updater.getFeedURL?.() ?? null;
      diagLog('feed URL', diag.feedURL);
    } catch (err) {
      diagLog('getFeedURL threw', err);
    }

    updater.on('checking-for-update', () => {
      diag.lastEvent = { name: 'checking-for-update', payload: null, at: new Date().toISOString() };
      diagLog('event: checking-for-update');
    });
    updater.on('update-available', (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string };
      diag.lastEvent = {
        name: 'update-available',
        payload: info,
        at: new Date().toISOString(),
      };
      diagLog('event: update-available', info);
      log.info('Auto-updater: update available', { version: info.version });
      currentState = { kind: 'downloading', version: info.version ?? null };
      broadcast('updater:available', { version: info.version ?? null });
    });
    updater.on('update-not-available', (...args: unknown[]) => {
      diag.lastEvent = {
        name: 'update-not-available',
        payload: args[0] ?? null,
        at: new Date().toISOString(),
      };
      diagLog('event: update-not-available', args[0]);
    });
    updater.on('download-progress', (...args: unknown[]) => {
      const p = args[0] as { percent?: number } | undefined;
      diag.lastEvent = {
        name: 'download-progress',
        payload: p ?? null,
        at: new Date().toISOString(),
      };
      // do not log every progress tick — too noisy
      if (p && Math.round(p.percent ?? 0) % 10 === 0) diagLog('progress', p.percent);
    });
    updater.on('update-downloaded', (...args: unknown[]) => {
      const info = (args[0] ?? {}) as { version?: string };
      diag.lastEvent = {
        name: 'update-downloaded',
        payload: info,
        at: new Date().toISOString(),
      };
      diagLog('event: update-downloaded', info);
      log.info('Auto-updater: update downloaded', { version: info.version });
      currentState = { kind: 'ready', version: info.version ?? null };
      broadcast('updater:ready', { version: info.version ?? null });
    });
    updater.on('error', (...args: unknown[]) => {
      const err = args[0] as Error | undefined;
      diag.lastEvent = {
        name: 'error',
        payload: err ? { message: err.message, stack: err.stack } : null,
        at: new Date().toISOString(),
      };
      diag.lastError = toErrorRecord(err);
      diagLog('event: error', err);
      log.warn('Auto-updater: error', err);
    });

    void runCheck('boot');

    setInterval(
      () => {
        void runCheck('interval');
      },
      4 * 60 * 60 * 1000,
    );
  } catch (e) {
    diag.lastError = toErrorRecord(e);
    diagLog('init threw', e);
    log.warn('Auto-updater: init failed', e);
  }
}

async function runCheck(trigger: 'boot' | 'interval' | 'manual'): Promise<{
  ok: boolean;
  trigger: string;
  result?: unknown;
  error?: { message: string; stack?: string };
}> {
  if (!updaterRef) {
    return { ok: false, trigger, error: { message: 'updater not initialized' } };
  }
  diag.checksAttempted += 1;
  diag.lastCheckAt = new Date().toISOString();
  diagLog(`checkForUpdates() trigger=${trigger}`);
  try {
    const result = await updaterRef.checkForUpdates();
    diag.lastCheckResult = sanitizeResult(result);
    diagLog('checkForUpdates resolved', diag.lastCheckResult);
    return { ok: true, trigger, result: diag.lastCheckResult };
  } catch (err) {
    const rec = toErrorRecord(err);
    diag.lastError = rec;
    diag.lastCheckResult = null;
    diagLog('checkForUpdates rejected', err);
    log.warn('updater: check failed', err);
    return { ok: false, trigger, error: rec };
  }
}

function sanitizeResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  // UpdateCheckResult has a non-serializable cancellationToken — strip it.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'cancellationToken') continue;
    if (typeof v === 'function') continue;
    try {
      JSON.stringify(v);
      clean[k] = v;
    } catch {
      clean[k] = '[unserializable]';
    }
  }
  return clean;
}

function toErrorRecord(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

/**
 * Apply the downloaded update and restart. Renderer invokes this via IPC
 * when the user clicks "Restart now" on the toast.
 */
export async function quitAndInstallUpdate(): Promise<void> {
  try {
    const mod = (await import(/* webpackIgnore: true */ 'electron-updater' as string).catch(
      () => null,
    )) as null | Record<string, unknown>;
    if (!mod) return;
    const updater =
      (mod['autoUpdater'] as AutoUpdaterLike | undefined) ??
      ((mod['default'] as Record<string, unknown> | undefined)?.['autoUpdater'] as
        | AutoUpdaterLike
        | undefined);
    if (!updater) {
      log.warn('Auto-updater: autoUpdater missing on install');
      return;
    }
    updater.quitAndInstall();
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
  getFeedURL?: () => string | null;
  quitAndInstall: () => void;
}
