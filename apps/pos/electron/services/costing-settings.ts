/**
 * Saving the owner's costing settings (costing spec Phase 1 targets, Phase 6
 * alert thresholds) through business-settings-repo: synced and audited, one
 * transaction per save. Kept out of costing-service.ts, which is read-only
 * and also runs in the Reports worker thread (the Dashboard's "Do this"
 * list, Phase 7): the worker must never load a write path.
 */
import type { CostAlertSettingsView, CostingTargetsView, SetCostAlertSettingsRequest, SetCostingTargetsRequest } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { setBusinessSetting, setBusinessSettings } from '../db/repositories/business-settings-repo.js';
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
 * Save the owner's alert thresholds (business-settings-repo: synced,
 * audited). Key ingredients that are no longer there are dropped. Answers
 * with the settings as they now stand.
 */
export function saveCostAlertSettings(db: AppDatabase, req: SetCostAlertSettingsRequest, actor: Actor): CostAlertSettingsView {
  const live = new Set(
    (db.prepare(`SELECT id FROM ingredients WHERE deleted_at IS NULL`).all() as Array<{ id: string }>).map((i) => i.id),
  );
  setBusinessSetting(
    db,
    'costing.alerts',
    {
      jumpBps: req.jumpBps,
      impactWeekCents: req.impactWeekCents,
      keyIngredientIds: [...new Set(req.keyIngredientIds)].filter((id) => live.has(id)),
    },
    actor,
  );
  return getCostAlertSettings(db);
}
