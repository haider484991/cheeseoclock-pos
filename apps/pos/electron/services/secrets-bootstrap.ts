import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { isSealed, sealSecret } from './secret-seal.js';

const SECRET_FIELDS: Array<{ key: string; field: string }> = [
  { key: 'webBridge.config', field: 'bridgeSecret' },
  { key: 'fbr.config', field: 'bearerToken' },
  { key: 'sync.config', field: 'deviceSecret' },
];

/**
 * One-time upgrade for databases that stored secrets in clear text (every
 * build before 0.4.9). Runs at boot, idempotent, and a no-op where the OS
 * keychain is unavailable.
 */
export function sealAllStoredSecrets(db: AppDatabase): void {
  for (const { key, field } of SECRET_FIELDS) {
    const raw = getSettingRaw(db, key);
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const value = obj[field];
    if (typeof value !== 'string' || value.length === 0 || isSealed(value)) continue;
    const sealed = sealSecret(value);
    if (sealed === value) return; // keychain unavailable on this machine
    setSetting(db, key, { ...obj, [field]: sealed });
    log.info('Sealed a stored secret with the OS keychain', { key, field });
  }
}
