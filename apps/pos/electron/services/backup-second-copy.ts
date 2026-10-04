/**
 * A second copy of every backup, outside this PC: the owner picks a folder on
 * a USB drive, a OneDrive / Google Drive folder, or a network share (Settings
 * → Backups → "Second copy"), and every daily backup and every "Back up now"
 * is copied there as well, newest KEEP_SECOND_COPIES kept. A till linked to
 * its website also has its cloud copies; this one needs no website and no
 * internet, so a dead disk in week one no longer loses everything.
 *
 * This till only ('backup.secondCopy' in the settings table); nothing is
 * written for a till whose owner never set a folder. A failed copy is
 * recorded and shown on the Backups tab; it never fails the backup itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { deleteSetting, getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';

export const SECOND_COPY_KEY = 'backup.secondCopy';
export const SECOND_COPY_LAST_KEY = 'backup.secondCopy.last';
export const SECOND_COPY_ERROR_KEY = 'backup.secondCopy.lastError';
/** Newest copies kept in the folder (the daily rotation keeps 14 on the PC). */
export const KEEP_SECOND_COPIES = 14;
/** Only our own backup files are ever rotated out of the owner's folder. */
const OUR_FILE = /^(auto|manual|before-menu)-.*\.db$/;

export interface SecondCopyStatus {
  dir: string | null;
  lastAt: string | null;
  lastFileName: string | null;
  lastError: { at: string; message: string } | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function getSecondCopyDir(db: AppDatabase): string | null {
  const dir = asRecord(getSettingRaw(db, SECOND_COPY_KEY))?.['dir'];
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

export function getSecondCopyStatus(db: AppDatabase): SecondCopyStatus {
  const last = asRecord(getSettingRaw(db, SECOND_COPY_LAST_KEY));
  const err = asRecord(getSettingRaw(db, SECOND_COPY_ERROR_KEY));
  return {
    dir: getSecondCopyDir(db),
    lastAt: typeof last?.['at'] === 'string' ? (last['at'] as string) : null,
    lastFileName: typeof last?.['fileName'] === 'string' ? (last['fileName'] as string) : null,
    lastError:
      typeof err?.['at'] === 'string' && typeof err?.['message'] === 'string'
        ? { at: err['at'] as string, message: err['message'] as string }
        : null,
  };
}

/**
 * Why a folder cannot be used, in the owner's words; null when it can. Makes
 * the folder if it does not exist yet, and proves it is writable.
 */
export function secondCopyFolderProblem(dir: string, userDataDir: string): string | null {
  if (!path.isAbsolute(dir)) return 'Pick a full folder path (for example E:\\Till backups).';
  const resolved = path.resolve(dir);
  const inside = path.relative(path.resolve(userDataDir), resolved);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    return 'That folder is inside the till’s own data folder — a copy there dies with the PC. Pick a USB drive, a cloud folder or a network share.';
  }
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const probe = path.join(resolved, `.till-write-check-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    return `The till cannot write in that folder (${e instanceof Error ? e.message : String(e)}).`;
  }
  return null;
}

/** Owner only (the handler checks). `null` stops the second copies; the files already there are left alone. */
export function setSecondCopyDir(db: AppDatabase, dir: string | null, userDataDir: string, actorUserId: string | null): SecondCopyStatus {
  if (dir === null) {
    setSetting(db, SECOND_COPY_KEY, { dir: '' }, { actorUserId });
    deleteSetting(db, SECOND_COPY_ERROR_KEY);
    log.info('Second backup copy switched off');
    return getSecondCopyStatus(db);
  }
  const problem = secondCopyFolderProblem(dir, userDataDir);
  if (problem) throw new Error(problem);
  setSetting(db, SECOND_COPY_KEY, { dir: path.resolve(dir) }, { actorUserId });
  deleteSetting(db, SECOND_COPY_ERROR_KEY);
  log.info('Second backup copy folder set', { dir: path.resolve(dir) });
  return getSecondCopyStatus(db);
}

/**
 * Copy one finished backup file to the folder and rotate the folder's older
 * copies of ours. Records the result; never throws.
 */
export async function copyBackupToSecondFolder(db: AppDatabase, fullPath: string, fileName: string): Promise<boolean> {
  const dir = getSecondCopyDir(db);
  if (!dir) return false;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const dest = path.join(dir, fileName);
    const tmp = `${dest}.part`;
    await fs.promises.copyFile(fullPath, tmp);
    await fs.promises.rename(tmp, dest);
    setSetting(db, SECOND_COPY_LAST_KEY, { at: new Date().toISOString(), fileName, dir });
    deleteSetting(db, SECOND_COPY_ERROR_KEY);
    await rotateSecondCopies(dir);
    log.info('Second backup copy written', { dir, fileName });
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn('Second backup copy failed', { dir, fileName, message });
    try {
      setSetting(db, SECOND_COPY_ERROR_KEY, { at: new Date().toISOString(), message });
    } catch {
      // the backup itself succeeded; the Backups tab reads the error on the next look
    }
    return false;
  }
}

async function rotateSecondCopies(dir: string): Promise<void> {
  const names = (await fs.promises.readdir(dir)).filter((n) => OUR_FILE.test(n));
  const withTime = await Promise.all(
    names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs })),
  );
  withTime.sort((a, b) => b.t - a.t);
  for (const old of withTime.slice(KEEP_SECOND_COPIES)) {
    try {
      await fs.promises.unlink(path.join(dir, old.n));
    } catch (e) {
      log.warn('Could not rotate an old second copy', { file: old.n, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
