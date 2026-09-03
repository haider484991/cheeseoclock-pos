import { safeStorage } from 'electron';
import log from 'electron-log/main';

/**
 * Secrets at rest. The settings table is plain JSON inside the SQLite file,
 * and the SQLite file is what every backup, USB copy and cloud copy carries.
 * Storing the website bridge secret, the FBR token or a sync secret in clear
 * text there meant a lost USB stick handed over the keys to the website.
 *
 * Sealing uses the OS keychain through Electron's safeStorage — DPAPI on
 * Windows, bound to the signed-in Windows account. A sealed value reads back
 * only on the machine and account that sealed it. Elsewhere (a restore on a
 * new PC) it is simply unreadable and the owner enters the secret again; the
 * Settings page says so instead of failing quietly.
 *
 * Format: "enc1:" + base64(ciphertext). Anything without the prefix is a
 * legacy plain value and is sealed on the next save (or at boot, see
 * sealAllStoredSecrets).
 */

const PREFIX = 'enc1:';
let warnedUnavailable = false;

export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

export function sealSecret(plain: string): string {
  if (!plain || isSealed(plain)) return plain;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (e) {
    log.warn('safeStorage could not seal a secret; storing it unsealed', e);
    return plain;
  }
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    log.warn('OS secret storage is unavailable on this machine; secrets stay unsealed');
  }
  return plain;
}

export interface OpenedSecret {
  value: string | undefined;
  /** True when the value was sealed by another machine/account and cannot be read here. */
  unreadable: boolean;
}

export function openSecret(stored: string | null | undefined): OpenedSecret {
  if (!stored) return { value: undefined, unreadable: false };
  if (!isSealed(stored)) return { value: stored, unreadable: false };
  try {
    const bytes = Buffer.from(stored.slice(PREFIX.length), 'base64');
    return { value: safeStorage.decryptString(bytes), unreadable: false };
  } catch {
    return { value: undefined, unreadable: true };
  }
}
