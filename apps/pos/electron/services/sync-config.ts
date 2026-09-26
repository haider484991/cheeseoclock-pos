import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { DestinationCodec } from '../db/repositories/sync-repo.js';
import type { SyncMode } from '../adapters/sync/factory.js';
import { openSecret, sealSecret } from './secret-seal.js';

export const SYNC_CONFIG_KEY = 'sync.config';

export const SyncConfigSchema = z.object({
  mode: z.enum(['off', 'mock', 'http']).default('off'),
  baseUrl: z.string().url().optional(),
  deviceSecret: z.string().optional(),
  /** How often (ms) the worker checks for pending pushes / pulls. */
  pollIntervalMs: z.number().int().min(2_000).default(15_000),
  paused: z.boolean().default(false),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

const DEFAULT: SyncConfig = SyncConfigSchema.parse({});

export function getSyncConfig(db: AppDatabase): SyncConfig {
  const raw = getSettingRaw(db, SYNC_CONFIG_KEY);
  const parsed = SyncConfigSchema.safeParse(raw ?? {});
  const cfg = parsed.success ? parsed.data : DEFAULT;
  // Sealed with the OS keychain at rest; unreadable on another PC → absent.
  return { ...cfg, deviceSecret: openSecret(cfg.deviceSecret).value };
}

/**
 * Just the link switch (mode + paused), without unsealing the secret: cheap
 * enough to ask before every housekeeping step. Parsed exactly as
 * getSyncConfig parses it, so housekeeping always agrees with what the sync
 * worker is doing (an unreadable config is "off" for both).
 */
export function readSyncSwitch(db: AppDatabase): { mode: SyncConfig['mode']; paused: boolean } {
  const parsed = SyncConfigSchema.safeParse(getSettingRaw(db, SYNC_CONFIG_KEY) ?? {});
  const cfg = parsed.success ? parsed.data : DEFAULT;
  return { mode: cfg.mode, paused: cfg.paused };
}

/**
 * Where the link points, as compared between ticks to notice a new place to
 * send to: the mode, the server address written one way (host lower-case, no
 * default port, no trailing slash) and a short fingerprint of the till's
 * password on it (a server set up again gives a new one). The secret itself
 * never goes into it, and the key is only ever stored sealed
 * (destinationSeal): a fast hash of a password, readable in a backup, would
 * let anyone holding the backup test guesses at the password offline.
 */
export function syncDestinationKey(cfg: Pick<SyncConfig, 'mode' | 'baseUrl' | 'deviceSecret'>): string {
  if (cfg.mode !== 'http') return cfg.mode;
  let url = (cfg.baseUrl ?? '').trim();
  try {
    const u = new URL(url);
    url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    url = url.replace(/\/+$/, '').toLowerCase();
  }
  const secret = cfg.deviceSecret
    ? createHash('sha256').update(cfg.deviceSecret).digest('hex').slice(0, 12)
    : '';
  return `http|${url}|${secret}`;
}

/**
 * sync_state "sync.destination" is sealed with the OS keychain, like the sync
 * password itself (secret-seal.ts; DPAPI on Windows): in a backup or cloud
 * copy it cannot be read, so it cannot be used to check password guesses.
 * On a PC without OS secret storage it stays plain, but so does the password
 * in settings then, so nothing more is given away. A value that cannot be
 * opened here (restored onto another PC) reads as unknown, which counts as a
 * new place to send to.
 */
export const destinationSeal: DestinationCodec = {
  seal: (key) => sealSecret(key),
  open: (stored) => {
    const o = openSecret(stored);
    return o.unreadable ? null : (o.value ?? null);
  },
};

export function setSyncConfig(db: AppDatabase, config: SyncConfig, actorUserId: string | null = null): void {
  setSetting(
    db,
    SYNC_CONFIG_KEY,
    { ...config, deviceSecret: config.deviceSecret ? sealSecret(config.deviceSecret) : undefined },
    { actorUserId },
  );
}

export function isSyncReady(c: SyncConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (c.mode === 'off' || c.mode === 'mock') return { ok: true, missing };
  if (!c.baseUrl) missing.push('Backend URL');
  if (!c.deviceSecret) missing.push('Device secret');
  return { ok: missing.length === 0, missing };
}

export type { SyncMode };
