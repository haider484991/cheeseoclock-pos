import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { COST_CAPABILITY, err, ok } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser, WhatIfResult } from '@cheeseoclock/shared-types';
import {
  batchCalcInputSchema,
  markCostAlertsSeenInputSchema,
  recipeCalcInputSchema,
  recipeCostInputSchema,
  setChannelFeesInputSchema,
  setCostAlertSettingsInputSchema,
  setCostingTargetsInputSchema,
  setTillsInputSchema,
  whatIfInputSchema,
} from '@cheeseoclock/shared-schemas';
import { mayProfit, requireCapability, requireProfit, REFUSED } from '../guards.js';
import {
  getBatchCalc,
  getCostAlerts,
  getCostAlertSettings,
  getCostingTargets,
  getItemCostSheet,
  getMenuCosts,
  getMissingCosts,
  itemCostSheetForLogin,
  menuCostsForLogin,
  previewRecipeCost,
} from '../../services/costing-service.js';
import {
  getChannelFees,
  getTillsSetting,
  saveChannelFees,
  saveCostAlertSettings,
  saveCostingTargets,
  saveTillsSetting,
} from '../../services/costing-settings.js';
import { getCostedRecipeCalc } from '../../services/recipe-calc-service.js';
import { readTillLink } from '../../services/till-link.js';
import { itemFoodpandaLine } from '../../services/shop-settings.js';
import { markCostAlertsSeen, runWeeklyDigestIfDue } from '../../db/repositories/cost-alert-repo.js';
import { getAnalyticsWorker } from '../../services/analytics/worker-host.js';
import { workOutExtra, type ReportWorker } from './reports-handlers.js';

/**
 * The Costing page (costing spec Phase 1). Costs are the owner's business
 * figures: every channel here is refused in the main process to a login
 * without COST_CAPABILITY (a cashier), not only hidden on screen. Changing
 * the food-cost targets and the alert thresholds is the owner's
 * (settings.manage); managers read them. Price alerts (Phase 6): managers
 * and the owner read them and mark them seen.
 *
 * Phase 9: payment fees and the rider cost (costing:getChannelFees —
 * managers read; costing:setChannelFees — the owner). foodpanda's terms live
 * in Settings → foodpanda: getChannelFees shows them read-only to the owner
 * (profit.view) and setChannelFees strips a foodpanda part. What-if (costing:whatIf — profit.view and costs; worked out in the
 * Reports worker, never saved, nothing on the till changes); and profit on
 * Menu costs and the cost sheet (what you keep per sale and per paid extra,
 * "price to hit target"), left out for a login without profit.view. Profit
 * is the owner's alone since 2026-09-27: a manager sees costs, never profit.
 */
function requireCosts(): AuthenticatedUser {
  return requireCapability(COST_CAPABILITY, REFUSED.costs);
}

function validationFailed(error: ZodError) {
  const first = error.issues[0];
  const path = first?.path.join('.');
  return err({
    code: 'validation_failed',
    message: first ? (path ? `${path}: ${first.message}` : first.message) : 'Invalid input',
    details: error.flatten(),
  });
}

/** What the Costing channels need of the Reports worker (What-if runs there). */
export interface CostingHandlerDeps {
  worker: () => ReportWorker | null;
}

export function registerCostingHandlers(ctx: HandlerContext, deps: CostingHandlerDeps = { worker: getAnalyticsWorker }): void {
  defineHandler('costing:menuCosts', ctx, () => {
    const s = requireCosts();
    // "You keep per sale" is profit.view's (owner, 2026-09-27).
    return ok(menuCostsForLogin(getMenuCosts(ctx.db), mayProfit(s)));
  });

  defineHandler('costing:itemSheet', ctx, (_ctx, payload) => {
    const s = requireCosts();
    if (!payload || typeof payload.menuItemId !== 'string') {
      return err({ code: 'validation_failed', message: 'Which menu item?' });
    }
    // What you keep and "price to hit target" are profit.view's (costing spec 4.3, D6; owner, 2026-09-27).
    const profit = mayProfit(s);
    const sheet = itemCostSheetForLogin(getItemCostSheet(ctx.db, payload.menuItemId), profit);
    if (!sheet) return ok(null);
    // "On foodpanda": the listing price and the price after the deal for anyone
    // who may see costs; foodpanda's commission and what the shop keeps are
    // profit — the owner's alone (profit.view), left out here for a manager.
    return ok({ ...sheet, onFoodpanda: itemFoodpandaLine(ctx.db, sheet.row, profit) });
  });

  defineHandler('costing:missingCosts', ctx, () => {
    requireCosts();
    return ok(getMissingCosts(ctx.db));
  });

  defineHandler('costing:getTargets', ctx, () => {
    requireCosts();
    return ok(getCostingTargets(ctx.db));
  });

  defineHandler('costing:setTargets', ctx, (_ctx, payload) => {
    requireCosts();
    const s = requireCapability('settings.manage', 'Only the owner can change the food-cost targets.');
    const parsed = setCostingTargetsInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveCostingTargets(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('costing:recipeCost', ctx, (_ctx, payload) => {
    requireCosts();
    const parsed = recipeCostInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(previewRecipeCost(ctx.db, parsed.data.menuItemId, parsed.data.lines));
  });

  defineHandler('costing:batchCalc', ctx, (_ctx, payload) => {
    requireCosts();
    const parsed = batchCalcInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(getBatchCalc(ctx.db, parsed.data.ingredientId, parsed.data.amount));
  });

  // The recipe calculator with what it costs (inventory:recipeCalc is the same without).
  defineHandler('costing:recipeCalc', ctx, (_ctx, payload) => {
    requireCosts();
    const parsed = recipeCalcInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(getCostedRecipeCalc(ctx.db, parsed.data));
  });

  // ---- Price alerts (costing spec Phase 6) ----
  defineHandler('costing:alerts', ctx, () => {
    requireCosts();
    // A Monday digest not written yet on this till is written now (it is
    // also written at start and every hour; the till's own work, no login's).
    runWeeklyDigestIfDue(ctx.db, { userId: null, deviceId: ctx.deviceId });
    return ok(getCostAlerts(ctx.db));
  });

  defineHandler('costing:markAlertsSeen', ctx, (_ctx, payload) => {
    const s = requireCosts();
    const parsed = markCostAlertsSeenInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    markCostAlertsSeen(ctx.db, parsed.data.ids, { userId: s.id, deviceId: ctx.deviceId });
    return ok(getCostAlerts(ctx.db));
  });

  defineHandler('costing:getAlertSettings', ctx, () => {
    requireCosts();
    return ok(getCostAlertSettings(ctx.db));
  });

  defineHandler('costing:setAlertSettings', ctx, (_ctx, payload) => {
    requireCosts();
    const s = requireCapability('settings.manage', 'Only the owner can change the price alerts.');
    const parsed = setCostAlertSettingsInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveCostAlertSettings(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- How many tills take orders (costing spec Phase 8, owner question 3) ----
  defineHandler('costing:getTills', ctx, () => {
    requireCosts();
    return ok(getTillsSetting(ctx.db, readTillLink(ctx.db)));
  });

  defineHandler('costing:setTills', ctx, (_ctx, payload) => {
    requireCosts();
    const s = requireCapability('settings.manage', 'Only the owner can say how many tills take orders.');
    const parsed = setTillsInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveTillsSetting(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }, readTillLink(ctx.db)));
  });

  // ---- Profit (costing spec Phase 9) ----
  defineHandler('costing:getChannelFees', ctx, () => {
    const s = requireCosts();
    // foodpanda's terms (its commission) are profit: the owner's alone.
    return ok(getChannelFees(ctx.db, mayProfit(s)));
  });

  defineHandler('costing:setChannelFees', ctx, (_ctx, payload) => {
    requireCosts();
    const s = requireCapability('settings.manage', 'Only the owner can change the card fees and the rider cost.');
    // A foodpanda part (an older screen) is stripped by the schema: Settings → foodpanda keeps foodpanda's terms.
    const parsed = setChannelFeesInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveChannelFees(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }, mayProfit(s)));
  });

  /** New prices TRIED, never saved: in the Reports worker (the last 28 days' sales), else here. */
  defineHandler('costing:whatIf', ctx, async (_ctx, payload) => {
    requireCosts();
    requireProfit();
    const parsed = whatIfInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    const { data, engine } = await workOutExtra(ctx.db, deps.worker(), 'whatIf', parsed.data);
    return ok({ ...(data as Omit<WhatIfResult, 'engine'>), engine });
  });
}
