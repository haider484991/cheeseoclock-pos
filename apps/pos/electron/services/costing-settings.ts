/**
 * Saving the owner's costing settings (costing spec Phase 1 targets, Phase 6
 * alert thresholds) through business-settings-repo: synced and audited, one
 * transaction per save. Kept out of costing-service.ts, which is read-only
 * and also runs in the Reports worker thread (the Dashboard's "Do this"
 * list, Phase 7): the worker must never load a write path.
 */
import type {
  ChannelFees,
  ChannelFeesView,
  CostAlertSettingsView,
  FoodpandaTermsInForce,
  CostingTargetsView,
  SetChannelFeesRequest,
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
import { loadProfitSettings } from './analytics/profit.js';
import { activeFoodpandaDeal } from '@cheeseoclock/pos-domain';
import { readShopSetting } from '../db/business-settings-read.js';

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

/**
 * foodpanda's terms in force (Settings → foodpanda), for Costing → Targets &
 * fees to show read-only: the ONE reader (readShopSetting — saved, carried
 * over from v0.7.20, or the suggested default) and the deal on the listing.
 */
export function foodpandaTermsInForce(db: AppDatabase, now: Date = new Date()): FoodpandaTermsInForce {
  const fees = readShopSetting(db, 'foodpanda.fees');
  const deal = readShopSetting(db, 'foodpanda.deal').value;
  return {
    fees: fees.value,
    carriedOver: fees.carriedOver,
    isDefault: fees.isDefault,
    deal,
    dealToday: activeFoodpandaDeal(deal, now.toISOString()) !== null,
  };
}

/**
 * Payment fees and the rider cost in force (costing spec Phase 9; the
 * defaults until saved), and — for the owner (`withFoodpanda`: profit.view)
 * — foodpanda's terms from Settings → foodpanda, for display. A manager
 * gets no foodpanda part: its commission is profit.
 */
export function getChannelFees(db: AppDatabase, withFoodpanda: boolean): ChannelFeesView {
  const p = loadProfitSettings(db);
  return {
    fees: { paymentFeeBps: p.fees.paymentFeeBps },
    riderCost: p.riderCost,
    isDefault: p.isDefault,
    savedAt: p.savedAt,
    foodpanda: withFoodpanda ? foodpandaTermsInForce(db) : null,
  };
}

/**
 * The card fees and how riders are paid: both keys in one transaction
 * (business-settings-repo: synced, audited, both tills). foodpanda's terms
 * are not saved here — Settings → foodpanda keeps them. The foodpanda part
 * v0.7.20 may have stored in 'channels.fees' is KEPT as stored (never taken
 * from the request, which the schema strips): it is what the one reader
 * carries over while Settings → foodpanda has never been saved, and what a
 * till still on v0.7.20 reads. Answers with the fees as they now stand.
 */
export function saveChannelFees(db: AppDatabase, req: SetChannelFeesRequest, actor: Actor, withFoodpanda: boolean): ChannelFeesView {
  const legacy = getBusinessSetting(db, 'channels.fees')?.value.foodpanda;
  const fees: ChannelFees = legacy
    ? { foodpanda: legacy, paymentFeeBps: req.fees.paymentFeeBps }
    : { paymentFeeBps: req.fees.paymentFeeBps };
  setBusinessSettings(
    db,
    [
      { key: 'channels.fees', value: fees },
      { key: 'delivery.riderCost', value: req.riderCost },
    ],
    actor,
  );
  return getChannelFees(db, withFoodpanda);
}
