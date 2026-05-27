import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import type { FbrAdapterConfig, FbrMode } from '@cheeseoclock/fbr-core';

export const FBR_CONFIG_KEY = 'fbr.config';

export const FbrConfigSchema = z.object({
  mode: z.enum(['noop', 'sandbox', 'production']),
  endpoint: z.string().url().optional(),
  bearerToken: z.string().optional(),
  sellerNTNCNIC: z.string().default(''),
  sellerBusinessName: z.string().default('Cheese O Clock'),
  sellerProvince: z.string().default('Punjab'),
  sellerAddress: z.string().default(''),
  /** Pause the worker without changing mode (useful when reconfiguring). */
  paused: z.boolean().default(false),
});

export type FbrConfig = z.infer<typeof FbrConfigSchema>;

const DEFAULT_CONFIG: FbrConfig = FbrConfigSchema.parse({ mode: 'noop' });

export function getFbrConfig(db: AppDatabase): FbrConfig {
  const raw = getSettingRaw(db, FBR_CONFIG_KEY);
  const parsed = FbrConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

export function setFbrConfig(db: AppDatabase, config: FbrConfig): void {
  setSetting(db, FBR_CONFIG_KEY, config);
}

/** Convert the user-facing FbrConfig into an FbrAdapterConfig. */
export function toAdapterConfig(c: FbrConfig): FbrAdapterConfig {
  return {
    mode: c.mode,
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    ...(c.bearerToken ? { bearerToken: c.bearerToken } : {}),
    sellerNTN: c.sellerNTNCNIC,
    retry: { maxAttempts: 5, backoffMs: 30_000 },
  };
}

/** Map FbrConfig → the seller block the mapper needs. */
export function toSellerInfo(c: FbrConfig): {
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
} {
  return {
    sellerNTNCNIC: c.sellerNTNCNIC,
    sellerBusinessName: c.sellerBusinessName,
    sellerProvince: c.sellerProvince,
    sellerAddress: c.sellerAddress,
  };
}

/** Whether the config has the minimum required fields for a real submission. */
export function isFbrReady(c: FbrConfig): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (c.mode === 'noop') return { ok: true, missing };
  if (!c.bearerToken) missing.push('Bearer token');
  if (!c.sellerNTNCNIC) missing.push('Seller NTN/CNIC');
  if (!c.sellerBusinessName) missing.push('Business name');
  if (!c.sellerAddress) missing.push('Seller address');
  return { ok: missing.length === 0, missing };
}

export type { FbrMode };
