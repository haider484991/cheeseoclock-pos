import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw } from '../db/repositories/settings-repo.js';
import { LAST_AUTO_BACKUP_ERROR_KEY, listBackups } from './backup-service.js';
import {
  CLOUD_BACKUP_INTERVALS_MS,
  getWebBridgeConfig,
  isWebBridgeReady,
} from './web-bridge-config.js';
import { LAST_CLOUD_ERROR_KEY } from './web-orders-bridge.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The daily copy on this PC is late after this long. */
const LOCAL_STALE_MS = 2 * DAY_MS;
const LAST_CLOUD_BACKUP_KEY = 'webBridge.lastCloudBackupAt';

function readError(db: AppDatabase, key: string): { at: string; message: string } | null {
  const raw = getSettingRaw(db, key) as { at?: unknown; message?: unknown } | null;
  return raw && typeof raw.at === 'string' && typeof raw.message === 'string'
    ? { at: raw.at, message: raw.message }
    : null;
}

function daysAgo(iso: string, now: number): number {
  return Math.max(1, Math.round((now - Date.parse(iso)) / DAY_MS));
}

/**
 * Whether the backups are actually happening, in words the owner can act on.
 * Every failure used to be a log line nobody reads: a full disk or an expired
 * website link stopped the copies for weeks and it showed only when a restore
 * was needed.
 */
export function getBackupHealth(db: AppDatabase, now = Date.now()) {
  const warnings: string[] = [];

  const newest = listBackups().find((b) => b.kind === 'auto') ?? listBackups()[0] ?? null;
  const lastLocalAt = newest?.createdAtIso ?? null;
  const lastLocalError = readError(db, LAST_AUTO_BACKUP_ERROR_KEY);
  if (lastLocalError) {
    warnings.push(`The daily backup on this PC failed: ${lastLocalError.message}`);
  } else if (!lastLocalAt) {
    warnings.push('There is no backup on this PC yet.');
  } else if (now - Date.parse(lastLocalAt) > LOCAL_STALE_MS) {
    warnings.push(`The last backup on this PC is ${daysAgo(lastLocalAt, now)} days old.`);
  }

  const cfg = getWebBridgeConfig(db);
  const cloudOn = cfg.cloudBackupFrequency !== 'off' && isWebBridgeReady(cfg).ok;
  const lastCloudRaw = getSettingRaw(db, LAST_CLOUD_BACKUP_KEY);
  const lastCloudAt = typeof lastCloudRaw === 'string' ? lastCloudRaw : null;
  const lastCloudError = readError(db, LAST_CLOUD_ERROR_KEY);
  if (cloudOn) {
    const interval = CLOUD_BACKUP_INTERVALS_MS[cfg.cloudBackupFrequency as keyof typeof CLOUD_BACKUP_INTERVALS_MS];
    if (!lastCloudAt) {
      warnings.push(
        lastCloudError
          ? `No cloud copy has ever been uploaded: ${lastCloudError.message}`
          : 'No cloud copy has been uploaded yet.',
      );
    } else if (now - Date.parse(lastCloudAt) > interval + DAY_MS) {
      warnings.push(
        `The last cloud copy is ${daysAgo(lastCloudAt, now)} days old${
          lastCloudError ? ` — the last try failed: ${lastCloudError.message}` : ''
        }.`,
      );
    }
  }

  return { lastLocalAt, lastLocalError, cloudOn, lastCloudAt, lastCloudError, warnings };
}
