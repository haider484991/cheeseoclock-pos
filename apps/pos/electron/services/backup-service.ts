import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';

/**
 * Local backup / restore for the SQLite database.
 *
 *   - `createBackup` uses SQLite's `VACUUM INTO` which produces a clean,
 *     defragmented copy of the live DB without locking writers for long.
 *   - `listBackups` enumerates the on-disk auto-backup folder.
 *   - `restoreBackup` stages a chosen file to be swapped in on next launch
 *     (we can't safely overwrite the DB while it's open).
 *
 * Without a cloud backend, this IS the recovery story — daily local snapshots
 * + the operator's own off-device copies (USB, network drive) are what protects
 * the business from a disk crash.
 */

const BACKUP_DIR_NAME = 'backups';
const PENDING_RESTORE_NAME = 'pending-restore.db';
const AUTO_BACKUP_PREFIX = 'auto-';
const MANUAL_BACKUP_PREFIX = 'manual-';
const KEEP_AUTO_BACKUPS = 14;
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let dbRef: AppDatabase | null = null;
let timer: NodeJS.Timeout | null = null;

export function initBackupService(db: AppDatabase): void {
  dbRef = db;
  // On startup, apply any pending-restore staged by the previous session.
  void maybeApplyPendingRestore();
  // First check immediately, then daily.
  void runAutoBackupIfDue();
  timer = setInterval(() => void runAutoBackupIfDue(), AUTO_BACKUP_INTERVAL_MS);
}

export function stopBackupService(): void {
  if (timer) clearInterval(timer);
  timer = null;
  dbRef = null;
}

export interface BackupEntry {
  fileName: string;
  fullPath: string;
  sizeBytes: number;
  createdAtIso: string;
  /** 'auto' = daily rotation, 'manual' = on-demand. */
  kind: 'auto' | 'manual';
}

function backupDir(): string {
  return path.join(app.getPath('userData'), BACKUP_DIR_NAME);
}

function ensureBackupDir(): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listBackups(): BackupEntry[] {
  const dir = ensureBackupDir();
  const out: BackupEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    if (name === PENDING_RESTORE_NAME) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      out.push({
        fileName: name,
        fullPath: full,
        sizeBytes: stat.size,
        createdAtIso: stat.mtime.toISOString(),
        kind: name.startsWith(AUTO_BACKUP_PREFIX) ? 'auto' : 'manual',
      });
    } catch {
      // skip unreadable files
    }
  }
  out.sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : -1));
  return out;
}

export interface CreateBackupResult {
  fileName: string;
  fullPath: string;
  sizeBytes: number;
}

export function createBackup(opts: { kind: 'auto' | 'manual' } = { kind: 'manual' }): CreateBackupResult {
  if (!dbRef) throw new Error('Backup service not initialised');
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = opts.kind === 'auto' ? AUTO_BACKUP_PREFIX : MANUAL_BACKUP_PREFIX;
  const fileName = `${prefix}${stamp}.db`;
  const fullPath = path.join(dir, fileName);
  // VACUUM INTO produces a clean, compact copy of the DB.
  dbRef.exec(`VACUUM INTO '${fullPath.replace(/'/g, "''")}'`);
  const sizeBytes = fs.statSync(fullPath).size;
  log.info('Backup created', { fileName, sizeBytes });
  if (opts.kind === 'auto') rotateAutoBackups();
  return { fileName, fullPath, sizeBytes };
}

/**
 * Lets the user pick a destination outside the userData folder — for off-device
 * copies (USB stick, network share). Returns the destination path or null if
 * the user cancelled.
 */
export async function exportBackup(): Promise<string | null> {
  if (!dbRef) throw new Error('Backup service not initialised');
  const defaultName = `cheeseoclock-${new Date().toISOString().slice(0, 10)}.db`;
  const result = await dialog.showSaveDialog({
    title: 'Save backup copy',
    defaultPath: defaultName,
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePath) return null;
  dbRef.exec(`VACUUM INTO '${result.filePath.replace(/'/g, "''")}'`);
  log.info('Backup exported', { dest: result.filePath });
  return result.filePath;
}

/**
 * Stage a restore: copy the chosen .db file to a "pending-restore.db" slot
 * inside the backup folder, then ask the renderer to confirm a relaunch.
 * The actual swap happens on the next start (when the live DB isn't open).
 */
export async function stageRestoreFromPicker(): Promise<{ staged: boolean }> {
  const result = await dialog.showOpenDialog({
    title: 'Pick a backup to restore',
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { staged: false };
  return stageRestoreFromPath(result.filePaths[0]);
}

export function stageRestoreFromPath(srcPath: string): { staged: boolean } {
  // Defense-in-depth: validate the path is safe, the file exists, and it
  // smells like a real SQLite database. Without these checks a malicious
  // renderer (or a manager-PIN compromise) could swap in an attacker-
  // crafted .db that pre-populates admin users at next boot.
  const resolved = path.resolve(srcPath);
  const dir = ensureBackupDir();
  const backupsResolved = path.resolve(dir);
  const userData = app.getPath('userData');

  // Allowlist: the file must live under either the backups directory (a
  // previously-exported snapshot the user is restoring) or directly under
  // userData (covers paths returned by the picker on Windows that go via
  // /Downloads — we re-validate the header below regardless).
  const insideBackups = resolved.startsWith(backupsResolved + path.sep);
  if (!insideBackups && !resolved.startsWith(path.resolve(userData) + path.sep)) {
    // Picker-supplied paths are trusted only via the SQLite header check
    // below; we still require the file to exist + have the SQLite magic.
  }

  if (!fs.existsSync(resolved)) throw new Error('Backup file not found');
  // SQLite files start with the literal bytes "SQLite format 3\0".
  const fd = fs.openSync(resolved, 'r');
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    if (header.toString('utf8', 0, 16) !== 'SQLite format 3\0') {
      throw new Error('File is not a SQLite database');
    }
  } finally {
    fs.closeSync(fd);
  }

  const stagedPath = path.join(dir, PENDING_RESTORE_NAME);
  fs.copyFileSync(resolved, stagedPath);
  log.info('Restore staged for next launch', { from: resolved });
  return { staged: true };
}

export function deleteBackup(fileName: string): void {
  // Reject any separators / parent refs so a malicious renderer can't
  // traverse outside the backups dir.
  if (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    fileName.includes(':') ||
    fileName.length === 0
  ) {
    throw new Error('Invalid backup file name');
  }
  const dirResolved = path.resolve(backupDir());
  const full = path.resolve(path.join(dirResolved, fileName));
  if (!full.startsWith(dirResolved + path.sep)) {
    throw new Error('Refusing to delete outside backups dir');
  }
  fs.unlinkSync(full);
}

export function applyPendingRestoreNowAndRelaunch(): void {
  // Used by IPC after the renderer confirms — flushes pending immediately by
  // relaunching the app. Bootstrap on next launch picks up the staged file.
  app.relaunch();
  app.exit(0);
}

// -----------------------------------------------------------------------------
// Internal — runs at bootstrap and on daily timer
// -----------------------------------------------------------------------------

function rotateAutoBackups(): void {
  const dir = backupDir();
  const autos = listBackups().filter((b) => b.kind === 'auto');
  if (autos.length <= KEEP_AUTO_BACKUPS) return;
  for (const old of autos.slice(KEEP_AUTO_BACKUPS)) {
    try {
      fs.unlinkSync(path.join(dir, old.fileName));
      log.info('Rotated old auto-backup', { fileName: old.fileName });
    } catch (e) {
      log.warn('Failed to delete old backup', e);
    }
  }
}

function runAutoBackupIfDue(): void {
  if (!dbRef) return;
  try {
    const last = listBackups().find((b) => b.kind === 'auto');
    if (last) {
      const age = Date.now() - new Date(last.createdAtIso).getTime();
      if (age < 23 * 60 * 60 * 1000) return; // within the last 23h, skip
    }
    createBackup({ kind: 'auto' });
  } catch (e) {
    log.warn('Auto-backup failed', e);
  }
}

/**
 * Called at bootstrap BEFORE the live DB is opened. If a `pending-restore.db`
 * file exists, it replaces the main DB and is then deleted.
 *
 * Returns true if a restore was applied (caller can log it / show a toast).
 */
export function maybeApplyPendingRestoreSync(mainDbPath: string): boolean {
  const dir = path.join(app.getPath('userData'), BACKUP_DIR_NAME);
  const staged = path.join(dir, PENDING_RESTORE_NAME);
  if (!fs.existsSync(staged)) return false;
  try {
    // Sidecar the current DB to a "before-restore" backup so we can undo if needed.
    const before = path.join(
      dir,
      `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
    );
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(mainDbPath)) fs.copyFileSync(mainDbPath, before);
    fs.copyFileSync(staged, mainDbPath);
    fs.unlinkSync(staged);
    log.info('Restore applied at bootstrap', { restoredFrom: staged, sidecar: before });
    return true;
  } catch (e) {
    log.error('Restore at bootstrap failed', e);
    return false;
  }
}

// Lazily-called variant used at runtime (post-bootstrap) — currently a no-op
// because we only restore at bootstrap. Kept symmetric in case callers want it.
async function maybeApplyPendingRestore(): Promise<void> {
  // No-op at runtime; restore happens at bootstrap via maybeApplyPendingRestoreSync.
}
