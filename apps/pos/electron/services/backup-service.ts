import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import log from 'electron-log/main';
import { closeDatabase, type AppDatabase } from '../db/connection.js';

/**
 * Local backup / restore for the SQLite database.
 *
 *   - `createBackup` uses SQLite's `VACUUM INTO` which produces a clean,
 *     defragmented copy of the live DB without locking writers for long.
 *   - `listBackups` enumerates the on-disk auto-backup folder.
 *   - `stageRestoreFromPath` stages a chosen file to be swapped in on next
 *     launch (we can't safely overwrite the DB while it's open), together
 *     with a sidecar describing who staged what — the boot code turns that
 *     into a permanent audit entry inside the restored data.
 *
 * Integrity: a USB export is written with a `.sha256` sidecar, and a restore
 * from a file that still has its sidecar refuses to proceed if the file no
 * longer matches. Restoring checkpoints the live database first so the
 * "before-restore" archive is complete and no stale write-ahead frames can
 * be replayed onto the restored file.
 */

const BACKUP_DIR_NAME = 'backups';
const PENDING_RESTORE_NAME = 'pending-restore.db';
const PENDING_RESTORE_INFO = 'pending-restore.json';
const AUTO_BACKUP_PREFIX = 'auto-';
const MANUAL_BACKUP_PREFIX = 'manual-';
const KEEP_AUTO_BACKUPS = 14;
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let dbRef: AppDatabase | null = null;
let timer: NodeJS.Timeout | null = null;

export function initBackupService(db: AppDatabase): void {
  dbRef = db;
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

export function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Lets the user pick a destination outside the userData folder — for off-device
 * copies (USB stick, network share). Writes a `.sha256` sidecar next to the
 * file so a later restore can tell whether the file was changed on the way.
 * Returns the destination path or null if the user cancelled.
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
  const digest = sha256OfFile(result.filePath);
  try {
    fs.writeFileSync(`${result.filePath}.sha256`, `${digest}  ${path.basename(result.filePath)}\n`);
  } catch (e) {
    log.warn('Could not write the checksum sidecar next to the export', e);
  }
  log.info('Backup exported', { dest: result.filePath, sha256: digest });
  return result.filePath;
}

export interface RestoreStagingInfo {
  source: 'file' | 'snapshot' | 'cloud';
  /** Human label: the file name, or "cloud copy … from <PC>". */
  label: string;
  fromDeviceId?: string | null;
  byUserId: string | null;
  /**
   * Captured by an onboarding cloud restore so the replacement PC comes up
   * connected to the website. The secret is sealed for THIS machine.
   */
  connection?: { siteUrl: string; bridgeSecretSealed: string } | null;
}

export interface PendingRestoreInfo extends RestoreStagingInfo {
  stagedAt: string;
}

export interface AppliedRestore {
  archivedTo: string | null;
  info: PendingRestoreInfo | null;
}

/**
 * Stage a restore: copy the chosen .db file to a "pending-restore.db" slot
 * inside the backup folder, then ask the renderer to confirm a relaunch.
 * The actual swap happens on the next start (when the live DB isn't open).
 */
export async function stageRestoreFromPicker(
  info: Omit<RestoreStagingInfo, 'label'>,
): Promise<{ staged: boolean }> {
  const result = await dialog.showOpenDialog({
    title: 'Pick a backup to restore',
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { staged: false };
  return stageRestoreFromPath(result.filePaths[0], {
    ...info,
    label: path.basename(result.filePaths[0]),
  });
}

export function stageRestoreFromPath(
  srcPath: string,
  info: RestoreStagingInfo,
): { staged: boolean } {
  // Defense-in-depth: the file must exist and smell like a real SQLite
  // database. Without this a malicious renderer could swap in an attacker-
  // crafted file that pre-populates admin users at next boot.
  const resolved = path.resolve(srcPath);
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

  // A USB export carries a checksum sidecar. If it is still there, the file
  // has to match it; a changed or damaged copy is refused rather than
  // silently restored.
  const sidecar = `${resolved}.sha256`;
  if (fs.existsSync(sidecar)) {
    const recorded = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
    if (/^[0-9a-f]{64}$/i.test(recorded) && recorded.toLowerCase() !== sha256OfFile(resolved)) {
      throw new Error(
        'This file does not match the checksum saved next to it when it was exported. It was changed or damaged afterwards; refusing to restore it.',
      );
    }
  }

  const dir = ensureBackupDir();
  const stagedPath = path.join(dir, PENDING_RESTORE_NAME);
  fs.copyFileSync(resolved, stagedPath);
  const pending: PendingRestoreInfo = { ...info, stagedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, PENDING_RESTORE_INFO), JSON.stringify(pending));
  log.info('Restore staged for next launch', { from: resolved, source: info.source });
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
  // Close cleanly so the write-ahead log is folded into the file before the
  // next boot archives it and swaps the staged copy in.
  closeDatabase();
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
 * Returns what was applied (so the boot code can record it in the audit
 * trail), or null when nothing was staged.
 */
export function maybeApplyPendingRestoreSync(mainDbPath: string): AppliedRestore | null {
  const dir = path.join(app.getPath('userData'), BACKUP_DIR_NAME);
  const staged = path.join(dir, PENDING_RESTORE_NAME);
  if (!fs.existsSync(staged)) return null;

  let info: PendingRestoreInfo | null = null;
  const infoPath = path.join(dir, PENDING_RESTORE_INFO);
  try {
    if (fs.existsSync(infoPath)) info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch (e) {
    log.warn('Could not read the pending-restore sidecar', e);
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    let archivedTo: string | null = null;
    if (fs.existsSync(mainDbPath)) {
      // Fold the write-ahead log into the main file so the archive is complete
      // and no stale frames can be replayed onto the restored database.
      try {
        const current = new Database(mainDbPath);
        current.pragma('wal_checkpoint(TRUNCATE)');
        current.close();
      } catch (e) {
        log.warn('Checkpoint before restore failed; archiving the main file as-is', e);
      }
      archivedTo = path.join(
        dir,
        `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
      );
      fs.copyFileSync(mainDbPath, archivedTo);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        fs.unlinkSync(mainDbPath + suffix);
      } catch {
        // none present
      }
    }
    fs.copyFileSync(staged, mainDbPath);
    fs.unlinkSync(staged);
    try {
      fs.unlinkSync(infoPath);
    } catch {
      // no sidecar
    }
    log.info('Restore applied at bootstrap', { restoredFrom: staged, archivedTo, source: info?.source });
    return { archivedTo, info };
  } catch (e) {
    log.error('Restore at bootstrap failed', e);
    return null;
  }
}
