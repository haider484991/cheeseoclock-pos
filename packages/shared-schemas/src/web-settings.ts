import { z } from 'zod';
import {
  DELIVERY_FEE_MAX_CENTS,
  DELIVERY_ZONES_MAX,
  DELIVERY_ZONE_ID_MAX,
  DELIVERY_ZONE_ID_RE,
  WEBSITE_PICKUP_MAX_PERCENT,
} from '@cheeseoclock/shared-types';
import type { PublishedPickup, PublishedSettings, PublishedZone } from '@cheeseoclock/shared-types';

/**
 * The settings block of the menu publish (PublishedMenu.settings, Settings
 * step 3): the ONE schema the website validates it with and the till's
 * tests check it against. The contract — what the website stores, keeps or
 * ignores, and what it answers — is written out in shared-types
 * web-bridge.ts ("THE SETTINGS BLOCK").
 *
 * Deliberately NOT strict: a newer till may add fields; an older website
 * drops them and uses what it knows. The cross-check against the menu that
 * travels with it is shared-types settingsBlockProblem.
 */

/** An ISO 8601 instant ("2026-09-29T14:02:00.000Z"). */
const instant = z
  .string()
  .max(40)
  .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)), {
    message: 'settingsAt is not a time',
  });

export const publishedZoneSchema = z.object({
  id: z
    .string()
    .max(DELIVERY_ZONE_ID_MAX)
    .regex(DELIVERY_ZONE_ID_RE, { message: 'A zone id is lower-case letters, digits and dashes' }),
  name: z.string().trim().min(1).max(80),
  shortName: z.string().trim().min(1).max(40),
  group: z.string().trim().min(1).max(40),
  feeCents: z
    .number()
    .int()
    .min(0)
    .max(DELIVERY_FEE_MAX_CENTS)
    .refine((c) => c % 100 === 0, { message: 'A delivery fee is whole rupees' }),
  feeItemId: z.string().min(1).max(64).nullable(),
  active: z.boolean(),
  sort: z.number().int().min(0).max(10_000),
  aliases: z.array(z.string().max(80)).max(60),
});

export const publishedPickupSchema = z.object({
  offered: z.boolean(),
  percent: z.number().int().min(0).max(WEBSITE_PICKUP_MAX_PERCENT),
});

export const publishedSettingsSchema = z
  .object({
    v: z.number().int().min(1),
    settingsAt: instant,
    settingsRev: z.number().int().min(0),
    settingsTie: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    deviceId: z.string().max(200),
    pickup: publishedPickupSchema,
    zones: z.array(publishedZoneSchema).min(1).max(DELIVERY_ZONES_MAX),
  })
  .superRefine((b, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const zn of b.zones) {
      if (ids.has(zn.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two zones have the id "${zn.id}"` });
      ids.add(zn.id);
      const n = zn.name.trim().toLowerCase();
      if (names.has(n))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two zones are called "${zn.name}"` });
      names.add(n);
    }
  });

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _zoneShape: Same<z.infer<typeof publishedZoneSchema>, PublishedZone> = true;
const _pickupShape: Same<z.infer<typeof publishedPickupSchema>, PublishedPickup> = true;
const _settingsShape: Same<z.infer<typeof publishedSettingsSchema>, PublishedSettings> = true;
