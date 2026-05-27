import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { SyncMode } from '../adapters/sync/factory.js';

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
  return parsed.success ? parsed.data : DEFAULT;
}

export function setSyncConfig(db: AppDatabase, config: SyncConfig): void {
  setSetting(db, SYNC_CONFIG_KEY, config);
}

export function isSyncReady(c: SyncConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (c.mode === 'off' || c.mode === 'mock') return { ok: true, missing };
  if (!c.baseUrl) missing.push('Backend URL');
  if (!c.deviceSecret) missing.push('Device secret');
  return { ok: missing.length === 0, missing };
}

export type { SyncMode };
