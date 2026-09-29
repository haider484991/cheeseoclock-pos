import { z } from 'zod';
import {
  shopHoursFields,
  shopHoursRule,
  shopProfileFields,
  shopWebsiteFields,
  websiteHomeFields,
  websiteHomeRule,
  websiteLine,
} from './web-settings.js';
import {
  ANNOUNCEMENT_MAX,
  CLOSED_NOTICE_MAX,
  DEFAULT_ONLINE_OPTIONS,
  MIN_DELIVERY_ORDER_MAX_CENTS,
  APPROVAL_MAX_FLAT_CENTS,
  APPROVAL_MAX_PERCENT,
  CAME_BY_CHOICES,
  CASH_OUT_REASONS_MAX,
  DAY_NOTE_TAGS,
  DELIVERY_FEE_MAX_CENTS,
  DELIVERY_PLACES,
  DELIVERY_ZONES,
  DELIVERY_ZONES_MAX,
  DELIVERY_ZONE_GROUP_MAX,
  DELIVERY_ZONE_ID_MAX,
  DELIVERY_ZONE_ID_RE,
  DELIVERY_ZONE_NAME_MAX,
  DELIVERY_ZONE_SHORT_NAME_MAX,
  DELIVERY_ZONE_SPELLINGS_MAX,
  DELIVERY_ZONE_SPELLING_MAX,
  PLAIN_SHOP_SETTING_KEYS,
  WEBSITE_PICKUP_MAX_PERCENT,
  normalizeAreaText,
  zoneAliasProblem,
  FOODPANDA_DEAL_MAX_PERCENT,
  FOODPANDA_TABLET_TOLERANCE_CENTS,
  FOODPANDA_TABLET_TOLERANCE_MAX_CENTS,
  KITCHEN_TIMING_BOUNDS,
  LEGACY_COMMISSION_BASES,
  NO_DISCOUNT_REASON_LABEL,
  isNoDiscountReasonLabel,
  OFFER_ID_RE,
  OFFER_MAX_FLAT_CENTS,
  OFFER_MAX_ORDER_CENTS,
  OFFER_MAX_PERCENT,
  OFFER_NAME_MAX,
  OFFERS_MAX,
  ORDER_REASON_ID_RE,
  ORDER_REASON_LABEL_MAX,
  ORDER_REASONS_MAX,
  PRESET_FLAT_MAX_CENTS,
  PRESET_FLATS_MAX,
  PRESET_PERCENTS_MAX,
  PRESET_REASON_MAX_LENGTH,
  PRESET_REASONS_MAX,
  RESERVED_WASTE_REASON_IDS,
  RIDER_COST_MODES,
  SHOP_SETTING_FORMAT,
  SHOP_SETTING_KEYS,
  STAFF_TIMING_BOUNDS,
  STOCK_RULE_BOUNDS,
  STOCK_RULE_BPS_STEP,
  WASTE_REASONS,
  WASTE_REASONS_MAX,
  WASTE_REASON_DEFAULT_LABEL,
  WASTE_REASON_ID_RE,
  WASTE_REASON_LABEL_MAX,
  daypartHours,
  isShopSettingKey,
} from '@cheeseoclock/shared-types';
import type {
  DeliveryZones,
  OnlineOptions,
  ShopHours,
  ShopProfile,
  ShopWebsite,
  WebsiteHome,
  PlainShopSettingKey,
  SaveDeliveryZonesRequest,
  WebsitePickup,
  CameBy,
  DiscountApproval,
  DiscountDelivery,
  DiscountOffers,
  DiscountPresets,
  KitchenTiming,
  MenuImportPolicy,
  OrderReasons,
  StaffTiming,
  StockRules,
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
  FoodpandaChecks,
  FoodpandaDeal,
  FoodpandaFees,
  FoodpandaTenderCheck,
  ShopSettingKey,
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

/** How much above the till's prices the foodpanda menu is: basis points, 0–100%, at most two decimals of a %. */
const upliftBpsSchema = z
  .number()
  .int({ message: 'How much dearer foodpanda is has at most two decimals' })
  .min(0, { message: "foodpanda's prices can't be below the till's here — 0% if they are the same" })
  .max(10_000, { message: "foodpanda's prices are at most 100% above the till's" });

const foodpandaFeesShape = {
  commissionBps: ratePercentBps('The commission'),
  confirmed: z.boolean(),
  base: z.enum(['after_deal', 'before_deal'], { errorMap: () => ({ message: 'After the deal, or before it' }) }),
  fixedFeeCents: wholeRupees(2_000, 'The fee per order'),
  commissionTaxBps: ratePercentBps('The tax on the commission'),
  upliftBps: upliftBpsSchema,
  paymentFeeBps: ratePercentBps("foodpanda's fee on the order's total"),
};
/** 'foodpanda.fees' as this version writes it. */
export const foodpandaFeesSchema = z.object({ v: writesFormat('foodpanda.fees'), ...foodpandaFeesShape }).strict();
// Format 1 gained upliftBps and paymentFeeBps before it was released; a value written without
// them reads as 0 (the till's prices, no fee on the total).
const foodpandaFeesReadSchema = z.object({
  v: readsFormat,
  ...foodpandaFeesShape,
  upliftBps: upliftBpsSchema.default(0),
  paymentFeeBps: foodpandaFeesShape.paymentFeeBps.default(0),
});

// ---------------------------------------------------------------------------
// Money & discounts (phase 2) and Staff & kitchen timing (phase 6)
// ---------------------------------------------------------------------------
//
// The hard bounds live here and are checked in the main process on every
// save (settings:setBusiness → business-settings-repo): a screen that sends
// something outside them is refused with the reason, and nothing is written.

/** A whole number from `lo` to `hi` ("Idle sign-out is at least 5 minutes"). */
const wholeIn = (lo: number, hi: number, what: string, unit = '') => {
  const u = unit ? ` ${unit}` : '';
  return z
    .number()
    .int({ message: `${what} is a whole number` })
    .min(lo, { message: `${what} is at least ${lo}${u}` })
    .max(hi, { message: `${what} is at most ${hi}${u}` });
};

/** No two the same (reasons: whatever their capitals). */
const allDifferent = (xs: ReadonlyArray<string | number>) =>
  new Set(xs.map((x) => (typeof x === 'string' ? x.toLowerCase() : x))).size === xs.length;

const discountApprovalShape = {
  percentOver: z
    .number()
    .int({ message: 'The % limit is a whole %' })
    .min(0, { message: "The % limit can't be below 0%" })
    .max(APPROVAL_MAX_PERCENT, { message: `The % limit is at most ${APPROVAL_MAX_PERCENT}%` }),
  flatOverCents: wholeRupees(APPROVAL_MAX_FLAT_CENTS / 100, 'The rupee limit'),
  // Format 2: a discount given by hand needs a reason.
  reasonRequired: z.boolean({ errorMap: () => ({ message: 'A discount needs a reason: Yes or No' }) }),
};
/** 'discounts.approval' as this version writes it. */
export const discountApprovalSchema = z.object({ v: writesFormat('discounts.approval'), ...discountApprovalShape }).strict();
// A format-1 value (v0.7.29 and before) has no reasonRequired: it reads as No, the reason optional as it was.
const discountApprovalReadSchema = z.object({
  v: readsFormat,
  ...discountApprovalShape,
  reasonRequired: discountApprovalShape.reasonRequired.default(false),
});

/** A one-tap reason: printed on the bill, so one line, no spaces at its ends, 30 letters at most. */
const presetReason = z
  .string()
  .min(1, { message: "A reason button can't be empty" })
  .max(PRESET_REASON_MAX_LENGTH, { message: `Keep a reason to ${PRESET_REASON_MAX_LENGTH} letters` })
  .refine((r) => r.trim() === r && r.trim() !== '', { message: 'A reason has no spaces at its start or end' })
  .refine((r) => !/[\r\n\t]/.test(r), { message: 'A reason is one line' });

const discountPresetsShape = {
  percents: z
    .array(wholeIn(1, 100, 'A % button', '%'))
    .min(1, { message: 'Keep at least one % button' })
    .max(PRESET_PERCENTS_MAX, { message: `At most ${PRESET_PERCENTS_MAX} % buttons` })
    .refine(allDifferent, { message: 'Two % buttons are the same' }),
  flatCents: z
    .array(
      wholeRupees(PRESET_FLAT_MAX_CENTS / 100, 'A rupee button').refine((c) => c > 0, { message: 'A rupee button is at least Rs 1' }),
    )
    .min(1, { message: 'Keep at least one rupee button' })
    .max(PRESET_FLATS_MAX, { message: `At most ${PRESET_FLATS_MAX} rupee buttons` })
    .refine(allDifferent, { message: 'Two rupee buttons are the same' }),
  reasons: z
    .array(presetReason)
    .min(1, { message: 'Keep at least one reason button' })
    .max(PRESET_REASONS_MAX, { message: `At most ${PRESET_REASONS_MAX} reason buttons` })
    .refine(allDifferent, { message: 'Two reason buttons are the same' }),
};
/**
 * Written only: a reason button can't be the words Reports use for "no
 * reason" (NO_DISCOUNT_REASON_LABEL), whatever its capitals and spacing
 * (isNoDiscountReasonLabel, the reason check's own comparison). The till counts
 * them as no reason (pos-domain discountReasonMissing), so with "A discount
 * needs a reason" on it would be a button that never works. A list saved
 * before (or by an older till) still reads; the F3 screen leaves such a
 * button out while a reason is needed.
 */
const discountPresetsWriteShape = {
  ...discountPresetsShape,
  reasons: discountPresetsShape.reasons.refine(
    (rs) => !rs.some(isNoDiscountReasonLabel),
    { message: `A reason button can't be “${NO_DISCOUNT_REASON_LABEL}”: Reports use those words for a discount with no reason` },
  ),
};
/** 'discounts.presets' as this version writes it. */
export const discountPresetsSchema = z.object({ v: writesFormat('discounts.presets'), ...discountPresetsWriteShape }).strict();
const discountPresetsReadSchema = z.object({ v: readsFormat, ...discountPresetsShape });

const discountDeliveryShape = {
  alsoOffDeliveryCharge: z.boolean({
    errorMap: () => ({ message: 'Say whether a discount also comes off the delivery charge: yes or no' }),
  }),
};
/** 'discounts.delivery' as this version writes it. */
export const discountDeliverySchema = z.object({ v: writesFormat('discounts.delivery'), ...discountDeliveryShape }).strict();
const discountDeliveryReadSchema = z.object({ v: readsFormat, ...discountDeliveryShape });

const [idleLo, idleHi] = STAFF_TIMING_BOUNDS.idleLogoutMin;
const [loginLo, loginHi] = STAFF_TIMING_BOUNDS.maxLoginHours;
const [stepLo, stepHi] = STAFF_TIMING_BOUNDS.stepInMin;
const [reprintLo, reprintHi] = STAFF_TIMING_BOUNDS.freeReprints;
const [windowLo, windowHi] = STAFF_TIMING_BOUNDS.reprintWindowMin;
const staffTimingShape = {
  // Never off: an owner or manager login left open hands anyone walking past the settings and the staff list.
  idleLogoutMin: wholeIn(idleLo, idleHi, 'Signing out an idle owner or manager', 'minutes'),
  maxLoginHours: wholeIn(loginLo, loginHi, 'The longest a login lasts', 'hours'),
  stepInMin: wholeIn(stepLo, stepHi, 'A manager stepping in', 'minutes'),
  freeReprints: wholeIn(reprintLo, reprintHi, 'Free reprints'),
  reprintWindowMin: wholeIn(windowLo, windowHi, 'The free reprint time', 'minutes'),
};
/** 'staff.timing' as this version writes it. */
export const staffTimingSchema = z.object({ v: writesFormat('staff.timing'), ...staffTimingShape }).strict();
const staffTimingReadSchema = z.object({ v: readsFormat, ...staffTimingShape });

const [amberLo, amberHi] = KITCHEN_TIMING_BOUNDS.amberMin;
const [redLo, redHi] = KITCHEN_TIMING_BOUNDS.redMin;
const [startLo, startHi] = KITCHEN_TIMING_BOUNDS.notStartedMin;
const [doneLo, doneHi] = KITCHEN_TIMING_BOUNDS.notDoneMin;
const kitchenTimingShape = {
  amberMin: wholeIn(amberLo, amberHi, 'Amber', 'minutes'),
  redMin: wholeIn(redLo, redHi, 'Red', 'minutes'),
  notStartedMin: wholeIn(startLo, startHi, '"Not started" reminder', 'minutes'),
  notDoneMin: wholeIn(doneLo, doneHi, '"Not done" reminder', 'minutes'),
};
const kitchenRules = (t: { amberMin: number; redMin: number; notStartedMin: number; notDoneMin: number }, ctx: z.RefinementCtx) => {
  if (t.redMin <= t.amberMin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A card turns red after it turns amber: give red more minutes' });
  }
  if (t.notDoneMin <= t.notStartedMin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The "not done" reminder comes after "not started": give it more minutes' });
  }
};
/** 'kitchen.timing' as this version writes it. */
export const kitchenTimingSchema = z
  .object({ v: writesFormat('kitchen.timing'), ...kitchenTimingShape })
  .strict()
  .superRefine(kitchenRules);
const kitchenTimingReadSchema = z.object({ v: readsFormat, ...kitchenTimingShape }).superRefine(kitchenRules);

// ---------------------------------------------------------------------------
// Kitchen & stock (phase 7): the stock rules and what a menu file may change
// ---------------------------------------------------------------------------

const [trigLo, trigHi] = STOCK_RULE_BOUNDS.varianceDoThisBps;
const [bandLo, bandHi] = STOCK_RULE_BOUNDS.bandBps;
const [winLo, winHi] = STOCK_RULE_BOUNDS.varianceMinWindowDays;
const [keyLo, keyHi] = STOCK_RULE_BOUNDS.keyItemsEveryDays;
const [fullLo, fullHi] = STOCK_RULE_BOUNDS.fullEveryDays;
const [multLo, multHi] = STOCK_RULE_BOUNDS.reorderMultiple;

/** "0.5%", "20%": basis points as the owner types them. */
const pctWords = (bps: number) => `${bps / 100}%`;

/** A share of food sales in basis points, in tenths of a %, from `lo` to `hi`. */
const shareOfSales = (lo: number, hi: number, what: string) =>
  z
    .number()
    .int({ message: `${what} has at most one decimal` })
    .min(lo, { message: `${what} is at least ${pctWords(lo)}` })
    .max(hi, { message: `${what} is at most ${pctWords(hi)}` })
    .refine((b) => b % STOCK_RULE_BPS_STEP === 0, { message: `${what} has at most one decimal` });

const varianceBandsShape = {
  goodUnderBps: shareOfSales(bandLo, bandHi, '"Good"'),
  okUpToBps: shareOfSales(bandLo, bandHi, '"OK"'),
  needsWorkUpToBps: shareOfSales(bandLo, bandHi, '"Needs work"'),
};
const bandsInOrder = (b: { goodUnderBps: number; okUpToBps: number; needsWorkUpToBps: number }, ctx: z.RefinementCtx) => {
  if (!(b.goodUnderBps < b.okUpToBps && b.okUpToBps < b.needsWorkUpToBps)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The ratings go up in order: Good, then OK, then Needs work' });
  }
};

const everyDays = (lo: number, hi: number, what: string) => wholeIn(lo, hi, what, 'days').nullable();
const remindersShape = {
  keyItemsEveryDays: everyDays(keyLo, keyHi, 'The key-items reminder'),
  fullEveryDays: everyDays(fullLo, fullHi, 'The full stock take reminder'),
};

/** A waste reason's name: printed on reports, so one line, no spaces at its ends, 30 letters at most. */
const wasteReasonLabel = z
  .string()
  .min(1, { message: "A waste reason can't be empty" })
  .max(WASTE_REASON_LABEL_MAX, { message: `Keep a waste reason to ${WASTE_REASON_LABEL_MAX} letters` })
  .refine((r) => r.trim() === r && r.trim() !== '', { message: 'A waste reason has no spaces at its start or end' })
  .refine((r) => !/[\r\n\t]/.test(r), { message: 'A waste reason is one line' });
const wasteReasonId = z
  .string()
  .regex(WASTE_REASON_ID_RE, { message: 'That is not a waste reason' })
  .refine((id) => !RESERVED_WASTE_REASON_IDS.includes(id), { message: 'That is not a waste reason' });
const wasteReasonShape = { id: wasteReasonId, label: wasteReasonLabel, hidden: z.boolean() };
const wasteReasonsRules = (reasons: ReadonlyArray<{ id: string; label: string; hidden: boolean }>, ctx: z.RefinementCtx) => {
  const ids = new Set(reasons.map((r) => r.id));
  if (ids.size !== reasons.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Two waste reasons have the same id' });
  if (!allDifferent(reasons.map((r) => r.label))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Two waste reasons have the same name' });
  // The seven the till was released with are what every version writes and reads: rename or hide, never remove.
  const missing = WASTE_REASONS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${WASTE_REASON_DEFAULT_LABEL[missing[0]!]}" is one of the till's own reasons: hide it instead of removing it`,
    });
  }
  if (!reasons.some((r) => !r.hidden)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Keep at least one waste reason on the Waste screen' });
};
const wasteReasonsList = <T extends z.ZodType<{ id: string; label: string; hidden: boolean }>>(item: T) =>
  z
    .array(item)
    .min(1, { message: 'Keep at least one waste reason' })
    .max(WASTE_REASONS_MAX, { message: `At most ${WASTE_REASONS_MAX} waste reasons, hidden ones included` })
    .superRefine(wasteReasonsRules);

const stockRulesCommon = {
  varianceDoThisBps: shareOfSales(trigLo, trigHi, '"Do this" from'),
  varianceMinWindowDays: wholeIn(winLo, winHi, 'The shortest stretch between stock takes', 'days'),
  reorderMultiple: wholeIn(multLo, multHi, 'A full stock bar', 'times the low level'),
};
/** The stock rules' fields as this version writes them (strict all the way down). */
const stockRulesWriteShape = {
  ...stockRulesCommon,
  bands: z.object(varianceBandsShape).strict().superRefine(bandsInOrder),
  reminders: z.object(remindersShape).strict(),
  wasteReasons: wasteReasonsList(z.object(wasteReasonShape).strict()),
};
/** …and as they are read: a newer till's fields this version does not know are dropped. */
const stockRulesReadShape = {
  ...stockRulesCommon,
  bands: z.object(varianceBandsShape).superRefine(bandsInOrder),
  reminders: z.object(remindersShape),
  wasteReasons: wasteReasonsList(z.object(wasteReasonShape)),
};
/** 'stock.rules' as this version writes it. */
export const stockRulesSchema = z.object({ v: writesFormat('stock.rules'), ...stockRulesWriteShape }).strict();
const stockRulesReadSchema = z.object({ v: readsFormat, ...stockRulesReadShape });

const importSide = z.enum(['file', 'till'], { errorMap: () => ({ message: 'The file, or the till' }) });
const menuImportPolicyShape = { itemPrices: importSide, choices: importSide, recipes: importSide, tax: importSide };
/** 'menu.importPolicy' as this version writes it. */
export const menuImportPolicySchema = z.object({ v: writesFormat('menu.importPolicy'), ...menuImportPolicyShape }).strict();
const menuImportPolicyReadSchema = z.object({ v: readsFormat, ...menuImportPolicyShape });

// ---------------------------------------------------------------------------
// Automatic offers by how the order came in (phase 4, Money & discounts)
// ---------------------------------------------------------------------------

/** Walk-in, Phone or WhatsApp: how a counter order came in. */
export const cameBySchema = z.enum(CAME_BY_CHOICES, { errorMap: () => ({ message: 'Walk-in, Phone or WhatsApp' }) });

/** An offer's name: it prints on the bill, so one line, no spaces at its ends, 30 letters at most. */
const offerName = z
  .string()
  .min(1, { message: 'Give the offer a name — it prints on the bill' })
  .max(OFFER_NAME_MAX, { message: `Keep an offer's name to ${OFFER_NAME_MAX} letters` })
  .refine((r) => r.trim() === r && r.trim() !== '', { message: "An offer's name has no spaces at its start or end" })
  .refine((r) => !/[\r\n\t]/.test(r), { message: "An offer's name is one line" });

const offerCameBy = z.union(
  [
    z.literal('any'),
    z
      .array(cameBySchema)
      .min(1, { message: 'Pick how the order came in, or "Any way"' })
      .max(CAME_BY_CHOICES.length)
      .refine(allDifferent, { message: 'Pick each way the order came in once' }),
  ],
  { errorMap: () => ({ message: 'Pick how the order came in, or "Any way"' }) },
);

const offerHoursShape = { fromHour: clockHour, toHour: clockHour };
const offerShape = {
  id: z.string().regex(OFFER_ID_RE, { message: 'That is not an offer' }),
  name: offerName,
  on: z.boolean(),
  cameBy: offerCameBy,
  orderTypes: z
    .array(z.enum(['takeaway', 'delivery'], { errorMap: () => ({ message: 'Takeaway or delivery' }) }))
    .min(1, { message: 'Pick takeaway, delivery or both' })
    .max(2)
    .refine(allDifferent, { message: 'Pick takeaway and delivery once each' }),
  type: z.enum(['percent', 'flat'], { errorMap: () => ({ message: 'A % off, or rupees off' }) }),
  value: z.number().int({ message: 'The amount off is a whole number' }),
  minOrderCents: wholeRupees(OFFER_MAX_ORDER_CENTS / 100, 'The smallest order').nullable(),
  maxOffCents: wholeRupees(OFFER_MAX_ORDER_CENTS / 100, 'The most off one order')
    .refine((c) => c > 0, { message: 'The most off one order must be more than Rs 0 — or leave it empty' })
    .nullable(),
  days: z
    .array(wholeIn(0, 6, 'A day'))
    .min(1, { message: 'Pick at least one day' })
    .max(7)
    .refine(allDifferent, { message: 'Pick each day once' }),
  hours: z.object(offerHoursShape).nullable(),
  startsOn: tradingDay.nullable(),
  endsOn: tradingDay.nullable(),
  oncePerCustomerPerDay: z.boolean(),
};
const offerRules = (
  o: { name: string; type: 'percent' | 'flat'; value: number; startsOn: string | null; endsOn: string | null },
  ctx: z.RefinementCtx,
) => {
  const which = o.name ? `“${o.name}”: ` : '';
  if (o.type === 'percent' && !(o.value >= 1 && o.value <= OFFER_MAX_PERCENT)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${which}a whole % from 1 to ${OFFER_MAX_PERCENT}` });
  }
  if (o.type === 'flat' && !(o.value >= 100 && o.value <= OFFER_MAX_FLAT_CENTS && o.value % 100 === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${which}whole rupees from Rs 1 to Rs ${(OFFER_MAX_FLAT_CENTS / 100).toLocaleString('en-PK')}`,
    });
  }
  if (o.startsOn && o.endsOn && o.endsOn < o.startsOn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${which}it can’t end before it starts` });
  }
};
const offersListRules = (offers: ReadonlyArray<{ id: string; name: string }>, ctx: z.RefinementCtx) => {
  if (new Set(offers.map((o) => o.id)).size !== offers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Two offers have the same id' });
  }
  if (!allDifferent(offers.map((o) => o.name))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Two offers have the same name — they print on the bill' });
  }
};
const offersList = <T extends z.ZodType<{ id: string; name: string }>>(item: T) =>
  z
    .array(item)
    .max(OFFERS_MAX, { message: `At most ${OFFERS_MAX} offers` })
    .superRefine(offersListRules);

/** The offers' fields as this version writes them (strict all the way down). */
const discountOffersWriteShape = {
  askCameBy: z.boolean({ errorMap: () => ({ message: 'Say whether the cashier is asked how the order came in' }) }),
  offers: offersList(z.object({ ...offerShape, hours: z.object(offerHoursShape).strict().nullable() }).strict().superRefine(offerRules)),
};
/** …and as they are read: a newer till's fields this version does not know are dropped. */
const discountOffersReadShape = {
  askCameBy: z.boolean(),
  offers: offersList(z.object(offerShape).superRefine(offerRules)),
};
/**
 * 'discounts.offers' as this version writes it. Website offers are not part
 * of it: they come later with the website settings block (Settings plan step
 * 3), and the till never puts an automatic offer on a web order.
 */
export const discountOffersSchema = z.object({ v: writesFormat('discounts.offers'), ...discountOffersWriteShape }).strict();
const discountOffersReadSchema = z.object({ v: readsFormat, ...discountOffersReadShape });

/** orders:setCameBy — a manager's PIN or password only once the order has been sent. */
export const setCameByInputSchema = z
  .object({
    orderId: z.string().min(1).max(64),
    cameBy: cameBySchema.nullable(),
    approverPin: z.string().max(200).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Reason buttons (Settings → Staff & kitchen): the Cancel, Refund and Cash out ones
// ---------------------------------------------------------------------------

// A reason is saved as its words on the order or the drawer row, and printed:
// one line, no control characters, no spaces at its ends.
// eslint-disable-next-line no-control-regex
const REASON_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const reasonLabel = (what: string) =>
  z
    .string()
    .min(1, { message: `${what} can't be empty` })
    .max(ORDER_REASON_LABEL_MAX, { message: `Keep ${what.toLowerCase()} to ${ORDER_REASON_LABEL_MAX} letters` })
    .refine((r) => r.trim() === r && r.trim() !== '', { message: `${what} has no spaces at its start or end` })
    .refine((r) => !REASON_CONTROL_CHARS.test(r), { message: `${what} is one line of plain words` });

const reasonFood = z.enum(['made', 'not_made', 'ask'], {
  errorMap: () => ({ message: 'Say what the button answers about the food: made, not made, or ask' }),
});
const reasonButtonShape = {
  id: z.string().regex(ORDER_REASON_ID_RE, { message: 'That is not a reason button' }),
  label: reasonLabel('A reason button'),
  food: reasonFood,
};
const reasonButtons = <T extends z.ZodType<{ id: string; label: string; food: string }>>(item: T, which: string) =>
  z
    .array(item)
    .min(1, { message: `Keep at least one ${which} reason button` })
    .max(ORDER_REASONS_MAX, { message: `At most ${ORDER_REASONS_MAX} ${which} reason buttons` })
    .superRefine((buttons, ctx) => {
      if (new Set(buttons.map((b) => b.id)).size !== buttons.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two ${which} reason buttons have the same id` });
      }
      if (!allDifferent(buttons.map((b) => b.label))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two ${which} reason buttons say the same` });
      }
    });
const cashOutReasons = z
  .array(reasonLabel('A cash-out reason'))
  .max(CASH_OUT_REASONS_MAX, { message: `At most ${CASH_OUT_REASONS_MAX} cash-out reasons` })
  .refine(allDifferent, { message: 'Two cash-out reasons are the same' });

const orderReasonsWriteShape = {
  cancel: reasonButtons(z.object(reasonButtonShape).strict(), 'cancel'),
  refund: reasonButtons(z.object(reasonButtonShape).strict(), 'refund'),
  cashOut: cashOutReasons,
};
const orderReasonsReadShape = {
  cancel: reasonButtons(z.object(reasonButtonShape), 'cancel'),
  refund: reasonButtons(z.object(reasonButtonShape), 'refund'),
  cashOut: cashOutReasons,
};
/** 'orders.reasons' as this version writes it. */
export const orderReasonsSchema = z.object({ v: writesFormat('orders.reasons'), ...orderReasonsWriteShape }).strict();
const orderReasonsReadSchema = z.object({ v: readsFormat, ...orderReasonsReadShape });

const checkRule = z.enum(['optional', 'required'], { errorMap: () => ({ message: 'Optional or required' }) });
const foodpandaChecksShape = {
  orderCode: checkRule,
  tabletTotal: checkRule,
  // Format 2: whole rupees, Rs 0 to Rs 10 — an anti-fraud check, never wider.
  tabletToleranceCents: wholeRupees(FOODPANDA_TABLET_TOLERANCE_MAX_CENTS / 100, 'The difference allowed on the tablet'),
};
/** 'foodpanda.checks' as this version writes it. */
export const foodpandaChecksSchema = z.object({ v: writesFormat('foodpanda.checks'), ...foodpandaChecksShape }).strict();
// A format-1 value (v0.7.29 and before) has no tolerance: it reads as Rs 1, as it was.
const foodpandaChecksReadSchema = z.object({
  v: readsFormat,
  ...foodpandaChecksShape,
  tabletToleranceCents: foodpandaChecksShape.tabletToleranceCents.default(FOODPANDA_TABLET_TOLERANCE_CENTS),
});

// ---------------------------------------------------------------------------
// Delivery areas & fees, the website pick-up, online options (phase 3)
// ---------------------------------------------------------------------------

/** One line of text: trimmed, not empty, at most `max` letters. */
const oneLine = (max: number, what: string) =>
  z
    .string()
    .min(1, { message: `${what} can’t be empty` })
    .max(max, { message: `Keep ${what.toLowerCase()} to ${max} letters` })
    .refine((t) => t.trim() === t && t.trim() !== '', { message: `${what} has no spaces at its start or end` })
    .refine((t) => !/[\r\n\t]/.test(t), { message: `${what} is one line` });

const zoneIdSchema = z
  .string()
  .max(DELIVERY_ZONE_ID_MAX, { message: 'That area id is too long' })
  .regex(DELIVERY_ZONE_ID_RE, { message: 'That is not an area id' });
const spellings = (what: string) =>
  z
    .array(z.string().min(1).max(DELIVERY_ZONE_SPELLING_MAX, { message: `Keep a spelling to ${DELIVERY_ZONE_SPELLING_MAX} letters` }))
    .max(DELIVERY_ZONE_SPELLINGS_MAX, { message: `At most ${DELIVERY_ZONE_SPELLINGS_MAX} ${what} for one area` });

const deliveryZoneShape = {
  id: zoneIdSchema,
  name: oneLine(DELIVERY_ZONE_NAME_MAX, 'An area’s name'),
  shortName: oneLine(DELIVERY_ZONE_SHORT_NAME_MAX, 'An area’s short name'),
  group: oneLine(DELIVERY_ZONE_GROUP_MAX, 'An area’s group'),
  feeCents: wholeRupees(DELIVERY_FEE_MAX_CENTS / 100, 'A delivery fee'),
  feeItemId: z.string().min(1).max(64).nullable(),
  active: z.boolean(),
  aliases: spellings('spellings'),
  hints: spellings('search shortcuts'),
};
/** The fields of one area this version writes (a newer till's extra field makes the stored list "newer": storedFormatIsNewer). */
const DELIVERY_ZONE_FIELDS: ReadonlySet<string> = new Set(Object.keys(deliveryZoneShape));

/** Ids, names and spellings each name ONE area. */
const zonesAreDistinct = (
  zones: ReadonlyArray<{ id: string; name: string; aliases: readonly string[] }>,
  ctx: z.RefinementCtx,
) => {
  const ids = new Set<string>();
  const words = new Map<string, string>();
  for (const zn of zones) {
    if (ids.has(zn.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Two areas have the id "${zn.id}"` });
      return;
    }
    ids.add(zn.id);
    for (const w of [zn.name, ...zn.aliases]) {
      const key = normalizeAreaText(w);
      if (!key) continue;
      const other = words.get(key);
      if (other !== undefined && other !== zn.id) {
        const otherName = zones.find((x) => x.id === other)?.name ?? other;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${w}" names both ${otherName} and ${zn.name} — keep it on one area`,
        });
        return;
      }
      words.set(key, zn.id);
    }
  }
};

/** What this version writes: every rule of the card. */
const zonesWriteRules = (
  zones: ReadonlyArray<{ id: string; name: string; group: string; feeCents: number; feeItemId: string | null; aliases: readonly string[] }>,
  ctx: z.RefinementCtx,
) => {
  zonesAreDistinct(zones, ctx);
  for (const zn of zones) {
    for (const a of zn.aliases) {
      const problem = zoneAliasProblem(a);
      if (problem) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${zn.name}: ${problem}` });
        return;
      }
    }
    if (zn.feeCents === 0 && zn.feeItemId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${zn.name} is free to deliver to: it takes no delivery charge item` });
      return;
    }
  }
  // The released areas are what every version knows (and the website's pages): switch one off, never remove it.
  const ids = new Set(zones.map((zn) => zn.id));
  const missing = DELIVERY_ZONES.find((zn) => !ids.has(zn.id));
  if (missing) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${missing.name} is one of the shop’s own areas: switch it off instead of removing it`,
    });
    return;
  }
  // A landmark ("Khayaban-e-Ittehad") lies in areas of one group: the till asks "which phase?" within it.
  const groupOf = new Map(zones.map((zn) => [zn.id, zn.group.trim().toLowerCase()]));
  for (const p of DELIVERY_PLACES) {
    const groups = new Set(p.zoneIds.map((id) => groupOf.get(id)).filter((g): g is string => g !== undefined));
    if (groups.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${p.label} lies in ${p.zoneIds.map((id) => zones.find((x) => x.id === id)?.name ?? id).join(', ')}: keep those areas in one group`,
      });
      return;
    }
  }
};

const zonesList = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item)
    .min(1, { message: 'Keep at least one delivery area' })
    .max(DELIVERY_ZONES_MAX, { message: `At most ${DELIVERY_ZONES_MAX} delivery areas, switched-off ones included` });

/** 'delivery.zones' as this version writes it. */
export const deliveryZonesSchema = z
  .object({
    v: writesFormat('delivery.zones'),
    zones: zonesList(z.object(deliveryZoneShape).strict()).superRefine(zonesWriteRules),
  })
  .strict();
const deliveryZonesReadSchema = z.object({
  v: readsFormat,
  // A newer till's fields are dropped; ids and names must still each name one area.
  zones: zonesList(z.object(deliveryZoneShape)).superRefine(zonesAreDistinct),
});

const websitePickupShape = {
  offered: z.boolean({ errorMap: () => ({ message: 'Say whether pick-up is offered on the website: yes or no' }) }),
  percent: z
    .number()
    .int({ message: 'The pick-up discount is a whole %' })
    .min(0, { message: "The pick-up discount can't be below 0%" })
    .max(WEBSITE_PICKUP_MAX_PERCENT, { message: `The pick-up discount is at most ${WEBSITE_PICKUP_MAX_PERCENT}%` }),
};
/** 'discounts.websitePickup' as this version writes it. */
export const websitePickupSchema = z.object({ v: writesFormat('discounts.websitePickup'), ...websitePickupShape }).strict();
const websitePickupReadSchema = z.object({ v: readsFormat, ...websitePickupShape });

// 'online.options' format 2 (v0.7.30): the website's messages and delivery minimum joined
// `autoPublishMenu`. Their words' rules are the settings block's own (web-settings.ts), so
// what the till saves always passes the website's check.
/** A website message as the till saves it: one line of plain words, no spaces at its ends. */
const savedWebsiteLine = (max: number, what: string) =>
  websiteLine(max, what).refine((t) => t.trim() === t, { message: `${what[0]!.toUpperCase()}${what.slice(1)} has no spaces at its start or end` });
const closedNoticeFields = {
  text: savedWebsiteLine(CLOSED_NOTICE_MAX, 'the closed notice'),
  until: tradingDay.nullable(),
};
const announcementFields = {
  on: z.boolean({ errorMap: () => ({ message: 'Say whether the announcement shows: yes or no' }) }),
  text: savedWebsiteLine(ANNOUNCEMENT_MAX, 'the announcement'),
};
const announcementHasWords = (a: { on: boolean; text: string }) => !a.on || a.text !== '';
const ANNOUNCEMENT_NEEDS_WORDS = { message: 'Type the announcement, or switch it off' };
const minDeliveryOrder = wholeRupees(MIN_DELIVERY_ORDER_MAX_CENTS / 100, 'The smallest website delivery order');
const onlineOptionsShape = {
  autoPublishMenu: z.boolean({ errorMap: () => ({ message: 'Say whether the menu goes to the website by itself: yes or no' }) }),
  closedNotice: z.object(closedNoticeFields).strict(),
  announcement: z.object(announcementFields).strict().refine(announcementHasWords, ANNOUNCEMENT_NEEDS_WORDS),
  minDeliveryOrderCents: minDeliveryOrder,
};
/** 'online.options' as this version writes it (format 2: every field, nothing else). */
export const onlineOptionsSchema = z.object({ v: writesFormat('online.options'), ...onlineOptionsShape }).strict();
/**
 * Read: a format-1 value (v0.7.29: `autoPublishMenu` only) reads with the
 * messages and the minimum at their defaults (today's website). A message
 * that does not read (a newer till's changed shape) falls back to its
 * default ALONE — never taking `autoPublishMenu` down with it. Nothing here
 * depends on today: a notice whose last day is past still reads (it is
 * simply no longer in force).
 */
const onlineOptionsReadSchema = z.object({
  v: readsFormat,
  autoPublishMenu: onlineOptionsShape.autoPublishMenu,
  closedNotice: z
    .object(closedNoticeFields)
    .default({ ...DEFAULT_ONLINE_OPTIONS.closedNotice })
    .catch(() => ({ ...DEFAULT_ONLINE_OPTIONS.closedNotice })),
  announcement: z
    .object(announcementFields)
    .default({ ...DEFAULT_ONLINE_OPTIONS.announcement })
    .catch(() => ({ ...DEFAULT_ONLINE_OPTIONS.announcement })),
  minDeliveryOrderCents: minDeliveryOrder.default(DEFAULT_ONLINE_OPTIONS.minDeliveryOrderCents).catch(DEFAULT_ONLINE_OPTIONS.minDeliveryOrderCents),
});

// ---------------------------------------------------------------------------
// The shop's details the website shows (sweep B2 + B4; shared-types
// website-shop.ts, web-bridge.ts THE SHOP BLOCK). Their bounds are the shop
// block's own (web-settings.ts shopProfileFields…), so a Save always passes
// the website's check. Format 1; the read schemas take any format from 1 and
// drop fields this version does not know (storedFormatIsNewer says so).
// ---------------------------------------------------------------------------

/** 'shop.profile' as this version writes it. */
export const shopProfileSchema = z.object({ v: writesFormat('shop.profile'), ...shopProfileFields }).strict();
const shopProfileReadSchema = z.object({ v: readsFormat, ...shopProfileFields });

/** 'shop.hours' as this version writes it (THE rule: shared-types shopHoursProblem). */
export const shopHoursSchema = z.object({ v: writesFormat('shop.hours'), ...shopHoursFields }).strict().superRefine(shopHoursRule);
const shopHoursReadSchema = z.object({ v: readsFormat, ...shopHoursFields }).superRefine(shopHoursRule);

/** 'shop.website' as this version writes it. */
export const shopWebsiteSchema = z.object({ v: writesFormat('shop.website'), ...shopWebsiteFields }).strict();
const shopWebsiteReadSchema = z.object({ v: readsFormat, ...shopWebsiteFields });

/** 'website.home' as this version writes it. */
export const websiteHomeSchema = z.object({ v: writesFormat('website.home'), ...websiteHomeFields }).strict().superRefine(websiteHomeRule);
const websiteHomeReadSchema = z.object({ v: readsFormat, ...websiteHomeFields }).superRefine(websiteHomeRule);

/**
 * settings:saveDeliveryZones: the whole list as the card sends it (the main
 * process decides every fee item; a feeItemId sent is ignored), or "Put
 * back the default". The full rules are deliveryZonesSchema's, checked on
 * the list the Save writes.
 */
export const saveDeliveryZonesInputSchema = z.union([
  z.object({ useDefault: z.literal(true) }).strict(),
  z
    .object({
      zones: zonesList(
        z
          .object({
            ...deliveryZoneShape,
            feeItemId: deliveryZoneShape.feeItemId.optional(),
          })
          .strict(),
      ),
    })
    .strict(),
]);

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

/** What each way of paying costs the shop (costing spec 4.7). */
const paymentFeeBpsSchema = z
  .object({
    cash: feeBps('A payment fee'),
    card: feeBps('A payment fee'),
    foodpanda: feeBps('A payment fee'),
    transfer: feeBps('A payment fee'),
  })
  .strict();

/**
 * v0.7.20's foodpanda part of 'channels.fees' (RETIRED: Settings →
 * foodpanda, 'foodpanda.fees', is the one place foodpanda's terms live).
 * Still read — carried over while 'foodpanda.fees' was never saved — and
 * kept as stored when the card fees are saved, never written new.
 */
const legacyFoodpandaChannelFeesSchema = z
  .object({
    commissionBps: feeBps('The commission'),
    base: z.enum(LEGACY_COMMISSION_BASES, { errorMap: () => ({ message: 'Pick what the commission is taken on' }) }),
    fixedFeeCents: feeCents('The fixed fee'),
    upliftBps: feeBps('How much dearer foodpanda is'),
  })
  .strict();

/**
 * Phase 9: what each way of paying costs (costing spec 4.7), and — only as
 * v0.7.20 saved it — its retired foodpanda part.
 */
export const channelFeesSchema = z
  .object({
    foodpanda: legacyFoodpandaChannelFeesSchema.optional(),
    paymentFeeBps: paymentFeeBpsSchema,
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
  'foodpanda.deal': foodpandaDealSchema,
  'foodpanda.fees': foodpandaFeesSchema,
  'foodpanda.checks': foodpandaChecksSchema,
  'discounts.approval': discountApprovalSchema,
  'discounts.presets': discountPresetsSchema,
  'discounts.delivery': discountDeliverySchema,
  'staff.timing': staffTimingSchema,
  'kitchen.timing': kitchenTimingSchema,
  'stock.rules': stockRulesSchema,
  'menu.importPolicy': menuImportPolicySchema,
  'discounts.offers': discountOffersSchema,
  'orders.reasons': orderReasonsSchema,
  'discounts.websitePickup': websitePickupSchema,
  'delivery.zones': deliveryZonesSchema,
  'online.options': onlineOptionsSchema,
  'shop.profile': shopProfileSchema,
  'shop.hours': shopHoursSchema,
  'shop.website': shopWebsiteSchema,
  'website.home': websiteHomeSchema,
  'channels.fees': channelFeesSchema,
  'delivery.riderCost': riderCostSchema,
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
  'discounts.approval': discountApprovalReadSchema,
  'discounts.presets': discountPresetsReadSchema,
  'discounts.delivery': discountDeliveryReadSchema,
  'staff.timing': staffTimingReadSchema,
  'kitchen.timing': kitchenTimingReadSchema,
  'stock.rules': stockRulesReadSchema,
  'menu.importPolicy': menuImportPolicyReadSchema,
  'discounts.offers': discountOffersReadSchema,
  'orders.reasons': orderReasonsReadSchema,
  'discounts.websitePickup': websitePickupReadSchema,
  'delivery.zones': deliveryZonesReadSchema,
  'online.options': onlineOptionsReadSchema,
  'shop.profile': shopProfileReadSchema,
  'shop.hours': shopHoursReadSchema,
  'shop.website': shopWebsiteReadSchema,
  'website.home': websiteHomeReadSchema,
  'channels.fees': channelFeesSchema,
  'delivery.riderCost': riderCostSchema,
};

/** The fields each shop rule has in the format this version writes. */
const SHOP_SETTING_FIELDS: { readonly [K in ShopSettingKey]: ReadonlySet<string> } = {
  'foodpanda.deal': new Set(['v', ...Object.keys(foodpandaDealShape)]),
  'foodpanda.fees': new Set(['v', ...Object.keys(foodpandaFeesShape)]),
  'foodpanda.checks': new Set(['v', ...Object.keys(foodpandaChecksShape)]),
  'discounts.approval': new Set(['v', ...Object.keys(discountApprovalShape)]),
  'discounts.presets': new Set(['v', ...Object.keys(discountPresetsShape)]),
  'discounts.delivery': new Set(['v', ...Object.keys(discountDeliveryShape)]),
  'staff.timing': new Set(['v', ...Object.keys(staffTimingShape)]),
  'kitchen.timing': new Set(['v', ...Object.keys(kitchenTimingShape)]),
  'stock.rules': new Set(['v', ...Object.keys(stockRulesWriteShape)]),
  'menu.importPolicy': new Set(['v', ...Object.keys(menuImportPolicyShape)]),
  'discounts.offers': new Set(['v', ...Object.keys(discountOffersWriteShape)]),
  'orders.reasons': new Set(['v', ...Object.keys(orderReasonsWriteShape)]),
  'discounts.websitePickup': new Set(['v', ...Object.keys(websitePickupShape)]),
  'delivery.zones': new Set(['v', 'zones']),
  'online.options': new Set(['v', ...Object.keys(onlineOptionsShape)]),
  'shop.profile': new Set(['v', ...Object.keys(shopProfileFields)]),
  'shop.hours': new Set(['v', ...Object.keys(shopHoursFields)]),
  'shop.website': new Set(['v', ...Object.keys(shopWebsiteFields)]),
  'website.home': new Set(['v', ...Object.keys(websiteHomeFields)]),
};

/** The fields of the shop keys' nested objects this version writes (a newer till's extra one makes the value "newer"). */
const SHOP_PHONE_FIELDS: ReadonlySet<string> = new Set(['display', 'e164']);
const SHOP_ADDRESS_FIELDS: ReadonlySet<string> = new Set(['street', 'areaLine', 'postalCode']);
const HOME_ENTRY_FIELDS: ReadonlySet<string> = new Set(['itemRef', 'headline', 'text']);
const HOME_ITEM_REF_FIELDS: ReadonlySet<string> = new Set(['posItemId', 'name']);

/** An object (not a list) with a field this version does not know. */
function hasUnknownField(o: unknown, known: ReadonlySet<string>): boolean {
  return typeof o === 'object' && o !== null && !Array.isArray(o) && Object.keys(o).some((f) => !known.has(f));
}

/** A shop key's nested objects with a field this version does not know: a newer till's. */
function shopNestedIsNewer(key: 'shop.profile' | 'website.home', raw: Record<string, unknown>): boolean {
  if (key === 'shop.profile') {
    const lines = Array.isArray(raw['whatsappLines']) ? (raw['whatsappLines'] as unknown[]) : [];
    return (
      hasUnknownField(raw['phone'], SHOP_PHONE_FIELDS) ||
      hasUnknownField(raw['address'], SHOP_ADDRESS_FIELDS) ||
      lines.some((l) => hasUnknownField(l, SHOP_PHONE_FIELDS))
    );
  }
  const entries = [
    ...(Array.isArray(raw['pizzas']) ? (raw['pizzas'] as unknown[]) : []),
    ...(raw['burger'] ? [raw['burger']] : []),
    ...(Array.isArray(raw['deals']) ? (raw['deals'] as unknown[]) : []),
  ];
  return entries.some(
    (e) =>
      hasUnknownField(e, HOME_ENTRY_FIELDS) ||
      (typeof e === 'object' && e !== null && hasUnknownField((e as { itemRef?: unknown }).itemRef, HOME_ITEM_REF_FIELDS)),
  );
}

const CLOSED_NOTICE_FIELDS: ReadonlySet<string> = new Set(Object.keys(closedNoticeFields));
const ANNOUNCEMENT_FIELDS: ReadonlySet<string> = new Set(Object.keys(announcementFields));

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
  if (Object.keys(raw).some((f) => !known.has(f))) return true;
  // The areas are a list of objects: a field one of them has that this version does not know is newer too.
  if (key === 'delivery.zones') {
    const zones = (raw as { zones?: unknown }).zones;
    if (Array.isArray(zones)) {
      return zones.some(
        (zn) => typeof zn === 'object' && zn !== null && Object.keys(zn).some((f) => !DELIVERY_ZONE_FIELDS.has(f)),
      );
    }
  }
  // The shop's details with nested fields this version does not know: a newer till's too.
  if (key === 'shop.profile' || key === 'website.home') return shopNestedIsNewer(key, raw as Record<string, unknown>);
  // The website's messages with fields this version does not know: a newer till's too.
  if (key === 'online.options') {
    const nested = (field: string, known: ReadonlySet<string>) => {
      const o = (raw as Record<string, unknown>)[field];
      return typeof o === 'object' && o !== null && !Array.isArray(o) && Object.keys(o).some((f) => !known.has(f));
    };
    return nested('closedNotice', CLOSED_NOTICE_FIELDS) || nested('announcement', ANNOUNCEMENT_FIELDS);
  }
  // An offer (or its hours) with fields this version does not know: a newer till's too.
  if (key === 'discounts.offers') {
    const offers = (raw as { offers?: unknown }).offers;
    if (Array.isArray(offers)) {
      const offerFields = new Set(Object.keys(offerShape));
      const hourFields = new Set(Object.keys(offerHoursShape));
      return offers.some((o) => {
        if (typeof o !== 'object' || o === null) return false;
        if (Object.keys(o).some((f) => !offerFields.has(f))) return true;
        const hours = (o as { hours?: unknown }).hours;
        return typeof hours === 'object' && hours !== null && Object.keys(hours).some((f) => !hourFields.has(f));
      });
    }
  }
  return false;
}

/** The keys settings:setBusiness saves: every shop rule but the delivery areas (settings:saveDeliveryZones). */
const plainShopSettingKey = z.enum(PLAIN_SHOP_SETTING_KEYS as [PlainShopSettingKey, ...PlainShopSettingKey[]], {
  errorMap: () => ({ message: 'Which setting?' }),
});

/**
 * settings:setBusiness: a key and its value, or "Put back the default". The
 * value is checked by the key's schema. Never 'delivery.zones': its Save
 * also makes the delivery-charge items (settings:saveDeliveryZones).
 */
export const setShopSettingInputSchema = z.union([
  z.object({ key: plainShopSettingKey, useDefault: z.literal(true) }).strict(),
  z.object({ key: plainShopSettingKey, value: z.unknown() }).strict(),
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

/**
 * Costing → Targets & fees saves the payment fees and the rider cost
 * (costing:setChannelFees; the owner only). foodpanda's terms are Settings →
 * foodpanda's: a foodpanda part sent here (an older screen) is STRIPPED —
 * `fees` is a plain (non-strict) object, so unknown keys are dropped — and
 * the stored one is kept as it was (costing-settings saveChannelFees).
 */
export const setChannelFeesInputSchema = z
  .object({ fees: z.object({ paymentFeeBps: paymentFeeBpsSchema }), riderCost: riderCostSchema })
  .strict();

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
const _approvalShape: Same<z.infer<typeof discountApprovalSchema>, DiscountApproval> = true;
const _approvalReadShape: Same<z.infer<typeof discountApprovalReadSchema>, DiscountApproval> = true;
const _presetsShape: Same<z.infer<typeof discountPresetsSchema>, DiscountPresets> = true;
const _presetsReadShape: Same<z.infer<typeof discountPresetsReadSchema>, DiscountPresets> = true;
const _staffTimingShape: Same<z.infer<typeof staffTimingSchema>, StaffTiming> = true;
const _staffTimingReadShape: Same<z.infer<typeof staffTimingReadSchema>, StaffTiming> = true;
const _kitchenTimingShape: Same<z.infer<typeof kitchenTimingSchema>, KitchenTiming> = true;
const _kitchenTimingReadShape: Same<z.infer<typeof kitchenTimingReadSchema>, KitchenTiming> = true;
const _stockRulesShape: Same<z.infer<typeof stockRulesSchema>, StockRules> = true;
const _stockRulesReadShape: Same<z.infer<typeof stockRulesReadSchema>, StockRules> = true;
const _menuImportPolicyShape: Same<z.infer<typeof menuImportPolicySchema>, MenuImportPolicy> = true;
const _menuImportPolicyReadShape: Same<z.infer<typeof menuImportPolicyReadSchema>, MenuImportPolicy> = true;
const _deliveryZonesShape: Same<z.infer<typeof deliveryZonesSchema>, DeliveryZones> = true;
const _deliveryZonesReadShape: Same<z.infer<typeof deliveryZonesReadSchema>, DeliveryZones> = true;
const _saveDeliveryZonesShape: Same<z.infer<typeof saveDeliveryZonesInputSchema>, SaveDeliveryZonesRequest> = true;
const _websitePickupShape: Same<z.infer<typeof websitePickupSchema>, WebsitePickup> = true;
const _websitePickupReadShape: Same<z.infer<typeof websitePickupReadSchema>, WebsitePickup> = true;
const _onlineOptionsShape: Same<z.infer<typeof onlineOptionsSchema>, OnlineOptions> = true;
const _onlineOptionsReadShape: Same<z.infer<typeof onlineOptionsReadSchema>, OnlineOptions> = true;
const _discountDeliveryShape: Same<z.infer<typeof discountDeliverySchema>, DiscountDelivery> = true;
const _shopProfileShape: Same<z.infer<typeof shopProfileSchema>, ShopProfile> = true;
const _shopProfileReadShape: Same<z.infer<typeof shopProfileReadSchema>, ShopProfile> = true;
const _shopHoursShape: Same<z.infer<typeof shopHoursSchema>, ShopHours> = true;
const _shopHoursReadShape: Same<z.infer<typeof shopHoursReadSchema>, ShopHours> = true;
const _shopWebsiteShape: Same<z.infer<typeof shopWebsiteSchema>, ShopWebsite> = true;
const _shopWebsiteReadShape: Same<z.infer<typeof shopWebsiteReadSchema>, ShopWebsite> = true;
const _websiteHomeShape: Same<z.infer<typeof websiteHomeSchema>, WebsiteHome> = true;
const _websiteHomeReadShape: Same<z.infer<typeof websiteHomeReadSchema>, WebsiteHome> = true;
const _discountDeliveryReadShape: Same<z.infer<typeof discountDeliveryReadSchema>, DiscountDelivery> = true;
const _discountOffersShape: Same<z.infer<typeof discountOffersSchema>, DiscountOffers> = true;
const _discountOffersReadShape: Same<z.infer<typeof discountOffersReadSchema>, DiscountOffers> = true;
const _cameByShape: Same<z.infer<typeof cameBySchema>, CameBy> = true;
const _orderReasonsShape: Same<z.infer<typeof orderReasonsSchema>, OrderReasons> = true;
const _orderReasonsReadShape: Same<z.infer<typeof orderReasonsReadSchema>, OrderReasons> = true;
const _feesShape: Same<z.infer<typeof channelFeesSchema>, ChannelFees> = true;
const _riderShape: Same<z.infer<typeof riderCostSchema>, RiderCostSetting> = true;
const _setFeesShape: Same<z.infer<typeof setChannelFeesInputSchema>, SetChannelFeesRequest> = true;
const _whatIfShape: Same<z.infer<typeof whatIfInputSchema>, WhatIfRequest> = true;
const _menuMapShape: Same<z.infer<typeof menuMapInputSchema>, MenuMapRequest> = true;
