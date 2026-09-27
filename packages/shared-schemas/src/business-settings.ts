import { z } from 'zod';
import { COMMISSION_BASES, DAY_NOTE_TAGS, RIDER_COST_MODES, daypartHours } from '@cheeseoclock/shared-types';
import type {
  ChannelFees,
  CostAlertSettings,
  CostingTargets,
  Daypart,
  MenuMapRequest,
  RiderCostSetting,
  SetChannelFeesRequest,
  SetCostAlertSettingsRequest,
  SetCostingTargetsRequest,
  TillsSetting,
  WhatIfRequest,
} from '@cheeseoclock/shared-types';

/**
 * Business settings (costing spec §3, migration 0032): shop-wide settings
 * both tills share, one row per key in `business_settings` (replicable,
 * unlike the per-till `settings` table). Every key has exactly one schema
 * here; a value is checked against it when it is written AND when it is
 * read back (a row from another till's newer version that does not fit is
 * ignored, never trusted). Each phase adds only its own keys.
 */

/** A food-cost target or the "close" width: a whole number of basis points, 0–100%. */
const targetBps = z
  .number()
  .int({ message: 'A target is a whole number of basis points' })
  .min(0, { message: 'A target cannot be below 0%' })
  .max(10_000, { message: 'A target cannot be above 100%' });

/** Phase 1: food-cost targets per menu category. */
export const costingTargetsSchema = z
  .object({
    defaultBps: targetBps.refine((v) => v > 0, { message: 'The default target must be above 0%' }),
    amberBps: targetBps.max(5_000, { message: '"Close" can be at most 50 points over the target' }),
    perCategory: z.record(
      z.string().min(1),
      z.object({
        bps: targetBps.refine((v) => v > 0, { message: 'A target must be above 0%' }),
        confirmed: z.boolean(),
      }),
    ),
    nonFoodCategoryIds: z.array(z.string().min(1)).max(500),
  })
  .strict();

/** Phase 1: prices are suggested in steps of this many paisa (Rs 1 to Rs 1,000). */
export const costingPriceStepSchema = z
  .number()
  .int({ message: 'The price step is a whole number of paisa' })
  .min(100, { message: 'The price step is at least Rs 1' })
  .max(100_000, { message: 'The price step is at most Rs 1,000' });

/** The key items as a list of ingredient ids (at most 1,000). */
const keyIngredientIdsSchema = z.array(z.string().min(1)).max(1_000);

const alertThresholds = {
  jumpBps: z
    .number()
    .int({ message: 'The price-jump threshold is a whole number of basis points' })
    .min(100, { message: 'A price jump is at least 1%' })
    .max(10_000, { message: 'A price jump is at most 100%' }),
  impactWeekCents: z
    .number()
    .int({ message: 'The weekly amount is in whole paisa' })
    .min(0, { message: 'The weekly amount cannot be below Rs 0' })
    .max(100_000_000, { message: 'The weekly amount is at most Rs 1,000,000' }),
};

/**
 * Phase 6: the price alerts' thresholds (costing spec D1, Phase 6). A key
 * item moving more than `jumpBps` is an alert — and the same figure is D1's
 * purchase guard (a bill that far from the usual price asks first); any
 * price change costing at least `impactWeekCents` a week at this till's
 * sales is an alert.
 *
 * `keyIngredientIds` is LEGACY: Phase 6 kept the key ingredients here; since
 * Phase 8 they are one list on the ingredients (ingredients.count_weekly),
 * and migration 0038 moved a saved list there once. Never READ since then.
 * Still written — a copy of the ingredients' list (ingredient-repo
 * mirrorKeyItemsForOlderTills) — for a till not yet upgraded: v0.7.16 needs
 * it to read the setting at all, and its 0038 moves that copy onto its
 * ingredients when it is upgraded after the other till.
 */
export const costingAlertsSchema = z
  .object({
    ...alertThresholds,
    keyIngredientIds: keyIngredientIdsSchema.optional(),
  })
  .strict();

/**
 * Phase 8: how many tills take orders at the shop (owner question 3; 1 when
 * nothing is saved). Two, while the second-till link is off, switches off
 * "used vs should have used" and the real food cost (costing spec D14).
 */
export const analyticsTillsSchema = z
  .object({
    sellingTills: z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'One till or two' }) }),
  })
  .strict();

/** A Pakistan clock hour, 0–23. */
const clockHour = z
  .number()
  .int({ message: 'An hour is a whole number from 0 to 23' })
  .min(0, { message: 'An hour is from 0 to 23' })
  .max(23, { message: 'An hour is from 0 to 23' });

/**
 * Phase 7: the parts of the day Reports → When splits the sales into
 * (costing spec 4.10). One to six parts, each a name and its first and last
 * clock hour (Late 23 → 4 runs across midnight). No two parts share an hour
 * or a name; hours in no part are "Other hours".
 */
export const analyticsDaypartsSchema = z
  .array(
    z
      .object({
        name: z.string().trim().min(1, { message: 'Give each part of the day a name' }).max(24, { message: 'Keep a name to 24 letters' }),
        fromHour: clockHour,
        toHour: clockHour,
      })
      .strict(),
  )
  .min(1, { message: 'Keep at least one part of the day' })
  .max(6, { message: 'At most six parts of the day' })
  .superRefine((parts, ctx) => {
    const names = new Set<string>();
    const taken = new Map<number, string>();
    for (const p of parts) {
      const key = p.name.trim().toLowerCase();
      if (names.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two parts of the day are called "${p.name}"` });
        return;
      }
      names.add(key);
      for (const h of daypartHours(p)) {
        const other = taken.get(h);
        if (other !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${other}" and "${p.name}" both take the hour from ${h}:00` });
          return;
        }
        taken.set(h, p.name);
      }
    }
  });

/** A share of money in basis points, 0–100% (2500 = 25%). */
const feeBps = (what: string) =>
  z
    .number()
    .int({ message: `${what} is a whole number of basis points` })
    .min(0, { message: `${what} cannot be below 0%` })
    .max(10_000, { message: `${what} cannot be above 100%` });

/** Paisa, Rs 0 to Rs 100,000. */
const feeCents = (what: string) =>
  z
    .number()
    .int({ message: `${what} is in whole paisa` })
    .min(0, { message: `${what} cannot be below Rs 0` })
    .max(10_000_000, { message: `${what} is at most Rs 100,000` });

/**
 * Phase 9: foodpanda's commission (owner question 9; 25% of the order before
 * tax until answered) and what each way of paying costs (costing spec 4.7).
 */
export const channelFeesSchema = z
  .object({
    foodpanda: z
      .object({
        commissionBps: feeBps('The commission'),
        base: z.enum(COMMISSION_BASES, { errorMap: () => ({ message: 'Pick what the commission is taken on' }) }),
        fixedFeeCents: feeCents('The fixed fee'),
        upliftBps: feeBps('How much dearer foodpanda is'),
      })
      .strict(),
    paymentFeeBps: z
      .object({
        cash: feeBps('A payment fee'),
        card: feeBps('A payment fee'),
        foodpanda: feeBps('A payment fee'),
        transfer: feeBps('A payment fee'),
      })
      .strict(),
  })
  .strict();

/** Phase 9: what a delivery costs in rider (costing spec 4.7): the zone's rate by default. */
export const riderCostSchema = z
  .object({
    mode: z.enum(RIDER_COST_MODES, { errorMap: () => ({ message: 'Pick how riders are paid' }) }),
    fixedCents: feeCents('The rider cost per trip'),
  })
  .strict();

/** Every key and its schema. A key not listed here cannot be written. */
export const BUSINESS_SETTING_SCHEMAS = {
  'costing.targets': costingTargetsSchema,
  'costing.priceStep': costingPriceStepSchema,
  'costing.alerts': costingAlertsSchema,
  'analytics.dayparts': analyticsDaypartsSchema,
  'analytics.tills': analyticsTillsSchema,
  'channels.fees': channelFeesSchema,
  'delivery.riderCost': riderCostSchema,
} as const;

export type BusinessSettingKey = keyof typeof BUSINESS_SETTING_SCHEMAS;
export type BusinessSettingValue<K extends BusinessSettingKey> = z.infer<(typeof BUSINESS_SETTING_SCHEMAS)[K]>;

export function isBusinessSettingKey(key: string): key is BusinessSettingKey {
  return Object.hasOwn(BUSINESS_SETTING_SCHEMAS, key);
}

/** What the Targets screen saves (costing:setTargets): both Phase 1 keys at once. */
export const setCostingTargetsInputSchema = z
  .object({
    defaultBps: costingTargetsSchema.shape.defaultBps,
    amberBps: costingTargetsSchema.shape.amberBps,
    perCategory: costingTargetsSchema.shape.perCategory,
    nonFoodCategoryIds: costingTargetsSchema.shape.nonFoodCategoryIds,
    priceStepCents: costingPriceStepSchema,
  })
  .strict();

/**
 * What the Targets tab saves for the alerts (costing:setAlertSettings): the
 * thresholds ('costing.alerts') and the key items (onto the ingredients).
 */
export const setCostAlertSettingsInputSchema = z
  .object({ ...alertThresholds, keyIngredientIds: keyIngredientIdsSchema })
  .strict();

/** Costing → Targets & fees saves how many tills take orders (costing:setTills; the owner only). */
export const setTillsInputSchema = analyticsTillsSchema;

/** Costing → Targets & fees saves foodpanda's commission, payment fees and the rider cost (costing:setChannelFees; the owner only). */
export const setChannelFeesInputSchema = z.object({ fees: channelFeesSchema, riderCost: riderCostSchema }).strict();

const anId = z.string().min(1).max(64);

/**
 * Costing → What-if (costing:whatIf): prices to TRY, never saved. An
 * ingredient's as a pack (size in its base unit, price in paisa); a menu
 * item's own price (before tax). At most 200 of each.
 */
export const whatIfInputSchema = z
  .object({
    ingredients: z
      .array(
        z
          .object({
            ingredientId: anId,
            packSize: z
              .number()
              .int({ message: 'A pack size is a whole number' })
              .min(1, { message: 'A pack is at least 1' })
              .max(100_000_000, { message: 'That pack is too big' }),
            packPriceCents: z
              .number()
              .int({ message: 'A price is in whole paisa' })
              .min(0, { message: 'A price cannot be below Rs 0' })
              .max(100_000_000, { message: 'A price is at most Rs 1,000,000' }),
          })
          .strict(),
      )
      .max(200),
    items: z
      .array(
        z
          .object({
            menuItemId: anId,
            priceCents: z
              .number()
              .int({ message: 'A price is in whole paisa' })
              .min(0, { message: 'A price cannot be below Rs 0' })
              .max(100_000_000, { message: 'A price is at most Rs 1,000,000' }),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

/** An ISO instant. */
const instant = z.string().refine((v) => Number.isFinite(Date.parse(v)), { message: 'Pick a date' });

/** Reports → Menu, the menu map (reports:menuMap): a period, or nothing for the last 28 days. */
export const menuMapInputSchema = z
  .object({ sinceIso: instant.optional(), untilIso: instant.optional() })
  .strict()
  .refine((v) => (v.sinceIso === undefined) === (v.untilIso === undefined), { message: 'Give both dates, or neither' })
  .refine((v) => v.sinceIso === undefined || v.untilIso === undefined || Date.parse(v.untilIso) > Date.parse(v.sinceIso), {
    message: 'The period must end after it starts',
  });

/** "Seen" on Costing → Alerts: one or more alerts at once. */
export const markCostAlertsSeenInputSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1, { message: 'Which alert?' }).max(500) })
  .strict();

/** "Use the sheet's price" (Inventory → Ingredients). */
export const useSheetPriceInputSchema = z.object({ ingredientId: z.string().min(1).max(64) }).strict();

/** Costing → Targets saves the parts of the day (reports:setDayparts; the owner only). */
export const setDaypartsInputSchema = z.object({ dayparts: analyticsDaypartsSchema }).strict();

/** A real calendar date, YYYY-MM-DD (a trading day). */
const tradingDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a day' })
  .refine((ymd) => {
    const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
    const t = Date.UTC(y, m - 1, d);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
  }, { message: 'That is not a real date' });

/** A note for a day, added on Reports → When (reports:addDayNote; report.view). */
export const dayNoteInputSchema = z
  .object({
    day: tradingDay,
    tag: z.enum(DAY_NOTE_TAGS, { errorMap: () => ({ message: 'Pick what the day was' }) }),
    note: z
      .string()
      .max(200, { message: 'Keep the note to 200 letters' })
      .nullish()
      .transform((v) => {
        const t = (v ?? '').replace(/\s+/g, ' ').trim();
        return t === '' ? null : t;
      }),
    excludeFromForecast: z.boolean().optional(),
  })
  .strict();

/** Taking a day note off (reports:removeDayNote). */
export const removeDayNoteInputSchema = z.object({ id: z.string().min(1).max(64) }).strict();

// The IPC contract's types (shared-types) and these schemas must describe the
// same shape: tsc fails here the moment one changes without the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _targetsShape: Same<z.infer<typeof costingTargetsSchema>, CostingTargets> = true;
const _setTargetsShape: Same<z.infer<typeof setCostingTargetsInputSchema>, SetCostingTargetsRequest> = true;
const _alertsShape: Same<z.infer<typeof costingAlertsSchema>, CostAlertSettings> = true;
const _setAlertsShape: Same<z.infer<typeof setCostAlertSettingsInputSchema>, SetCostAlertSettingsRequest> = true;
const _tillsShape: Same<z.infer<typeof analyticsTillsSchema>, TillsSetting> = true;
const _daypartsShape: Same<z.infer<typeof analyticsDaypartsSchema>, Daypart[]> = true;
const _feesShape: Same<z.infer<typeof channelFeesSchema>, ChannelFees> = true;
const _riderShape: Same<z.infer<typeof riderCostSchema>, RiderCostSetting> = true;
const _setFeesShape: Same<z.infer<typeof setChannelFeesInputSchema>, SetChannelFeesRequest> = true;
const _whatIfShape: Same<z.infer<typeof whatIfInputSchema>, WhatIfRequest> = true;
const _menuMapShape: Same<z.infer<typeof menuMapInputSchema>, MenuMapRequest> = true;
