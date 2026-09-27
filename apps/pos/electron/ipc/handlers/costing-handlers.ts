import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { COST_CAPABILITY, err, ok } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import {
  batchCalcInputSchema,
  markCostAlertsSeenInputSchema,
  recipeCostInputSchema,
  setCostAlertSettingsInputSchema,
  setCostingTargetsInputSchema,
  setTillsInputSchema,
} from '@cheeseoclock/shared-schemas';
import { requireCapability, REFUSED } from '../guards.js';
import {
  getBatchCalc,
  getCostAlerts,
  getCostAlertSettings,
  getCostingTargets,
  getItemCostSheet,
  getMenuCosts,
  getMissingCosts,
  previewRecipeCost,
} from '../../services/costing-service.js';
import { getTillsSetting, saveCostAlertSettings, saveCostingTargets, saveTillsSetting } from '../../services/costing-settings.js';
import { readTillLink } from '../../services/till-link.js';
import { markCostAlertsSeen, runWeeklyDigestIfDue } from '../../db/repositories/cost-alert-repo.js';

/**
 * The Costing page (costing spec Phase 1). Costs are the owner's business
 * figures: every channel here is refused in the main process to a login
 * without COST_CAPABILITY (a cashier), not only hidden on screen. Changing
 * the food-cost targets and the alert thresholds is the owner's
 * (settings.manage); managers read them. Price alerts (Phase 6): managers
 * and the owner read them and mark them seen.
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

export function registerCostingHandlers(ctx: HandlerContext): void {
  defineHandler('costing:menuCosts', ctx, () => {
    requireCosts();
    return ok(getMenuCosts(ctx.db));
  });

  defineHandler('costing:itemSheet', ctx, (_ctx, payload) => {
    requireCosts();
    if (!payload || typeof payload.menuItemId !== 'string') {
      return err({ code: 'validation_failed', message: 'Which menu item?' });
    }
    return ok(getItemCostSheet(ctx.db, payload.menuItemId));
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
}
