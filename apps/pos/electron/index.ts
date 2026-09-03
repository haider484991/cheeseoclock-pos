import { app, BrowserWindow, shell } from 'electron';
import log from 'electron-log/main';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from './db/connection.js';
import { runMigrations } from './db/migrator.js';
import { ensureDeviceInfo } from './db/repositories/device-repo.js';
import { ensureSeedUsers } from './db/repositories/user-repo.js';
import { ensureSeedMenu } from './db/seed.js';
import { registerAllIpcHandlers } from './ipc/registry.js';
import { printSpooler } from './services/print-spooler.js';
import { fbrWorker } from './services/fbr-worker.js';
import { syncWorker } from './services/sync-worker.js';
import { webOrdersBridge } from './services/web-orders-bridge.js';
import { initErrorReporter } from './services/error-reporter.js';
import { initAutoUpdater } from './services/auto-updater.js';
import {
  initBackupService,
  maybeApplyPendingRestoreSync,
} from './services/backup-service.js';
import { recordAppliedRestore } from './services/restore-service.js';
import { sealAllStoredSecrets } from './services/secrets-bootstrap.js';
import { auditChainService } from './services/audit-chain-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// A dev run shares %APPDATA%\@cheeseoclock\pos with an installed build, which
// makes it impossible to try a fresh database (onboarding, seed data, settings)
// next to a real install. Point a dev run elsewhere with COC_USER_DATA_DIR.
// Has to happen before electron-log resolves its file path. Production builds
// never read it.
if (isDev && process.env['COC_USER_DATA_DIR']) {
  app.setPath('userData', process.env['COC_USER_DATA_DIR']);
}

log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.initialize();

let mainWindow: BrowserWindow | null = null;

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'CheeseOclock POS',
    backgroundColor: '#0c0a09',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses Node APIs (ipcRenderer); contextIsolation keeps renderer safe
      spellcheck: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // External links open in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Renderer entry: dev server URL or built file
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function bootstrap() {
  log.info('Bootstrapping CheeseOclock POS', { version: app.getVersion(), isDev });

  // Optional error reporting + auto-update. Both no-op gracefully when their
  // dependencies / config are not present (see service files for details).
  await initErrorReporter();
  void initAutoUpdater();

  // Initialize SQLite at userData/cheeseoclock.sqlite. If a pending restore
  // was staged by the previous session, apply it before opening any connection.
  const dbPath = path.join(app.getPath('userData'), 'cheeseoclock.sqlite');
  const restore = maybeApplyPendingRestoreSync(dbPath);
  if (restore) {
    log.info('Restore applied — running on restored database', { from: restore.info?.label });
  }
  log.info('SQLite path', { dbPath });
  const db = initDatabase(dbPath);

  await runMigrations(db);

  const deviceInfo = ensureDeviceInfo(db);
  log.info('Device registered', { deviceId: deviceInfo.deviceId });

  // Secrets stored in clear by older builds get sealed with the OS keychain;
  // a restore leaves a permanent, hash-chained record inside the restored data.
  sealAllStoredSecrets(db);
  if (restore) recordAppliedRestore(db, restore);

  // COC_NO_SEED=1 keeps a dev database empty so the onboarding wizard (and its
  // restore path) can be exercised; production builds never seed.
  if (isDev && !process.env['COC_NO_SEED']) {
    ensureSeedUsers(db, deviceInfo.deviceId);
    ensureSeedMenu(db, deviceInfo.deviceId);
  }

  printSpooler.init(db);
  fbrWorker.init(db);
  syncWorker.init(db, deviceInfo.deviceId);
  webOrdersBridge.init(db, deviceInfo.deviceId);
  initBackupService(db);
  auditChainService.verifyInBackground(db);

  registerAllIpcHandlers({ db, deviceId: deviceInfo.deviceId });

  await createMainWindow();
}

app.whenReady().then(bootstrap).catch((err) => {
  log.error('Failed to bootstrap', err);
  app.exit(1);
});

app.on('window-all-closed', () => {
  closeDatabase();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

// Hardened defaults: deny new window creation from any renderer.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://localhost') || url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });
});
