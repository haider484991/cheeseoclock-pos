import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters tuned for fast counter-side login (~200ms on a modern
 * laptop). Used for both kinds of sign-in secret: a 4-12 digit PIN, where
 * the strength comes from the lockout on attempts (login-attempts.ts), and a
 * 6-64 character password. 19 MiB / t=2 / p=1 is OWASP's minimum argon2id
 * setting for passwords. The functions keep their PIN names; the argument
 * is the normalized secret either way (normalizeSecret, shared-schemas).
 *
 * @node-rs/argon2 defaults to Argon2id — we keep the default by omitting algorithm
 * (importing Algorithm enum trips isolatedModules const-enum rules).
 */
const ARGON_OPTS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPin(pin: string): Promise<string> {
  return await hash(pin, ARGON_OPTS);
}

export async function verifyPin(pin: string, expectedHash: string): Promise<boolean> {
  try {
    return await verify(expectedHash, pin);
  } catch {
    return false;
  }
}
