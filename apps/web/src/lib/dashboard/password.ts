import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Dashboard passwords (shared-types dashboard.ts): scrypt from node:crypto,
 * so the website adds no dependency and no native module.
 *
 * N = 2^17, r = 8, p = 1 is OWASP's floor for scrypt (128 MiB, a few hundred
 * milliseconds on a Vercel function), so a stolen database row costs an
 * attacker real work per guess. The parameters travel inside the stored
 * string, so a later change of N still reads every password made before it.
 *
 *   scrypt$<log2 N>$<r>$<p>$<salt base64url>$<key base64url>
 */

const LOG2_N = 17;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
/** Node's default memory cap (32 MiB) is below what N = 2^17 needs (128 * N * r = 128 MiB). */
const MAX_MEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N: 2 ** log2N, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, LOG2_N, R, P);
  return ['scrypt', LOG2_N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** false for a wrong password AND for a stored value this code can't read (never throws). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, keyText] = parts as [string, string, string, string, string, string];
  const log2N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  // Bounds keep a tampered row from asking for gigabytes of memory.
  if (![log2N, rr, pp].every(Number.isInteger) || log2N < 14 || log2N > 20 || rr < 1 || rr > 16 || pp < 1 || pp > 4) {
    return false;
  }
  const want = Buffer.from(keyText, 'base64url');
  if (want.length !== KEY_BYTES) return false;
  try {
    const got = await derive(password, Buffer.from(saltText, 'base64url'), log2N, rr, pp);
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/**
 * A hash nobody's password matches, worked out once: a sign-in for a
 * username that doesn't exist still pays for one scrypt, so the answer's
 * timing does not tell which usernames are real.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  if (!decoy) decoy = hashPassword(randomBytes(24).toString('base64url'));
  return decoy;
}
