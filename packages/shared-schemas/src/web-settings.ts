import { z } from 'zod';
import {
  ANNOUNCEMENT_MAX,
  CLOSED_NOTICE_MAX,
  DELIVERY_FEE_MAX_CENTS,
  DELIVERY_ZONES_MAX,
  DELIVERY_ZONE_ID_MAX,
  DELIVERY_ZONE_ID_RE,
  MIN_DELIVERY_ORDER_MAX_CENTS,
  WEBSITE_PICKUP_MAX_PERCENT,
  WEBSITE_TEXT_FORBIDDEN_RE,
} from '@cheeseoclock/shared-types';
import type {
  ClosedNotice,
  PublishedPickup,
  PublishedSettings,
  PublishedZone,
  WebsiteAnnouncement,
} from '@cheeseoclock/shared-types';

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

// ---------------------------------------------------------------------------
// WEBSITE MESSAGES (v0.7.30, shared-types web-bridge.ts): the bounds the till
// writes them in (shared-schemas business-settings.ts 'online.options' uses
// these same rules) and the website checks them against.
// ---------------------------------------------------------------------------

/**
 * One line of plain words for the website, at most `max` letters: no control
 * character (a line break or a tab), no line or paragraph separator, no mark
 * that turns the text's direction, no invisible character
 * (WEBSITE_TEXT_FORBIDDEN_RE). '' is allowed (= none).
 */
export const websiteLine = (max: number, what: string) =>
  z
    .string()
    .max(max, { message: `Keep ${what} to ${max} letters` })
    .refine((t) => !WEBSITE_TEXT_FORBIDDEN_RE.test(t), {
      message: `${what[0]!.toUpperCase()}${what.slice(1)} is one line of plain words (no line break, and no hidden or direction mark — retype it if it was pasted)`,
    });

/** A real calendar day, YYYY-MM-DD (a Karachi date: the notice's last day). */
export const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a day' })
  .refine(
    (ymd) => {
      const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
      const t = Date.UTC(y, m - 1, d);
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
    },
    { message: 'That is not a real date' },
  );

/** The block's closed notice. Not strict: a newer till's extra field is dropped. */
export const publishedClosedNoticeSchema = z.object({
  text: websiteLine(CLOSED_NOTICE_MAX, 'the closed notice'),
  until: calendarDay.nullable(),
});

/** The block's announcement. Not strict. (Shown only while on AND with words: announcementInForce.) */
export const publishedAnnouncementSchema = z.object({
  on: z.boolean(),
  text: websiteLine(ANNOUNCEMENT_MAX, 'the announcement'),
});

/** The smallest website delivery order's food: paisa, whole rupees, Rs 0–5,000 (0 = no minimum). */
export const minDeliveryOrderCentsSchema = z
  .number()
  .int({ message: 'The smallest delivery order is in whole rupees' })
  .min(0, { message: "The smallest delivery order can't be below Rs 0" })
  .max(MIN_DELIVERY_ORDER_MAX_CENTS, {
    message: `The smallest delivery order is at most Rs ${(MIN_DELIVERY_ORDER_MAX_CENTS / 100).toLocaleString('en-US')}`,
  })
  .refine((c) => c % 100 === 0, { message: 'The smallest delivery order is in whole rupees' });

const blockShape = {
  v: z.number().int().min(1),
  settingsAt: instant,
  settingsRev: z.number().int().min(0),
  settingsTie: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deviceId: z.string().max(200),
  pickup: publishedPickupSchema,
  zones: z.array(publishedZoneSchema).min(1).max(DELIVERY_ZONES_MAX),
};

const zonesDistinct = (b: { zones: Array<{ id: string; name: string }> }, ctx: z.RefinementCtx) => {
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
};

/**
 * A block as a till sends it (PUT /api/bridge/menu's `settings`, PUT
 * /api/bridge/settings): a message field out of its bounds fails the block
 * (400 validation) — a till never sends one. The message fields are
 * OPTIONAL: absent from a v0.7.29 till's block = keep what is stored.
 */
export const publishedSettingsSchema = z
  .object({
    ...blockShape,
    closedNotice: publishedClosedNoticeSchema.optional(),
    announcement: publishedAnnouncementSchema.optional(),
    minDeliveryOrderCents: minDeliveryOrderCentsSchema.optional(),
  })
  .superRefine(zonesDistinct);

/**
 * A block as the website READS BACK what it stored (site_menu.menu_json →
 * settings): the same, except that a message field that does not fit (a
 * hand-edited row) reads as ABSENT (its default) instead of throwing the
 * whole block away — the areas and fees must never fall back to the
 * built-in list because of a message.
 */
export const publishedSettingsReadSchema = z
  .object({
    ...blockShape,
    closedNotice: publishedClosedNoticeSchema.optional().catch(undefined),
    announcement: publishedAnnouncementSchema.optional().catch(undefined),
    minDeliveryOrderCents: minDeliveryOrderCentsSchema.optional().catch(undefined),
  })
  .superRefine(zonesDistinct);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _zoneShape: Same<z.infer<typeof publishedZoneSchema>, PublishedZone> = true;
const _pickupShape: Same<z.infer<typeof publishedPickupSchema>, PublishedPickup> = true;
const _settingsShape: Same<z.infer<typeof publishedSettingsSchema>, PublishedSettings> = true;
const _settingsReadShape: Same<z.infer<typeof publishedSettingsReadSchema>, PublishedSettings> = true;
const _closedNoticeShape: Same<z.infer<typeof publishedClosedNoticeSchema>, ClosedNotice> = true;
const _announcementShape: Same<z.infer<typeof publishedAnnouncementSchema>, WebsiteAnnouncement> = true;
