import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { openSecret, sealSecret } from './secret-seal.js';

export const WEB_BRIDGE_CONFIG_KEY = 'webBridge.config';

/**
 * Config for the online-ordering bridge (cheeseoclock.net ↔ this POS).
 * Stored in the settings table; the secret is sealed with the OS keychain
 * (see secret-seal.ts) so backups and USB copies never carry it in clear.
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

/** Config as readable on this machine. */
export interface LoadedWebBridgeConfig extends WebBridgeConfig {
  /**
   * True when a secret is stored but was sealed by another Windows account or
   * PC (a restored copy) and cannot be opened here. The owner enters it again.
   */
  secretUnreadable: boolean;
}

const DEFAULT: WebBridgeConfig = WebBridgeConfigSchema.parse({});

export function getWebBridgeConfig(db: AppDatabase): LoadedWebBridgeConfig {
  const raw = getSettingRaw(db, WEB_BRIDGE_CONFIG_KEY);
  const parsed = WebBridgeConfigSchema.safeParse(raw ?? {});
  const cfg = parsed.success ? parsed.data : { ...DEFAULT };
  const opened = openSecret(cfg.bridgeSecret);
  return { ...cfg, bridgeSecret: opened.value, secretUnreadable: opened.unreadable };
}

export function setWebBridgeConfig(db: AppDatabase, config: WebBridgeConfig): void {
  const { enabled, siteUrl, bridgeSecret, pollIntervalMs, cloudBackupFrequency } = config;
  setSetting(db, WEB_BRIDGE_CONFIG_KEY, {
    enabled,
    siteUrl,
    bridgeSecret: bridgeSecret ? sealSecret(bridgeSecret) : undefined,
    pollIntervalMs,
    cloudBackupFrequency,
  });
}

/** Parse + normalise a site URL typed by the operator (trailing slashes dropped). */
export function normaliseSiteUrl(input: string): string {
  return WebBridgeConfigSchema.shape.siteUrl.parse(input.trim()) as string;
}

export function isWebBridgeReady(
  c: WebBridgeConfig | LoadedWebBridgeConfig,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.siteUrl) missing.push('Website URL');
  if (!c.bridgeSecret) {
    missing.push(
      'secretUnreadable' in c && c.secretUnreadable
        ? 'Bridge secret (it was saved on another PC — enter it again)'
        : 'Bridge secret',
    );
  }
  return { ok: missing.length === 0, missing };
}
