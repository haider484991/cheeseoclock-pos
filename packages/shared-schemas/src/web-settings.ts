import { z } from 'zod';
import {
  ALLERGY_NOTICE_MAX,
  ALLERGY_NOTICE_MIN,
  ANNOUNCEMENT_MAX,
  CLOSED_NOTICE_MAX,
  DEFAULT_SHOP_HOURS,
  DEFAULT_SHOP_PROFILE,
  DEFAULT_SHOP_WEBSITE,
  DEFAULT_WEBSITE_HOME,
  DELIVERY_FEE_MAX_CENTS,
  DELIVERY_ZONES_MAX,
  DELIVERY_ZONE_ID_MAX,
  DELIVERY_ZONE_ID_RE,
  DOOR_PAYMENTS,
  HOME_DEALS_MAX,
  HOME_HEADLINE_MAX,
  HOME_ITEM_NAME_MAX,
  HOME_PIZZAS_MAX,
  HOME_PIZZAS_MIN,
  HOME_TEXT_MAX,
  MIN_DELIVERY_ORDER_MAX_CENTS,
  PRICE_RANGE_MAX,
  SHOP_AREA_LINE_MAX,
  SHOP_DAYS,
  SHOP_NAME_MAX,
  SHOP_PHONE_DISPLAY_MAX,
  SHOP_STREET_MAX,
  SHOP_TAGLINE_MAX,
  SOCIAL_LINKS_MAX,
  WEBSITE_PICKUP_MAX_PERCENT,
  WEBSITE_TEXT_FORBIDDEN_RE,
  WHATSAPP_GREETING_MAX,
  WHATSAPP_LINES_MAX,
  canonicalPayments,
  homeDuplicateProblem,
  normalizePhone,
  sameSocialLink,
  shopHoursProblem,
  socialLinkProblem,
} from '@cheeseoclock/shared-types';
import type {
  ClosedNotice,
  PublishedPickup,
  PublishedSettings,
  PublishedShop,
  PublishedShopHours,
  PublishedShopProfile,
  PublishedShopWebsite,
  PublishedWebsiteHome,
  PublishedZone,
  ShopDay,
  ShopPhone,
  WebsiteAnnouncement,
  WebsiteHome,
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
  /** v0.7.37 (WEBSITE DELIVERY DISCOUNT): sent only as true; absent = deliveries pay full price. */
  alsoDelivery: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// WEBSITE MESSAGES (v0.7.30, shared-types web-bridge.ts): the bounds the till
// writes them in (shared-schemas business-settings.ts 'online.options' uses
// these same rules) and the website checks them against.
// ---------------------------------------------------------------------------

/**
 * One line of plain words for the website, at most `max` letters: no control
 * character (a line break or a tab), no line or paragraph separator, and no
 * format character — a mark that turns the text's direction, an invisible
 * one — but the zero-width non-joiner and joiner (Urdu keyboards and emoji
 * use them): WEBSITE_TEXT_FORBIDDEN_RE. '' is allowed (= none).
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

// ---------------------------------------------------------------------------
// THE SHOP BLOCK (sweep B2 + B4, shared-types web-bridge.ts): the bounds of
// its four sections — the SAME rules the till's Save checks ('shop.profile',
// 'shop.hours', 'shop.website', 'website.home' in business-settings.ts use
// these fields), so what a till saves always passes the website's check.
// Nested objects are not strict: a newer till's extra field is dropped.
// ---------------------------------------------------------------------------

const cap = (what: string) => `${what[0]!.toUpperCase()}${what.slice(1)}`;

/**
 * One line of the shop's words for the website: one line of plain words
 * (websiteLine: no line break, no hidden or direction mark), `min` to `max`
 * letters, no spaces at its start or end.
 */
export const shopLine = (min: number, max: number, what: string) =>
  websiteLine(max, what)
    .refine((t) => t.trim() === t, { message: `${cap(what)} has no spaces at its start or end` })
    .refine((t) => t.length >= min, {
      message: min <= 1 ? `${cap(what)} can’t be empty` : `${cap(what)} is at least ${min} letters`,
    });

/** A phone line: printed as typed ("0300 9367865"), dialled as +92 and ten digits; the two must be the same number. */
export const shopPhoneSchema = z
  .object({
    display: z
      .string()
      .min(1, { message: 'Type the phone number' })
      .max(SHOP_PHONE_DISPLAY_MAX, { message: `Keep a phone number to ${SHOP_PHONE_DISPLAY_MAX} characters` })
      .regex(/^[0-9+\-() ]+$/, { message: 'A phone number is digits, spaces, + and -' }),
    e164: z.string().regex(/^\+92\d{10}$/, { message: 'A phone number is a Pakistani number (+92 and ten digits)' }),
  })
  .superRefine((p, ctx) => {
    if (normalizePhone(p.display) !== p.e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${p.display} is not a Pakistani phone number the website can call` });
    }
  });

const shopAddressSchema = z.object({
  street: shopLine(1, SHOP_STREET_MAX, 'the street address'),
  areaLine: shopLine(1, SHOP_AREA_LINE_MAX, 'the short address line'),
  postalCode: z.string().regex(/^\d{5}$/, { message: 'The postal code is five digits' }),
});

/** 'shop.profile' without its format: name, tagline, numbers, address, social links, price range. */
export const shopProfileFields = {
  name: shopLine(1, SHOP_NAME_MAX, 'the shop’s name'),
  tagline: shopLine(0, SHOP_TAGLINE_MAX, 'the tagline'),
  phone: shopPhoneSchema,
  whatsappLines: z
    .array(shopPhoneSchema)
    .min(1, { message: 'Keep at least one WhatsApp number' })
    .max(WHATSAPP_LINES_MAX, { message: `At most ${WHATSAPP_LINES_MAX} WhatsApp numbers` })
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      for (const l of lines) {
        if (seen.has(l.e164)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${l.display} is listed twice` });
        seen.add(l.e164);
      }
    }),
  address: shopAddressSchema,
  socialLinks: z
    .array(
      z.string().superRefine((url, ctx) => {
        const problem = socialLinkProblem(url);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    )
    .max(SOCIAL_LINKS_MAX, { message: `At most ${SOCIAL_LINKS_MAX} social links` })
    .superRefine((links, ctx) => {
      for (let i = 0; i < links.length; i += 1) {
        if (links.slice(0, i).some((l) => sameSocialLink(l, links[i]!))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${links[i]!} is listed twice` });
          return;
        }
      }
    }),
  priceRange: shopLine(1, PRICE_RANGE_MAX, 'the price range'),
};

/** 'shop.hours' without its format. THE rule: shared-types shopHoursProblem (shopHoursRule). */
export const shopHoursFields = {
  opens: z.string().max(5),
  closes: z.string().max(5),
  days: z.array(z.enum(SHOP_DAYS, { errorMap: () => ({ message: 'That is not a day of the week' }) })).max(7),
};
export const shopHoursRule = (h: { opens: string; closes: string; days: ShopDay[] }, ctx: z.RefinementCtx) => {
  const problem = shopHoursProblem(h);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
};

/** What the rider or the counter takes, in the website's words: cash always (v1), each once, in the usual order. */
const paymentsList = (what: string) =>
  z
    .array(z.enum(DOOR_PAYMENTS, { errorMap: () => ({ message: `${cap(what)}: cash, card, EasyPaisa, JazzCash or bank transfer` }) }))
    .min(1, { message: `${cap(what)} includes cash` })
    .max(DOOR_PAYMENTS.length)
    .superRefine((list, ctx) => {
      if (!list.includes('cash')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${cap(what)} always includes cash` });
      else if (new Set(list).size !== list.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${cap(what)}: each one once` });
      else if (canonicalPayments(list).join() !== list.join()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${cap(what)}: in the usual order (cash, card, EasyPaisa, JazzCash, bank transfer)` });
      }
    });

/** 'shop.website' without its format: the greeting, the payment words, the allergy notice. */
export const shopWebsiteFields = {
  whatsappGreeting: websiteLine(WHATSAPP_GREETING_MAX, 'the WhatsApp greeting')
    .refine((t) => /^\S/.test(t), { message: 'The WhatsApp greeting has words, with no space at its start' })
    .refine((t) => /\S $/.test(t), { message: 'The WhatsApp greeting ends with one space (the customer types on after it)' }),
  doorPayments: paymentsList('what the rider takes'),
  pickupPayments: paymentsList('what the counter takes for a pick-up'),
  allergyNotice: shopLine(ALLERGY_NOTICE_MIN, ALLERGY_NOTICE_MAX, 'the allergy notice'),
};

const homeItemRefSchema = z.object({
  posItemId: z.string().min(1).max(64).nullable(),
  // As the till names the item (not trimmed here: it is the till's name, matched folded).
  name: websiteLine(HOME_ITEM_NAME_MAX, 'an item’s name').refine((t) => t.trim() !== '', { message: 'Pick an item' }),
});
const homeEntrySchema = z.object({
  itemRef: homeItemRefSchema,
  headline: shopLine(1, HOME_HEADLINE_MAX, 'a home headline').optional(),
  text: shopLine(1, HOME_TEXT_MAX, 'the home words').optional(),
});

/** 'website.home' without its format: 1–8 pizzas, at most one burger, 0–4 deals. */
export const websiteHomeFields = {
  pizzas: z
    .array(homeEntrySchema)
    .min(HOME_PIZZAS_MIN, { message: 'The home page shows at least one pizza' })
    .max(HOME_PIZZAS_MAX, { message: `The home page shows at most ${HOME_PIZZAS_MAX} pizzas` }),
  burger: homeEntrySchema.nullable(),
  deals: z.array(homeEntrySchema).max(HOME_DEALS_MAX, { message: `The home page shows at most ${HOME_DEALS_MAX} deals` }),
};
export const websiteHomeRule = (h: Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>, ctx: z.RefinementCtx) => {
  const twice = homeDuplicateProblem(h);
  if (twice) ctx.addIssue({ code: z.ZodIssueCode.custom, message: twice });
  const headed = h.deals.find((d) => d.headline !== undefined);
  if (headed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A deal shows no headline (${headed.itemRef.name})` });
};

export const publishedShopProfileSchema = z.object(shopProfileFields);
export const publishedShopHoursSchema = z.object(shopHoursFields).superRefine(shopHoursRule);
export const publishedShopWebsiteSchema = z.object(shopWebsiteFields);
export const publishedWebsiteHomeSchema = z.object(websiteHomeFields).superRefine(websiteHomeRule);

/** An ISO instant for a stamp. */
const stampInstant = z
  .string()
  .max(40)
  .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)), { message: 'shopAt is not a time' });

const shopStampShape = {
  v: z.number().int().min(1),
  shopRev: z.number().int().min(0),
  shopAt: stampInstant,
  shopTie: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deviceId: z.string().max(200),
};

/**
 * The shop block as a till sends it (PUT /api/bridge/menu's `shop`, PUT
 * /api/bridge/shop): a section out of its bounds fails the block — the
 * website answers 400 shop_invalid with the first issue's message. Not
 * strict: a newer till's extra field is dropped.
 */
export const publishedShopSchema = z.object({
  ...shopStampShape,
  profile: publishedShopProfileSchema,
  hours: publishedShopHoursSchema,
  website: publishedShopWebsiteSchema,
  home: publishedWebsiteHomeSchema,
});

/** A section of a default without its format, as a fresh copy (never the frozen object). */
const sectionOf = <T extends { v: number }>(d: Readonly<T>): Omit<T, 'v'> => {
  const { v: _v, ...rest } = JSON.parse(JSON.stringify(d)) as T;
  return rest;
};

/**
 * The shop block as the website READS BACK what it stored
 * (site_menu.menu_json → shop): a section that does not read (a hand-edited
 * row) falls back to its DEFAULT alone (today's website) — never taking the
 * other sections, or the stamp, with it.
 */
export const publishedShopReadSchema = z.object({
  ...shopStampShape,
  profile: publishedShopProfileSchema.catch(() => sectionOf(DEFAULT_SHOP_PROFILE)),
  hours: publishedShopHoursSchema.catch(() => sectionOf(DEFAULT_SHOP_HOURS)),
  website: publishedShopWebsiteSchema.catch(() => sectionOf(DEFAULT_SHOP_WEBSITE)),
  home: publishedWebsiteHomeSchema.catch(() => sectionOf(DEFAULT_WEBSITE_HOME)),
});

const _shopShape: Same<z.infer<typeof publishedShopSchema>, PublishedShop> = true;
const _shopReadShape: Same<z.infer<typeof publishedShopReadSchema>, PublishedShop> = true;
const _shopProfileShape: Same<z.infer<typeof publishedShopProfileSchema>, PublishedShopProfile> = true;
const _shopHoursShape: Same<z.infer<typeof publishedShopHoursSchema>, PublishedShopHours> = true;
const _shopWebsiteShape: Same<z.infer<typeof publishedShopWebsiteSchema>, PublishedShopWebsite> = true;
const _websiteHomeShape: Same<z.infer<typeof publishedWebsiteHomeSchema>, PublishedWebsiteHome> = true;
const _shopPhoneShape: Same<z.infer<typeof shopPhoneSchema>, ShopPhone> = true;
