import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters tuned for fast counter-side login (~200ms on a modern
 * laptop). Strong enough for a 4-8 digit PIN given login attempts are also
 * rate-limited at the application layer.
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
