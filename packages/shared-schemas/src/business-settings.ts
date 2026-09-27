import { z } from 'zod';
import {
  DAY_NOTE_TAGS,
  FOODPANDA_DEAL_MAX_PERCENT,
  SHOP_SETTING_FORMAT,
  SHOP_SETTING_KEYS,
  daypartHours,
  isShopSettingKey,
} from '@cheeseoclock/shared-types';
import type {
  CostAlertSettings,
  CostingTargets,
  Daypart,
  SetCostAlertSettingsRequest,
  SetCostingTargetsRequest,
  TillsSetting,
  FoodpandaChecks,
  FoodpandaDeal,
  FoodpandaFees,
  FoodpandaTenderCheck,
  ShopSettingKey,
} from '@cheeseoclock/shared-types';

/**
 * Business settings (costing spec §3, migration 0032): shop-wide settings
 * both tills share, one row per key in `business_settings` (replicable,
 * unlike the per-till `settings` table). Every key has exactly one schema
 * here; a value is checked against it when it is written AND when it is
 * read back (a row from another till's newer version that does not fit is
 * ignored, never trusted). Each phase adds only its own keys.
 */

/** A real calendar date, YYYY-MM-DD (a trading day). */
const tradingDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Pick a day' })
  .refine((ymd) => {
    const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
    const t = Date.UTC(y, m - 1, d);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd;
  }, { message: 'That is not a real date' });

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

// ---------------------------------------------------------------------------
// The owner's shop rules (Settings → foodpanda …, shared-types shop-settings.ts)
// ---------------------------------------------------------------------------
//
// Each value carries `v`, its format. The WRITE schema is strict and takes
// only the format this version writes. The READ schema strips fields it does
// not know and takes any format from 1 up, so a value a newer till saved is
// still used here (the fields this version knows); storedFormatIsNewer tells
// the card to go read-only and the repository to refuse a save over it.

/** `v`: the format this version writes (write) or any format from 1 (read). */
const writesFormat = (key: ShopSettingKey) =>
  z
    .number()
    .int()
    .refine((v) => v === SHOP_SETTING_FORMAT[key], {
      message: 'Saved by a different version of the app — update this till to change it',
    });
const readsFormat = z.number().int().min(1);

/** Whole rupees in paisa, from Rs 0 up to `maxRupees`. */
const wholeRupees = (maxRupees: number, what: string) =>
  z
    .number()
    .int({ message: `${what} is in whole rupees` })
    .min(0, { message: `${what} can't be below Rs 0` })
    .max(maxRupees * 100, { message: `${what} is at most Rs ${maxRupees.toLocaleString('en-PK')}` })
    .refine((c) => c % 100 === 0, { message: `${what} is in whole rupees` });

const wholePercent = (what: string) =>
  z
    .number()
    .int({ message: `${what} is a whole %` })
    .min(0, { message: `${what} can't be below 0%` })
    .max(FOODPANDA_DEAL_MAX_PERCENT, { message: `${what} is at most ${FOODPANDA_DEAL_MAX_PERCENT}%` });

/** A rate in basis points with at most two decimals of a %, 0–50%. */
const ratePercentBps = (what: string) =>
  z
    .number()
    .int({ message: `${what} has at most two decimals` })
    .min(0, { message: `${what} can't be below 0%` })
    .max(5_000, { message: `${what} is at most 50%` });

const foodpandaDealShape = {
  percent: wholePercent('The deal'),
  shopPercent: wholePercent('Your part of the deal'),
  minOrderCents: wholeRupees(50_000, 'The smallest order').nullable(),
  maxOffCents: wholeRupees(50_000, 'The most off one order')
    .refine((c) => c > 0, { message: 'The most off one order must be more than Rs 0 — or leave it empty' })
    .nullable(),
  startsOn: tradingDay.nullable(),
  endsOn: tradingDay.nullable(),
};
const dealRules = (d: { percent: number; shopPercent: number; startsOn: string | null; endsOn: string | null }, ctx: z.RefinementCtx) => {
  if (d.shopPercent > d.percent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Your part of the deal can’t be more than the deal itself' });
  }
  if (d.startsOn && d.endsOn && d.endsOn < d.startsOn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The deal can’t end before it starts' });
  }
};

/** 'foodpanda.deal' as this version writes it. */
export const foodpandaDealSchema = z
  .object({ v: writesFormat('foodpanda.deal'), ...foodpandaDealShape })
  .strict()
  .superRefine(dealRules);
const foodpandaDealReadSchema = z.object({ v: readsFormat, ...foodpandaDealShape }).superRefine(dealRules);

const foodpandaFeesShape = {
  commissionBps: ratePercentBps('The commission'),
  confirmed: z.boolean(),
  base: z.enum(['after_deal', 'before_deal'], { errorMap: () => ({ message: 'After the deal, or before it' }) }),
  fixedFeeCents: wholeRupees(2_000, 'The fee per order'),
  commissionTaxBps: ratePercentBps('The tax on the commission'),
};
/** 'foodpanda.fees' as this version writes it. */
export const foodpandaFeesSchema = z.object({ v: writesFormat('foodpanda.fees'), ...foodpandaFeesShape }).strict();
const foodpandaFeesReadSchema = z.object({ v: readsFormat, ...foodpandaFeesShape });

const checkRule = z.enum(['optional', 'required'], { errorMap: () => ({ message: 'Optional or required' }) });
const foodpandaChecksShape = { orderCode: checkRule, tabletTotal: checkRule };
/** 'foodpanda.checks' as this version writes it. */
export const foodpandaChecksSchema = z.object({ v: writesFormat('foodpanda.checks'), ...foodpandaChecksShape }).strict();
const foodpandaChecksReadSchema = z.object({ v: readsFormat, ...foodpandaChecksShape });

/** Every key and its schema. A key not listed here cannot be written. */
export const BUSINESS_SETTING_SCHEMAS = {
  'costing.targets': costingTargetsSchema,
  'costing.priceStep': costingPriceStepSchema,
  'costing.alerts': costingAlertsSchema,
  'analytics.dayparts': analyticsDaypartsSchema,
  'analytics.tills': analyticsTillsSchema,
  'foodpanda.deal': foodpandaDealSchema,
  'foodpanda.fees': foodpandaFeesSchema,
  'foodpanda.checks': foodpandaChecksSchema,
} as const;

export type BusinessSettingKey = keyof typeof BUSINESS_SETTING_SCHEMAS;
export type BusinessSettingValue<K extends BusinessSettingKey> = z.infer<(typeof BUSINESS_SETTING_SCHEMAS)[K]>;

export function isBusinessSettingKey(key: string): key is BusinessSettingKey {
  return Object.hasOwn(BUSINESS_SETTING_SCHEMAS, key);
}

/**
 * How a stored value is read back. The costing keys have no format and are
 * read with their write schema, as before (a value that does not fit is "not
 * set"). The shop rules are read leniently: fields this version does not
 * know are dropped, any format from 1 up is taken.
 */
export const BUSINESS_SETTING_READ_SCHEMAS: { readonly [K in BusinessSettingKey]: z.ZodType<BusinessSettingValue<K>, z.ZodTypeDef, unknown> } = {
  'costing.targets': costingTargetsSchema,
  'costing.priceStep': costingPriceStepSchema,
  'costing.alerts': costingAlertsSchema,
  'analytics.dayparts': analyticsDaypartsSchema,
  'analytics.tills': analyticsTillsSchema,
  'foodpanda.deal': foodpandaDealReadSchema,
  'foodpanda.fees': foodpandaFeesReadSchema,
  'foodpanda.checks': foodpandaChecksReadSchema,
};

/** The fields each shop rule has in the format this version writes. */
const SHOP_SETTING_FIELDS: { readonly [K in ShopSettingKey]: ReadonlySet<string> } = {
  'foodpanda.deal': new Set(['v', ...Object.keys(foodpandaDealShape)]),
  'foodpanda.fees': new Set(['v', ...Object.keys(foodpandaFeesShape)]),
  'foodpanda.checks': new Set(['v', ...Object.keys(foodpandaChecksShape)]),
};

/**
 * A stored shop rule saved by a newer version of the app: a higher format,
 * or fields this version does not know. This till uses what it knows but
 * shows the card read-only and refuses to save over it (it would silently
 * drop the rest). Costing keys (no format) are never "newer".
 */
export function storedFormatIsNewer(key: BusinessSettingKey, raw: unknown): boolean {
  if (!isShopSettingKey(key)) return false;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const v = (raw as { v?: unknown }).v;
  if (typeof v === 'number' && v > SHOP_SETTING_FORMAT[key]) return true;
  const known = SHOP_SETTING_FIELDS[key];
  return Object.keys(raw).some((f) => !known.has(f));
}

/** settings:setBusiness: a key and its value, or "Put back the default". The value is checked by the key's schema. */
export const setShopSettingInputSchema = z.union([
  z.object({ key: z.enum(SHOP_SETTING_KEYS), useDefault: z.literal(true) }).strict(),
  z.object({ key: z.enum(SHOP_SETTING_KEYS), value: z.unknown() }).strict(),
]);

/** settings:getBusiness */
export const getShopSettingInputSchema = z.object({ key: z.enum(SHOP_SETTING_KEYS) }).strict();

/** The foodpanda half of orders:tender. */
export const foodpandaTenderCheckSchema = z
  .object({
    tabletTotalCents: z
      .number()
      .int({ message: 'The tablet total is in paisa' })
      .min(0, { message: 'The tablet total can’t be below Rs 0' })
      .max(100_000_000, { message: 'That tablet total is too big — check it' })
      .nullish(),
  })
  .strict();

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

/** "Seen" on Costing → Alerts: one or more alerts at once. */
export const markCostAlertsSeenInputSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1, { message: 'Which alert?' }).max(500) })
  .strict();

/** "Use the sheet's price" (Inventory → Ingredients). */
export const useSheetPriceInputSchema = z.object({ ingredientId: z.string().min(1).max(64) }).strict();

/** Costing → Targets saves the parts of the day (reports:setDayparts; the owner only). */
export const setDaypartsInputSchema = z.object({ dayparts: analyticsDaypartsSchema }).strict();

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
const _foodpandaDealShape: Same<z.infer<typeof foodpandaDealSchema>, FoodpandaDeal> = true;
const _foodpandaDealReadShape: Same<z.infer<typeof foodpandaDealReadSchema>, FoodpandaDeal> = true;
const _foodpandaFeesShape: Same<z.infer<typeof foodpandaFeesSchema>, FoodpandaFees> = true;
const _foodpandaFeesReadShape: Same<z.infer<typeof foodpandaFeesReadSchema>, FoodpandaFees> = true;
const _foodpandaChecksShape: Same<z.infer<typeof foodpandaChecksSchema>, FoodpandaChecks> = true;
const _foodpandaChecksReadShape: Same<z.infer<typeof foodpandaChecksReadSchema>, FoodpandaChecks> = true;
const _tenderCheckShape: Same<z.infer<typeof foodpandaTenderCheckSchema>, FoodpandaTenderCheck> = true;
