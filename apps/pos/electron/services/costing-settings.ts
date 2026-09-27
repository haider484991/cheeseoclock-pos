/**
 * Saving the owner's costing settings (costing spec Phase 1 targets, Phase 6
 * alert thresholds) through business-settings-repo: synced and audited, one
 * transaction per save. Kept out of costing-service.ts, which is read-only
 * and also runs in the Reports worker thread (the Dashboard's "Do this"
 * list, Phase 7): the worker must never load a write path.
 */
import type {
  CostAlertSettingsView,
  CostingTargetsView,
  SetCostAlertSettingsRequest,
  SetCostingTargetsRequest,
  TillLinkState,
  TillsSetting,
  TillsSettingView,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { getBusinessSetting, setBusinessSetting, setBusinessSettings } from '../db/repositories/business-settings-repo.js';
import { keyItemIds, setKeyItems } from '../db/repositories/ingredient-repo.js';
import type { Actor } from '../db/repositories/base.js';
import { getCostAlertSettings, getCostingTargets } from './costing-service.js';

/**
 * Save the owner's targets and price step, both keys in one transaction
 * (business-settings-repo). Targets for categories that no longer exist are
 * dropped. Answers with the targets as they now stand.
 */
export function saveCostingTargets(db: AppDatabase, req: SetCostingTargetsRequest, actor: Actor): CostingTargetsView {
  const live = new Set(
    (db.prepare(`SELECT id FROM categories WHERE deleted_at IS NULL`).all() as Array<{ id: string }>).map((c) => c.id),
  );
  const perCategory = Object.fromEntries(Object.entries(req.perCategory).filter(([id]) => live.has(id)));
  setBusinessSettings(
    db,
    [
      {
        key: 'costing.targets',
        value: {
          defaultBps: req.defaultBps,
          amberBps: req.amberBps,
          perCategory,
          nonFoodCategoryIds: req.nonFoodCategoryIds.filter((id) => live.has(id)),
        },
      },
      { key: 'costing.priceStep', value: req.priceStepCents },
    ],
    actor,
  );
  return getCostingTargets(db);
}

/**
 * Save the owner's alert thresholds (business-settings-repo) and the key
 * items — ONE list, on the ingredients (ingredient-repo setKeyItems: the
 * same list the weekly stock take counts) — in one transaction, each change
 * synced and audited. Ids that are no longer ingredients are ignored.
 * The setting also carries a copy of the list, for a till not yet upgraded
 * (ingredient-repo mirrorKeyItemsForOlderTills): never read here.
 * Answers with the settings as they now stand.
 */
export function saveCostAlertSettings(db: AppDatabase, req: SetCostAlertSettingsRequest, actor: Actor): CostAlertSettingsView {
  db.transaction(() => {
    setKeyItems(db, req.keyIngredientIds, actor);
    setBusinessSetting(db, 'costing.alerts', { jumpBps: req.jumpBps, impactWeekCents: req.impactWeekCents, keyIngredientIds: keyItemIds(db) }, actor);
  })();
  return getCostAlertSettings(db);
}

/** How many tills take orders (costing spec Phase 8, 'analytics.tills'), with the link as it is now. */
export function getTillsSetting(db: AppDatabase, link: TillLinkState): TillsSettingView {
  const saved = getBusinessSetting(db, 'analytics.tills');
  return { sellingTills: saved?.value.sellingTills ?? 1, isDefault: saved === null, savedAt: saved?.updatedAt ?? null, link };
}

/** The owner says how many tills take orders (business-settings-repo: synced, audited, both tills). */
export function saveTillsSetting(db: AppDatabase, value: TillsSetting, actor: Actor, link: TillLinkState): TillsSettingView {
  setBusinessSetting(db, 'analytics.tills', { sellingTills: value.sellingTills }, actor);
  return getTillsSetting(db, link);
}
