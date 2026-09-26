import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import { openSecret, sealSecret } from './secret-seal.js';

/**
 * The key the wrong-PIN/password counters are filed under (login_attempts).
 *
 * Each row of login_attempts is keyed on a digest of what was typed, and that
 * table travels in every backup, USB copy and daily cloud copy. A plain
 * SHA-256 of a guess (the prefix is in this public repo) can be reversed by
 * trying billions of candidates a second, and one path files a cashier's
 * CORRECT password under it (typed into a manager box). So the digest is an
 * HMAC with this key, and the key lives in its own file next to the database,
 * never inside it: a copy of the database alone no longer says what anyone
 * typed.
 *
 * The file is sealed with the OS keychain when it can be (secret-seal.ts). If
 * it is missing or unreadable (a restore on a new PC, another Windows
 * account), a new key is made: the old rows are simply never matched again,
 * and are pruned (login-attempts.ts). Nothing is lost but a running count.
 */

const KEY_FILE = 'login-attempts.key';
const KEY_BYTES = 32;

let cached: Buffer | null = null;

export function attemptKey(): Buffer {
  if (!cached) cached = loadOrCreate();
  return cached;
}

/** Tests: forget the key so the next call reads the file again. */
export function resetAttemptKeyForTests(): void {
  cached = null;
}

function keyFilePath(): string | null {
  try {
    return path.join(app.getPath('userData'), KEY_FILE);
  } catch {
    // No Electron app (unit tests): a key for this run only.
    return null;
  }
}

function loadOrCreate(): Buffer {
  const file = keyFilePath();
  if (file) {
    try {
      const opened = openSecret(readFileSync(file, 'utf8').trim());
      const key = opened.value ? Buffer.from(opened.value, 'base64') : null;
      if (key && key.length === KEY_BYTES) return key;
    } catch {
      // Missing: made below.
    }
  }
  const key = randomBytes(KEY_BYTES);
  if (file) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, sealSecret(key.toString('base64')), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      log.warn('Could not save the login-attempts key; wrong-PIN counts restart with the app', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return key;
}
