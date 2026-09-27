import { z } from 'zod';
import type { CostAlertSettings, CostingTargets, SetCostingTargetsRequest } from '@cheeseoclock/shared-types';

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

/**
 * Phase 6: the price alerts' thresholds (costing spec D1, Phase 6). A key
 * ingredient moving more than `jumpBps` is an alert — and the same figure is
 * D1's purchase guard (a bill that far from the usual price asks first);
 * any price change costing at least `impactWeekCents` a week at this till's
 * sales is an alert; `keyIngredientIds` are the key ingredients.
 */
export const costingAlertsSchema = z
  .object({
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
    keyIngredientIds: z.array(z.string().min(1)).max(1_000),
  })
  .strict();

/** Every key and its schema. A key not listed here cannot be written. */
export const BUSINESS_SETTING_SCHEMAS = {
  'costing.targets': costingTargetsSchema,
  'costing.priceStep': costingPriceStepSchema,
  'costing.alerts': costingAlertsSchema,
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

/** What the Targets tab saves for the alerts (costing:setAlertSettings): the 'costing.alerts' value. */
export const setCostAlertSettingsInputSchema = costingAlertsSchema;

/** "Seen" on Costing → Alerts: one or more alerts at once. */
export const markCostAlertsSeenInputSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1, { message: 'Which alert?' }).max(500) })
  .strict();

/** "Use the sheet's price" (Inventory → Ingredients). */
export const useSheetPriceInputSchema = z.object({ ingredientId: z.string().min(1).max(64) }).strict();

// The IPC contract's types (shared-types) and these schemas must describe the
// same shape: tsc fails here the moment one changes without the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _targetsShape: Same<z.infer<typeof costingTargetsSchema>, CostingTargets> = true;
const _setTargetsShape: Same<z.infer<typeof setCostingTargetsInputSchema>, SetCostingTargetsRequest> = true;
const _alertsShape: Same<z.infer<typeof costingAlertsSchema>, CostAlertSettings> = true;
