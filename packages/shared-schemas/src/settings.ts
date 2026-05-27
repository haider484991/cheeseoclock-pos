import { z } from 'zod';

/**
 * Settings are key-value JSON. Schemas here are the authoritative per-key shapes.
 * Use settingsSchemaForKey(key) to look up a schema for validation on write.
 */

export const businessProfileSchema = z.object({
  businessName: z.string().min(1).max(120),
  ntn: z.string().regex(/^\d{7,13}$/).optional(),
  address: z.string().max(500).optional(),
  province: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(200).optional(),
  taxInclusive: z.boolean().default(false),
});

export const fbrSettingsSchema = z.object({
  mode: z.enum(['noop', 'sandbox', 'production']).default('noop'),
  endpoint: z.string().url().optional(),
  sellerNTN: z.string().regex(/^\d{7,13}$/).optional(),
  /** Bearer token — stored encrypted at rest in the settings table. */
  bearerTokenCipher: z.string().optional(),
  retryMaxAttempts: z.number().int().min(1).max(20).default(8),
  retryBackoffMs: z.number().int().min(1000).default(30_000),
});

export const printerWidthSettingSchema = z.object({
  defaultWidth: z.union([z.literal(32), z.literal(48)]).default(48),
});

export const SETTINGS_KEYS = {
  BUSINESS_PROFILE: 'business.profile',
  FBR: 'fbr',
  PRINTER_DEFAULT_WIDTH: 'printer.defaultWidth',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

export function settingsSchemaForKey(key: SettingsKey) {
  switch (key) {
    case SETTINGS_KEYS.BUSINESS_PROFILE:
      return businessProfileSchema;
    case SETTINGS_KEYS.FBR:
      return fbrSettingsSchema;
    case SETTINGS_KEYS.PRINTER_DEFAULT_WIDTH:
      return printerWidthSettingSchema;
  }
}
