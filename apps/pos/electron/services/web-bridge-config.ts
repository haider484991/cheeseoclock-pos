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
  /** e.g. https://cheeseoclock.net — no trailing slash. */
  siteUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  /** Must equal BRIDGE_SECRET on the Vercel deployment. */
  bridgeSecret: z.string().optional(),
  pollIntervalMs: z.number().int().min(5_000).default(20_000),
});

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
