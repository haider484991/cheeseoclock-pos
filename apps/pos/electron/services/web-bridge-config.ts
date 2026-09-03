import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';

export const WEB_BRIDGE_CONFIG_KEY = 'webBridge.config';

/**
 * Config for the online-ordering bridge (cheeseoclock.net ↔ this POS).
 * Stored in the encrypted settings table next to FBR/sync config.
 */
export const WebBridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** e.g. https://www.cheeseoclock.net — the exact host the site lives on, no trailing slash. */
  siteUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  /** Must equal BRIDGE_SECRET on the Vercel deployment. */
  bridgeSecret: z.string().optional(),
  pollIntervalMs: z.number().int().min(5_000).default(20_000),
  /**
   * Scheduled upload of the (gzipped) SQLite database to the cloud.
   * Independent of `enabled` (online ordering) — a shop can back up to the
   * cloud without accepting web orders, as long as siteUrl + secret are set.
   */
  cloudBackupFrequency: z.enum(['off', 'daily', 'weekly', 'monthly']).default('daily'),
});

export const CLOUD_BACKUP_INTERVALS_MS: Record<
  'daily' | 'weekly' | 'monthly',
  number
> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export type WebBridgeConfig = z.infer<typeof WebBridgeConfigSchema>;

const DEFAULT: WebBridgeConfig = WebBridgeConfigSchema.parse({});

export function getWebBridgeConfig(db: AppDatabase): WebBridgeConfig {
  const raw = getSettingRaw(db, WEB_BRIDGE_CONFIG_KEY);
  const parsed = WebBridgeConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT;
}

export function setWebBridgeConfig(db: AppDatabase, config: WebBridgeConfig): void {
  setSetting(db, WEB_BRIDGE_CONFIG_KEY, config);
}

export function isWebBridgeReady(c: WebBridgeConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.siteUrl) missing.push('Website URL');
  if (!c.bridgeSecret) missing.push('Bridge secret');
  return { ok: missing.length === 0, missing };
}
