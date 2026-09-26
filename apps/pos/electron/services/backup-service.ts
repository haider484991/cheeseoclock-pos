import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import log from 'electron-log/main';
import { closeDatabase, type AppDatabase } from '../db/connection.js';
import { deleteSetting, setSetting } from '../db/repositories/settings-repo.js';

/**
 * Local backup / restore for the SQLite database.
 *
 *   - `createBackup` uses SQLite's `VACUUM INTO` which produces a clean,
 *     defragmented copy of the live DB without locking writers for long —
 *     but in one synchronous call that freezes the till while it runs.
 *     `createBackupAsync` (the daily copy, "Back up now", USB export, cloud
 *     copies) uses the online backup API a slice at a time instead.
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
/**
 * The daily copy is checked for this long after boot, then hourly (it is made
 * when the newest one is 23 h old). It used to run synchronously before the
 * window even opened, and then every 24 h from boot — in the middle of
 * whatever service was on at that hour.
 */
const AUTO_BACKUP_FIRST_CHECK_MS = 2 * 60_000;
const AUTO_BACKUP_CHECK_MS = 60 * 60_000;

let dbRef: AppDatabase | null = null;
let timer: NodeJS.Timeout | null = null;
let firstCheck: NodeJS.Timeout | null = null;
let autoBackupRunning = false;

export function initBackupService(db: AppDatabase): void {
  dbRef = db;
  firstCheck = setTimeout(() => void runAutoBackupIfDue(), AUTO_BACKUP_FIRST_CHECK_MS);
  timer = setInterval(() => void runAutoBackupIfDue(), AUTO_BACKUP_CHECK_MS);
}

export function stopBackupService(): void {
  if (firstCheck) clearTimeout(firstCheck);
  firstCheck = null;
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

export function ensureBackupDir(): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a clean, self-contained copy of an OPEN database to `destPath`.
 * Folds the write-ahead log into the main file first so the copy carries
 * every committed write, then `VACUUM INTO` — the only safe way to snapshot
 * a database another connection is holding. `PASSIVE` never blocks readers;
 * whatever it cannot fold is still read through the connection by the VACUUM.
 */
export function snapshotDatabaseTo(db: AppDatabase, destPath: string): void {
  db.pragma('wal_checkpoint(PASSIVE)');
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

/**
 * The same snapshot without stopping the till. SQLite's online backup API
 * (better-sqlite3 `db.backup`) copies a hundred pages per turn of the event
 * loop, so sales, prints and every IPC call carry on while it runs; writes
 * made meanwhile on this connection land in the copy too. VACUUM INTO does
 * the whole copy in one synchronous call on the main process: measured
 * 12.6 s on a 2 GB database against a worst pause of 88 ms for this.
 *
 * The copy is written beside the destination and renamed into place, and is
 * left in rollback-journal mode: one self-contained file, as VACUUM INTO
 * made (it would otherwise inherit WAL mode and grow -wal/-shm files when
 * opened).
 */
export async function snapshotDatabaseAsync(db: AppDatabase, destPath: string): Promise<void> {
  const part = `${destPath}.part`;
  removeDatabaseFiles(part);
  try {
    await db.backup(part);
    const copy = new Database(part);
    try {
      copy.pragma('journal_mode = DELETE');
    } finally {
      copy.close();
    }
    fs.renameSync(part, destPath);
  } finally {
    removeDatabaseFiles(part);
  }
}

/** A database file and whatever journal files SQLite left next to it. */
export function removeDatabaseFiles(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(filePath + suffix);
    } catch {
      // not there
    }
  }
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

function newBackupPath(kind: 'auto' | 'manual'): { fileName: string; fullPath: string } {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = kind === 'auto' ? AUTO_BACKUP_PREFIX : MANUAL_BACKUP_PREFIX;
  const fileName = `${prefix}${stamp}.db`;
  return { fileName, fullPath: path.join(dir, fileName) };
}

function backupCreated(kind: 'auto' | 'manual', fileName: string, fullPath: string): CreateBackupResult {
  const sizeBytes = fs.statSync(fullPath).size;
  log.info('Backup created', { fileName, sizeBytes });
  if (kind === 'auto') rotateAutoBackups();
  return { fileName, fullPath, sizeBytes };
}

/** Synchronous (VACUUM INTO): only where the next step must not start before it exists. */
export function createBackup(opts: { kind: 'auto' | 'manual' } = { kind: 'manual' }): CreateBackupResult {
  if (!dbRef) throw new Error('Backup service not initialised');
  const { fileName, fullPath } = newBackupPath(opts.kind);
  snapshotDatabaseTo(dbRef, fullPath);
  return backupCreated(opts.kind, fileName, fullPath);
}

/** The same backup without freezing the till while it is written (see snapshotDatabaseAsync). */
export async function createBackupAsync(
  opts: { kind: 'auto' | 'manual' } = { kind: 'manual' },
): Promise<CreateBackupResult> {
  if (!dbRef) throw new Error('Backup service not initialised');
  const { fileName, fullPath } = newBackupPath(opts.kind);
  await snapshotDatabaseAsync(dbRef, fullPath);
  return backupCreated(opts.kind, fileName, fullPath);
}

export function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** sha256OfFile read in pieces, so a big file (or a slow USB stick) never stalls the till. */
export async function sha256OfFileAsync(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of fs.createReadStream(filePath)) hash.update(piece as Buffer);
  return hash.digest('hex');
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
  // A USB stick writes at a few MB/s: VACUUM INTO straight onto it froze the
  // till for the whole write.
  await snapshotDatabaseAsync(dbRef, result.filePath);
  const digest = await sha256OfFileAsync(result.filePath);
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
  /**
   * Set by backup:applyAndRelaunch once the owner said yes and the safety
   * copy step is done. Only a confirmed restore is applied at the next start:
   * a copy that was staged and then declined used to sit in the slot and
   * silently replace the data the next time the till was switched on, with
   * no safety copy of what it overwrote.
   */
  confirmedAt?: string;
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

function pendingRestorePaths(): { staged: string; info: string } {
  const dir = ensureBackupDir();
  return { staged: path.join(dir, PENDING_RESTORE_NAME), info: path.join(dir, PENDING_RESTORE_INFO) };
}

/** A copy is staged and waiting for the owner's yes. */
export function hasPendingRestore(): boolean {
  return fs.existsSync(pendingRestorePaths().staged);
}

/**
 * The owner said yes (and the safety copy step is done): mark the staged copy
 * so the next start applies it. Throws when nothing is staged.
 */
export function confirmPendingRestore(): void {
  const { staged, info } = pendingRestorePaths();
  if (!fs.existsSync(staged)) {
    throw new Error('Nothing is waiting to be restored. Pick the copy again.');
  }
  let pending: PendingRestoreInfo | null = null;
  try {
    pending = JSON.parse(fs.readFileSync(info, 'utf8')) as PendingRestoreInfo;
  } catch {
    pending = null;
  }
  if (!pending) throw new Error('The details of the chosen copy are missing. Pick the copy again.');
  fs.writeFileSync(info, JSON.stringify({ ...pending, confirmedAt: new Date().toISOString() }));
}

/** The owner said no: drop the staged copy so it can never be applied later. */
export function cancelPendingRestore(): { cancelled: boolean } {
  const { staged, info } = pendingRestorePaths();
  const existed = fs.existsSync(staged);
  for (const p of [staged, info]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // not there — nothing to drop
    }
  }
  if (existed) log.info('Staged restore cancelled');
  return { cancelled: existed };
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

async function runAutoBackupIfDue(): Promise<void> {
  const db = dbRef;
  if (!db || autoBackupRunning) return;
  autoBackupRunning = true;
  try {
    const last = listBackups().find((b) => b.kind === 'auto');
    if (last) {
      const age = Date.now() - new Date(last.createdAtIso).getTime();
      if (age < 23 * 60 * 60 * 1000) return; // within the last 23h, skip
    }
    await createBackupAsync({ kind: 'auto' });
    deleteSetting(db, LAST_AUTO_BACKUP_ERROR_KEY);
  } catch (e) {
    log.warn('Auto-backup failed', e);
    // Kept (not just logged) so the dashboard can say so until one works:
    // a disk that filled up used to stop the daily copy without a word.
    try {
      setSetting(db, LAST_AUTO_BACKUP_ERROR_KEY, {
        at: new Date().toISOString(),
        message: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // the database itself is the problem; the log has it
    }
  } finally {
    autoBackupRunning = false;
  }
}

export const LAST_AUTO_BACKUP_ERROR_KEY = 'backup.lastAutoError';

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

  // Staged but never confirmed (the owner said no, or the app closed before
  // the question was answered): throw it away rather than rewind the data.
  if (!info?.confirmedAt) {
    log.warn('Discarding a staged restore that was never confirmed', {
      source: info?.source,
      label: info?.label,
      stagedAt: info?.stagedAt,
    });
    for (const p of [staged, infoPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        // already gone
      }
    }
    return null;
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
